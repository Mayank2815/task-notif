# Teamwork → Slack task reminders

Two Slack DMs per weekday, per person:

- **Morning reminder** (10:00 by default) — the Teamwork tasks that need their attention,
  each a direct link, deep-linked to the specific comment when a comment triggered it.
- **Evening digest** (21:00 by default) — what they actually did today, shaped for
  reading out at the next day's standup: tasks they commented on (with any PR links
  pulled out), tasks completed, other edits, work that landed on them today, and who
  asked them something in Teamwork *and Slack* — each split into answered and still open.

Unanswered Slack mentions are carried into the next morning's reminder too, so a thread
you meant to reply to doesn't quietly disappear overnight.

## How it decides what to send

Every task in the workspace is put through two stages.

**Stage 1 — hard exclude.** A task where the person appears nowhere (not assigned, not
mentioned in any comment) can never appear. This is what keeps tasks that were assigned
to someone long ago and quietly dropped out of the reminder.

**Stage 2 — inclusion rules.** Whatever survives is included if it trips at least one rule:

| Rule | Fires when | Links to |
|---|---|---|
| `awaiting-response` | Task is **assigned to them**, a comment @-mentions them, and they haven't replied since | the comment |
| `action-requested` | Task is **assigned to someone else**, and a comment @-mentions them *with an ask* ("pls check", "can you review") | the comment |
| `overdue` | Task is assigned to them and the due date has arrived or passed | the task |

A task that trips several rules is reported once, under the lowest-numbered priority.

### Two things worth knowing

**Assignment is what separates rule A from rule B.** Teamwork automatically subscribes
anyone you @-mention as a comment follower, so "is a follower" is true for every mention
and cannot be used to tell the two apart.

**Mentions are matched on handle, not name.** Teamwork writes mentions as plain `@Handle`
text with no user ID attached, so the handle is the only reliable key. Matching is
word-boundary exact: `@PriyaS` will not match `@PriyaSha` or `@PriyaSin` — which
matters here, because three different Priyas share this workspace.

**A cc is not a request.** `Hi @DevK cc @PriyaS @NikhilB …` asks Dev for something
and merely copies the other two. Being named only inside a `cc`/`fyi`/`copying` list does
not surface the task. The cc list ends where prose resumes, so
`Done cc @NikhilB — separately @PriyaS can you confirm?` still counts as addressed to
Priya. Turn this off with `ignoreCcOnlyMentions: false` if you would rather see copies too.

## First run

Only the tokens need a shell. Everything else is done in the dashboard.

```bash
cp .env.example .env      # add TEAMWORK_API_TOKEN and SLACK_BOT_TOKEN
docker compose up -d      # or ./scripts/deploy.sh user@host
ssh -N -L 4310:127.0.0.1:4310 user@host   # if remote
```

Open `http://localhost:4310`, then **Recipients → + Add person**. Search Teamwork by name
or email, and the tool finds that person's `@handle` by scanning real comments for a
markdown mention that ties a handle to their user id. A green dot means the handle is
confirmed from live evidence; amber means it was guessed from their name and should be
verified before you rely on it.

Everything after that — schedule, days, rules, filters, adding and removing people, muting
threads — is dashboard-only. No file editing, no restart.

## Setup

```bash
npm install
npm --prefix dashboard install
cp .env.example .env      # then fill in the two tokens
```

### Teamwork token
Avatar (top right) → **Edit My Details** → **API & Mobile** → *Show your token*.
Used as HTTP Basic username with `x` as the password.

### Slack token
1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → *From scratch*
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `users:read`, `users:read.email`
3. **Install to Workspace**, copy the `xoxb-…` token

No `im:write` needed — `chat.postMessage` accepts a user ID as the channel and opens the
DM itself.

## Running

```bash
npm run dry-run         # what the morning reminder would contain; sends nothing
npm run digest-preview  # what tonight's digest would contain; sends nothing
npm run send-now        # send the reminder immediately
npm run send-now digest # send the digest immediately
npm run dev             # API + scheduler on :4310
npm test                # unit tests
```

For the dashboard in development, run `npm --prefix dashboard run dev` (port 5310, proxies
`/api` to 4310). In production `npm run build` compiles both and the server serves the
dashboard from `/`.

### Keeping it running

The scheduler lives in the server process, so that process must be alive at the moment a
reminder is due.

**On an always-on host (recommended).** A laptop is asleep at 09:00 more often than not.

