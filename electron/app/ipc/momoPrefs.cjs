// IPC for MoMo's settings (#2139): one key of prefs.momo set (Reset MoMo resets them, electron/app/ipc/momoReset.cjs), read and merged here in one step so a change never drops another window's or the main chat's; refused while MoMo is not allowed for the account.
const { momoAllowed } = require('../../momo/access.cjs');
const { setMomoPref } = require('../../../shared/momoPrefs.mjs');
const { momoResetting } = require('../../momo/stores.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** A failure with the code the window sees; its message is what the user is told. */
const failure = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const SAVE_FAILED = "Couldn't save MoMo's settings.";
const OWN = new Set(['not_allowed', 'bad_args', 'save_failed', 'busy']);

/**
 * One key of prefs.momo set, read and merged in one step: `{ value: true }`, or `{ error: { message, code } }`. The windows'
 * momoPrefs:set and a paired phone's momo.prefs.set (remote/momoOps.cjs) both go through it.
 * @param {{ readState: () => Record<string, any>, live: { patchPrefs?: (set: Record<string, unknown>) => boolean } }} deps
 * @param {unknown} key @param {unknown} value
 * @param {{ allowed?: () => boolean }} [o] for tests
 */
function setMomoPrefNow({ readState, live }, key, value, { allowed = momoAllowed } = {}) {
  try {
    if (!allowed()) throw failure('not_allowed', 'MoMo is not available.');
    // a reset keeps MoMo paused until its stores are gone (electron/app/ipc/momoReset.cjs)
    if (key === 'paused' && value === false && momoResetting()) throw failure('busy', 'MoMo resumes once its reset is done.');
    // what is saved now, changed and written with nothing in between: another writer's change is never lost
    const r = setMomoPref(readState()?.prefs?.momo, key, value);
    if (!r.ok) throw failure('bad_args', `${SAVE_FAILED} ${r.error}`);
    if (live.patchPrefs?.({ momo: r.momo }) !== true) throw failure('save_failed', SAVE_FAILED);
    return { value: true };
  } catch (err) {
    if (OWN.has(err?.code)) return { error: { message: err.message, code: err.code } };
    // a disk error's text and path are for the log, not the user
    noteIgnored("save MoMo's settings", err);
    return { error: { message: SAVE_FAILED, code: 'save_failed' } };
  }
}

/**
 * @param {{ handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void }} ipcMain
 * @param {{ readState: () => Record<string, any>, live: { patchPrefs?: (set: Record<string, unknown>) => boolean } }} deps
 * @param {{ allowed?: () => boolean }} [o] for tests
 */
function register(ipcMain, deps, o = {}) {
  // errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them)
  ipcMain.handle('momoPrefs:set', (_e, key, value) => setMomoPrefNow(deps, key, value, o));
}

/**
 * What a paired phone's MoMo settings need from main (remote/momoOps.cjs attach, wired by app/automations.cjs): MoMo's
 * access, and setMomoPrefNow over these deps.
 * @param {{ readState: () => any, live: any }} deps @param {{ allowed?: () => boolean }} [o] for tests
 */
function momoPrefsForPhones(deps, { allowed = momoAllowed } = {}) {
  return {
    allowed,
    setPref: (/** @type {unknown} */ key, /** @type {unknown} */ value) => setMomoPrefNow(deps, key, value, { allowed }),
  };
}

module.exports = { register, setMomoPrefNow, momoPrefsForPhones };
