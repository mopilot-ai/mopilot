// MoMo's Google intents for the home's intent table (shared/momoIntents.mjs, lane 'google'): `google {intent, client}`, `source.reconnect {id}` and `source.remove {id}`, run through the sign-in of ./view.mjs; a failure is an IntentError with the one tap that fixes it.
import { IntentError } from '../momoHomeApi.mjs';
import { GOOGLE_INTENTS, runGoogleIntent } from './view.mjs';

const NOT_THIS = 'That is not something MoMo can do.';
/** Said where no browser can be opened for the sign-in (a Host): the sign-in is made from the Mac or phone in hand. */
const NO_DEVICE = 'Sign in to Google from the Mac or the phone you are using.';
/** Said when a Google account was removed here but Google could not be reached: the grant is still live there, and this Host keeps trying. */
export const OWED_NOTICE = 'Disconnected here. Google couldn’t be reached; remove MoPilot at myaccount.google.com/permissions.';
const SOURCES = new Set(['gmail', 'calendar']);

/**
 * The handlers to register with `createIntentRegistry().register('google', …)`. Where the sign-in happens is where the browser (or system sign-in sheet)
 * is, so a device passes its own `startCatcher`; a Host has none and can only remove the account (a sign-in there says where to sign in).
 * @param {object} o
 * @param {(method: string, params: object) => Promise<unknown>} o.call a call to the home's Host (`host.momoGoogle` carries the steps)
 * @param {import('./seal.mjs').Sealer} o.sealer
 * @param {(() => Promise<import('./signIn.mjs').Catcher>) | null} [o.startCatcher]
 * @param {'desktop' | 'ios'} [o.client] the client this device signs in with, for the intents that do not say (`source.*`)
 */
export function googleIntents({ call, sealer, startCatcher = null, client = 'desktop' }) {
  const host = { call: (/** @type {string} */ op, /** @type {object} */ params = {}) => call('host.momoGoogle', { op, ...params }) };
  /** @param {string} intent @param {unknown} as */
  const run = async (intent, as) => {
    if (as !== 'desktop' && as !== 'ios') throw new IntentError(NOT_THIS);
    if (!GOOGLE_INTENTS.includes(intent)) throw new IntentError(NOT_THIS);
    if (intent !== 'remove' && !startCatcher) throw new IntentError(NO_DEVICE);
    const out = await runGoogleIntent({
      intent,
      host,
      startCatcher: /** @type {() => Promise<import('./signIn.mjs').Catcher>} */ (startCatcher),
      sealer,
      client: as,
    });
    if (out.ok) return 'owed' in out && out.owed ? { notice: OWED_NOTICE } : {};
    if (/needs_sign_in/.test(out.code))
      throw new IntentError(out.message, { fix: { kind: 'google', intent: 'reconnect', client: as }, fixLabel: 'Sign in again' });
    if (/different_account|wrong_account/.test(out.code))
      throw new IntentError(out.message, { fix: { kind: 'google', intent: 'remove', client: as }, fixLabel: 'Disconnect Google' });
    throw new IntentError(out.message);
  };
  /** @param {string} intent @param {{ id?: unknown }} i */
  const ofSource = (intent, i) => {
    if (typeof i.id !== 'string' || !SOURCES.has(i.id)) throw new IntentError(NOT_THIS);
    return run(intent, client);
  };
  return {
    google: (/** @type {{ intent: string, client: string }} */ i) => run(i.intent, i.client),
    // Gmail and Calendar are one Google account: either row reconnects or removes both
    'source.reconnect': (/** @type {{ id?: unknown }} */ i) => ofSource('reconnect', i),
    'source.remove': (/** @type {{ id?: unknown }} */ i) => ofSource('remove', i),
  };
}
