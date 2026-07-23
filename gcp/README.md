# DroidStream on GCE

```bash
./setup.sh [PROJECT_ID] [ZONE] [MACHINE_TYPE]   # defaults: droidstream-svc us-east1-c n2-standard-4
./deploy.sh [PROJECT_ID] [ZONE]                 # copies the project over, fetches scrcpy, docker compose up
```

No `--enable-nested-virtualization`, no `/dev/kvm` — that's the entire point of
DroidStream's container backend. `cloud-init.yaml` only needs Docker plus a
kernel with binderfs, which stock Ubuntu 24.04 already has.

Currently deployed: `droidstream-svc` project, instance `droidstream` in
`us-east1-c`. Firewall opens only `tcp:8080` (web console + WebSocket) —
ADB stays loopback-only by the app's own design, nothing to open for it.

## Verified working (2026-07-22)

Full round-trip confirmed on a fresh `n2-standard-4` / Ubuntu 24.04 VM:
`POST /api/sessions` → container starts → `sys.boot_completed=1` inside it →
`adb exec-out screencap` over the session's published ADB port shows a real
rendered Android 13 home screen. `DELETE /api/sessions/:id` cleans up.

## Three real bugs found and fixed getting here

None of these are exotic — worth knowing before debugging this fresh on
another host.

1. **`scripts/fetch-scrcpy.sh`'s pinned `SHA256` for scrcpy v2.7 was wrong.**
   Downloaded the real release asset from `github.com/Genymobile/scrcpy`
   independently twice and got the same digest both times, which doesn't
   match the pinned value — a stale/placeholder hash, not a sign of a
   compromised download. Fixed with the verified value; if this happens
   again on a different scrcpy version, reproduce the download yourself
   before trusting `SCRCPY_SHA256=skip`.

2. **The control plane's own `docker` CLI was too old to talk to a modern
   Docker daemon.** `control-plane/Dockerfile` installed Debian bookworm's
   `docker.io` package (client API 1.41); a stock Ubuntu 24.04 host's Docker
   Engine (29.x) refuses clients below API 1.44 outright
   (`client version 1.41 is too old`). Fixed by installing `docker-ce-cli`
   from Docker's own apt repo in the Dockerfile instead. If you see this
   error again, it means the gap between "whatever Debian bookworm ships"
   and "whatever the host actually runs" has reopened — check
   `docker exec droidstream-control-plane-1 docker version` against the
   host's `docker version`.

3. **`autoBackend()` in `control-plane/src/config.js` can't see the host's
   binderfs.** It checks `existsSync('/dev/binderfs')` from *inside the
   control-plane's own container*, which never reflects the host — that
   path only appears when something (redroid itself, per-container) mounts
   it, not from kernel-level availability. `scripts/preflight.sh`, which
   runs directly on the host, detects it correctly via
   `/proc/filesystems`. Net effect: auto-detection silently falls back to
   the 10-30x-slower `emulator-tcg` backend even when the fast container
   path is fully available. Fixed by pinning `DROIDSTREAM_BACKEND: container`
   explicitly in `docker-compose.yml` rather than trusting the
   auto-detect — verify with `scripts/preflight.sh` on the host first,
   then set it explicitly.

4. **redroid needs `--privileged`, not just `--security-opt
   seccomp=unconfined`, on this host.** `redroid.js`'s default path treats
   `REDROID_PRIVILEGED=1` as an escape hatch "some hosts need"; on this
   stock GCE Ubuntu 24.04 + Docker 29.x host it's not optional — without it
   the container's `/init` exits immediately (code 0, zero log output,
   looks like nothing happened at all) because mounting binderfs inside
   the container needs `CAP_SYS_ADMIN`, which `seccomp=unconfined` doesn't
   grant (it only lifts syscall filtering, not capabilities). Confirmed by
   reproducing the exact `docker run` by hand outside the control plane
   with and without `--privileged`. Now set in `docker-compose.yml`.

   **This is a real security tradeoff, not just a config toggle** — per
   `docs/DEPLOYMENT.md`, privileged mode "hands the container the host."
   Worth deciding deliberately per deployment rather than copying this
   default forward; a host with a newer/different capability model might
   not need it.

