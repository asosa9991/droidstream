import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { log } from './log.js';
import { SessionManager } from './sessions.js';
import { reapOrphans } from './devices/redroid.js';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(config.webRoot, { maxAge: '1h', index: 'index.html' }));

const manager = new SessionManager();

// Session tokens are otherwise the whole auth model (see docs/DEPLOYMENT.md)
// -- a session's token is normally only ever seen by the browser tab that
// created it. This is a deliberate, off-by-default escape hatch: with
// ADMIN_TOKEN configured server-side, a caller that presents it back gets
// every session's real token too, letting one browser (or operator tool)
// see and attach to sessions it didn't start itself.
function isAdmin(req) {
  return Boolean(config.adminToken) && req.get('x-admin-token') === config.adminToken;
}
function sessionJson(session, admin) {
  return admin ? { ...session.toJSON(), token: session.token } : session.toJSON();
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    backend: config.backend,
    kvm: config.hasKvm,
    sessions: manager.sessions.size,
    maxSessions: config.maxSessions,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/capabilities', (_req, res) => {
  res.json({
    defaultBackend: config.backend,
    backends: [
      { id: 'container', label: 'Container', available: true, note: 'Runs on the host kernel. No virtualization.' },
      { id: 'emulator-kvm', label: 'Emulator (hardware)', available: config.hasKvm, note: 'Needs /dev/kvm.' },
      { id: 'emulator-tcg', label: 'Emulator (software)', available: true, note: 'Full device emulation. Much slower.' },
    ],
    images: Object.keys(config.images),
    profiles: config.profiles,
  });
});

app.get('/api/sessions', (req, res) => {
  const admin = isAdmin(req);
  res.json({ sessions: [...manager.sessions.values()].map((s) => sessionJson(s, admin)) });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const session = await manager.create(req.body ?? {});
    res.status(202).json({
      ...session.toJSON(),
      token: session.token,
      streamPath: `/stream?token=${session.token}`,
    });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no session with that id' });
  res.json(sessionJson(session, isAdmin(req)));
});

app.get('/api/sessions/:id/logs', async (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no session with that id' });
  if (typeof session.device?.logs !== 'function') {
    return res.status(400).json({ error: 'this backend does not expose logs' });
  }
  try {
    res.type('text/plain').send(await session.device.logs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const existed = await manager.destroy(req.params.id);
  if (!existed) return res.status(404).json({ error: 'no session with that id' });
  res.status(204).end();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/stream') {
    socket.destroy();
    return;
  }

  const session = manager.byToken(url.searchParams.get('token'));
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (session.state !== 'ready' || !session.bridge) {
    socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.binaryType = 'nodebuffer';
    session.bridge.attach(ws);
    log.info('viewer attached', { session: session.id, viewers: session.bridge.clients.size });
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  server.close();
  await manager.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await reapOrphans();

server.listen(config.port, config.host, () => {
  log.info('control plane listening', {
    url: `http://${config.host}:${config.port}`,
    backend: config.backend,
    kvm: config.hasKvm,
  });
  if (config.backend === 'emulator-tcg') {
    log.warn('no binderfs and no KVM on this host; sessions will use software emulation and will be slow');
  }
});
