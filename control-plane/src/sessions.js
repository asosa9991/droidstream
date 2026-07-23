import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { RedroidDevice } from './devices/redroid.js';
import { EmulatorDevice } from './devices/emulator.js';
import { ScrcpyStream } from './stream/scrcpy.js';
import { SessionBridge } from './stream/bridge.js';

class PortPool {
  constructor([min, max]) {
    this.free = [];
    for (let p = min; p < max; p++) this.free.push(p);
  }

  take() {
    const port = this.free.shift();
    if (port === undefined) throw new Error('no free ports; the session limit is set too high for the configured port range');
    return port;
  }

  give(port) {
    if (port !== undefined && !this.free.includes(port)) this.free.push(port);
  }
}

export class Session {
  constructor({ id, backend, image, profile }) {
    this.id = id;
    this.backend = backend;
    this.image = image;
    this.profile = profile;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.state = 'starting';
    this.createdAt = Date.now();
    this.lastSeenAt = Date.now();
    this.error = null;
    this.device = null;
    this.bridge = null;
  }

  touch() {
    this.lastSeenAt = Date.now();
  }

  get idleMs() {
    if (this.bridge?.clients.size) return 0;
    return Date.now() - this.lastSeenAt;
  }

  toJSON() {
    return {
      id: this.id,
      state: this.state,
      backend: this.backend,
      image: this.image,
      profile: this.profile,
      display: this.device?.displaySize ?? null,
      viewers: this.bridge?.clients.size ?? 0,
      createdAt: new Date(this.createdAt).toISOString(),
      ageSeconds: Math.round((Date.now() - this.createdAt) / 1000),
      error: this.error,
    };
  }
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.adbPorts = new PortPool(config.adbPortRange);
    this.streamPorts = new PortPool([config.adbPortRange[1], config.adbPortRange[1] + 100]);

    this.reaper = setInterval(() => this.#reapIdle(), 30_000);
    this.reaper.unref();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  get(id) {
    return this.sessions.get(id);
  }

  byToken(token) {
    if (!token) return null;
    for (const session of this.sessions.values()) {
      // Constant-time compare so a token cannot be discovered a byte at a time.
      const a = Buffer.from(session.token);
      const b = Buffer.from(String(token));
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return session;
    }
    return null;
  }

  async create({ backend, image, profile } = {}) {
    if (this.sessions.size >= config.maxSessions) {
      throw Object.assign(new Error(`this host is at its limit of ${config.maxSessions} sessions`), { status: 429 });
    }

    const chosenBackend = backend ?? config.backend;
    const imageKey = image ?? config.defaultImage;
    const imageRef = config.images[imageKey] ?? imageKey;
    const profileName = profile ?? config.defaultProfile;
    const profileSpec = config.profiles[profileName];

    if (!profileSpec) {
      throw Object.assign(new Error(`unknown profile "${profileName}". Available: ${Object.keys(config.profiles).join(', ')}`), { status: 400 });
    }

    const id = crypto.randomBytes(6).toString('hex');
    const session = new Session({ id, backend: chosenBackend, image: imageKey, profile: profileName });
    this.sessions.set(id, session);

    // Booting takes tens of seconds; the caller gets the id immediately and
    // polls, rather than holding an HTTP request open past a proxy timeout.
    this.#boot(session, { backend: chosenBackend, imageRef, profileSpec }).catch((err) => {
      session.state = 'failed';
      session.error = err.message;
      log.error('session failed to start', { session: id, error: err.message });
      this.destroy(id).catch(() => {});
    });

    return session;
  }

  async #boot(session, { backend, imageRef, profileSpec }) {
    const adbPort = this.adbPorts.take();
    const streamPort = this.streamPorts.take();
    session.adbPort = adbPort;
    session.streamPort = streamPort;

    try {
      session.device =
        backend === 'container'
          ? new RedroidDevice({ id: session.id, adbPort, image: imageRef, profile: profileSpec })
          : new EmulatorDevice({ id: session.id, adbPort, accel: backend });

      await session.device.start();
      if (session.state === 'stopping') return;

      const stream = new ScrcpyStream(session.device.adb, { hostPort: streamPort });
      await stream.start();

      session.bridge = new SessionBridge(session, stream);
      session.state = 'ready';
      session.touch();
      log.info('session ready', { session: session.id, backend, seconds: Math.round((Date.now() - session.createdAt) / 1000) });
    } catch (err) {
      this.adbPorts.give(adbPort);
      this.streamPorts.give(streamPort);
      throw err;
    }
  }

  async destroy(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.state = 'stopping';
    this.sessions.delete(id);

    try {
      session.bridge?.close();
      await session.device?.stop();
    } catch (err) {
      log.warn('error while tearing down session', { session: id, error: err.message });
    } finally {
      this.adbPorts.give(session.adbPort);
      this.streamPorts.give(session.streamPort);
      log.info('session destroyed', { session: id });
    }
    return true;
  }

  #reapIdle() {
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      if (session.idleMs > config.idleTimeoutMs) {
        log.info('reaping idle session', { session: session.id, idleSeconds: Math.round(session.idleMs / 1000) });
        this.destroy(session.id).catch(() => {});
      }
    }
  }

  async shutdown() {
    clearInterval(this.reaper);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}