5. **The web console fails with "This browser cannot decode the stream" in
   every browser, including fully WebCodecs-capable Chrome.** WebCodecs
   (`VideoDecoder`) is spec-restricted to *secure contexts* — HTTPS or
   `localhost` — and the control plane
   (`control-plane/src/index.js`, `http.createServer`) only ever speaks
   plain HTTP. On `http://<external-ip>:8080` (a non-localhost, non-HTTPS
   origin), `window.VideoDecoder` is simply absent in every browser, which
   trips the app's own capability check (`web/app.js:174`,
   `!('VideoDecoder' in window)`) and produces that exact message
   regardless of which browser or version you're on.

   Fixed by adding an nginx TLS-terminating reverse proxy in front
   (`gcp/nginx-tls.conf`, `tls-proxy` service in `docker-compose.yml`),
   serving on `:8443` with a self-signed cert generated fresh on the VM by
   `deploy.sh` (the private key never travels over scp). A self-signed
   cert is sufficient — secure-context status depends on the URL scheme,
   not on whether the browser actually trusts the certificate chain.
   **Use `https://<ip>:8443`, not `:8080`, and click through the
   self-signed-certificate warning once.** Verified: WS upgrade requests
   reach the control plane correctly through the proxy (got back the
   app's own `409 Conflict` for an intentionally-premature attach attempt,
   proving the Upgrade/Connection header passthrough works, not just
   plain HTTP).

6. **The real bug behind the black/frozen screen: a race in
   `#connectWithRetry()` (`control-plane/src/stream/scrcpy.js`).** This one
   took the longest to find and is worth understanding in full if it
   recurs. Symptom: the web console shows `READY` with a live WebSocket
   connection, but the viewport stays black forever — 0 fps, 0 kb/s, no
   resolution. No error anywhere by default.

   Root cause: `spawnShell()` returns as soon as the shell command is
   *launched*, not once the JVM inside it has actually started and bound
   its `adb forward` target (`localabstract:scrcpy_<scid>`) — which
   genuinely takes on the order of a second. The very next line calls
   `adb forward` then immediately tries to connect. `adb forward` to a
   `localabstract` target lets the **local** TCP connect succeed instantly
   against adb's own smart-socket layer even when the *device-side* socket
   doesn't exist yet — adb then tears the tunnel down the moment it
   discovers the real destination isn't there. That arrives as a normal
   `'connect'` event followed, within single-digit milliseconds, by
   `'close'`/`'end'` — not a connection error. `#connectWithRetry()` only
   ever retried on outright connect *errors*, so it happily handed back
   this already-dead socket as a "successful" connection. `session.state`
   was already `'ready'` by that point and nothing ever reset it, and
   `#readVideo()`'s failure path called `#shutdown()` with **no logging
   anywhere** — so the whole failure was completely invisible except as a
   permanently-black viewport.

   How this was actually isolated (worth the paper trail, since several
   plausible-looking leads turned out to be red herrings):
   - Attached a raw WS client using the control plane's own bundled `ws`
     package directly against a live session — confirmed *zero* bytes of
     any kind arrive, not even the cached meta/config a late-joining
     viewer should get replayed (ruling out "browser problem").
   - Reproduced the exact `app_process ... Server 2.7 scid=...` invocation
     by hand with real `nc` — worked perfectly and streamed real H.264 for
     as long as I gave the JVM a real head start before connecting. This
     is what first pointed at *timing*, not the protocol itself.
   - A hand-typed `scid=deadbeef` crashed the server with a
     `NumberFormatException`, which looked like a smoking gun (scid
     generated as hex, `Integer.parseInt` looked decimal-only from the
     stack trace) — **this was a red herring.** Fetched the real
     `Options.java` from the tagged `v2.7` source: `scid` is parsed as hex
     (`Integer.parseInt(value, 0x10)`), and `crypto.randomInt(0,
     0x7fffffff)` already keeps every value the app could actually
     generate within the required 31-bit bound. `"deadbeef"` and another
     failing test value only crashed because *I* hand-typed values that
     overflow 31 bits *as hex* — not something the real code path could
     produce. Changing scid to decimal (my first attempted fix) was
     reverted; it was correct already.
   - Only after reverting that and adding explicit error logging to
     `#shutdown()` did the real message surface: `"device closed the
     video stream"`, firing in the same millisecond as `"session
     ready"` — too fast for a JVM to have done anything. Instrumenting
     `#connectWithRetry()` with per-event timestamps confirmed the full
     spawn→forward→connect→close sequence completing in ~22ms total,
     which is what actually pointed at the real bug.

   Fixed by having `#connectWithRetry()` treat a socket that closes within
   a short grace window (250ms) after connecting as a failed attempt to
   retry, not a successful one — rather than trusting the TCP-level
   `'connect'` event alone. Verified 3-for-3 on fresh sessions after the
   fix: `"video stream open"` now logs immediately (previously never
   appeared, ever, across the whole investigation), and a direct
   WebSocket probe through the real token-auth path received the `meta`
   JSON plus 106 real H.264 frames (config + keyframe + deltas, 1.14MB)
   in 8 seconds.

