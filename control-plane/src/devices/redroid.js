import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { Adb } from '../adb.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

/**
 * Android as a container on the host kernel.
 *
 * There is no guest kernel and no hypervisor here, so nothing needs to be
 * nested. The container gets binderfs from the host and runs the Android init
 * tree as ordinary processes. This is the backend that makes the whole service
 * work on a stock cloud VM.
 */
export class RedroidDevice {
  constructor({ id, adbPort, image, profile }) {
    this.id = id;
    this.adbPort = adbPort;
    this.image = image;
    this.profile = profile;
    this.containerName = `droidstream-${id}`;
    this.serial = `127.0.0.1:${adbPort}`;
    this.adb = null;
  }

  get backend() {
    return 'container';
  }

  #dockerArgs() {
    const { width, height, dpi } = this.profile;

    const args = [
      'run', '--detach', '--rm',
      '--name', this.containerName,
      '--label', 'droidstream=session',
      '--label', `droidstream.session=${this.id}`,

      // Android's low-memory killer behaves badly if the host swaps it out.
      '--memory-swappiness', '0',
      '--memory', process.env.SESSION_MEMORY ?? '3g',
      '--cpus', process.env.SESSION_CPUS ?? '2',
      '--pids-limit', '4096',

      // ADB only, bound to loopback. The control plane is the only client.
      '--publish', `127.0.0.1:${this.adbPort}:5555`,
    ];

    // redroid mounts binderfs itself when the host kernel provides it. Some
    // hosts (older Docker + cgroup v1, or a restrictive seccomp default) reject
    // that; the escape hatch is explicit rather than silently privileged.
    if (process.env.REDROID_PRIVILEGED === '1') {
      args.push('--privileged');
    } else {
      args.push('--security-opt', 'seccomp=unconfined');
    }

    if (process.env.REDROID_GPU_MODE === 'host') {
      args.push('--device', '/dev/dri');
    }

    args.push(this.image);

    // Everything after the image name is appended to the Android kernel cmdline.
    args.push(
      `androidboot.redroid_width=${width}`,
      `androidboot.redroid_height=${height}`,
      `androidboot.redroid_dpi=${dpi}`,
      `androidboot.redroid_gpu_mode=${process.env.REDROID_GPU_MODE ?? 'guest'}`,
      'androidboot.redroid_net_ndns=1',
      'androidboot.redroid_net_dns1=8.8.8.8',
    );

    return args;
  }

  async start() {
    log.info('starting container', { session: this.id, image: this.image });

    try {
      await execFileAsync(config.dockerBin, this.#dockerArgs(), { timeout: 120_000 });
    } catch (err) {
      const detail = (err.stderr || err.message || '').trim();
      if (/no such image|manifest unknown|pull access denied/i.test(detail)) {
        throw new Error(`image ${this.image} is not available locally. Pull it first: docker pull ${this.image}`);
      }
      throw new Error(`could not start container: ${detail}`);
    }

    this.adb = await Adb.connect(this.serial, { timeoutMs: 90_000 });
    await this.adb.waitForBoot();

    // Trust the device over the profile: redroid can clamp odd dimensions.
    this.displaySize = await this.adb.displaySize();
    return this;
  }

  async logs({ tail = 200 } = {}) {
    const { stdout } = await execFileAsync(
      config.dockerBin,
      ['logs', '--tail', String(tail), this.containerName],
      { maxBuffer: 4 << 20 },
    );
    return stdout;
  }

  async stop() {
    if (this.adb) await this.adb.disconnect();
    try {
      // redroid handles SIGTERM poorly and can leave binder references behind;
      // a short grace period then a kill is cleaner than waiting 10s for nothing.
      await execFileAsync(config.dockerBin, ['stop', '--time', '3', this.containerName], { timeout: 30_000 });
    } catch (err) {
      log.warn('container stop failed, forcing removal', { session: this.id, error: err.message });
      try {
        await execFileAsync(config.dockerBin, ['rm', '--force', this.containerName], { timeout: 30_000 });
      } catch {
        /* already gone */
      }
    }
  }
}

/** Removes containers left behind by a control-plane crash. */
export async function reapOrphans() {
  try {
    const { stdout } = await execFileAsync(config.dockerBin, [
      'ps', '--quiet', '--filter', 'label=droidstream=session',
    ]);
    const ids = stdout.split('\n').filter(Boolean);
    if (!ids.length) return 0;
    await execFileAsync(config.dockerBin, ['rm', '--force', ...ids], { timeout: 60_000 });
    log.warn('removed orphaned containers from a previous run', { count: ids.length });
    return ids.length;
  } catch {
    return 0;
  }
}
