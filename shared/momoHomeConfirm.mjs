// A move the owner must confirm (shared/momoHomeReal.mjs): the first press is refused with words that say what it does and a button that repeats it with a token only the asker was given; only that repeat, soon after, does it. A press that was never asked first, came too late, or carries another's token is refused, so another window or phone cannot confirm what was asked elsewhere.
import { fixId } from './momoFixId.mjs';
import { IntentError } from './momoHomeApi.mjs';

/** How long a confirmation stays open after it was asked. */
export const CONFIRM_MS = 5 * 60_000;

/** @param {{ now: () => number, newId: () => string }} o */
export function createConfirmations({ now, newId }) {
  /** @type {Map<string, { until: number, token: string, data: unknown }>} */
  const asked = new Map();
  return {
    /**
     * Refuses the first press with what it would do. The fix that confirms is `<yes>:<token>:<rest>`: the token is made here and goes only to whoever asked.
     * @param {string} key @param {string} words @param {string} yes @param {string} rest @param {string} label @param {unknown} [data] what was true when it was asked, handed back with the repeat @returns {never}
     */
    ask(key, words, yes, rest, label, data) {
      const token = newId().replaceAll(':', '');
      asked.set(key, { until: now() + CONFIRM_MS, token, data });
      throw new IntentError(words, { fix: { kind: 'fix', id: fixId(yes, token, ...(rest ? [rest] : [])) }, fixLabel: label });
    },
    /** The repeat: valid once, only after it was asked, not long ago, and with the token that was given; what was asked with comes back. @param {string} key @param {string} token */
    consume(key, token) {
      const a = asked.get(key);
      const refused = new IntentError('That has to be asked first, then confirmed.');
      if (!a) throw refused;
      if (a.until < now()) {
        asked.delete(key);
        throw refused;
      }
      // another's token neither confirms nor cancels what was asked
      if (a.token !== token) throw refused;
      asked.delete(key);
      return a.data;
    },
    clear: () => asked.clear(),
  };
}
