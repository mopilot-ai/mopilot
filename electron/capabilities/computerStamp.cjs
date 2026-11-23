// What the computer-use helper client does with a helper whose build stamp is not this app's (#4320): relaunch it once from disk, then refuse it with the fix until the bundle on disk changes.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { stampProblem } = require('./helperStamp.cjs');
const { HelperError, outdatedHelperText } = require('./computerContract.cjs');

/** When the helper bundle's Info.plist last changed: a rebuilt or reinstalled bundle shows here. 0 when unreadable. */
function plistTime(h) {
  try {
    return fs.statSync(path.join(h.appPath, 'Contents/Info.plist')).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The error a refused helper keeps raising, until its bundle on disk changes (then null, and the next call launches it again).
 * @param {any} h the ComputerHelper
 */
function stampRefusal(h) {
  if (!h.outdated) return null;
  if (plistTime(h) !== h.outdated.at) {
    h.outdated = null;
    return null;
  }
  return h.outdated.error;
}

/**
 * Runs one launch and checks the stamp its hello carries. A mismatch stops that helper and launches once more, because the
 * process may be one a bundle replacement left behind; a second mismatch is the bundle itself, so the helper is refused
 * (nothing runs on it) with the fix that applies to this app.
 * @param {any} h the ComputerHelper @param {() => Promise<any>} launch
 */
async function launchStamped(h, launch) {
  // read at each launch: a checkout's helper rebuilt while the app runs is compared with the sources as they are now
  const want = () => (typeof h.expectedDigest === 'function' ? h.expectedDigest() : h.expectedDigest);
  let info = await launch();
  let bad = h.connectTo ? null : stampProblem(info, want());
  if (bad) {
    h.stop();
    info = await launch();
    bad = stampProblem(info, want());
  }
  if (!bad) return info;
  h.stop();
  const error = new HelperError(outdatedHelperText({ fix: h.fix }, `(it ${bad})`), -32000, 'helper_outdated');
  h.outdated = { error, at: plistTime(h) };
  throw error;
}

module.exports = { stampRefusal, launchStamped };
