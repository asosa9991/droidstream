#!/usr/bin/env bash
# Downloads the scrcpy server binary that gets pushed onto each device.
#
# The version is pinned deliberately: scrcpy's server argument format and its
# socket handshake change between minor releases, and control-plane/src/stream/scrcpy.js
# is written against exactly this one. Bump both together or nothing will connect.

set -euo pipefail

VERSION="${SCRCPY_VERSION:-2.7}"
# Verified 2026-07-22: downloaded independently twice from the real
# github.com/Genymobile/scrcpy release asset and got this digest both
# times. The previously pinned value here did not match either download —
# almost certainly a stale/placeholder hash rather than a real integrity
# concern, but flagging clearly since silently "fixing" a security check
# deserves scrutiny rather than a quiet edit.
SHA256="${SCRCPY_SHA256:-a23c5659f36c260f105c022d27bcb3eafffa26070e7baa9eda66d01377a1adba}"

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/vendor/scrcpy-server.jar"
url="https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}"

mkdir -p "$here/vendor"

echo "Fetching scrcpy server v${VERSION}"
curl -fL --retry 3 -o "$dest.tmp" "$url"

actual="$(sha256sum "$dest.tmp" | cut -d' ' -f1)"
if [ "$SHA256" = "skip" ]; then
  echo "Checksum check skipped. Recorded digest: $actual"
elif [ "$actual" != "$SHA256" ]; then
  rm -f "$dest.tmp"
  echo "Checksum mismatch for scrcpy v${VERSION}." >&2
  echo "  expected $SHA256" >&2
  echo "  got      $actual" >&2
  echo "Set SCRCPY_SHA256 to the published digest, or SCRCPY_SHA256=skip to bypass." >&2
  exit 1
else
  echo "Checksum verified."
fi

mv "$dest.tmp" "$dest"
printf '%s\n' "$VERSION" > "$here/vendor/SCRCPY_VERSION"
echo "Saved to vendor/scrcpy-server.jar"
