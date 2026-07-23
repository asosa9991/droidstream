import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { Adb } from '../adb.js';
import { log } from '../log.js';

/**
 * The real SDK emulator, for sessions that need a virtual *device* rather than
 * just an Android userspace: telephony, sensor injection, boot-loader state,
 * the emulator gRPC console.
 *
 * Two modes:
 *   emulator-kvm  needs /dev/kvm, which inside a VM means nested virtualization
 *   emulator-tcg  pure software translation, runs anywhere, 10-30x slower
 *
 * Mode is not guessed at runtime. A session that silently fell back to TCG
 * would look like a broken test suite rather than a slow one.
 */
export class EmulatorDevice {
  constructor({ id, adbPort, avd, accel }) {
    this.id = id;
    this.adbPort = adbPort;
    this.avd = avd ?? process.env.AVD_NAME ?? 'droidstream';
    this.accel = accel === 'emulator-kvm' ? 'kvm' : 'tcg';
    this.serial = `emulator-${adbPort}`;
    this.proc = null;
    this.adb = null;
  }

  get backend() {
    return this.accel === 'kvm' ? 'emulator-kvm' : 'emulator-tcg';
  }

  #args() {
    const args = [
      '-avd', this.avd,
      '-port', String(this.adbPort),
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-no-snapshot',
      // Wipe on every start so sessions never inherit each other's state.
      '-wipe-data',
    ];

    if (this.accel === 'kvm') {
      args.push('-accel', 'on', '-gpu', 'swiftshader_indirect');
    } else {
      // TCG: every guest instruction is translated on the CPU. Keep the render
      // path off the critical path and give the guest as few cores as it can
      // tolerate — extra vCPUs make TCG slower, not faster, because of the
      // translation block lock.
      args.push(
        '-accel', 'off',
        '-gpu', 'swiftshader_indirect',
        '-cores', '1',
        '-memory', '2048',
      );
    }
    return args;
  }

  async start() {
    if (this.accel === 'kvm' && !config.hasKvm) {
      throw new Error('emulator-kvm was requested but /dev/kvm is not usable here. Use backend "container", or "emulator-tcg" if you need a full virtual device.');
    }
    if (this.accel === 'tcg') {
      log.warn('starting software-emulated device; boot typically takes several minutes', { session: this.id });
    }

    this.proc = spawn(process.env.EMULATOR_BIN ?? 'emulator', this.#args(), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.proc.stderr.on('data', (b) => log.debug('emulator', { session: this.id, out: b.toString().trim() }));

    const exited = new Promise((_, reject) => {
      this.proc.once('exit', (code) => reject(new Error(`emulator exited early with code ${code}`)));
    });

    this.adb = new Adb(this.serial);
    // TCG boots are slow enough that the normal timeout is meaningless.
    const bootTimeoutMs = this.accel === 'tcg' ? 20 * 60_000 : config.bootTimeoutMs;

    await Promise.race([exited, this.adb.waitForBoot({ timeoutMs: bootTimeoutMs })]);
    this.displaySize = await this.adb.displaySize();
    return this;
  }

  async stop() {
    if (this.adb) {
      try {
        await this.adb.shell('reboot -p');
      } catch {
        /* fall through to SIGTERM */
      }
      await this.adb.disconnect();
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      setTimeout(() => this.proc?.kill('SIGKILL'), 5000).unref();
    }
  }
}
