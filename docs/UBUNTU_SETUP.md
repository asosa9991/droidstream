# DroidStream on a fresh Ubuntu server (manual, no cloud CLI needed)

For when you already have SSH access to a plain Ubuntu box — a VPS, bare
metal, or a cloud VM you provisioned some other way — rather than using
`gcp/setup.sh`'s `gcloud`-specific automation. Every step here is plain
`ssh`/`bash`; nothing assumes GCP.

**Target:** Ubuntu 22.04 or 24.04 LTS, x86_64 or arm64, 4+ vCPU / 16+ GB RAM
recommended (redroid sessions cost ~1.5–2GB RAM and ~1 core each while
active). **No nested virtualization, no `/dev/kvm` needed at all** — that's
the entire point of DroidStream's container backend: Android runs on the
host kernel directly, same as any other Docker workload.

---

## 0. Before you start

SSH in with a user that has (or can get) `sudo`:

```bash
ssh youruser@your-server-ip
```

Everything below assumes that shell.

---

## 1. Update the system and install base packages

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg git openssl
```

---

## 2. Install Docker

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Let your user run `docker` without `sudo` (log out and back in for this to
take effect):

```bash
sudo usermod -aG docker "$USER"
```

Verify:

```bash
docker version   # should show both Client and Server sections
```

---

## 3. Confirm the kernel has binderfs

This is the one thing that actually matters for the fast path to work —
everything else is ordinary Docker.

```bash
grep -qw binder /proc/filesystems && echo "binderfs: present" || echo "binderfs: MISSING"
```

If it prints **present**, you're done with this step — skip to §4.

If it prints **MISSING**, install the extra kernel modules package for your
exact running kernel and reload:

```bash
sudo apt-get install -y "linux-modules-extra-$(uname -r)"
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder
grep -qw binder /proc/filesystems && echo "binderfs: present now" || echo "still missing -- see troubleshooting below"
```

---

## 4. Clone the repo

```bash
git clone https://github.com/asosa9991/droidstream.git
cd droidstream
```

---

## 5. Run preflight

This is the project's own host-capability check — confirms binderfs,
Docker, cgroup version, and whether the scrcpy asset is present yet (it
isn't yet, that's expected right now).

```bash
sudo ./scripts/preflight.sh
```

You want to see: **"Verdict: use the container backend. No virtualization
required."** If you see anything else, stop and read the "Troubleshooting"
section below before continuing.

---

## 6. Fetch the scrcpy server

```bash
./scripts/fetch-scrcpy.sh
```

This downloads the exact scrcpy server build the control plane's code is
written against (version and checksum are pinned in the script) into
`vendor/scrcpy-server.jar`. It should say **"Checksum verified."** — if it
ever doesn't for this same pinned version, stop and investigate rather
than passing `SCRCPY_SHA256=skip` (see the script's own comments and
`gcp/README.md`'s bug #1 for why that checksum was wrong once already and
how it was verified as a stale value rather than a real problem).

---

## 7. Generate the TLS certificate for the web console

The control plane itself only speaks plain HTTP, but the browser's video
decoder (WebCodecs) requires a secure context (HTTPS). A self-signed cert
is enough — the browser will show a one-time warning to click through, but
that doesn't affect whether it counts as "secure" for this purpose.

```bash
mkdir -p gcp/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout gcp/tls/key.pem -out gcp/tls/cert.pem \
  -subj "/CN=droidstream"
