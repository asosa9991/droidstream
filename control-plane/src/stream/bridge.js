import { ControlEncoder, KEYCODES } from './control.js';
import { log } from '../log.js';

const FRAME_VIDEO = 0x01;
const FLAG_CONFIG = 0x01;
const FLAG_KEYFRAME = 0x02;

const GOP_BUFFER_LIMIT = 6 << 20;

/**
 * Owns the path between one device and the browser sockets watching it.
 *
 * The GOP buffer is the reason a tab shows a picture immediately instead of
 * waiting for the next I-frame. scrcpy asks MediaCodec for a keyframe every ten
 * seconds, so a client that attached at a bad moment would otherwise stare at a
 * blank canvas for most of that interval. Holding the SPS/PPS packet plus every
 * packet since the last keyframe means a new client can be caught up on attach.
 */
export class SessionBridge {
  constructor(session, stream) {
    this.session = session;
    this.stream = stream;
    this.clients = new Set();
    this.encoder = null;

    this.configPacket = null;
    this.gop = [];
    this.gopBytes = 0;

    this.stats = { framesOut: 0, bytesOut: 0, startedAt: Date.now() };

    stream.on('meta', (meta) => {
      this.meta = meta;
      this.encoder = new ControlEncoder({ width: meta.width, height: meta.height });
      this.#broadcastJson({ t: 'meta', ...meta, backend: session.backend, sessionId: session.id });
    });

    stream.on('video', (packet) => this.#onVideo(packet));

    stream.on('close', (err) => {
      this.#broadcastJson({ t: 'ended', reason: err ? err.message : 'device stream closed' });
      for (const ws of this.clients) ws.close(1011, 'device stream closed');
      this.clients.clear();
    });
  }

  #onVideo({ data, pts, config, keyframe }) {
    if (config) {
      // SPS/PPS. Everything before it is undecodable now, so start fresh.
      this.configPacket = { data, pts, config: true, keyframe: false };
      this.gop = [];
      this.gopBytes = 0;
    } else if (keyframe) {
      this.gop = [{ data, pts, config: false, keyframe: true }];
      this.gopBytes = data.length;
    } else if (this.gop.length) {
      this.gop.push({ data, pts, config: false, keyframe: false });
      this.gopBytes += data.length;
      // A pathologically long GOP would otherwise grow without bound.
      if (this.gopBytes > GOP_BUFFER_LIMIT) {
        this.gop = [];
        this.gopBytes = 0;
      }
    }

    const frame = encodeVideoFrame({ data, pts, config, keyframe });
    this.stats.framesOut += 1;
    this.stats.bytesOut += frame.length;

    for (const ws of this.clients) this.#sendFrame(ws, frame);
  }

  #sendFrame(ws, frame) {
    if (ws.readyState !== ws.OPEN) return;
    // Dropping is better than queueing: a client that cannot keep up would
    // otherwise fall further behind on every frame and never recover.
    if (ws.bufferedAmount > 4 << 20) {
      if (!ws._droppedWarned) {
        ws._droppedWarned = true;
        log.warn('client is behind, dropping frames', { session: this.session.id });
      }
      return;
    }
    ws._droppedWarned = false;
    ws.send(frame);
  }

  #broadcastJson(obj) {
    const text = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  attach(ws) {
    this.clients.add(ws);
    this.session.touch();

    if (this.meta) {
      ws.send(JSON.stringify({ t: 'meta', ...this.meta, backend: this.session.backend, sessionId: this.session.id }));
    }
    if (this.configPacket) {
      ws.send(encodeVideoFrame(this.configPacket));
      for (const packet of this.gop) ws.send(encodeVideoFrame(packet));
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      this.session.touch();
      try {
        this.#handleInput(JSON.parse(raw.toString()), ws);
      } catch (err) {
        log.debug('bad client message', { session: this.session.id, error: err.message });
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.session.touch();
    });
  }

  #handleInput(msg, ws) {
    if (!this.encoder) return;
    const send = (b) => (Array.isArray(b) ? b.forEach((x) => this.stream.send(x)) : this.stream.send(b));

    switch (msg.t) {
      case 'touch':
        send(this.encoder.touch(msg));
        break;
      case 'scroll':
        send(this.encoder.scroll(msg));
        break;
      case 'key':
        send(this.encoder.key(msg));
        break;
      case 'nav': {
        const keycode = KEYCODES[msg.button];
        if (keycode !== undefined) send(this.encoder.keyTap(keycode));
        break;
      }
      case 'text':
        send(this.encoder.text(msg.value));
        break;
      case 'clipboard':
        send(this.encoder.setClipboard(msg.value, { paste: msg.paste === true }));
        break;
      case 'rotate':
        send(this.encoder.rotate());
        break;
      case 'notifications':
        send(this.encoder.expandNotifications());
        break;
      case 'collapse':
        send(this.encoder.collapsePanels());
        break;
      case 'ping':
        // Round-trip probe. Answer only the socket that asked, or every client
        // would inherit the latency of whichever one is slowest.
        if (ws?.readyState === ws?.OPEN) ws.send(JSON.stringify({ t: 'pong', id: msg.id }));
        break;
      default:
        log.debug('ignored client message type', { type: msg.t });
    }
  }

  close() {
    for (const ws of this.clients) ws.close(1001, 'session ended');
    this.clients.clear();
    this.stream.stop();
  }
}

/** [type:1][flags:1][pts:8 BE][H.264 Annex-B payload] */
function encodeVideoFrame({ data, pts, config, keyframe }) {
  const header = Buffer.allocUnsafe(10);
  header.writeUInt8(FRAME_VIDEO, 0);
  header.writeUInt8((config ? FLAG_CONFIG : 0) | (keyframe ? FLAG_KEYFRAME : 0), 1);
  header.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(pts))), 2);
  return Buffer.concat([header, data]);
}
