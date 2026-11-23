// The push settings and wire names the Mac, the relay and the phone agree on, in one place so no side spells them on its own.

/** The sealed event that hands a phone its per-pair title key (patch: { key: 64 lowercase hex }). */
export const PUSH_TITLE_EVENT = 'push.titleKey';
/** The AEAD associated data prefix of a sealed push title: `"mopilot-push-title-v1|" + ref`. */
export const PUSH_TITLE_AAD_PREFIX = 'mopilot-push-title-v1|';
/** The AEAD associated data prefix of a sealed MoMo push body (A6): `"mopilot-push-body-v1|" + ref`. */
export const PUSH_BODY_AAD_PREFIX = 'mopilot-push-body-v1|';
/** A sealed push body is padded with spaces to this many bytes, so the relay learns nothing from its length. */
export const PUSH_BODY_PAD_BYTES = 160;
/** Longest chat title, in text units, that is sealed into a push. */
export const PUSH_TITLE_MAX_UNITS = 120;

/**
 * What a person can set about notifications. The Mac decides (a push is requested only where a banner would show), so
 * the phone's Settings shows these Mac settings and does not keep copies of its own.
 * - `titlesInPush`: opt-in chat titles in pushes (sealed on device), off by default.
 * - `mode`: prefs.notifyOnComplete; which banners (and so pushes) are allowed.
 * - `kinds`: prefs.notifyKinds; a kind set to false never notifies.
 * - `quietHours`: prefs.notifyQuietHours: banners and pushes wait while they last, and the "needs you" among them are
 *   pushed once when they end (electron/platform/quietHold.cjs); null (the default) means none. MoMo's chats keep their own:
 * - `momoQuietHours`: prefs.momo.routines.quietHours, MoMo only: a "needs you" waits until they end, then one is pushed;
 *   null means none.
 */
export const PUSH_SETTINGS = Object.freeze({
  titlesInPush: Object.freeze({ key: 'titlesInPush', default: false }),
  mode: Object.freeze({ key: 'notifyOnComplete', values: Object.freeze(['unfocused', 'always', 'needed', 'never']), default: 'unfocused' }),
  kinds: Object.freeze({
    key: 'notifyKinds',
    values: Object.freeze(['turn', 'approval', 'scheduled', 'goal', 'auth', 'computer', 'momo']),
    default: true,
  }),
  quietHours: Object.freeze({ key: 'notifyQuietHours', default: null }),
  momoQuietHours: Object.freeze({ key: 'momo.routines.quietHours', default: Object.freeze({ start: '22:00', end: '07:00' }) }),
});

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Quiet hours as `{ start, end }` ("HH:MM", past midnight when end is earlier), or null for none or anything that is not two different clock times. */
export function readQuietHours(/** @type {any} */ v) {
  return CLOCK.test(v?.start) && CLOCK.test(v?.end) && v.start !== v.end ? { start: String(v.start), end: String(v.end) } : null;
}

/** The kinds whose phone push is off until their switch is turned on (`true`): Claude pushes no finished chat unless asked. Their Mac banner stays on unless the switch is `false`. */
export const PUSH_OPT_IN_KINDS = Object.freeze(['turn', 'goal']);

/** Whether a notification of `kind` may push to the phone, given prefs.notifyKinds: an opt-in kind needs its switch `true`, the rest only not `false`. */
export function pushesToPhone(/** @type {any} */ kinds, /** @type {string} */ kind) {
  return PUSH_OPT_IN_KINDS.includes(kind) ? kinds?.[kind] === true : kinds?.[kind] !== false;
}