## REST bridge: json-deeplink-viewer on DroidStream

`gcp/json-bridge/` runs a small Python (stdlib-only) sidecar on **:8600**
that bridges DroidStream's ephemeral session pool to the
[json-deeplink-viewer](https://github.com/asosa9991/json-deeplink-viewer)
app — the same "POST JSON, get a screenshot back" pattern already used for
Cuttlefish and the local headless emulator, adapted to a service where
devices are created/destroyed on demand rather than being one fixed box.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"hello":"world"}' \
  http://EXTERNAL_IP:8600/api/json \
  -o screenshot.png
```

Per request, it: finds an existing `ready` session via the control plane's
own `/api/sessions` (or creates one and waits, ~15s cold), installs the APK
if this particular ephemeral session doesn't have it yet (redroid
containers are `--rm`, so a freshly-created session never does), invokes
the deeplink with the same POSIX-single-quote escaping used everywhere
else in this project, waits briefly, and returns a `screencap -p` PNG.
Verified: ~19s cold (session boot + install + render), ~1.5s when an
existing session is reused (confirmed via the `X-Session-Id` response
header staying the same across calls).

**Why a separate `docker port` lookup instead of asking the control
plane's API for the adb port:** `Session.toJSON()`
(`control-plane/src/sessions.js`) deliberately does not expose it — adb is
meant to stay internal to the control plane, not become another public
surface. Since `json-bridge` needs it and runs as a trusted sidecar on the
same host anyway (same trust level as `control-plane` itself, which
already has the Docker socket mounted), it resolves the port itself via
`docker port droidstream-<session-id> 5555/tcp` rather than changing the
app's own public API contract.

Errors: `400` invalid/empty JSON, `413` over `MAX_JSON_BYTES` (8MB
default), `502` if the control plane itself is unreachable, `500` for
anything else (session failed to boot, install failed, `am start` failed,
screenshot failed) — response body names which.

**Scrolling content — filmstrip mode:** a single screenshot only covers one
viewport. Add `?full=1` to instead scroll through the whole page and get
back every position **laid out side-by-side** (a filmstrip), rather than
stitched into one seamless scrolling image:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d @big-payload.json \
  "http://EXTERNAL_IP:8600/api/json?full=1" \
  -o filmstrip.png
```

