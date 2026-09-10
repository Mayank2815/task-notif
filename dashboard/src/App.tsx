import { useCallback, useEffect, useState } from 'react';
import type { Config, DismissalRow, Job, JobKind, PersonSuggestion, Preview, Recipient, RuleInfo, Status } from './types.js';

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
];

const TIMEZONES = ['Asia/Kolkata', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney'];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as T;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [dismissals, setDismissals] = useState<DismissalRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonSuggestion[]>([]);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, s, r, d] = await Promise.all([
        api<{ config: Config }>('/config'),
        api<Status>('/status'),
        api<{ rules: RuleInfo[] }>('/rules'),
        api<{ dismissals: DismissalRow[] }>('/dismissals'),
      ]);
      setConfig(c.config);
      setStatus(s);
      setRules(r.rules);
      setDismissals(d.dismissals);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const patch = (p: Partial<Config>) => setConfig((c) => (c ? { ...c, ...p } : c));

  async function save() {
    if (!config) return;
    setBusy('save'); setError(null);
    try {
      const r = await api<{ config: Config }>('/config', { method: 'PUT', body: JSON.stringify(config) });
      setConfig(r.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  async function run(kind: 'preview' | 'test-send', job: JobKind = 'reminder', recipientId?: string) {
    const key = recipientId ? `${kind}:${job}:${recipientId}` : `${kind}:${job}`;
    setBusy(key); setError(null);
    try {
      const r = await api<{ scan: Preview | null }>(`/${kind}`, { method: 'POST', body: JSON.stringify({ job, recipientId }) });
      if (r.scan) setPreview(r.scan);
      if (kind === 'test-send') await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  /** Loaded once; the list is ~100 people, so filtering happens in the browser. */
  async function loadPeople() {
    if (people.length > 0) return;
    setBusy('people'); setError(null);
    try {
      setPeople((await api<{ people: PersonSuggestion[] }>('/people')).people);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  /** Matches name, email or @handle, so typing "@tar" finds Nikhil. */
  function matches(p: PersonSuggestion, query: string): boolean {
    const needle = query.trim().toLowerCase().replace(/^@/, '');
    if (!needle) return true;
    return p.name.toLowerCase().includes(needle)
      || p.email.toLowerCase().includes(needle)
      || p.candidates.some((c) => c.handle.toLowerCase().includes(needle));
  }

  async function addRecipient(person: PersonSuggestion) {
    setBusy(`add:${person.id}`); setError(null);
    try {
      const handles = person.candidates.slice(0, 1).map((c) => c.handle);
      const r = await api<{ config: Config }>('/recipients', {
        method: 'POST',
        body: JSON.stringify({
          label: person.name, teamworkUserId: person.id, handles,
          slackEmail: person.email, enabled: true, mirrorOf: null,
        }),
      });
      setConfig(r.config);
      setAdding(false); setSearch(''); // keep the loaded list so reopening is instant
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  /**
   * The way back for a Done pressed longer ago than Slack's undo window allows. The
   * item returns to the next reminder; if the window happens to still be open, the
   * Slack message is put back too.
   */
  async function undoDismissal(d: DismissalRow) {
    setBusy(`undo:${d.recipientId}:${d.key}`);
    setError(null);
    try {
      await api('/dismissals/undo', {
        method: 'POST',
        body: JSON.stringify({ recipientId: d.recipientId, key: d.key }),
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removeRecipient(r: Recipient) {
    if (!window.confirm(`Remove ${r.label || r.id}? They will stop receiving reminders.`)) return;
    setBusy(`del:${r.id}`); setError(null);
    try {
      const res = await api<{ config: Config }>(`/recipients/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      setConfig(res.config);
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  if (!config) return <div className="wrap"><p className="muted">Loading…{error && <span className="err"> {error}</span>}</p></div>;

  return (
    <div className="wrap">
      <header className="top">
        <h1>Teamwork → Slack reminders</h1>
        <span className="next">
          {status?.nextRun ? `Next run ${new Date(status.nextRun).toLocaleString()}` : 'Scheduling disabled'}
        </span>
      </header>

      {error && <div className="card err">{error}</div>}

      <section className="card">
        <h2>Connections</h2>
        <div className="status">
          <span className={`dot ${status?.teamwork.ok ? 'ok' : 'bad'}`} />
          <span className="label">Teamwork</span>
          <span className="detail">{status?.teamwork.detail ?? '—'}</span>
        </div>
        <div className="status">
          <span className={`dot ${status?.slack.ok ? 'ok' : 'bad'}`} />
          <span className="label">Slack</span>
          <span className="detail">{status?.slack.detail ?? '—'}</span>
        </div>
        {status?.slack.targets.map((t) => (
          <div className="status" key={t.id}>
            <span className={`dot ${t.resolved ? 'ok' : 'bad'}`} />
            <span className="label">DM → {t.id}</span>
            <span className="detail">{t.resolved ?? 'unresolved'} <span className="pill">{t.source}</span></span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Schedule</h2>
        <div className="grid">
          <label className="field">Timezone
            <select value={config.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </label>
          <label className="field">Lookback (days)
            <input type="number" min={1} max={365} value={config.lookbackDays}
              onChange={(e) => patch({ lookbackDays: Number(e.target.value) })} />
          </label>
          <label className="field">Undo window (minutes)
            <input type="number" min={1} max={1440} value={config.undoWindowMinutes}
              onChange={(e) => patch({ undoWindowMinutes: Number(e.target.value) })} />
          </label>
          <label className="field">Teamwork site
            <input value={config.teamworkSiteUrl} onChange={(e) => patch({ teamworkSiteUrl: e.target.value })} />
          </label>
        </div>

        {(['reminder', 'digest'] as JobKind[]).map((kind) => {
          const job = config.jobs[kind];
          const setJob = (p: Partial<Job>) => patch({ jobs: { ...config.jobs, [kind]: { ...job, ...p } } });
          return (
            <div className="recipient" key={kind} style={{ marginTop: 16 }}>
              <div className="head">
                <strong>{kind === 'reminder' ? '📋 Morning reminder — what needs you' : '🌙 Evening digest — what you did'}</strong>
                <label className="toggle">
                  <input type="checkbox" checked={job.enabled} onChange={(e) => setJob({ enabled: e.target.checked })} />
                  enabled
                </label>
              </div>
              <div className="grid">
                <label className="field">Time
                  <input type="time" value={job.time} onChange={(e) => setJob({ time: e.target.value })} />
                </label>
                <div className="field">Next run
                  <div className="muted" style={{ paddingTop: 9 }}>
                    {status?.nextRuns?.[kind] ? new Date(status.nextRuns[kind]!).toLocaleString() : '—'}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="days">
                  {DAYS.map((d) => (
                    <span key={d.n}
                      className={`day ${job.daysOfWeek.includes(d.n) ? 'on' : ''}`}
                      onClick={() => setJob({
                        daysOfWeek: job.daysOfWeek.includes(d.n)
                          ? job.daysOfWeek.filter((x) => x !== d.n)
                          : [...job.daysOfWeek, d.n].sort(),
                      })}>{d.label}</span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        <div style={{ marginTop: 18, display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          <label className="toggle">
            <input type="checkbox" checked={config.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            Scheduler enabled
          </label>
          <label className="toggle">
            <input type="checkbox" checked={config.sendWhenEmpty} onChange={(e) => patch({ sendWhenEmpty: e.target.checked })} />
            Send when nothing is pending
          </label>
          <label className="toggle">
            <input type="checkbox" checked={config.includeDueToday} onChange={(e) => patch({ includeDueToday: e.target.checked })} />
            Count tasks due today as overdue
          </label>
          <label className="toggle">
            <input type="checkbox" checked={config.ignoreCcOnlyMentions}
              onChange={(e) => patch({ ignoreCcOnlyMentions: e.target.checked })} />
            Ignore cc-only mentions
          </label>
        </div>
      </section>

      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Recipients</h2>
          <button className="secondary" onClick={() => { setAdding(!adding); if (!adding) void loadPeople(); }}>
            {adding ? 'Cancel' : '+ Add person'}
          </button>
        </div>

        {adding && (() => {
          const existing = new Set(config.recipients.map((r) => r.teamworkUserId));
          const shown = people.filter((p) => matches(p, search)).slice(0, 40);
          return (
            <div className="recipient" style={{ borderColor: 'var(--accent)' }}>
              <label className="field" style={{ marginBottom: 12 }}>
                Search {people.length > 0 ? `${people.length} Teamwork people` : 'Teamwork people'} — by name, email or @handle
                <input autoFocus value={search} placeholder="e.g. Nikhil, @nik, nikhil@…"
                  onChange={(e) => setSearch(e.target.value)} />
              </label>

              {busy === 'people' && (
                <p className="muted">Loading people and scanning comments for their @handles — a few seconds, once.</p>
              )}

              <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                {shown.map((p) => {
                  const already = existing.has(p.id);
                  const best = p.candidates[0];
                  const tone = best?.confidence === 'confirmed' ? 'ok' : best?.confidence === 'seen' ? 'ok' : 'bad';
                  return (
                    <div className="status" key={p.id}>
                      <span className={`dot ${tone}`} />
                      <span className="label" style={{ minWidth: 170 }}>{p.name}</span>
                      <span className="detail" style={{ flex: 1 }}>
                        {p.email}
                        {best ? (
                          <> · <span className="pill">@{best.handle}</span> {
                            best.confidence === 'confirmed' ? 'confirmed'
                              : best.confidence === 'seen' ? `seen ${best.count}×`
                              : <span className="err">guessed — verify</span>
                          }</>
                        ) : <> · <span className="err">no handle</span></>}
                      </span>
                      <button onClick={() => void addRecipient(p)}
                        disabled={busy !== null || already || !best}>
                        {already ? 'Added' : busy === `add:${p.id}` ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                  );
                })}
              </div>

              {busy !== 'people' && shown.length === 0 && (
                <p className="muted">No one matches “{search}”.</p>
              )}
              {shown.length === 40 && <p className="muted">Showing the first 40 — keep typing to narrow it.</p>}
            </div>
          );
        })()}

        {config.recipients.length === 0 && !adding && (
          <p className="muted">Nobody configured yet. Add a person to start sending reminders.</p>
        )}

        {config.recipients.map((r, i) => {
          const setR = (p: Partial<Recipient>) => {
            const next = [...config.recipients];
            next[i] = { ...r, ...p };
            patch({ recipients: next });
          };
          return (
            <div className="recipient" key={r.id}>
              <div className="head">
                <strong>{r.label || r.id} <span className="pill">{r.id}</span></strong>
                <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <label className="toggle">
                    <input type="checkbox" checked={r.enabled} onChange={(e) => setR({ enabled: e.target.checked })} />
                    enabled
                  </label>
                  <button className="secondary" onClick={() => void run('test-send', 'reminder', r.id)} disabled={busy !== null}>
                    {busy === `test-send:reminder:${r.id}` ? 'Sending…' : 'Test'}
                  </button>
                  <button className="secondary" onClick={() => void removeRecipient(r)} disabled={busy !== null}>
                    {busy === `del:${r.id}` ? 'Removing…' : 'Remove'}
                  </button>
                </span>
              </div>
              <div className="grid">
                <label className="field">Display name
                  <input value={r.label} onChange={(e) => setR({ label: e.target.value })} />
                </label>
                <label className="field">Teamwork user ID
                  <input type="number" value={r.teamworkUserId} onChange={(e) => setR({ teamworkUserId: Number(e.target.value) })} />
                </label>
                <label className="field">Teamwork @handles (comma separated)
                  <input value={r.handles.join(', ')}
                    onChange={(e) => setR({ handles: e.target.value.split(',').map((h) => h.trim()).filter(Boolean) })} />
                </label>
                <label className="field">Slack email
                  <input value={r.slackEmail} onChange={(e) => setR({ slackEmail: e.target.value })} />
                </label>
                <label className="field">Slack ID (overrides email)
                  <input value={r.slackTarget} placeholder="U01ABCDEF" onChange={(e) => setR({ slackTarget: e.target.value })} />
                </label>
                <label className="field">
                  Slack user token {r.hasSlackUserToken
                    ? <span className="pill">set via {r.slackUserTokenSource}</span>
                    : <span className="muted">not set</span>}
                  <input type="password" value={r.slackUserToken ?? ''}
                    disabled={r.slackUserTokenSource === 'environment'}
                    placeholder={r.slackUserTokenSource === 'environment' ? 'set in .env — edit there' : r.hasSlackUserToken ? 'leave blank to keep' : 'xoxp-… (optional)'}
                    onChange={(e) => setR({ slackUserToken: e.target.value })} />
                </label>
                <label className="field">Send a copy of (instead of their own list)
                  <select value={r.mirrorOf ?? ''} onChange={(e) => setR({ mirrorOf: e.target.value || null })}>
                    <option value="">— their own list —</option>
                    {config.recipients.filter((o) => o.id !== r.id && !o.mirrorOf).map((o) => (
                      <option key={o.id} value={o.id}>{o.label || o.id}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Slack mentions</h2>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 16 }}>
          <label className="toggle">
            <input type="checkbox" checked={config.slackMentionsEnabled}
              onChange={(e) => patch({ slackMentionsEnabled: e.target.checked })} />
            Include Slack mentions
          </label>
          <label className="toggle">
            <input type="checkbox" checked={config.slackIgnoreCcOnly}
              onChange={(e) => patch({ slackIgnoreCcOnly: e.target.checked })} />
            Ignore Slack cc-only mentions
          </label>
          <label className="toggle">
            <input type="checkbox" checked={config.slackHideWhenCoMentionedReplied}
              onChange={(e) => patch({ slackHideWhenCoMentionedReplied: e.target.checked })} />
            Hide threads a tagged colleague answered
          </label>
        </div>
        <div className="grid">
          <label className="field">Drop messages tagging more than
            <input type="number" min={0} max={50} value={config.slackBroadcastThreshold}
              onChange={(e) => patch({ slackBroadcastThreshold: Number(e.target.value) })} />
          </label>
          <label className="field">Carry unanswered threads forward (days)
            <input type="number" min={1} max={30} value={config.slackPendingDays}
              onChange={(e) => patch({ slackPendingDays: Number(e.target.value) })} />
          </label>
          <label className="field">Late-delivery grace (minutes)
            <input type="number" min={5} max={1440} value={config.catchUpGraceMinutes}
              onChange={(e) => patch({ catchUpGraceMinutes: Number(e.target.value) })} />
          </label>
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          <label className="toggle">
            <input type="checkbox" checked={config.standupSummaryEnabled}
              onChange={(e) => patch({ standupSummaryEnabled: e.target.checked })} />
            Let Gemini write the stand-up summary
          </label>
          <label className="toggle">
            <input type="checkbox" checked={config.standupSummaryIncludeDmText}
              onChange={(e) => patch({ standupSummaryIncludeDmText: e.target.checked })} />
            Send DM text to Gemini too
          </label>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          With Gemini off, the summary is assembled locally from the same facts — no network, no data leaving the host.
        </p>
      </section>

      <section className="card">
        <h2>Rules</h2>
        {rules.map((rule) => (
          <div className="status" key={rule.id}>
            <label className="toggle">
              <input type="checkbox" checked={!config.disabledRules.includes(rule.id)}
                onChange={(e) => patch({
                  disabledRules: e.target.checked
                    ? config.disabledRules.filter((d) => d !== rule.id)
                    : [...config.disabledRules, rule.id],
                })} />
              <span className="label">{rule.label}</span>
            </label>
            <span className="detail"><span className="pill">{rule.id}</span></span>
          </div>
        ))}
      </section>

      <div className="actions" style={{ marginBottom: 24 }}>
        <button onClick={save} disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
        <button className="secondary" onClick={() => run('preview')} disabled={busy !== null}>
          {busy === 'preview:reminder' ? 'Scanning…' : 'Preview reminder'}
        </button>
        <button className="secondary" onClick={() => run('test-send', 'reminder')} disabled={busy !== null}>
          {busy === 'test-send:reminder' ? 'Sending…' : 'Send reminder now'}
        </button>
        <button className="secondary" onClick={() => run('test-send', 'digest')} disabled={busy !== null}>
          {busy === 'test-send:digest' ? 'Sending…' : 'Send digest now'}
        </button>
        {saved && <span className="muted">Saved.</span>}
      </div>

      {dismissals.length > 0 && (
        <section className="card">
          <h2>Marked done</h2>
          <p className="muted" style={{ marginTop: -8 }}>
            Hidden from reminders until someone says something new on them. Bring one back
            at any time — Slack's own Undo button only lasts {config?.undoWindowMinutes ?? 15} minutes.
          </p>
          <div className="runs">
            {dismissals.map((d) => (
              <div key={`${d.recipientId}:${d.key}`}>
                <span className="pill">{d.kind === 'task' ? 'task' : 'slack'}</span>
                <span>{d.label || d.key}</span>
                <span className="muted">
                  {d.recipientLabel} · {new Date(d.at).toLocaleString()}
                  {d.undoOpen && ' · undo still open in Slack'}
                </span>
                <button
                  className="secondary"
                  onClick={() => void undoDismissal(d)}
                  disabled={busy !== null}
                >
                  {busy === `undo:${d.recipientId}:${d.key}` ? 'Undoing…' : 'Undo'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {status && status.runs.length > 0 && (
        <section className="card">
          <h2>Recent runs</h2>
          <div className="runs">
            {status.runs.map((r) => (
              <div key={r.at}>
                <span className={`dot ${r.ok ? 'ok' : 'bad'}`} style={{ marginTop: 6 }} />
                <span>{new Date(r.at).toLocaleString()}</span>
                <span className="pill">{r.job ?? 'reminder'}</span>
                <span className="pill">{r.trigger}</span>
                <span className="muted">{r.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {preview && (
        <section className="card">
          <h2>Preview</h2>
          <p className="muted" style={{ marginTop: -8 }}>
            {preview.stats.commentsSwept} comments swept · {preview.stats.tasksIndexed} tasks indexed · {(preview.stats.durationMs / 1000).toFixed(1)}s
          </p>
          {preview.results.map((r) => (
            <div key={r.recipientId} style={{ marginTop: 20 }}>
              <strong>{r.label}</strong> <span className="pill">{r.total} tasks</span>
              {r.total === 0 && <p className="muted">Nothing pending.</p>}
              {r.groups.map((g) => (
                <div key={g.ruleId}>
                  <div className="group-head">{g.label} ({g.items.length})</div>
                  {g.items.map((item) => (
                    <div className={`item ${g.ruleId}`} key={item.id}>
                      <a href={item.link} target="_blank" rel="noreferrer">{item.name}</a>
                      <div className="meta">
                        {item.project ?? '—'} · {item.assignees.length ? item.assignees.join(', ') : 'unassigned'}
                        {item.dueDate ? ` · due ${item.dueDate}` : ''}
                      </div>
                      <div className="why">{item.detail}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
