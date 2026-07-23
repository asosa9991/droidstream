import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ControlEncoder } from '../src/stream/control.js';
import { StreamReader } from '../src/stream/reader.js';

/*
 * These cover the two places where a wrong byte is expensive to debug against
 * a real device: the scrcpy control message layout, and the framing of the
 * video socket.
 */

test('touch message matches the scrcpy layout', () => {
  const enc = new ControlEncoder({ width: 720, height: 1280 });
  const buf = enc.touch({ action: 'down', x: 0.5, y: 0.25, pointerId: 3 });

  assert.equal(buf.length, 32, 'INJECT_TOUCH_EVENT is 32 bytes');
  assert.equal(buf.readUInt8(0), 2, 'message type');
  assert.equal(buf.readUInt8(1), 0, 'AMOTION_EVENT_ACTION_DOWN');
  assert.equal(buf.readBigUInt64BE(2), 3n, 'pointer id');
  assert.equal(buf.readInt32BE(10), 360, 'x scaled to device pixels');
  assert.equal(buf.readInt32BE(14), 320, 'y scaled to device pixels');
  assert.equal(buf.readUInt16BE(18), 720);
  assert.equal(buf.readUInt16BE(20), 1280);
  assert.equal(buf.readUInt16BE(22), 0xffff, 'full pressure on press');
  assert.equal(buf.readInt32BE(28), 1, 'primary button held');
});

test('lifting a finger reports zero pressure and no buttons', () => {
  const enc = new ControlEncoder({ width: 720, height: 1280 });
  const buf = enc.touch({ action: 'up', x: 0.5, y: 0.5 });
  assert.equal(buf.readUInt16BE(22), 0);
  assert.equal(buf.readInt32BE(28), 0);
});

test('coordinates outside the screen are clamped, not wrapped', () => {
  const enc = new ControlEncoder({ width: 720, height: 1280 });
  const low = enc.touch({ action: 'move', x: -4, y: -4 });
  const high = enc.touch({ action: 'move', x: 9, y: 9 });
  assert.equal(low.readInt32BE(10), 0);
  assert.equal(high.readInt32BE(10), 719);
  assert.equal(high.readInt32BE(14), 1279);
});

test('keycode message is 14 bytes with the keycode in place', () => {
  const enc = new ControlEncoder({ width: 100, height: 100 });
  const buf = enc.key({ keycode: 4, action: 'down' });
  assert.equal(buf.length, 14);
  assert.equal(buf.readUInt8(0), 0);
  assert.equal(buf.readInt32BE(2), 4);
});

test('text message carries a length prefix', () => {
  const enc = new ControlEncoder({ width: 100, height: 100 });
  const buf = enc.text('héllo');
  const payload = Buffer.from('héllo', 'utf8');
  assert.equal(buf.readUInt8(0), 1);
  assert.equal(buf.readUInt32BE(1), payload.length, 'length is bytes, not characters');
  assert.deepEqual(buf.subarray(5), payload);
});

test('scroll uses signed 16-bit fixed point', () => {
  const enc = new ControlEncoder({ width: 720, height: 1280 });
  const buf = enc.scroll({ x: 0.5, y: 0.5, vscroll: -1 });
  assert.equal(buf.length, 21);
  assert.equal(buf.readInt16BE(13), 0, 'hscroll');
  assert.equal(buf.readInt16BE(15), -32767, 'vscroll');
  assert.equal(buf.readInt32BE(17), 0, 'buttons');
});

test('StreamReader reassembles headers split across chunks', async () => {
  const socket = new PassThrough();
  const reader = new StreamReader(socket);

  const frame = Buffer.alloc(12 + 5);
  frame.writeBigUInt64BE((1n << 62n) | 12345n, 0); // keyframe flag + pts
  frame.writeUInt32BE(5, 8);
  frame.write('ABCDE', 12);

  // Deliver one byte at a time; TCP is allowed to do exactly this.
  const pending = (async () => {
    const header = await reader.read(12);
    const raw = header.readBigUInt64BE(0);
    return {
      pts: Number(raw & ((1n << 62n) - 1n)),
      keyframe: (raw & (1n << 62n)) !== 0n,
      payload: (await reader.read(header.readUInt32BE(8))).toString(),
    };
  })();

  for (const byte of frame) socket.write(Buffer.from([byte]));

  const got = await pending;
  assert.equal(got.pts, 12345);
  assert.equal(got.keyframe, true);
  assert.equal(got.payload, 'ABCDE');
});

test('StreamReader rejects outstanding reads when the socket dies', async () => {
  const socket = new PassThrough();
  const reader = new StreamReader(socket);
  const pending = reader.read(64);
  socket.destroy();
  await assert.rejects(pending);
});