Deliberately simpler than a true stitch: no overlap/alignment math needed
(that's what made the local-emulator API's equivalent feature tricky to
get right — see `~/android/json-deeplink-viewer/local-server/README.md`).
Here, each swipe's full screenshot is placed into a **grid** —
`FILMSTRIP_COLS` per row (default 3, env-configurable) — with a small
gutter between cells; the only thing that needs detecting is "did
scrolling change anything," to know when the bottom is reached. Response
header `X-Filmstrip-Frames` reports how many frames were captured.
Verified on a 120-row payload: 21 frames on this session's 720×1280
profile (smaller screen than the local emulator's, hence more frames for
the same content), laid out as a 3×7 grid (2176×9008px, matching
3×720+gutters by 7×1280+gutters exactly), `field_000` at the start of
frame 0 through `field_119` at the end of the last frame, no gaps or
duplicates.

Needs Pillow in the `json-bridge` image (already added); `?full=1` without
it returns `501`.

**Light/dark theme:** the app defaults to its original dark look. Add
`?theme=light` for a light render instead (any other value, or omitting
it, stays dark):

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"hello":"world"}' \
  "http://EXTERNAL_IP:8600/api/json?theme=light" \
  -o screenshot.png
```

Explicit per call, not sticky — a request with no `theme` param on a
*reused* session still renders dark, even if the previous call on that
same session asked for light. This is enforced app-side
(`json-deeplink-viewer`'s `__loadFromNative()` re-applies theme, from a
`theme` intent extra, on every single invocation whether it's a cold
start or a repeat call on an already-running session) — `json-bridge`
just passes `--es theme light` through when asked. Filmstrip mode's
gutter color also switches to match. Verified both single-shot and
`?full=1&theme=light` render correctly and legibly (contrast-appropriate
syntax colors, not just the dark palette's hues lightened).

Caveat inherited from DroidStream's own design: sessions are reaped after
5 minutes idle regardless of how `json-bridge` is using them (pure `adb`
traffic doesn't `touch()` the session the way a WebSocket viewer does), so
the next call after a long gap pays the ~15s cold-start cost again. Fine
for occasional/bursty use; for constant use, either lower
`IDLE_TIMEOUT_MS` expectations accordingly or poll `/api/health` from
outside periodically to keep a session warm.

## Admin mode: seeing/attaching to every session

By design, a session's access token is only ever seen by the browser tab
that created it (`GET /api/sessions*` never includes it) — that's the
app's entire access-control model, per `docs/DEPLOYMENT.md`. This means a
different tab, a different browser, or a session created via `curl`/
`json-bridge` shows up in the list as unreachable ("No access token — This
browser did not start that session").

`deploy.sh` now generates a random `ADMIN_TOKEN` on the VM on first deploy
(kept in `.env` next to `docker-compose.yml`, **never committed** — this
repo is public — and never hardcoded into `docker-compose.yml` itself,
which references it as `${ADMIN_TOKEN:-}`). It's printed at the end of
`deploy.sh`'s output; retrieve it again any time with:

```bash
gcloud compute ssh droidstream --zone=us-east1-c --project=droidstream-svc \
  --command='grep ADMIN_TOKEN /opt/droidstream/.env'
```

Paste it into the **"admin token"** field in the web console's top bar
(persisted in that browser's `localStorage`, so it's a one-time setup per
browser). Once set, every request for the session list includes an
`X-Admin-Token` header; the control plane (`control-plane/src/index.js`,
`isAdmin()`) only ever includes the real `token` field in its response
when that header matches, and the browser silently adopts it into
`sessionStorage` the same way it does for sessions it created itself —
after that, tapping *any* session in the list attaches normally.

Verified: `GET /api/sessions/:id` omits `token` with no header and with a
wrong header, includes the correct one only when `X-Admin-Token` matches.

Empty `ADMIN_TOKEN` (the default if you don't run `deploy.sh`'s generation
step, e.g. a manual `docker compose up`) disables the feature entirely —
`isAdmin()` requires a non-empty configured token before comparing.

## Known gaps (from `docs/DEPLOYMENT.md`, worth repeating here)

- **No authentication beyond per-session tokens.** Anyone who can reach
  `:8080` can create sessions and burn resources. Fine for a personal/team
  box behind a firewall you control; put a real identity provider in front
  before this is public.
- **The Docker socket is mounted into the control plane** — equivalent to
  root on the host. Don't expose the API to untrusted callers.
