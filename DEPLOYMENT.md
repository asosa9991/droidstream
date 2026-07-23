# Deployment

## Picking a host

Run `scripts/preflight.sh` on a candidate instance before you commit to it. What it is
really checking is whether the kernel exposes binderfs, because that is the difference
between "Android runs as a container" and "you need nested virtualization."

| Provider | Shape | Container backend | Notes |
|---|---|---|---|
| AWS | `m7g`, `c7g` (Graviton) | yes | arm64 image runs ARM APKs natively — usually the right choice |
| AWS | `m7i`, `c7i` | yes | x86_64 image; ARM-only APKs need translation |
| GCP | `n2`, `t2a` | yes | Nested virt is available on some N2 shapes but is not needed here |
| Azure | `Dpsv5` (Cobalt) | yes | arm64 |
| Hetzner / OVH / DO | most VPS | yes | Verify the kernel is not an ancient vendor build |
| Fly.io, most container PaaS | — | usually no | You get a container, not a host kernel you can load binder into |

The last row is the real constraint in practice. DroidStream needs a host where *you* own
the kernel — a VM or bare metal. A managed container platform that hands you a namespace
inside someone else's kernel will not let Android's init tree start.

## Sizing

A booted, idle redroid session settles at roughly 1.2–1.8 GB RSS and near-zero CPU. Under
interaction it costs about one core, mostly in SwiftShader.

| vCPU / RAM | Comfortable concurrent sessions |
|---|---|
| 4 / 16 GB | 4–6 |
| 8 / 32 GB | 10–14 |
| 16 / 64 GB | 20–28 |

The control plane itself is negligible: it copies H.264 buffers and never decodes them.
Set `SESSION_MEMORY` and `SESSION_CPUS` so a runaway app cannot take the node down with it.

## Scaling out

The control plane is stateful — it holds sockets to its own devices — so do not put two
replicas behind a round-robin load balancer and hope. Two workable shapes:

**Session-affinity routing.** A thin router keeps `session id → node` and proxies both the
API call and the WebSocket upgrade to the owning node. Simple, and the only piece that
needs to be highly available is the router.

**One control plane per node, scheduler above it.** Each node advertises capacity via
`/api/health`; a scheduler places new sessions on the least loaded node and hands the
client that node's URL directly. No proxying on the hot path, which matters because the
video stream is the hot path.

Either way, sessions are disposable. Reap aggressively — `IDLE_TIMEOUT_MS` defaults to five
minutes without an attached viewer — and never try to migrate one.

## Security

This is the part to read twice.

**Containers share the host kernel.** A session is not the isolation boundary a VM is. If
you run untrusted APKs, run them on nodes dedicated to that, and assume a kernel escape is
possible. `REDROID_PRIVILEGED=1` exists because some hosts need it; understand that it
hands the container the host.

**The Docker socket is mounted into the control plane.** That is equivalent to root on the
host. The control plane is therefore a privileged component: put authentication in front of
it, do not expose it directly, and do not let it execute anything derived from user input.
Replacing the socket mount with a small broker that only accepts a fixed `run` template is
a worthwhile hardening step for any real deployment.

**ADB ports are published to loopback only.** Keep it that way. An exposed 5555 is an
unauthenticated root shell on the device.

**Session tokens are the whole auth model.** There is no user system here. Put a real
identity provider in front of the API, scope tokens to the user who created the session,
and serve everything over TLS — the token travels in the WebSocket query string, where it
will end up in access logs unless you handle it.

## Performance

- **Lower `VIDEO_MAX_SIZE` before you lower bitrate.** SwiftShader cost scales with pixels,
  so 720p at 6 Mb/s feels better than 1080p at 12.
- **`optimizeForLatency` is already set** on the browser decoder; without it Chrome buffers
  several frames and adds visible lag.
- **A GPU on the host is a large win** if you have one. `REDROID_GPU_MODE=host` plus
  `/dev/dri` passthrough moves rendering off the CPU. It needs no virtualization either.
- **Match image ABI to host ABI.** An arm64 image on x86_64 reintroduces the translation
  cost you avoided by not using the emulator.

## Operational notes

- The control plane removes containers labelled `droidstream=session` on startup, so a
  crash does not leak devices.
- `GET /api/sessions/:id/logs` returns the device container's logs. When a session fails
  during boot, that is the first place to look — usually a missing binder mount or the
  image not being pulled.
- `LOG_LEVEL=debug` logs every scrcpy server line and every rejected client message.