```bash
./scripts/deploy.sh user@your-host          # syncs, builds, restarts, waits for health
ssh -N -L 4310:127.0.0.1:4310 user@your-host  # then open http://localhost:4310
```

Requires Docker and Docker Compose on the host. `data/` is a volume, so config and run
history survive redeploys. `.env` is copied separately and never deleted by the sync, so a
bad deploy cannot wipe the credentials.

**Volume ownership.** A mounted volume arrives with the host's ownership, which overrides
whatever the image chowned at build time — so a container running as a non-root user cannot
write its own store. `docker-entrypoint.sh` starts as root only long enough to `chown` the
data directory, then `su-exec`s to `node`. The app itself never runs as root. Verified: the
first build without this failed with `EACCES` on the very first write.

**On macOS (fallback).** `./scripts/install-launchd.sh` installs a launchd agent that
starts at login and restarts on crash. It only fires while the Mac is awake and logged in.

Either way, a restart inside the window still sends: on boot the scheduler checks whether
the slot was missed (`catchUpGraceMinutes`, 5 hours by default) and whether it was already
delivered, so you get it once, marked late, and never twice.

**A failed run retries rather than waiting for tomorrow.** A laptop waking at 09:00 often
has no network for the first minute, and the scan then fails outright. Retries run at 1, 3,
10 and 30 minutes — about the first three quarters of an hour — after which it gives up
until the next slot rather than hammering a real outage. Retried sends are marked late.
A failure during the scan is written to the run history too; previously it threw before any
bookkeeping, so a lost run left no trace in the dashboard at all.

### Deploying to an Oracle Cloud Always Free VM

Oracle's free tier gives a permanently-on VM rather than a trial or a sleeping
container, so nothing about this tool degrades: the process stays up, the 09:00 and
21:00 slots fire on time, the ✅ Done buttons keep working over Socket Mode, and
`data/` lives on a real disk.

**Create the VM.** Compute → Instances → Create. Ubuntu 22.04 or 24.04, shape
**VM.Standard.A1.Flex** (Ampere, "Always Free-eligible"). One core and 6 GB is plenty;
the free allowance is four cores and 24 GB. Paste `~/.ssh/id_rsa.pub` as the SSH key.
Leave the networking defaults — port 22 is open and nothing else needs to be, because
the dashboard is bound to loopback and reached through a tunnel.

If creation fails with **"Out of host capacity"**, that is the well-known free-tier ARM
squeeze, not a mistake on your part. Try another availability domain, then another
region.

**Then, from here:**

```bash
./scripts/provision-host.sh ubuntu@<public-ip>   # installs Docker, adds swap
./scripts/deploy.sh         ubuntu@<public-ip>   # builds, starts, waits for health
ssh -N -L 4310:127.0.0.1:4310 ubuntu@<public-ip> # then open http://localhost:4310
```

Two things the provisioning script handles that bite people on this shape specifically.
The Docker apt repo needs the architecture spelled out and Ampere is `arm64`, so the
usual copy-pasted `arch=amd64` line installs nothing. And the free shapes ship with no
swap at all, which lets the TypeScript and Vite builds get OOM-killed with nothing in
the output but `Killed` — 2 GB of swap on a 47 GB boot volume removes the whole class
of problem.

### Deploying to Render

`render.yaml` is a blueprint: point Render at the repo and it builds from the Dockerfile.
Two settings are not optional:

- **A paid instance.** Free services sleep after 15 minutes idle. Nothing requests the app
  at 09:00, so a sleeping instance simply never sends. The scheduler is the process.
- **A persistent disk mounted at `/app/data`.** Without it, config, run history and the
  threads marked Done are wiped on every deploy.

Set every `sync: false` variable in the Render dashboard. On Render the dashboard is
reachable at the service URL, and **it has no authentication** — see below.

### The dashboard has no authentication

It is bound to `127.0.0.1` in `docker-compose.yml` deliberately — anyone who could reach it
could read your tasks and trigger sends. Reach it through an SSH tunnel rather than
publishing the port. If you ever do expose it, put a reverse proxy with auth in front.

### macOS launchd gotcha

If the agent registers but never runs — `launchctl list` shows `-` and exit code `78`, with
nothing in the logs — the cause is almost always where the log files live. launchd opens
them itself, before the process starts, and it has no access to the folders macOS protects:
Desktop, Documents and Downloads. A checkout sitting in one of those gets its log files
stamped with a `com.apple.macl` extended attribute (`xattr <logfile>`), launchd cannot open
them to attach the job's output, and the job dies before producing a single line.

