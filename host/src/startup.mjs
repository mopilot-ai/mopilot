// Whether this Host starts when the machine does, before anyone signs in: on a Mac, when launchd runs it as a system daemon (shared/host/launchDaemon.mjs sets MOPILOT_HOST_SUPERVISED=system); on Linux, when the user's systemd manager lingers (`loginctl enable-linger`). A Mac also says whether FileVault is on, since then the disk must be unlocked after a power loss before anything starts. Asked with each status and kept for a minute.
import { execFile } from 'node:child_process';
import os from 'node:os';

/** @typedef {{ atBoot: 'yes' | 'no' | 'unknown', fileVault: 'on' | 'off' | 'unknown' }} Startup */

const KEEP_MS = 60_000;
const PROBE_MS = 5_000;

/** One command's standard output, or null when it could not run or failed. @param {string} bin @param {string[]} args @returns {Promise<string | null>} */
export const output = (bin, args) =>
  new Promise((resolve) => execFile(bin, args, { timeout: PROBE_MS }, (error, stdout) => resolve(error ? null : String(stdout))));

/**
 * @param {object} [o]
 * @param {NodeJS.Platform} [o.platform]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {string} [o.user] the account the Host runs as
 * @param {(bin: string, args: string[]) => Promise<string | null>} [o.run]
 * @param {() => number} [o.now]
 * @returns {() => Promise<Startup>} calls while one is asked join it
 */
export function createStartupCheck({
  platform = process.platform,
  env = process.env,
  user = os.userInfo().username,
  run = output,
  now = Date.now,
} = {}) {
  /** @returns {Promise<Startup>} */
  async function ask() {
    /** @type {Startup} */
    const unknown = { atBoot: 'unknown', fileVault: 'unknown' };
    // a Host started from a terminal is not the machine's service: whether that one starts at boot is not its to say
    if (!env.MOPILOT_HOST_SUPERVISED) return unknown;
    if (platform === 'darwin') {
      const fv = await run('/usr/bin/fdesetup', ['status']);
      /** @type {Startup} */
      const mac = {
        atBoot: env.MOPILOT_HOST_SUPERVISED === 'system' ? 'yes' : 'no',
        fileVault: fv === null ? 'unknown' : /FileVault is On/.test(fv) ? 'on' : 'off',
      };
      return mac;
    }
    if (platform === 'linux') {
      const linger = (await run('loginctl', ['show-user', user, '--property=Linger', '--value']))?.trim();
      /** @type {Startup} */
      const lin = { ...unknown, atBoot: linger === 'yes' ? 'yes' : linger === 'no' ? 'no' : 'unknown' };
      return lin;
    }
    return unknown;
  }
  /** @type {{ at: number, answer: Promise<Startup> } | null} */
  let kept = null;
  return () => {
    if (!kept || now() - kept.at >= KEEP_MS) kept = { at: now(), answer: ask() };
    return /** @type {{ answer: Promise<Startup> }} */ (kept).answer;
  };
}
