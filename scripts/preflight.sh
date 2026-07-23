#!/usr/bin/env bash
# Checks whether this host can run DroidStream, and which backend it should use.
# Exit 0 = container backend available (no virtualization needed).
# Exit 3 = only the software emulator will work.
# Exit 1 = nothing will work; the message says what to fix.

set -uo pipefail

pass=0; warn=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n'  "$1"; fail=$((fail+1)); }

echo
echo "DroidStream preflight — $(uname -sr) on $(uname -m)"
echo

# ---------------------------------------------------------------- environment
echo "Environment"
virt="$(systemd-detect-virt 2>/dev/null || echo unknown)"
if [ "$virt" = "none" ]; then
  ok "bare metal"
else
  ok "running inside '$virt' — this is the case DroidStream is built for"
fi

if [ -e /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  ok "/dev/kvm is usable — the emulator-kvm backend is available as a bonus"
  HAS_KVM=1
else
  ok "no usable /dev/kvm — expected, and not required"
  HAS_KVM=0
fi

# ---------------------------------------------------------------------- kernel
echo
echo "Kernel"
kver="$(uname -r | cut -d- -f1)"
kmaj="${kver%%.*}"; krest="${kver#*.}"; kmin="${krest%%.*}"
if [ "$kmaj" -gt 5 ] || { [ "$kmaj" -eq 5 ] && [ "$kmin" -ge 4 ]; }; then
  ok "kernel $kver is new enough for binderfs"
else
  bad "kernel $kver is older than 5.4; binderfs may be missing"
fi

# binder: built in, loadable module, or already mounted — any of the three is fine.
binder_state=""
if [ -d /dev/binderfs ] || grep -qw binder /proc/filesystems 2>/dev/null; then
  binder_state="present"
elif modprobe -n binder_linux >/dev/null 2>&1 || modprobe -n binder >/dev/null 2>&1; then
  binder_state="loadable"
fi

case "$binder_state" in
  present)  ok "binderfs is available" ;;
  loadable) note "binder is not loaded yet; run: sudo modprobe binder_linux devices=binder,hwbinder,vndbinder" ;;
  *)        bad "no binderfs and no binder module — install linux-modules-extra-$(uname -r), or use the emulator-tcg backend" ;;
esac

# ashmem is only needed for Android 10 and below. We ship 13/14.
if grep -qw ashmem /proc/misc 2>/dev/null; then
  ok "ashmem present (not required for Android 11+)"
else
  ok "no ashmem — fine, Android 11+ uses memfd"
fi

# ------------------------------------------------------------------ container
echo
echo "Container runtime"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "docker is reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
else
  bad "docker is not running or the current user cannot reach it"
fi

if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  ok "cgroup v2"
else
  note "cgroup v1 — works, but per-session memory limits are less reliable"
fi

# --------------------------------------------------------------------- assets
echo
echo "Assets"
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$here/vendor/scrcpy-server.jar" ]; then
  ok "scrcpy-server.jar is present"
else
  note "scrcpy-server.jar is missing; run ./scripts/fetch-scrcpy.sh"
fi

# --------------------------------------------------------------------- verdict
echo
if [ "$fail" -eq 0 ] && [ "$binder_state" = "present" ]; then
  echo "Verdict: use the container backend. No virtualization required."
  echo "  DROIDSTREAM_BACKEND=container"
  exit 0
fi

if [ "$fail" -eq 0 ]; then
  echo "Verdict: load the binder module, then re-run. Container backend will work."
  exit 0
fi

if [ "$HAS_KVM" -eq 1 ]; then
  echo "Verdict: container backend unavailable, but /dev/kvm works."
  echo "  DROIDSTREAM_BACKEND=emulator-kvm"
  exit 3
fi

echo "Verdict: fall back to software emulation. Expect 10–30× slower than native."
echo "  DROIDSTREAM_BACKEND=emulator-tcg"
exit 3