Deleting the stale files clears it for a while, but the attribute comes back. The durable
fix is to keep the logs outside the protected folders, so the agent writes to
`~/Library/Logs/task-notif/` regardless of where the checkout lives. `install-launchd.sh`
sets that up, and verifies the job is actually running rather than reporting success blindly.

## Configuration

Everything except the two tokens is edited in the dashboard and stored in
`data/store.json`. Tokens live only in `.env`, which is gitignored.

| Setting | Meaning |
|---|---|
| `jobs.reminder.time` / `jobs.digest.time` | When each send fires, in `timezone` |
| `jobs.*.daysOfWeek` | Luxon weekday numbers, 1 = Monday. Default Mon–Fri |
| `jobs.*.enabled` | Turn one send off without affecting the other |
| `lookbackDays` | How far back comments are swept. Bounds the API cost |
| `includeDueToday` | Whether tasks due today count as overdue |
| `ignoreCcOnlyMentions` | Skip comments that name you only in a cc list. On by default |
| `sendWhenEmpty` | Send a "nothing pending" note instead of staying quiet |
| `recipients[].handles` | The `@handles` that mean this person — the key signal |
| `recipients[].mirrorOf` | Send this person a copy of another recipient's list instead of their own |
| `recipients[].slackUserToken` | Optional `xoxp-`. `SLACK_USER_TOKEN_<ID>` in the environment wins when both are set |
| `slackBroadcastThreshold` | Drop messages tagging more people than this |
| `slackPendingDays` | How far back unanswered Slack threads are carried into the morning |
| `catchUpGraceMinutes` | How late a missed slot may still be delivered |
| `dismissals` | Threads marked done. Permanent; edit the file to reverse one |

The store file holds Slack user tokens when they are entered in the dashboard, so it is
written `0600`. Prefer the environment variables if you would rather keep secrets out of
it entirely — the dashboard then shows the token as `set via environment` and refuses to
overwrite it.

### Finding someone's handle

Handles are not exposed by the Teamwork API. The reliable way is to find a markdown
mention in a real comment — they look like `[@ArjunR](/app/people/400002)`, which ties the
handle to the user ID. `npm run probe` dumps live API shapes if you need to dig.

## Adding a new rule

1. Create `src/rules/my-rule.ts` exporting a `Rule`:

```ts
export const myRule: Rule = {
  id: 'my-rule',
  label: 'Heading shown in Slack',
  priority: 4,                    // lower wins when one task trips several rules
  evaluate(task, ctx) {
    if (!somethingIsTrue) return null;
    return { ruleId: this.id, detail: 'why this surfaced', link: task.url };
  },
};
```

2. Add it to `ALL_RULES` in `src/rules/index.ts`.

That's the whole contract. `ctx` gives you the person's identity, the config, the current
time, the task's comments oldest-first, and a user lookup map. Helpers in
`src/rules/shared.ts` cover the common cases — `lastUnansweredMention`, `looksLikeRequest`,
`isAssignedToMe`. Rules can be toggled off from the dashboard without a code change.

## Design notes

**One sweep, many people.** Comments are fetched once per run via the workspace-wide
comments endpoint and shared across every recipient, rather than one request per task.
A run covering two people costs roughly 40 API calls and about 30 seconds.

**Rate limits.** Every request is serialised through a 400 ms gate (~150/min), and 429s
and 5xxs back off exponentially, honouring `Retry-After`.

**Teamwork API gotchas found the hard way.** The v3 tasks endpoint silently ignores
`assigneeUserIds` and returns everything — the parameter it honours is
`responsiblePartyIds`. A task's project ID lives at `tasklist.meta.projectId`, not at the
top level.

**Storage.** Config and run history sit in one JSON file written atomically (temp file
plus rename), so a crash mid-write cannot truncate it. Run history is capped at 50 entries.

## Layout

```
src/
  teamwork/     API client, mention matching, types
  rules/        one file per rule + the registry
  slack/        Web API client, Block Kit message builder
  scheduler/    timezone-aware next-fire calculation, catch-up on restart
  server/       Express API for the dashboard
  cli/          probe (API discovery), dry-run (preview without sending)
  __tests__/    scheduler maths, mention matching, rule boundaries
dashboard/      Vite + React config panel, dark
```

## The evening digest

Built from two sources, both scoped to midnight-to-now in your timezone:

