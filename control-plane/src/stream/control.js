/**
 * Encoder for scrcpy's binary control protocol.
 *
 * The browser sends normalized coordinates (0..1) so a resized window, a
 * rotated device and a retina display all produce the same wire message. The
 * pixel conversion happens here, against the size the device actually reported.
 */

const TYPE = {
  KEYCODE: 0,
  TEXT: 1,
  TOUCH: 2,
  SCROLL: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  ROTATE_DEVICE: 11,
};

const MOTION = { down: 0, up: 1, move: 2, cancel: 3 };
const KEY_ACTION = { down: 0, up: 1 };
const BUTTON_PRIMARY = 1;

/** Android keycodes reachable from the browser's navigation bar. */
export const KEYCODES = {
  home: 3,
  back: 4,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  enter: 66,
  backspace: 67,
  tab: 61,
  escape: 111,
  appSwitch: 187,
  dpadUp: 19,
  dpadDown: 20,
  dpadLeft: 21,
  dpadRight: 22,
};

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const u16 = (n) => Math.min(0xffff, Math.max(0, Math.round(n)));

export class ControlEncoder {
  constructor({ width, height }) {
    this.setSize({ width, height });
  }

  setSize({ width, height }) {
    this.width = width;
    this.height = height;
  }

  #toPixels(x, y) {
    return {
      px: Math.min(this.width - 1, Math.round(clamp01(x) * this.width)),
      py: Math.min(this.height - 1, Math.round(clamp01(y) * this.height)),
    };
  }

  touch({ action, x, y, pointerId = 0, pressure = 1 }) {
    const code = MOTION[action];
    if (code === undefined) throw new Error(`unknown touch action: ${action}`);

    const { px, py } = this.#toPixels(x, y);
    const buf = Buffer.alloc(32);
    let o = 0;
    buf.writeUInt8(TYPE.TOUCH, o); o += 1;
    buf.writeUInt8(code, o); o += 1;
    buf.writeBigUInt64BE(BigInt(pointerId), o); o += 8;
    buf.writeInt32BE(px, o); o += 4;
    buf.writeInt32BE(py, o); o += 4;
    buf.writeUInt16BE(this.width, o); o += 2;
    buf.writeUInt16BE(this.height, o); o += 2;
    // Lifting a finger must report zero pressure or Android treats it as a hover.
    buf.writeUInt16BE(code === MOTION.up ? 0 : u16(pressure * 0xffff), o); o += 2;
    buf.writeInt32BE(BUTTON_PRIMARY, o); o += 4;
    buf.writeInt32BE(code === MOTION.up ? 0 : BUTTON_PRIMARY, o);
    return buf;
  }

  scroll({ x, y, hscroll = 0, vscroll = 0 }) {
    const { px, py } = this.#toPixels(x, y);
    const fixed = (v) => Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, v)) * 32767)));

    const buf = Buffer.alloc(21);
    let o = 0;
    buf.writeUInt8(TYPE.SCROLL, o); o += 1;
    buf.writeInt32BE(px, o); o += 4;
    buf.writeInt32BE(py, o); o += 4;
    buf.writeUInt16BE(this.width, o); o += 2;
    buf.writeUInt16BE(this.height, o); o += 2;
    buf.writeInt16BE(fixed(hscroll), o); o += 2;
    buf.writeInt16BE(fixed(vscroll), o); o += 2;
    buf.writeInt32BE(0, o);
    return buf;
  }

  key({ keycode, action = 'down', repeat = 0, metaState = 0 }) {
    const code = KEY_ACTION[action];
    if (code === undefined) throw new Error(`unknown key action: ${action}`);
    const buf = Buffer.alloc(14);
    buf.writeUInt8(TYPE.KEYCODE, 0);
    buf.writeUInt8(code, 1);
    buf.writeInt32BE(keycode, 2);
    buf.writeInt32BE(repeat, 6);
    buf.writeInt32BE(metaState, 10);
    return buf;
  }

  /** A press and release pair; most navigation buttons want this. */
  keyTap(keycode) {
    return [this.key({ keycode, action: 'down' }), this.key({ keycode, action: 'up' })];
  }

  text(value) {
    const payload = Buffer.from(String(value), 'utf8').subarray(0, 8192);
    const buf = Buffer.alloc(5 + payload.length);
    buf.writeUInt8(TYPE.TEXT, 0);
    buf.writeUInt32BE(payload.length, 1);
    payload.copy(buf, 5);
    return buf;
  }

  setClipboard(value, { paste = false, sequence = 0 } = {}) {
    const payload = Buffer.from(String(value), 'utf8');
    const buf = Buffer.alloc(14 + payload.length);
    buf.writeUInt8(TYPE.SET_CLIPBOARD, 0);
    buf.writeBigUInt64BE(BigInt(sequence), 1);
    buf.writeUInt8(paste ? 1 : 0, 9);
    buf.writeUInt32BE(payload.length, 10);
    payload.copy(buf, 14);
    return buf;
  }

  getClipboard() {
    return Buffer.from([TYPE.GET_CLIPBOARD, 0]);
  }

  rotate() {
    return Buffer.from([TYPE.ROTATE_DEVICE]);
  }

  expandNotifications() {
    return Buffer.from([TYPE.EXPAND_NOTIFICATION_PANEL]);
  }

  collapsePanels() {
    return Buffer.from([TYPE.COLLAPSE_PANELS]);
  }
}
