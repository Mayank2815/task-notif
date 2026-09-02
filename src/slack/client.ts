export class SlackError extends Error {
  constructor(message: string, readonly slackError?: string) {
    super(message);
    this.name = 'SlackError';
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackClient {
  constructor(private readonly token: string) {}

  /**
   * Slack accepts JSON only on methods that take structured payloads. Lookup methods
   * (users.lookupByEmail, auth.test) reject a JSON body with invalid_arguments and must
   * be form-encoded.
   */
  private async call<T extends SlackResponse>(
    method: string,
    body: Record<string, unknown>,
    encoding: 'json' | 'form' = 'form',
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const isJson = encoding === 'json';
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': isJson
            ? 'application/json; charset=utf-8'
            : 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: isJson
          ? JSON.stringify(body)
          : new URLSearchParams(
              Object.entries(body).map(
                ([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)],
              ),
            ).toString(),
      });

      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 5);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }

      const data = (await res.json()) as T;
      if (!data.ok) throw new SlackError(`slack ${method} failed: ${data.error ?? 'unknown'}`, data.error);
      return data;
    }
    throw new SlackError(`slack ${method} rate limited after retries`);
  }

  async authTest(): Promise<{ user: string; team: string; botId: string }> {
    const r = await this.call<SlackResponse & { user: string; team: string; bot_id: string }>('auth.test', {});
    return { user: r.user, team: r.team, botId: r.bot_id };
  }

  /** Resolving by email avoids asking anyone to dig their member ID out of Slack. */
  async lookupUserByEmail(email: string): Promise<string | null> {
    try {
      const r = await this.call<SlackResponse & { user: { id: string } }>('users.lookupByEmail', { email });
      return r.user.id;
    } catch (err) {
      if ((err as SlackError).slackError === 'users_not_found') return null;
      throw err;
    }
  }

  /**
   * Every member, as a userId -> display name map.
   * Slack writes mentions as raw "<@U123>" tokens, so without this the digest shows ids.
   */
  async userDirectory(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor: string | undefined;

    for (let page = 0; page < 20; page++) {
      const r = await this.call<SlackResponse & {
        members: Record<string, unknown>[];
        response_metadata?: { next_cursor?: string };
      }>('users.list', { limit: 1000, ...(cursor ? { cursor } : {}) });

      for (const m of r.members ?? []) {
        const profile = (m.profile ?? {}) as Record<string, unknown>;
        const name =
          str(profile.display_name) ?? str(profile.real_name) ?? str(m.real_name) ?? str(m.name);
        if (m.id && name) map.set(String(m.id), name);
      }

      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }

    return map;
  }

  /** postMessage opens the DM itself when given a user ID, so no im:write scope is needed. */
  async postMessage(channel: string, text: string, blocks: unknown[]): Promise<string> {
    const r = await this.call<SlackResponse & { ts: string }>(
      'chat.postMessage',
      { channel, text, blocks, unfurl_links: false, unfurl_media: false },
      'json',
    );
    return r.ts;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
