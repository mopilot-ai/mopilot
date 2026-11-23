// A read of the helper's macOS grants (Calendar and Reminders, or Accessibility, Screen Recording and Input Monitoring) by a helper that is not running (#2528): the helper is launched once through LaunchServices (its own responsible process, so the grants are its own), writes them to a file and exits. A running helper is no use for it: it keeps the status it first read, so a switch the user turns on later is seen only by a new process, and System Settings asks the user to "Quit & Reopen" an app that is running when its switch changes.
const { spawn: spawnChild, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The helper's flag for each kind of grant (native/helper main.swift). */
const FLAGS = Object.freeze({ eventkit: '--eventkit-status', permissions: '--permissions-status' });
/** How long the one-shot launch may take before it counts as failed. */
const TIMEOUT_MS = 15_000;

/**
 * @param {{ appPath: string, spawn?: typeof spawnChild }} helper
 * @param {'eventkit' | 'permissions'} kind
 * @param {{ timeoutMs?: number, dir?: string, bin?: string }} [o]
 * @returns {Promise<any>} `{ calendar, reminders, … }` for eventkit, `{ accessibility, screenRecording, inputMonitoring }` for permissions
 */
async function offlineStatus(helper, kind, { timeoutMs = TIMEOUT_MS, dir = os.tmpdir(), bin = '/usr/bin/open' } = {}) {
  const file = path.join(dir, `mpcu-${kind}-${crypto.randomUUID()}.json`);
  const spawn = helper.spawn ?? spawnChild;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, ['-n', '-g', '-W', '-a', helper.appPath, '--args', FLAGS[kind], '--out', file], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('the computer-use helper did not answer'));
      }, timeoutMs);
      child.once('error', (e) => (clearTimeout(timer), reject(e)));
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(undefined);
        else reject(new Error(`the computer-use helper's status read ended with ${code}`));
      });
    });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** tccutil's name for each source macOS asks the helper about. */
const TCC_SERVICE = Object.freeze({ calendar: 'Calendar', reminders: 'Reminders' });

/**
 * Clears macOS's record of the helper's answer for a source (`tccutil reset <service> <bundle id>`, which needs no admin rights),
 * so the next request is asked afresh. For the one helper only, never all apps: used once after a request macOS answered without
 * its prompt (#2999). Resolves whether it worked; never throws.
 * @param {string} entity 'calendar' | 'reminders'
 * @param {{ bundleId: string, exec?: typeof execFile, bin?: string, timeoutMs?: number }} o
 * @returns {Promise<boolean>}
 */
function resetGrant(entity, { bundleId, exec = execFile, bin = '/usr/bin/tccutil', timeoutMs = 5000 }) {
  const service = TCC_SERVICE[/** @type {keyof typeof TCC_SERVICE} */ (entity)];
  if (!service || !bundleId) return Promise.resolve(false);
  return new Promise((resolve) => {
    exec(bin, ['reset', service, bundleId], { timeout: timeoutMs }, (error) => resolve(!error));
  });
}

module.exports = { offlineStatus, resetGrant, FLAGS };
