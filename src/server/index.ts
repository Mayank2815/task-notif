import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDataDirWritable } from '../config/store.js';
import { Scheduler } from '../scheduler/index.js';
import { basicAuth } from './auth.js';
import { SlackSocket } from '../slack/socket.js';
import { buildRouter } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
// Render and most PaaS hosts inject PORT; 4310 is the local default.
const port = Number(process.env.PORT ?? 4310);
const teamworkToken = process.env.TEAMWORK_API_TOKEN ?? '';
const slackToken = process.env.SLACK_BOT_TOKEN ?? '';
const slackAppToken = process.env.SLACK_APP_TOKEN ?? '';

try {
  assertDataDirWritable();
} catch (err) {
  console.error(`[server] ${(err as Error).message}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Declared before auth: a platform health check sends no credentials, and a 401
// would make the host consider the service dead and restart it forever.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

const dashboardPassword = process.env.DASHBOARD_PASSWORD ?? '';
if (dashboardPassword) {
  app.use(basicAuth(dashboardPassword));
  console.log('[server] dashboard is password protected');
}

const scheduler = new Scheduler({ teamworkToken, slackToken });
const socket = slackAppToken ? new SlackSocket(slackAppToken) : null;
app.use('/api', buildRouter({ teamworkToken, slackToken, scheduler }));

const dashboardDist = resolve(here, '../../dashboard/dist');
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get('*', (_req, res) => res.sendFile(join(dashboardDist, 'index.html')));
}

const server = app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  if (!teamworkToken) console.warn('[server] TEAMWORK_API_TOKEN is not set');
  if (!slackToken) console.warn('[server] SLACK_BOT_TOKEN is not set');
  if (!dashboardPassword) {
    console.warn(
      '[server] DASHBOARD_PASSWORD is not set — fine behind loopback, ' +
      'but set it on any host where the port is publicly reachable',
    );
  }
  scheduler.start();

  if (socket) {
    void socket.start();
  } else {
    console.warn('[server] SLACK_APP_TOKEN not set — Mute buttons will render but do nothing');
  }
});

// Without this, a stale process holding the port makes launchd crash-loop in silence.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] port ${port} is already in use — another copy is running.\n` +
      `[server] find it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    );
  } else {
    console.error(`[server] failed to start: ${err.message}`);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    scheduler.stop();
    socket?.stop();
    process.exit(0);
  });
}
