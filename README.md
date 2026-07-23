# DroidStream

Run Android in a browser tab from any VM — no nested virtualization, no `/dev/kvm`, no bare-metal instance.

```
  browser  ──WebSocket──▶  control plane  ──ADB──▶  Android container
 (WebCodecs)                (Node.js)              (redroid, host kernel)
```

---

## The core idea

The Android *emulator* (`emulator` from the SDK) is a QEMU fork. To be usable it needs
hardware virtualization — `/dev/kvm` on Linux. Inside a cloud VM that means **nested
virtualization**, which most providers either disable, charge for, or only expose on
`.metal` shapes.

DroidStream sidesteps the problem by not booting a virtual machine at all.

**Android is a Linux userspace.** With [redroid](https://github.com/remote-android/redroid-doc)
the whole Android system image runs as an ordinary container process tree on the *host's*
kernel — same as any other Docker workload. There is no guest kernel, no hypervisor, no
`/dev/kvm` access, and therefore nothing to nest. It runs on a `t3.medium` as happily as on
bare metal.

The two kernel features Android needs are already in mainline:

| Android requirement | Where it comes from | Availability |
|---|---|---|
| `binder` IPC | `CONFIG_ANDROID_BINDERFS` | Mainline since 5.0 — built into Ubuntu 20.04+, Debian 11+, AL2023 |
| `ashmem` shared memory | Replaced by `memfd` in Android 11+ | Not needed if you run redroid 11 or newer |

So on any reasonably modern distro kernel there are **no modules to compile**. That is the
whole trick, and `scripts/preflight.sh` verifies it in about two seconds.

### When you actually still want the emulator

Containers give you a real Android userspace but not a virtual *device*: no telephony
modem, no sensor injection, no boot-loader, no `emulator` gRPC control surface. If your
tests need those, DroidStream has a second backend that runs the SDK emulator in pure
software (`-accel off`, QEMU TCG). It works on literally any VM and is roughly 10–30×
slower — fine for a smoke test, not for a UI suite. Pick per session:

```jsonc
POST /api/sessions { "backend": "container" }      // default, fast, no virt
POST /api/sessions { "backend": "emulator-tcg" }   // slow, full device emulation
POST /api/sessions { "backend": "emulator-kvm" }   // used only if /dev/kvm exists
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│   canvas  ◀── VideoDecoder (WebCodecs, H.264 Annex-B)        │
│   pointer/key events ──▶ JSON over the same WebSocket        │
└────────────────────────────┬─────────────────────────────────┘
                             │  wss://…/stream?token=…
┌────────────────────────────▼─────────────────────────────────┐
│ Control plane (Node.js)                                      │
│   • session lifecycle + port allocation + idle reaping       │
│   • starts the backend, waits for sys.boot_completed         │
│   • pushes scrcpy-server.jar, opens video + control sockets  │
│   • reframes H.264 for the browser, translates input events  │
└────────────────────────────┬─────────────────────────────────┘
                             │  adb / TCP 5555
┌────────────────────────────▼─────────────────────────────────┐
│ Device backend — one container per session                   │
│   redroid:14  (host kernel, no hypervisor)                   │
│   MediaCodec encodes the framebuffer to H.264 in-guest       │
└──────────────────────────────────────────────────────────────┘
```

Video never gets transcoded on the host. Android's own `MediaCodec` produces H.264, scrcpy
streams the NAL units over ADB, the control plane adds an 11-byte header per access unit,
and the browser's `VideoDecoder` handles it. The host does no pixel work at all, which is
what keeps a single 4-vCPU box usable for a dozen concurrent sessions.

---

## Quick start

```bash
./scripts/preflight.sh          # checks kernel, binderfs, docker, cgroups
./scripts/fetch-scrcpy.sh       # downloads the pinned scrcpy-server.jar
docker compose up --build
open http://localhost:8080
```

`preflight.sh` exits non-zero and tells you exactly which capability is missing, rather
than letting you discover it 90 seconds into a failed boot.

---

## Directory map

```
control-plane/
  src/index.js          HTTP API + WebSocket upgrade
  src/sessions.js       session registry, idle reaping, port pool
  src/adb.js            thin adb wrapper (connect, shell, push, forward)
  src/devices/          one module per backend
    redroid.js            container backend  — no virtualization
    emulator.js           SDK emulator       — TCG or KVM
  src/stream/
    scrcpy.js           launches scrcpy-server, parses the video stream
    control.js          browser events → scrcpy binary control protocol
    bridge.js           wires a device to a WebSocket
web/
  index.html            the console
  app.js                WebCodecs decode loop + input capture
  style.css
scripts/
  preflight.sh          host capability check
  fetch-scrcpy.sh       pinned scrcpy-server download
docs/
  DEPLOYMENT.md         sizing, scaling, security, cloud notes
  PROTOCOL.md           the WebSocket wire format
```

---

## Constraints worth knowing before you commit

**Graphics.** redroid renders with SwiftShader on the CPU by default (`gpu_mode=guest`).
2D apps and most of the framework are fine; heavy 3D is not. If the host has a GPU you can
switch to `gpu_mode=host` and pass through `/dev/dri`, which needs no virtualization
either.

**ABI.** redroid ships `x86_64` and `arm64` images. An arm64 image on an x86_64 host —
or the reverse — needs binary translation, which lands you back in slow-path territory.
Match the image to the host: Graviton/Ampere/Axion hosts get the arm64 image and run ARM
APKs natively, which is usually what you want for real-world app testing.

**Isolation.** Containers share the host kernel. A session is not a security boundary the
way a VM is. Run untrusted APKs on dedicated nodes with seccomp and user namespaces on,
and read `docs/DEPLOYMENT.md` before exposing this to the public.

**Play Services.** redroid images are AOSP. Apps that hard-depend on GMS need microG or a
GMS-bearing image, and licensing that is on you.
