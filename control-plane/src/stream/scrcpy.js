import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { StreamReader } from './reader.js';

const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';

// Set in the top bits of the 64-bit presentation timestamp.
const FLAG_CONFIG = 1n << 63n;
const FLAG_KEYFRAME = 1n << 62n;
const PTS_MASK = (1n << 62n) - 1n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs scrcpy's server on the device and turns its socket into events.
 *
 * Android's MediaCodec does the H.264 encoding on-device, so the host never
 * touches a pixel. That is what lets one modest VM carry a lot of sessions.
 *
 * Emits:
 *   'meta'   { deviceName, codec, width, height }
 *   'video'  { data, pts, config, keyframe }
 *   'device' Buffer  — messages coming back on the control socket
 *   'close'  Error | undefined
 */
export class ScrcpyStream extends EventEmitter {
  constructor(adb, { hostPort }) {
    super();
    this.adb = adb;
    this.hostPort = hostPort;
    // Verified against the real scrcpy v2.7 source (Options.java): scid IS
    // parsed as hex (`Integer.parseInt(value, 0x10)`), so this original
    // hex encoding is correct -- crypto.randomInt's exclusive upper bound
    // of 0x7fffffff already keeps every value within the 31-bit range the
    // server requires, round-tripping safely through hex either way. (A
    // since-reverted "fix" here mistook a manual test artifact -- hand-typed
    // test values like "deadbeef" that overflow 31 bits *as hex* -- for a
    // real bug. They were never values this code could actually produce.)
    this.scid = crypto.randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
    this.videoSocket = null;
    this.controlSocket = null;
    this.proc = null;
    this.closed = false;
  }

  async start() {
    if (!existsSync(config.scrcpyJar)) {
      throw new Error(`scrcpy-server.jar not found at ${config.scrcpyJar}. Run ./scripts/fetch-scrcpy.sh`);
    }

    await this.adb.push(config.scrcpyJar, REMOTE_JAR);

    // These options are version-specific. They match the version pinned in
    // scripts/fetch-scrcpy.sh; changing one without the other breaks the handshake.
    const opts = [
      `scid=${this.scid}`,
      'log_level=warn',
      'video=true',
      'audio=false',
      'control=true',
      'tunnel_forward=true',
      'video_codec=h264',
      `video_bit_rate=${config.video.bitRate}`,
      `max_size=${config.video.maxSize}`,
      `max_fps=${config.video.maxFps}`,
      'send_device_meta=true',
      'send_frame_meta=true',
      'send_codec_meta=true',
      'send_dummy_byte=true',
      'stay_awake=true',
      'power_off_on_close=false',
      'cleanup=true',
    ];

    const cmd = `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${config.scrcpyVersion} ${opts.join(' ')}`;
    this.proc = this.adb.spawnShell(cmd);
    this.proc.stderr.on('data', (b) => {
      const text = b.toString().trim();
      if (text) log.warn('scrcpy server', { serial: this.adb.serial, text });
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.#shutdown(new Error(`scrcpy server exited with code ${code}`));
    });

    await this.adb.forward(this.hostPort, `localabstract:scrcpy_${this.scid}`);

    // The server binds its socket a moment after app_process starts, so the
    // first connect attempts will legitimately be refused.
    this.videoSocket = await this.#connectWithRetry();
    this.controlSocket = await this.#connectWithRetry();

    this.videoSocket.setNoDelay(true);
    this.controlSocket.setNoDelay(true);
    this.controlSocket.on('data', (b) => this.emit('device', b));
    this.controlSocket.on('error', (err) => this.#shutdown(err));

    this.#readVideo().catch((err) => this.#shutdown(err));
    return this;
  }

  async #connectWithRetry({ attempts = 60, delayMs = 150, settleMs = 250 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = net.connect({ host: '127.0.0.1', port: this.hostPort });
          s.once('connect', () => {
            s.removeListener('error', reject);
            resolve(s);
          });
          s.once('error', reject);
        });

        // `adb forward` to a localabstract target lets the *local* TCP
        // connect succeed immediately against adb's own smart-socket layer,
        // even when the remote abstract socket doesn't exist yet (the
        // server, spawned moments ago via spawnShell(), is still starting
        // its JVM). adb then closes the tunnel as soon as it discovers the
        // device-side open failed -- which arrives as a normal 'connect'
        // followed by an near-instant 'close'/'end', NOT a connection
        // error. Without this check, that race handed back an already-dead
        // socket as a "successful" connection (confirmed by hand: spawn to
        // dead-socket takes single-digit milliseconds, while the JVM
        // genuinely needs on the order of a second before its abstract
        // socket exists). Confirm the connection survives a short grace
        // window before trusting it.
        const alive = await new Promise((resolve) => {
          const onClose = () => { clearTimeout(timer); resolve(false); };
          const timer = setTimeout(() => {
            socket.removeListener('close', onClose);
            resolve(true);
          }, settleMs);
          socket.once('close', onClose);
        });

        if (alive) return socket;
        last = new Error('connection closed immediately (device-side socket not ready yet)');
      } catch (err) {
        last = err;
      }
      await sleep(delayMs);
    }
    throw new Error(`scrcpy server never accepted a connection on port ${this.hostPort}: ${last?.message}`);
  }

  async #readVideo() {
    const reader = new StreamReader(this.videoSocket);

    // tunnel_forward mode sends one byte to prove the tunnel is live before
    // any real data. Without this the device name would be off by one.
    await reader.read(1);

    const nameBuf = await reader.read(64);
    const nul = nameBuf.indexOf(0);
    const deviceName = nameBuf.toString('utf8', 0, nul === -1 ? 64 : nul);

    const codecMeta = await reader.read(12);
    const meta = {
      deviceName,
      codec: codecMeta.toString('ascii', 0, 4),
      width: codecMeta.readUInt32BE(4),
      height: codecMeta.readUInt32BE(8),
    };
    this.meta = meta;
    this.emit('meta', meta);
    log.info('video stream open', { serial: this.adb.serial, ...meta });

    for (;;) {
      const header = await reader.read(12);
      const raw = header.readBigUInt64BE(0);
      const length = header.readUInt32BE(8);
      if (length === 0 || length > 32 << 20) {
        throw new Error(`implausible frame length ${length}; the server version probably does not match`);
      }
      const data = await reader.read(length);

      this.emit('video', {
        data,
        pts: Number(raw & PTS_MASK),
        config: (raw & FLAG_CONFIG) !== 0n,
        keyframe: (raw & FLAG_KEYFRAME) !== 0n,
      });
    }
  }

  /** Writes an already-encoded scrcpy control message. */
  send(buffer) {
    if (this.closed || !this.controlSocket?.writable) return false;
    return this.controlSocket.write(buffer);
  }

  #shutdown(err) {
    if (this.closed) return;
    // #readVideo()'s rejection handler calls this with no logging anywhere
    // in the original path -- a stream that dies after the session already
    // reported "ready" was completely invisible (no log line, no state
    // change on the session, nothing but silently-empty client sockets).
    if (err) log.error('scrcpy stream closed with error', { serial: this.adb.serial, error: err.message, stack: err.stack });
    this.closed = true;
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.proc?.kill('SIGTERM');
    this.adb.removeForward(this.hostPort).catch(() => {});
    this.emit('close', err);
  }

  stop() {
    this.#shutdown();
  }
}
