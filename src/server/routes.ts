import { Router } from 'express';
import { ConfigSchema, RecipientSchema } from '../config/schema.js';
import { getConfig, getRuns, setConfig } from '../config/store.js';
import { discoverHandles, listPeople, slugify } from '../teamwork/discovery.js';
import { userTokenFor } from '../slack/mentions.js';
import { runAndDeliver } from '../deliver.js';
import { makeClient, runScan } from '../pipeline.js';
import { ALL_RULES } from '../rules/index.js';
import type { Scheduler } from '../scheduler/index.js';
import { SlackClient } from '../slack/client.js';

export interface RouterDeps {
  teamworkToken: string;
  slackToken: string;
  scheduler: Scheduler;
}

export function buildRouter(deps: RouterDeps): Router {
  const router = Router();

  /**
   * Tokens are write-only: the UI shows whether one is in effect, never its value.
   * "In effect" must account for the environment, or a token set in .env reads as
   * missing and someone pastes a second copy into the store.
   */
  function redact(config: ReturnType<typeof getConfig>) {
    return {
      ...config,
      recipients: config.recipients.map(({ slackUserToken, ...rest }) => ({
        ...rest,
        hasSlackUserToken: Boolean(userTokenFor(rest.id, slackUserToken)),
        slackUserTokenSource: process.env[`SLACK_USER_TOKEN_${rest.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
          ? 'environment'
          : slackUserToken.trim().length > 0 ? 'dashboard' : null,
      })),
    };
  }

  router.get('/config', (_req, res) => {
    res.json({ config: redact(getConfig()), nextRun: deps.scheduler.nextRun });
  });

  router.put('/config', (req, res) => {
    const parsed = ConfigSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid config', issues: parsed.error.issues });
      return;
    }
    // A blank token from the UI means "leave it alone", not "erase it".
    const current = getConfig();
    const patch = { ...parsed.data };
    if (patch.recipients) {
      patch.recipients = patch.recipients.map((r) => {
        if (r.slackUserToken?.trim()) return r;
        const existing = current.recipients.find((c) => c.id === r.id);
        return { ...r, slackUserToken: existing?.slackUserToken ?? '' };
      });
    }

    const config = setConfig(patch);
    deps.scheduler.reschedule(); // config change must take effect without a restart
    res.json({ config: redact(config), nextRun: deps.scheduler.nextRun });
  });

  // Scanning comments for handle evidence is slow, so the map is built once and reused.
  let evidence: Awaited<ReturnType<typeof discoverHandles>> | null = null;

  router.get('/people', async (req, res) => {
    try {
      if (!deps.teamworkToken) throw new Error('TEAMWORK_API_TOKEN is not set');
      const config = getConfig();
      const client = makeClient(config, deps.teamworkToken);

      if (!evidence || req.query.refresh === '1') {
        evidence = discoverHandles(await client.recentTaskComments());
      }

      const people = await listPeople(client, evidence);
      res.json({ people, takenIds: getConfig().recipients.map((r) => r.id) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/recipients', (req, res) => {
    const config = getConfig();
    const parsed = RecipientSchema.partial({ id: true }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid recipient', issues: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    if (!input.teamworkUserId || !input.handles?.length) {
      res.status(400).json({ error: 'a Teamwork user and at least one @handle are required' });
      return;
    }
    if (config.recipients.some((r) => r.teamworkUserId === input.teamworkUserId)) {
      res.status(409).json({ error: 'that person is already a recipient' });
      return;
    }

    const id = input.id?.trim() || slugify(input.label ?? '', config.recipients.map((r) => r.id));
    const recipient = RecipientSchema.parse({ ...input, id });
    const next = setConfig({ recipients: [...config.recipients, recipient] });
    deps.scheduler.reschedule();
    res.json({ config: redact(next) });
  });

  router.delete('/recipients/:id', (req, res) => {
    const config = getConfig();
    const id = req.params.id;
    if (!config.recipients.some((r) => r.id === id)) {
      res.status(404).json({ error: 'no such recipient' });
      return;
    }
    const next = setConfig({ recipients: config.recipients.filter((r) => r.id !== id) });
    deps.scheduler.reschedule();
    res.json({ config: redact(next) });
  });

  router.get('/rules', (_req, res) => {
    const disabled = getConfig().disabledRules;
    res.json({
      rules: ALL_RULES.map((r) => ({ id: r.id, label: r.label, priority: r.priority, enabled: !disabled.includes(r.id) })),
    });
  });

  router.get('/status', async (_req, res) => {
    const config = getConfig();
    const [teamwork, slack] = await Promise.all([
      checkTeamwork(config, deps.teamworkToken),
      checkSlack(deps.slackToken, config),
    ]);
    res.json({ teamwork, slack, nextRun: deps.scheduler.nextRun, nextRuns: deps.scheduler.nextRuns, runs: getRuns().slice(0, 10) });
  });

  router.post('/preview', async (_req, res) => {
    try {
      if (!deps.teamworkToken) throw new Error('TEAMWORK_API_TOKEN is not set');
      const scan = await runScan(getConfig(), deps.teamworkToken);
      res.json({ scan: serialiseScan(scan) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/test-send', async (req, res) => {
    try {
      if (!deps.teamworkToken) throw new Error('TEAMWORK_API_TOKEN is not set');
      if (!deps.slackToken) throw new Error('SLACK_BOT_TOKEN is not set');
      const job = req.body?.job === 'digest' ? 'digest' : 'reminder';
      const only = typeof req.body?.recipientId === 'string' ? req.body.recipientId : null;
      // Sending to one person lets you test without DMing everyone.
      const base = getConfig();
      const config = only
        ? { ...base, recipients: base.recipients.map((r) => ({ ...r, enabled: r.id === only })) }
        : base;
      // Manual sends were silent, which made diagnosing a slow run impossible.
      const outcome = await runAndDeliver(config, deps.teamworkToken, deps.slackToken, job, 'manual',
        (m) => console.log(`[manual] ${m}`));
      res.json({ job, perRecipient: outcome.perRecipient, scan: outcome.scan ? serialiseScan(outcome.scan) : null });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

async function checkTeamwork(config: ReturnType<typeof getConfig>, token: string) {
  if (!token) return { ok: false, detail: 'TEAMWORK_API_TOKEN is not set' };
  try {
    const me = await makeClient(config, token).me();
    return { ok: true, detail: `${[me.firstName, me.lastName].filter(Boolean).join(' ')} (${me.id})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function checkSlack(token: string, config: ReturnType<typeof getConfig>) {
  if (!token) return { ok: false, detail: 'SLACK_BOT_TOKEN is not set', targets: [] };
  try {
    const slack = new SlackClient(token);
    const auth = await slack.authTest();
    const targets = [];
    for (const r of config.recipients) {
      if (r.slackTarget) {
        targets.push({ id: r.id, resolved: r.slackTarget, source: 'configured' });
      } else if (r.slackEmail) {
        const found = await slack.lookupUserByEmail(r.slackEmail);
        targets.push({ id: r.id, resolved: found, source: found ? 'email lookup' : 'not found' });
      } else {
        targets.push({ id: r.id, resolved: null, source: 'no target set' });
      }
    }
    return { ok: true, detail: `${auth.user} in ${auth.team}`, targets };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, targets: [] };
  }
}

/** Trim the scan to what the dashboard renders — full task objects are far more than the UI needs. */
function serialiseScan(scan: Awaited<ReturnType<typeof runScan>>) {
  return {
    stats: scan.stats,
    results: scan.results.map((r) => ({
      recipientId: r.recipient.id,
      label: r.recipient.label || r.identity.displayName,
      total: r.total,
      groups: r.groups.map((g) => ({
        ruleId: g.ruleId,
        label: g.label,
        items: g.items.map((i) => ({
          id: i.task.id,
          name: i.task.name,
          project: i.task.projectName ?? null,
          assignees: i.assigneeNames,
          dueDate: i.task.dueDate,
          detail: i.match.detail,
          link: i.match.link,
        })),
      })),
    })),
  };
}
