import { existsSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const num = (v, d) => (v === undefined ? d : Number(v));

/** True when this host has a usable /dev/kvm. Almost never inside a plain cloud VM. */
function kvmUsable() {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Choose a backend without being asked. The container backend needs no
 * virtualization, so it wins whenever binderfs is around.
 */
function autoBackend() {
  const binder = existsSync('/dev/binderfs') || existsSync('/dev/binder');
  if (binder) return 'container';
  if (kvmUsable()) return 'emulator-kvm';
  return 'emulator-tcg';
}

export const config = {
  root,
  port: num(process.env.PORT, 8080),
  host: process.env.HOST ?? '0.0.0.0',

  backend: process.env.DROIDSTREAM_BACKEND ?? autoBackend(),
  hasKvm: kvmUsable(),

  // Each session claims one ADB port from this range.
  adbPortRange: [num(process.env.ADB_PORT_MIN, 15600), num(process.env.ADB_PORT_MAX, 15700)],
  maxSessions: num(process.env.MAX_SESSIONS, 8),

  // A session with no attached socket is torn down after this long.
  idleTimeoutMs: num(process.env.IDLE_TIMEOUT_MS, 5 * 60_000),
  bootTimeoutMs: num(process.env.BOOT_TIMEOUT_MS, 180_000),

  adbBin: process.env.ADB_BIN ?? 'adb',
  dockerBin: process.env.DOCKER_BIN ?? 'docker',
  scrcpyJar: process.env.SCRCPY_JAR ?? path.join(root, 'vendor', 'scrcpy-server.jar'),
  scrcpyVersion: process.env.SCRCPY_VERSION ?? '2.7',

  webRoot: path.join(root, 'web'),

  images: {
    // 64-bit only images boot faster and use noticeably less memory.
    'android-14': 'redroid/redroid:14.0.0_64only-latest',
    'android-13': 'redroid/redroid:13.0.0_64only-latest',
    'android-12': 'redroid/redroid:12.0.0_64only-latest',
    'android-11': 'redroid/redroid:11.0.0-latest',
  },
  defaultImage: process.env.DEFAULT_IMAGE ?? 'android-13',

  video: {
    maxSize: num(process.env.VIDEO_MAX_SIZE, 1024), // longest edge, px
    bitRate: num(process.env.VIDEO_BITRATE, 6_000_000),
    maxFps: num(process.env.VIDEO_MAX_FPS, 30),
  },

  profiles: {
    phone: { width: 720, height: 1280, dpi: 320 },
    'phone-hd': { width: 1080, height: 1920, dpi: 440 },
    tablet: { width: 1200, height: 1920, dpi: 240 },
  },
  defaultProfile: process.env.DEFAULT_PROFILE ?? 'phone',
};
