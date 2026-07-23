import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A single device, addressed by its ADB serial ("127.0.0.1:15601").
 * Everything the streamer needs from the device goes through here.
 */
export class Adb {
  constructor(serial) {
    this.serial = serial;
  }

  async #run(args, opts = {}) {
    const { stdout } = await execFileAsync(
      config.adbBin,
      ['-s', this.serial, ...args],
      { maxBuffer: 8 << 20, timeout: opts.timeout ?? 30_000, encoding: 'utf8' },
    );
    return stdout;
  }

  static async connect(serial, { timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'adb connect never ran';

    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(config.adbBin, ['connect', serial], { timeout: 10_000 });
        if (/connected to/i.test(stdout)) return new Adb(serial);
        lastError = stdout.trim();
      } catch (err) {
        lastError = err.message;
      }
      await sleep(1000);
    }
    throw new Error(`could not reach ${serial} over adb: ${lastError}`);
  }

  async disconnect() {
    try {
      await execFileAsync(config.adbBin, ['disconnect', this.serial], { timeout: 10_000 });
    } catch {
      /* the device may already be gone; that is the desired end state anyway */
    }
  }

  shell(cmd) {
    return this.#run(['shell', cmd]);
  }

  async getProp(name) {
    return (await this.shell(`getprop ${name}`)).trim();
  }

  async push(localPath, remotePath) {
    await this.#run(['push', localPath, remotePath], { timeout: 120_000 });
  }

  /** Map a host TCP port onto an abstract unix socket inside the device. */
  async forward(hostPort, remoteSpec) {
    await this.#run(['forward', `tcp:${hostPort}`, remoteSpec]);
  }

  async removeForward(hostPort) {
    try {
      await this.#run(['forward', '--remove', `tcp:${hostPort}`]);
    } catch {
      /* already removed */
    }
  }

  /** Long-lived shell process; used to host the scrcpy server. */
  spawnShell(cmd) {
    return spawn(config.adbBin, ['-s', this.serial, 'shell', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /**
   * Android reports boot_completed well before the launcher is actually usable,
   * so we also wait for the package manager to stop returning "not ready".
   */
  async waitForBoot({ timeoutMs = config.bootTimeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    let stage = 'waiting for device';

    while (Date.now() < deadline) {
      try {
        if (stage === 'waiting for device') {
          if ((await this.getProp('sys.boot_completed')) === '1') stage = 'waiting for package manager';
        } else {
          const out = await this.shell('pm path android');
          if (out.includes('package:')) {
            log.info(`device ${this.serial} booted`);
            return;
          }
        }
      } catch {
        /* adb daemon still settling */
      }
      await sleep(2000);
    }
    throw new Error(`device ${this.serial} did not finish booting within ${Math.round(timeoutMs / 1000)}s (stalled at: ${stage})`);
  }

  /** Physical display size in pixels, read from the running device. */
  async displaySize() {
    const out = await this.shell('wm size');
    const match = out.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/);
    if (!match) throw new Error(`could not parse display size from: ${out.trim()}`);
    return { width: Number(match[1]), height: Number(match[2]) };
  }
}
