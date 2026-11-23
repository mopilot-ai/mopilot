// What a phone reads and changes of the Mac's notification settings (electron/remote/methods/push.cjs): chat titles in push (the remote's own opt-in), the notification mode and the per-kind switches (the prefs Settings › Notifications writes, saved and heard by every window the way a window's change is), quiet hours (prefs.notifyQuietHours: banners and pushes wait, one push says what needed the person when they end) and MoMo's quiet hours (only for an account MoMo is allowed for).
const { RemoteError } = require('./serviceErrors.cjs');
const { PUSH_SETTINGS, PUSH_OPT_IN_KINDS, readQuietHours } = require('../../shared/remote/pushSettings.mjs');
const { readMomoPrefs, setMomoPref } = require('../../shared/momoPrefs.mjs');

/**
 * @param {object} o
 * @param {() => any} o.prefs the app's prefs
 * @param {(set: Record<string, unknown>) => unknown} o.patchPrefs saves prefs and tells every window (live.patchPrefs)
 * @param {() => { enabled: boolean, setEnabled(on: boolean): Promise<void> } | null} o.titles the running remote's chat-title switch (null while Mobile Remote is off)
 * @param {() => boolean} o.momoOn whether MoMo is allowed for the signed-in account
 */
/** The phone's view of the opt-in kinds before their switch is turned on: off. */
const PUSH_FINISHED_OFF = Object.freeze(Object.fromEntries(PUSH_OPT_IN_KINDS.map((k) => [k, false])));

function createPushSettingsOps({ prefs, patchPrefs, titles, momoOn }) {
  // the switches of the kinds there are: one saved for a kind since retired (a pull request's, #3661) is left behind
  const known = (/** @type {any} */ kinds) =>
    Object.fromEntries(Object.entries(kinds ?? {}).filter(([k]) => PUSH_SETTINGS.kinds.values.includes(k)));
  const read = () => {
    const p = prefs() ?? {};
    const out = {
      titlesInPush: titles()?.enabled === true,
      mode: PUSH_SETTINGS.mode.values.includes(p.notifyOnComplete) ? p.notifyOnComplete : PUSH_SETTINGS.mode.default,
      // a finished chat reaches the phone only where its switch was turned on (notifyPush.cjs), so unset reads as off here
      kinds: { ...PUSH_FINISHED_OFF, ...known(p.notifyKinds) },
      quietHours: readQuietHours(p.notifyQuietHours),
      // MoMo's switch and hours are absent (not null) for an account it is not allowed for
      ...(momoOn() === true && { momoQuietHours: readMomoPrefs(p.momo).routines.quietHours ?? null }),
    };
    if (momoOn() !== true) delete out.kinds.momo;
    return out;
  };
  return {
    get: read,
    /** @param {{ titlesInPush?: boolean, mode?: string, kinds?: Record<string, boolean>, quietHours?: { start: string, end: string } | null, momoQuietHours?: { start: string, end: string } | null }} patch (checked by the schema) */
    async set(patch) {
      // every check first, so a refused patch changes nothing
      const t = patch.titlesInPush === undefined ? null : titles();
      if (patch.titlesInPush !== undefined && !t) throw new RemoteError('failed', 'Mobile Remote is not running.');
      const set = /** @type {Record<string, unknown>} */ ({});
      if (patch.mode !== undefined) set.notifyOnComplete = patch.mode;
      if (patch.kinds !== undefined) set.notifyKinds = { ...known(prefs()?.notifyKinds), ...patch.kinds };
      if (patch.quietHours !== undefined) set.notifyQuietHours = patch.quietHours;
      if (patch.momoQuietHours !== undefined) {
        if (momoOn() !== true) throw new RemoteError('forbidden', 'MoMo is not on for this account.');
        const next = setMomoPref(prefs()?.momo, 'routines.quietHours', patch.momoQuietHours);
        if (!next.ok) throw new RemoteError('invalid', next.error);
        set.momo = next.momo;
      }
      if (Object.keys(set).length && !patchPrefs(set)) throw new RemoteError('failed', 'The settings could not be saved.');
      if (t) await t.setEnabled(patch.titlesInPush === true);
      return read();
    },
  };
}

/** The ops for main's `live` (patchPrefs and the remote's title switch are late-bound there). */
function pushSettingsFor({ live, prefs, momoOn }) {
  return createPushSettingsOps({ prefs, momoOn, patchPrefs: (set) => live.patchPrefs(set), titles: () => live.remote?.pushTitles ?? null });
}

module.exports = { createPushSettingsOps, pushSettingsFor };