```

---

## 8. (Optional, recommended) Set an admin token

Without this, a browser tab can only see/attach to sessions *it* created —
a session made via `curl` or another tab shows "No access token." Setting
this lets you paste the token into the web console's "admin token" field
to see and attach to every session on the host. Skip this step entirely to
leave the feature off (the default).

```bash
echo "ADMIN_TOKEN=$(openssl rand -hex 24)" > .env
cat .env   # copy this value somewhere -- you'll paste it into the web console later
```

---

## 9. Bring the stack up

```bash
sudo docker compose up --build -d
```

This builds three images and starts three containers:

| Service | What it is | Port |
|---|---|---|
| `control-plane` | Session orchestration + WebSocket video/input | 8080 (plain HTTP) |
| `tls-proxy` | nginx TLS termination in front of control-plane | 8443 (HTTPS) |
| `json-bridge` | REST bridge: POST JSON → screenshot of it rendered in an Android app | 8600 |

Plus a one-shot `image-warmer` that pre-pulls the ~1.5GB Android container
image so your first session doesn't stall on that download.

Check everything started:

```bash
sudo docker compose ps
sudo docker compose logs control-plane --tail 20
```

---

## 10. Open the firewall

**On the host itself**, if you use `ufw`:

```bash
sudo ufw allow 8443/tcp   # web console (HTTPS)
sudo ufw allow 8600/tcp   # json-bridge REST API
# 8080 is optional -- only needed if you want plain-HTTP API access too;
# the web console itself needs 8443, not 8080, because of the WebCodecs
# secure-context requirement mentioned in step 7.
sudo ufw allow 8080/tcp
sudo ufw enable   # if not already active; check first with `sudo ufw status`
```

**If this host is also behind a cloud provider's separate firewall/security
group** (AWS security group, GCP firewall rule, Hetzner cloud firewall,
etc.), you need to open the same three ports there too — a host-level
`ufw` rule alone won't help if the cloud layer in front of it still blocks
the traffic.

ADB itself needs **no port opened anywhere** — every device's ADB is
published to `127.0.0.1` only, by the app's own design (see
`docs/DEPLOYMENT.md`).

---

## 11. Verify

```bash
curl -s http://127.0.0.1:8080/api/health
curl -sk https://127.0.0.1:8443/api/health
curl -s http://127.0.0.1:8600/api/health
```

All three should return `{"ok":true,...}`. Then from your own machine (not
the server):

```bash
curl -sk https://YOUR_SERVER_IP:8443/api/health
```

If that hangs or refuses, it's almost always the firewall step (§10), not
the application.

**This is not enough to know DroidStream actually works.** All three
health checks above only prove the three always-on services are up —
none of them ever create an Android container. The one thing that
actually exercises the real pipeline (binder/`--privileged`, the
container image, Android boot, the scrcpy stream) is starting a
session, and that's worth doing right now, on the server, before you
ever open a browser — if it's going to fail, better to find out here with
full logs at hand than from a silent "Starting..." in the web console.

```bash
# create a session
SESSION=$(curl -s -X POST http://127.0.0.1:8080/api/sessions -H "Content-Type: application/json" -d "{}")
ID=$(echo "$SESSION" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "session id: $ID"

# poll until it's ready (times out after ~3 minutes, matching the server's own boot timeout)
for i in $(seq 1 60); do
  STATE=$(curl -s "http://127.0.0.1:8080/api/sessions/$ID" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
  echo "[$i] state=$STATE"
  [ "$STATE" = "ready" ] && { echo "BOOTED OK"; break; }
  [ "$STATE" = "failed" ] && { echo "FAILED -- see docker compose logs control-plane"; break; }
  sleep 3
done

# clean up either way
curl -s -X DELETE "http://127.0.0.1:8080/api/sessions/$ID"
```

**If it prints `BOOTED OK`:** the whole pipeline works. Move on to §12.

**If it times out or prints `FAILED`, in this order:**

1. **Check whether the container is still there at all:**
   ```bash
   sudo docker ps -a --filter "label=droidstream=session"
   ```
   Nothing there? It already crashed and was auto-removed (sessions run
   with `--rm`) — a crashed-and-removed container is the single most
   common cause of a boot that "times out" for what looks like no reason.

2. **Check Docker's event log, which persists even for removed containers**
   (a `create` → `start` → `die` sequence seconds apart confirms an
   instant crash rather than a genuine slow boot):
   ```bash
   sudo docker events --filter "label=droidstream=session" --since 10m --until now
   ```

3. **Confirm `REDROID_PRIVILEGED` really made it into your compose file** —
   this exact symptom (container exits immediately, nothing else visibly
   wrong) is what happens without it, because mounting `binder` inside the
   container needs `CAP_SYS_ADMIN`, which this project's default
   `seccomp=unconfined` alone does not grant on many hosts:
   ```bash
   grep -A2 REDROID_PRIVILEGED docker-compose.yml
   ```
   Should show `REDROID_PRIVILEGED: "1"`. If it's missing, add it under
   `control-plane`'s `environment:` block and re-run `sudo docker compose
   up -d --force-recreate control-plane`.

4. **Read the control plane's own log for this session** (look for
   `"starting container"`, `"device booted"`, or an explicit error — the
   presence or absence of `"device booted"` tells you whether it's stuck
   before or after Android's own boot sequence):
   ```bash
   sudo docker compose logs control-plane --tail 50
   ```

5. Still stuck? Bump `LOG_LEVEL: debug` in `docker-compose.yml`, `sudo
   docker compose up -d --force-recreate control-plane`, and repeat the
   session-create test above — the debug log includes every scrcpy
   server line and rejected client message.

---

## 12. Use it

**Web console:** open `https://YOUR_SERVER_IP:8443` in a browser (Chrome,
Edge, or Safari 16.4+ — this needs WebCodecs, which Firefox doesn't enable
by default). Click through the self-signed certificate warning once. Pick
an Android version/screen size and click **Start device** — first boot
takes about 40 seconds.

**REST API** (no browser, no video, just JSON → screenshot):

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"hello":"world"}' \
  http://YOUR_SERVER_IP:8600/api/json \
  -o screenshot.png
```

Useful variations:
- `?theme=light` — light-themed render instead of the default dark
- `?full=1` — scroll through the whole page, return a grid ("filmstrip")
  of every scroll position instead of just one screenshot
- Both together: `?full=1&theme=light`

Every new session defaults to an HD profile (1080×1920 @440dpi) unless you
specify otherwise when creating one through the web console's dropdowns.

---

## Troubleshooting

Real problems hit standing this project up, in the order you're likely to
hit them. Full detail (including exactly how each was diagnosed) is in
`gcp/README.md`.

**`preflight.sh` doesn't say "use the container backend."**
Almost always binderfs (§3). Re-run the check; if `linux-modules-extra`
doesn't exist for your kernel version at all, your provider may ship a
custom kernel — check with them, or fall back to the (much slower)
`emulator-tcg` backend the preflight script itself will suggest.

**`docker: Error response from daemon: client version X.XX is too old`**
The control plane's own container needs a `docker` CLI new enough to talk
to your host's Docker Engine version. This repo's `control-plane/Dockerfile`
already installs from Docker's own apt repo rather than Ubuntu's (older)
bundled package specifically because of this — if you still hit it, your
host's Docker Engine is likely *very* new; check
`docker version --format '{{.Server.Version}}'` on the host against what
`control-plane/Dockerfile` installs.

**A session reaches `ready` but the video never shows anything (0 fps, 0
kb/s, forever).**
This was a real race condition in the original code, already fixed in this
repo (`control-plane/src/stream/scrcpy.js`, `#connectWithRetry()`) — you
shouldn't hit it on a current checkout. If you somehow do, `git log` that
file and re-read the fix's commit message; it explains the exact
mechanism (an `adb forward` connection that succeeds instantly against a
device-side socket that isn't bound yet).

**The web console says "This browser cannot decode the stream."**
You're on `http://` (`:8080`) instead of `https://` (`:8443`). WebCodecs
requires a secure context; the plain-HTTP port will never work for the
video path no matter which browser you use. Use `:8443`.

**redroid container exits immediately, zero log output.**
Needs `--privileged` on some hosts' capability models to mount binder
inside the container (`REDROID_PRIVILEGED=1`, already set in this repo's
`docker-compose.yml`). This is a real, deliberate security tradeoff (it
hands the container the host) — read `docs/DEPLOYMENT.md`'s security
section before deciding whether that's acceptable for your deployment, and
consider dedicating this host to nothing else if you keep it on.

---

## Updating later

```bash
cd droidstream
git pull
sudo docker compose up --build -d
```

Existing sessions survive a `control-plane` restart's image rebuild only
if they're not also removed — check `sudo docker compose logs
control-plane | grep orphan` after restarting; the control plane cleans up
orphaned session containers from a previous run on its own startup by
design.

## Stopping everything

```bash
sudo docker compose down
```

Device containers created by past sessions that are still running (not
managed by compose) get cleaned up the next time `control-plane` starts,
per its own orphan-reaping behavior — or clean them up yourself right now:

```bash
sudo docker ps --filter "label=droidstream=session" -q | xargs -r sudo docker rm -f
```
