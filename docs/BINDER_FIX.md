# Fixing redroid "device offline" / binder failures on modern kernels (6.x)

Companion to `UBUNTU_SETUP.md`. Use this **only** if you've completed that
setup, all three services are healthy, but **starting an Android session
never reaches `ready`** — and the specific cause is a host-kernel binder
incompatibility (very common on Ubuntu's generic 6.8 kernels).

This is a real, known, kernel-version-specific problem in `redroid`
itself, not a mistake in your setup — the upstream issues for it
([#811](https://github.com/remote-android/redroid-doc/issues/811),
[#649](https://github.com/remote-android/redroid-doc/issues/649)) are open
and unresolved. This runbook is the tested way through it.

> **Mission-critical note up front:** the fix has **two mandatory halves** —
> (1) get binder working, and (2) make sure a future kernel update can't
> silently re-break it. Doing only (1) is how people end up back in this
> exact state at 2am after a routine `apt upgrade`. Section 5 is not
> optional.

---

## 1. Confirm you actually have *this* problem

Don't apply this fix blind — verify the symptom first, so you're not
chasing the wrong thing (e.g. an image that simply hasn't been pulled yet).

Create a session and watch it never boot:

```bash
SESSION=$(curl -s -X POST http://127.0.0.1:8080/api/sessions -H "Content-Type: application/json" -d '{}')
ID=$(echo "$SESSION" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "session id: $ID"
sleep 20
sudo docker ps -a --filter "label=droidstream=session"
```

You have the binder problem if **all** of these are true:

- The container above shows **`Up`** (not `Exited`, not absent).
- adb reports the device as **`offline`**:
  ```bash
  PORT=$(sudo docker port "droidstream-$ID" 5555/tcp | head -1 | cut -d: -f2)
  sudo docker exec droidstream-control-plane-1 adb connect 127.0.0.1:$PORT
  sudo docker exec droidstream-control-plane-1 adb -s 127.0.0.1:$PORT get-state
  # -> "offline"  (this is the tell: transport exists, Android never finished booting)
  ```
- The kernel log shows binder transaction failures:
  ```bash
  sudo dmesg | grep -i "binder.*undelivered\|binder.*transaction" | tail
  # -> lines like "binder_linux: undelivered transaction ..., process died"
  ```

Clean up this test session before continuing:
```bash
curl -s -X DELETE "http://127.0.0.1:8080/api/sessions/$ID"
```

If the container was **absent or `Exited`** instead of `Up`, you have a
*different* problem (crash-on-launch) — see `UBUNTU_SETUP.md` §11's
troubleshooting, not this doc.

---

## 2. Record your starting point

```bash
uname -r                      # e.g. 6.8.0-134-generic  -- note the point release (-134)
lsmod | grep binder           # confirms the distro binder_linux is currently loaded
modinfo binder_linux | grep filename
```

The `modinfo` filename will currently point at Ubuntu's distro module
(`.../kernel/drivers/android/binder_linux.ko...`). After Fix A it should
point at a `.../updates/dkms/...` path instead — that's how you'll know the
replacement took.

---

## 3. Fix A (recommended): replace the distro binder module via DKMS

Ubuntu's `linux-modules-extra` binder on a late point release like `-134`
is the prime suspect. Replace it with the actively-maintained module
source, built through **DKMS** — which auto-recompiles the module on every
future kernel update, so you keep getting kernel security patches *and*
binder keeps working. This is the mission-critical-correct choice.

### 3a. Stop the stack and clear stuck containers

```bash
cd ~/droidstream
sudo docker compose down
sudo docker ps -aq --filter "label=droidstream=session" | xargs -r sudo docker rm -f
```

### 3b. Install build tooling and the maintained module

```bash
sudo apt-get update
sudo apt-get install -y dkms git build-essential "linux-headers-$(uname -r)"

cd ~
git clone https://github.com/choff/anbox-modules.git
cd anbox-modules
sudo ./INSTALL.sh
sudo depmod -a
```

`INSTALL.sh` builds the modules into DKMS and sets them to auto-load at
boot.

**If `INSTALL.sh` fails while building `ashmem`** — that's fine and
expected on 6.x. ashmem was removed from the kernel in 5.18 and is **not
needed** for Android 11+ (redroid 13, which DroidStream uses by default,
uses `memfd`). Install just the binder module manually and skip ashmem:

```bash
cd ~/anbox-modules
sudo cp -rT binder /usr/src/anbox-binder-1
sudo dkms install anbox-binder/1
sudo depmod -a
```

**If the *binder* build itself fails**, this module source doesn't support
your kernel yet — read the build log at
`/var/lib/dkms/anbox-binder/1/build/make.log`, then go to **Fix B** (§4).

### 3c. Ensure the right binder devices are created on load

```bash
echo binder_linux | sudo tee /etc/modules-load.d/binder.conf
echo "options binder_linux devices=binder,hwbinder,vndbinder" | sudo tee /etc/modprobe.d/binder.conf
```

### 3d. Reboot so the DKMS module is the one actually loaded

```bash
sudo reboot
```

After it comes back, confirm the **replacement** module is live (filename
now under `updates/dkms/`) and the binder devices exist:

```bash
lsmod | grep binder
modinfo binder_linux | grep filename        # expect .../updates/dkms/...
ls -l /dev/binder /dev/hwbinder /dev/vndbinder
dkms status                                 # expect: anbox-binder, <ver>, <kernel>: installed
```

Bring the stack back up:
```bash
cd ~/droidstream
sudo docker compose up -d
```

Now jump to **§5 (verify)**. If it works, you're done — DKMS handles future
kernel updates for you.

---

## 4. Fix B (fallback): pin to a known-good kernel

Use this only if the DKMS module won't build on your kernel. The `-134`
regression theory (see [#649](https://github.com/remote-android/redroid-doc/issues/649))
says an *earlier* point release likely works.

See what's installed / available and install an earlier one:

```bash
dpkg --list | grep linux-image            # kernels already on disk (bootable via grub)
apt-cache search linux-image-6.8.0        # other point releases you can install
# example: install a specific earlier point release
sudo apt-get install -y linux-image-6.8.0-45-generic linux-modules-extra-6.8.0-45-generic
```

Boot the earlier kernel (via the GRUB "Advanced options" menu, or set it as
default), reload the distro binder module, and run §5's verification. Once
you find a kernel that works, **freeze it** so an update can't replace it:

```bash
sudo apt-mark hold linux-image-generic linux-headers-generic linux-generic
```

Also disable automatic kernel upgrades:
```bash
sudo sed -i 's|^\(\s*\)"${distro_id}:${distro_codename}-security";|\1// "${distro_id}:${distro_codename}-security";|' \
  /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null || true
# (or edit /etc/apt/apt.conf.d/50unattended-upgrades by hand and comment out the security line)
```

> **Tradeoff to accept consciously:** pinning stops kernel security
> updates, which is its own liability for a mission-critical box. That's
> exactly why Fix A (DKMS, keeps updating) is preferred. Only pin if you
> must.

---

## 5. Verify it's genuinely fixed

```bash
SESSION=$(curl -s -X POST http://127.0.0.1:8080/api/sessions -H "Content-Type: application/json" -d '{}')
ID=$(echo "$SESSION" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "session id: $ID"
for i in $(seq 1 60); do
  STATE=$(curl -s "http://127.0.0.1:8080/api/sessions/$ID" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
  echo "[$i] state=$STATE"
  [ "$STATE" = "ready" ] && { echo "BOOTED OK"; break; }
  [ "$STATE" = "failed" ] && { echo "FAILED"; break; }
  sleep 3
done
sudo dmesg | tail -30 | grep -i "undelivered\|binder.*transaction" && echo "!! binder STILL erroring" || echo "binder log clean"
curl -s -X DELETE "http://127.0.0.1:8080/api/sessions/$ID"
```

**Fixed** = reaches `ready` **and** `dmesg` shows no new
undelivered-transaction lines. Confirm end-to-end while you're here:

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"binder":"fixed"}' \
  http://127.0.0.1:8600/api/json -o /tmp/proof.png
file /tmp/proof.png    # -> PNG image data
```

---

## 6. Lock it in for mission-critical (do not skip)

The failure you hit is fundamentally "a kernel change broke binder." Make
that class of event *loud and caught*, not silent:

**If you used Fix A (DKMS):** you keep taking kernel updates, and DKMS
rebuilds binder for each new kernel automatically. But *verify* after every
kernel upgrade + reboot, because a future kernel could still break the
module source:
```bash
dkms status                 # must show anbox-binder ... installed for the running kernel
# then re-run §5's verification loop
```
Consider wiring §5's loop into a post-boot healthcheck / uptime monitor so
you find out before your users do.

**If you used Fix B (pinned kernel):** you're frozen, so binder won't
break — but you've stopped kernel security patches. Put a calendar reminder
to periodically test a newer kernel in a staging copy of this box and move
the pin forward deliberately.

**Snapshot the working machine image now**, whichever fix you used. A known-good
image you can redeploy is the strongest insurance for a mission-critical
host.

---

## 7. If neither fix works — the honest fallback

If binder simply won't cooperate on this host and it's blocking a
mission-critical launch, two escape hatches exist, in order of preference:

1. **A different no-virt host / kernel.** The problem is this specific
   kernel build, not your setup. A box on a different kernel line (or a
   provider that lets you choose one) may "just work" with the standard
   `UBUNTU_SETUP.md` steps.

2. **Software emulator backend — works anywhere, but slow.** DroidStream
   has a backend that bypasses binder/redroid entirely (Google's SDK
   emulator in software mode). 10–30× slower — a stopgap, not a
   destination:
   ```bash
   curl -s -X POST http://127.0.0.1:8080/api/sessions \
     -H "Content-Type: application/json" -d '{"backend":"emulator-tcg"}'
   ```

And the strategic point worth raising with whoever owns the "no-virt"
constraint: redroid trades "needs virtualization" for "production uptime
now depends on the host kernel's binder driver." A single KVM-capable host
running `{"backend":"emulator-kvm"}` removes this entire class of failure
permanently (zero binder dependency, Google-supported emulator). Fix A is a
legitimate answer for no-virt — but for something mission-critical, that
constraint is worth re-confirming deliberately rather than by default.
