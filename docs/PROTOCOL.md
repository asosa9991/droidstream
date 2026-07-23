# Wire protocol

One WebSocket per viewer, at `/stream?token=<session token>`. The token is returned once,
by `POST /api/sessions`, and is the only credential — treat it like a password.

Binary messages carry video. Text messages are JSON and carry everything else.

## Server → client

### Video (binary)

```
byte  0      0x01   frame type: video
byte  1      flags  bit0 = parameter sets (SPS/PPS), bit1 = keyframe
bytes 2..9   pts    uint64 big-endian, microseconds, device clock
bytes 10..   H.264 Annex-B payload
```

The payload is exactly what Android's `MediaCodec` produced. The host does not transcode,
which is why CPU use per session on the control plane stays in single-digit percent.

A client must hold the parameter-set packet and prepend it to the next keyframe before
handing it to `VideoDecoder`. `web/app.js` does this in `onBinary`.

On attach the server replays the cached parameter sets plus every packet since the last
keyframe, so a new tab paints immediately instead of waiting up to ten seconds for the next
I-frame.

### Status (text)

```jsonc
{ "t": "meta",  "deviceName": "redroid", "codec": "h264",
  "width": 720, "height": 1280, "backend": "container", "sessionId": "a1b2c3" }

{ "t": "pong",  "id": 42 }
{ "t": "ended", "reason": "device stream closed" }
```

## Client → server

All coordinates are normalized to `0..1` against the visible screen. The server scales them
to device pixels using the size the device reported, so window resizing, device rotation and
high-DPI displays need no client-side arithmetic.

```jsonc
{ "t": "touch",  "action": "down|move|up|cancel", "x": 0.5, "y": 0.32,
                 "pointerId": 0, "pressure": 1 }

{ "t": "scroll", "x": 0.5, "y": 0.5, "hscroll": 0, "vscroll": -0.4 }

{ "t": "key",    "keycode": 4, "action": "down|up", "metaState": 0 }

{ "t": "nav",    "button": "back|home|appSwitch|power|volumeUp|volumeDown|enter|backspace|escape|tab|dpadUp|dpadDown|dpadLeft|dpadRight" }

{ "t": "text",      "value": "hello" }
{ "t": "clipboard", "value": "hello", "paste": true }
{ "t": "rotate" }
{ "t": "notifications" }
{ "t": "collapse" }
{ "t": "ping", "id": 42 }
```

`nav` sends a press and release pair; `key` sends one or the other, which is what you want
for held modifiers or auto-repeat.

## Flow control

The server drops video frames for any socket whose `bufferedAmount` exceeds 4 MB rather
than queueing them. A client on a bad link should fall behind by dropped frames, not by
growing latency — a queue that only ever grows never recovers.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness, chosen backend, session count |
| `GET` | `/api/capabilities` | Backends, images and screen profiles this host offers |
| `POST` | `/api/sessions` | Start a device. Returns `202` with the id and token immediately |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/sessions/:id` | One session, including `state` and `error` |
| `GET` | `/api/sessions/:id/logs` | Device container logs (container backend only) |
| `DELETE` | `/api/sessions/:id` | Stop and remove |

`POST /api/sessions` returns before the device has booted. Poll `GET /api/sessions/:id`
until `state` is `ready`; `failed` sessions carry the reason in `error`. Holding an HTTP
request open for the forty seconds a container takes — or the several minutes software
emulation takes — would trip most load balancer timeouts.
