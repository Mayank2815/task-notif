import type { Stage } from './stage-range.js';
import type { TeamworkActivity, TeamworkComment, TeamworkTask, TeamworkUser, V3Envelope } from './types.js';

export interface TeamworkClientOptions {
  siteUrl: string;
  apiToken: string;
  /** Bounds how far back we look for activity. */
  lookbackDays?: number;
}

const PAGE_SIZE = 250; // Teamwork v3 caps pageSize at 500; 250 keeps responses small enough to parse fast
const MAX_RETRIES = 6;
const MAX_PAGES = 200; // hard stop so a pagination bug can never loop forever
const MIN_REQUEST_GAP_MS = 400; // ~150 req/min, under Teamwork's throttle even on a back-to-back run

export class TeamworkError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'TeamworkError';
  }
}

export class TeamworkClient {
  private readonly base: string;
  private readonly auth: string;
  /** Serialises every request through one chain so we never burst past the rate limit. */
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly opts: TeamworkClientOptions) {
    this.base = opts.siteUrl.replace(/\/+$/, '');
    this.auth = 'Basic ' + Buffer.from(`${opts.apiToken}:x`).toString('base64');
  }

  private throttle(): Promise<void> {
    const wait = this.gate.then(() => sleep(MIN_REQUEST_GAP_MS));
    this.gate = wait;
    return wait;
  }

  get siteUrl(): string {
    return this.base;
  }

  async request<T = unknown>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle();
      const res = await fetch(url, {
        headers: { Authorization: this.auth, Accept: 'application/json' },
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_RETRIES) {
          throw new TeamworkError(`Teamwork ${res.status} after ${MAX_RETRIES} retries`, res.status, await safeText(res));
        }
        // Honour Retry-After when present, otherwise exponential backoff.
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 2_000, 60_000);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new TeamworkError(`Teamwork ${res.status} on ${url.pathname}`, res.status, await safeText(res));
      }

      return (await res.json()) as T;
    }
    throw new TeamworkError('unreachable');
  }

  /**
   * Posts a comment on a task, as whoever owns the token this client was built with.
   * Teamwork has no way to post on another person's behalf, so the token IS the author —
   * which is why a reply sent from Slack has to use that person's own token.
   *
   * Creating a comment is a v1 endpoint; v3 only reads them. Deliberately not retried:
   * every other call here is a read and safe to repeat, but a comment that may already
   * have landed must not be posted twice.
   */
  async postComment(
    taskId: number,
    body: string,
    /**
     * HTML is how a mention becomes a real one — Teamwork's editor stores a mention as a
     * link to the person, and plain "@Name" text is only a word that looks like one.
     */
    opts: { html?: boolean; notify?: number[] } = {},
  ): Promise<number> {
    await this.throttle();
    const comment: Record<string, unknown> = { body, contentType: opts.html ? 'HTML' : 'TEXT' };
    // Leaving notify out notifies nobody, which is right for a reply that tags nobody.
    // The field takes a comma-separated list of user ids.
    if (opts.notify?.length) comment.notify = opts.notify.join(',');

    const res = await fetch(`${this.base}/tasks/${taskId}/comments.json`, {
      method: 'POST',
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment }),
    });

    if (!res.ok) {
      throw new TeamworkError(`Teamwork ${res.status} posting a comment on task ${taskId}`, res.status, await safeText(res));
    }
    const data = (await res.json()) as { commentId?: number | string; comment?: { id?: number | string }; id?: number | string };
    return Number(data.commentId ?? data.id ?? data.comment?.id ?? 0);
  }

  /** Walks every page of a v3 collection and returns the flattened rows plus merged sideloads. */
  async paginate<T = Record<string, unknown>>(
    path: string,
    collectionKey: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ rows: T[]; included: Record<string, Record<string, unknown>> }> {
    const rows: T[] = [];
    const included: Record<string, Record<string, unknown>> = {};

    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.request<V3Envelope<T>>(path, { ...params, page, pageSize: PAGE_SIZE });
      const batch = (body[collectionKey] as T[] | undefined) ?? [];
      rows.push(...batch);

      for (const [type, entries] of Object.entries(body.included ?? {})) {
        included[type] = { ...(included[type] ?? {}), ...entries };
      }

      const hasMore = body.meta?.page?.hasMore ?? false;
      if (!hasMore || batch.length === 0) break;
    }

    return { rows, included };
  }

  async me(): Promise<TeamworkUser> {
    const body = await this.request<{ person?: Record<string, unknown> }>('/projects/api/v3/me.json');
    const p = body.person ?? {};
    return {
      id: Number(p.id),
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      email: str(p.email) ?? str(p.emailAddress),
      handle: str(p.handle),
    };
  }

  async person(userId: number): Promise<TeamworkUser | null> {
    try {
      const body = await this.request<{ person?: Record<string, unknown> }>(`/projects/api/v3/people/${userId}.json`);
      const p = body.person;
      if (!p) return null;
      return {
        id: Number(p.id),
        firstName: str(p.firstName),
        lastName: str(p.lastName),
        email: str(p.email) ?? str(p.emailAddress),
        handle: str(p.handle),
      };
    } catch (err) {
      if ((err as TeamworkError).status === 404 || (err as TeamworkError).status === 403) return null;
      throw err;
    }
  }

  async people(): Promise<TeamworkUser[]> {
    const { rows } = await this.paginate<Record<string, unknown>>('/projects/api/v3/people.json', 'people');
    return rows.map((p) => ({
      id: Number(p.id),
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      email: str(p.email) ?? str(p.emailAddress),
      handle: str(p.handle),
    }));
  }

  private get cutoffIso(): string {
    return new Date(Date.now() - (this.opts.lookbackDays ?? 60) * 86_400_000).toISOString();
  }

  /** Open tasks assigned to a user. NB: v3 silently ignores `assigneeUserIds`; `responsiblePartyIds` is the one it honours. */
  async tasksAssignedTo(userId: number): Promise<TeamworkTask[]> {
    const { rows, included } = await this.paginate<Record<string, unknown>>('/projects/api/v3/tasks.json', 'tasks', {
      include: 'projects',
      includeCompletedTasks: false,
      responsiblePartyIds: userId,
    });
    const projects = included.projects ?? {};
    return rows.map((t) => this.normaliseTask(t, projects));
  }

  /** Every open task updated since the cutoff — one sweep instead of an individual call per task id. */
  async recentTasks(): Promise<TeamworkTask[]> {
    const { rows, included } = await this.paginate<Record<string, unknown>>('/projects/api/v3/tasks.json', 'tasks', {
      include: 'projects',
      includeCompletedTasks: false,
      updatedAfter: this.cutoffIso,
    });
    const projects = included.projects ?? {};
    return rows.map((t) => this.normaliseTask(t, projects));
  }

  async task(taskId: number): Promise<TeamworkTask | null> {
    try {
      const body = await this.request<{ task?: Record<string, unknown>; included?: Record<string, Record<string, unknown>> }>(
        `/projects/api/v3/tasks/${taskId}.json`,
        { include: 'projects' },
      );
      if (!body.task) return null;
      return this.normaliseTask(body.task, body.included?.projects ?? {});
    } catch (err) {
      if ((err as TeamworkError).status === 404) return null;
      throw err;
    }
  }

  /**
   * Every task comment posted since the lookback cutoff, newest first.
   * One sweep of this replaces a per-task comment fetch across thousands of tasks.
   */
  async recentTaskComments(onProgress?: (scanned: number) => void): Promise<TeamworkComment[]> {
    const cutoff = this.cutoffIso;
    const out: TeamworkComment[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.request<V3Envelope<Record<string, unknown>>>('/projects/api/v3/comments.json', {
        page,
        pageSize: PAGE_SIZE,
        orderBy: 'date',
        orderMode: 'desc',
      });
      const rows = (body.comments as Record<string, unknown>[] | undefined) ?? [];
      if (rows.length === 0) break;

      let reachedCutoff = false;
      for (const c of rows) {
        const postedAt = str(c.postedDateTime) ?? '';
        if (postedAt && postedAt < cutoff) { reachedCutoff = true; continue; }
        if (str(c.objectType) !== 'task') continue;
        if (c.deleted === true) continue;
        const taskId = num(c.objectId);
        if (taskId) out.push(this.normaliseComment(c, taskId));
      }

      onProgress?.(page * PAGE_SIZE);
      if (reachedCutoff || !(body.meta?.page?.hasMore ?? false)) break;
    }

    return out;
  }

  /** Workspace activity feed (status changes, edits, completions), newest first, back to `since`. */
  async activitySince(since: string): Promise<TeamworkActivity[]> {
    const out: TeamworkActivity[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.request<V3Envelope<Record<string, unknown>>>('/projects/api/v3/latestactivity.json', {
        page,
        pageSize: PAGE_SIZE,
      });
      const rows = (body.activities as Record<string, unknown>[] | undefined) ?? [];
      if (rows.length === 0) break;

      let reachedCutoff = false;
      for (const a of rows) {
        const dateTime = str(a.dateTime) ?? '';
        if (dateTime && dateTime < since) { reachedCutoff = true; continue; }
        out.push({
          id: Number(a.id),
          userId: Number(a.userId),
          activityType: str(a.activityType) ?? 'unknown',
          dateTime,
          description: str(a.description) ?? '',
          extraDescription: str(a.extraDescription),
          itemId: num(a.itemId),
          itemType: str((a.item as Record<string, unknown> | undefined)?.type),
          projectId: num(a.projectId),
          link: str(a.itemLink) ?? str(a.link),
        });
      }

      if (reachedCutoff || !(body.meta?.page?.hasMore ?? false)) break;
    }

    return out;
  }

  /**
   * Board columns for a workflow. `displayOrder` is the real left-to-right order —
   * the array order the API returns is not (one board lists Sprint Backlog
   * before the Backlog columns that precede it on the board).
   */
  async workflowStages(workflowId: number): Promise<Stage[]> {
    try {
      const { rows } = await this.paginate<Record<string, unknown>>(
        `/projects/api/v3/workflows/${workflowId}/stages.json`,
        'stages',
      );
      return rows
        .map((row) => ({ id: num(row.id) ?? 0, name: str(row.name) ?? '', displayOrder: Number(row.displayOrder ?? 0) }))
        .filter((s) => s.id > 0 && s.name.length > 0);
    } catch {
      // A workflow we cannot read just means no column names on those tasks.
      return [];
    }
  }

  async comments(taskId: number): Promise<TeamworkComment[]> {
    const { rows } = await this.paginate<Record<string, unknown>>(
      `/projects/api/v3/tasks/${taskId}/comments.json`,
      'comments',
    );
    return rows.map((c) => this.normaliseComment(c, taskId));
  }

  /**
   * A task's comments with their authors attached, in one request.
   *
   * Looking each author up separately cost a round trip per person — measured at 2.7s
   * for four authors on top of the comments themselves, which is the whole of the wait
   * someone saw after clicking Reply. The users sideload carries name and avatar in the
   * same response (0.7s).
   */
  async commentThread(taskId: number): Promise<{
    comments: TeamworkComment[];
    authors: Map<number, { name: string; avatarUrl: string | null }>;
  }> {
    const { rows, included } = await this.paginate<Record<string, unknown>>(
      `/projects/api/v3/tasks/${taskId}/comments.json`,
      'comments',
      { include: 'users' },
    );
    const authors = new Map<number, { name: string; avatarUrl: string | null }>();
    for (const [id, raw] of Object.entries(included.users ?? {})) {
      const u = raw as Record<string, unknown>;
      const name = [str(u.firstName), str(u.lastName)].filter(Boolean).join(' ');
      authors.set(Number(id), { name: name || 'Someone', avatarUrl: str(u.avatarUrl) ?? null });
    }
    return { comments: rows.map((c) => this.normaliseComment(c, taskId)), authors };
  }

  /**
   * Moves a task's due date, as whoever owns this client's token. Idempotent, so safe to
   * repeat, unlike posting a comment.
   */
  async setDueDate(taskId: number, dueAt: string): Promise<void> {
    await this.write('PUT', `/projects/api/v3/tasks/${taskId}.json`, { task: { dueAt } }, `moving the due date of task ${taskId}`);
  }

  /** Marks a task complete. A v1 endpoint; v3 has no equivalent. */
  async completeTask(taskId: number): Promise<void> {
    await this.write('PUT', `/tasks/${taskId}/complete.json`, {}, `completing task ${taskId}`);
  }

  /** One write, never retried — a write that may already have landed is not repeated blindly. */
  private async write(method: 'PUT' | 'POST', path: string, body: unknown, what: string): Promise<void> {
    await this.throttle();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new TeamworkError(`Teamwork ${res.status} ${what}`, res.status, await safeText(res));
  }

  /**
   * Time a person logged between two instants, one row per entry.
   *
   * `assignedToUserIds` is the filter that works on this endpoint: `userId`, `userIds` and
   * `personId` are ignored without an error and return everybody's time. Checked on
   * 14 September against a client-side count for five people — identical sets. The date
   * filter works by whole UTC day, so the exact window is applied here afterwards, and
   * rows are still checked against the person, in case the filter ever changes meaning.
   */
  async timeLoggedBy(userId: number, startIso: string, endIso: string): Promise<{
    taskId: number; minutes: number; at: string; taskName: string | null; projectName: string | null;
  }[]> {
    const { rows, included } = await this.paginate<Record<string, unknown>>('/projects/api/v3/time.json', 'timelogs', {
      assignedToUserIds: userId,
      startDate: startIso.slice(0, 10),
      endDate: endIso.slice(0, 10),
      include: 'tasks,projects',
    });
    const tasks = (included.tasks ?? {}) as Record<string, Record<string, unknown>>;
    const projects = (included.projects ?? {}) as Record<string, Record<string, unknown>>;
    const from = Date.parse(startIso);
    const to = Date.parse(endIso);

    return rows
      .filter((r) => Number(r.userId) === userId && Number(r.taskId) > 0 && !r.deleted)
      .map((r) => ({
        taskId: Number(r.taskId),
        minutes: Number(r.minutes ?? 0) + Number(r.hours ?? 0) * 60,
        at: String(r.timeLogged ?? ''),
        taskName: str(tasks[String(r.taskId)]?.name) ?? null,
        projectName: str(projects[String(r.projectId)]?.name) ?? null,
      }))
      .filter((r) => {
        const at = Date.parse(r.at);
        return Number.isFinite(at) && at >= from && at <= to;
      });
  }

  private normaliseTask(t: Record<string, unknown>, projects: Record<string, unknown>): TeamworkTask {
    const id = Number(t.id);
    const tasklistMeta = (t.tasklist as Record<string, unknown> | undefined)?.meta as Record<string, unknown> | undefined;
    // A task sits in at most one board column; the array is how Teamwork models it.
    const stage = (t.workflowStages as Record<string, unknown>[] | undefined)?.[0];
    const projectId = num(t.projectId) ?? num(tasklistMeta?.projectId);
    const project = projectId ? (projects[String(projectId)] as Record<string, unknown> | undefined) : undefined;

    return {
      id,
      name: str(t.name) ?? '(untitled)',
      description: str(t.description),
      status: str(t.status),
      completed: t.status === 'completed' || Boolean(t.completed),
      dueDate: str(t.dueDate) ?? null,
      createdAt: str(t.createdAt) ?? str(t.dateCreated),
      updatedAt: str(t.updatedAt) ?? str(t.dateUpdated),
      projectId,
      projectName: str(project?.name) ?? str(tasklistMeta?.name),
      assigneeIds: idList(t.assigneeUserIds),
      followerIds: [...idList(t.changeFollowers), ...idList(t.commentFollowers), ...idList(t.completeFollowers)],
      url: `${this.base}/app/tasks/${id}`,
      workflowId: num(stage?.workflowId),
      stageId: num(stage?.stageId),
      parentTaskId: num(t.parentTaskId) ?? num((t.parentTask as Record<string, unknown> | undefined)?.id),
    };
  }

  private normaliseComment(c: Record<string, unknown>, taskId: number): TeamworkComment {
    const id = Number(c.id);
    return {
      id,
      taskId,
      authorId: num(c.postedByUserId) ?? num(c.postedBy) ?? null,
      // htmlBody preserves mention markup; body is the plain-text rendering. Keep both joined for matching.
      body: str(c.body) ?? '',
      htmlBody: str(c.htmlBody) ?? '',
      postedAt: str(c.postedDateTime) ?? str(c.dateLastEdited) ?? null,
      url: `${this.base}/app/tasks/${taskId}?c=${id}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Teamwork returns related people as [{id,type}], as bare ids, or as a CSV string depending on endpoint. */
function idList(v: unknown): number[] {
  if (!v) return [];
  if (typeof v === 'string') return v.split(',').map(Number).filter(Number.isFinite);
  if (!Array.isArray(v)) return [];
  return v
    .map((entry) => (typeof entry === 'object' && entry !== null ? Number((entry as Record<string, unknown>).id) : Number(entry)))
    .filter((n) => Number.isFinite(n) && n > 0);
}
