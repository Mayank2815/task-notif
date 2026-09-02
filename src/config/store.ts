import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StoreSchema, type Config, type Dismissal, type RunRecord, type StoreData } from './schema.js';

const MAX_RUN_HISTORY = 50; // enough to debug a bad week without unbounded file growth

const dataDir = resolve(process.env.DATA_DIR ?? './data');
const filePath = join(dataDir, 'store.json');

/** Older stores kept a single reminderTime/daysOfWeek at the top level. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const config = raw.config as Record<string, unknown> | undefined;
  if (!config || config.jobs) return raw;

  const time = typeof config.reminderTime === 'string' ? config.reminderTime : '10:00';
  const daysOfWeek = Array.isArray(config.daysOfWeek) ? config.daysOfWeek : [1, 2, 3, 4, 5];
  config.jobs = {
    reminder: { time, daysOfWeek, enabled: true },
    digest: { time: '21:00', daysOfWeek, enabled: true },
  };
  delete config.reminderTime;
  delete config.daysOfWeek;
  return raw;
}

function read(): StoreData {
  if (!existsSync(filePath)) return StoreSchema.parse({});
  try {
    return StoreSchema.parse(migrate(JSON.parse(readFileSync(filePath, 'utf8'))));
  } catch (err) {
    // A corrupt store must not brick the service — fall back to defaults, leave the bad file in place.
    console.error(`[store] unreadable, using defaults: ${(err as Error).message}`);
    return StoreSchema.parse({});
  }
}

/** Write to a temp file then rename, so a crash mid-write cannot truncate the store. */
function write(data: StoreData): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  // 0600: the store can hold Slack user tokens, which read a person's DMs.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
}

let cache: StoreData | null = null;

function load(): StoreData {
  if (!cache) cache = read();
  return cache;
}

export function getConfig(): Config {
  return load().config;
}

export function setConfig(patch: Partial<Config>): Config {
  const data = load();
  const next = StoreSchema.parse({ ...data, config: { ...data.config, ...patch } });
  cache = next;
  write(next);
  return next.config;
}

export function getRuns(): RunRecord[] {
  return load().runs;
}

export function recordRun(run: RunRecord): void {
  const data = load();
  const next = StoreSchema.parse({ ...data, runs: [run, ...data.runs].slice(0, MAX_RUN_HISTORY) });
  cache = next;
  write(next);
}

/**
 * Threads marked done, permanently. Marking one done is a judgement that it no longer
 * needs this person, and that does not expire — a thread reappearing weeks later would
 * be worse than useless.
 */
export function getDismissals(recipientId?: string): Dismissal[] {
  return load().dismissals.filter((d) => !recipientId || d.recipientId === recipientId);
}

export function addDismissal(dismissal: Dismissal): void {
  const data = load();
  const others = data.dismissals.filter((d) => !(d.recipientId === dismissal.recipientId && d.key === dismissal.key));
  const next = StoreSchema.parse({ ...data, dismissals: [dismissal, ...others].slice(0, 500) });
  cache = next;
  write(next);
}

/**
 * A mounted volume often arrives owned by root, overriding whatever the Dockerfile
 * chowned. That turns into a silent crash-loop on the first write, so check up front
 * and say exactly what is wrong.
 */
export function assertDataDirWritable(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, '.write-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (err) {
    throw new Error(
      `DATA_DIR (${dataDir}) is not writable: ${(err as Error).message}\n` +
      `The process runs as uid ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}. ` +
      `If this is a mounted volume, its owner overrides the image's — chown it to that uid.`,
    );
  }
}

export const storePath = filePath;