- **Your comments today** — the task, what you wrote, and any pull-request links pulled
  out of the text. Recognises GitHub, GitLab, Bitbucket, Azure DevOps and AWS CodeSuite
  URL shapes.
- **The activity feed** — tasks you completed, plus other edits you made. Comment activity
  is dropped here because the comments section already covers it; the two are told apart
  by `item.type`, since a comment activity's `itemId` is the comment's, not the task's.

It also lists mentions of you from today split into **answered** and **still open**, and
any task assigned to you that was created today — the ad-hoc work standup asks about.

Two labels are applied by keyword and are hints, not judgements: `dev done` (from phrases
like "dev done", "PR raised", "ready for QA") and `blocker` (from "blocked", "waiting on",
"need access"). They can misfire on a comment that merely *describes* a blockage, such as
a root-cause analysis. Adjust `DONE_MARKERS` and `BLOCKER_MARKERS` in `src/digest.ts`.

**What it deliberately does not do** is write a narrative. There is no LLM in this
pipeline, so the digest reports facts and leaves the sentence-making to you.

## Slack mentions

Finding mentions needs a **user token** (`xoxp-`), not the bot token. `search.messages`
rejects bot tokens outright, and the only alternative — the bot joining every channel —
isn't practical. A user token searches everything that person can already see, with no
channel joins.

A user token is also strictly personal: it can only see one person's Slack. So each
recipient needs their own, held in `.env` as `SLACK_USER_TOKEN_<RECIPIENT_ID>`. Someone
without a token simply gets no Slack section — deliberately, because a list built from a
colleague's view of the workspace would silently omit their DMs and private channels while
looking complete.

**User Token Scopes** required: `search:read` to find the mentions, plus `channels:history`,
`groups:history`, `im:history` and `mpim:history` to read the conversation and tell whether
they replied.

### How answered/unanswered is decided

- **DMs** — any message they sent after the mention counts, because that is how people
  answer a DM.
- **Channels** — only a reply *in that thread* counts. A later message in a busy channel is
  almost always about something else.

A channel message that mentions them with no thread under it therefore reads as unanswered.

### Things learned from the live API

- Slack's search is fuzzy: querying `@handle` returns near-misses, so results are re-filtered
  on the literal `<@UID>` token before anything is reported.
- A match object has no `thread_ts` field — the thread root is a query parameter on the
  `permalink`.
- `slackBroadcastThreshold` (default 5) drops messages tagging more people than that. Without
  it a daily standup bot that @-mentions seven people appears in the digest every single day.

### Marking something done

Every task row and every Slack row carries a **✅ Done** button. Pressing it stops that
item appearing in any future message — morning or evening.

Tasks are keyed `task:<id>` and Slack threads `channelId:threadTimestamp`, so the two can
never collide.

**It hides the item until someone says something new.** The dismissal records the moment
the button was pressed; a Teamwork comment or a Slack mention after that moment brings the
item straight back. Pressing Done again re-hides it from the new moment on. That way
finishing with a thread is one click, but a colleague reopening it is not silently lost.

To drop an item permanently, delete its entry from the `dismissals` array in
`data/store.json` — nothing will revive it once the record is gone.

### Marking a thread done

Every Slack row carries a **✅ Done** button. It applies to *that one thread*, keyed on
`channelId:threadTimestamp` — other threads in the same channel keep coming through. It is
permanent and deliberately has no undo in the dashboard: pressing it is a judgement that
the thread no longer needs you, and one resurfacing weeks later would be worse than
useless.

If you ever need to reverse one, delete its entry from the `dismissals` array in
`data/store.json` and restart. Each entry records only the recipient, the thread key and
when — no message content.

### Why a colleague replying does not hide a thread

When a message tags several people, the row is annotated with who else replied
(`↩️ Leo replied`) and sorted below untouched threads — but it is never dropped.

These two are indistinguishable without reading intent:

| Message | A colleague replies | Does it still need you? |
|---|---|---|
| `hi @Leo @Priya please check this BUG` | Leo replies | No — one person checking is enough |
| `Hi @Kiran @Priya can you please raise the PR` | Kiran replies | Yes — both were asked |

Same shape, opposite answers. There is no LLM in this pipeline to judge which is which, so
guessing would silently drop things that genuinely needed a reply. The row is surfaced with
the fact attached, and the Mute button is the reliable way to silence one.

`slackHideWhenCoMentionedReplied: true` opts into dropping them if you prefer.
