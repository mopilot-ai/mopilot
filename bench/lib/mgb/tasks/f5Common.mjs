// MoPilot 12-Grid Bench (#1381) helpers the F5 cross-surface research tasks share: which browser made a change or a
// page view (the user's Chrome or MoPilot's in-app browser), the lines of a text file the agent wrote, and yes/no words.
import { has } from '../grade.mjs';
import { eventsOf } from './common.mjs';

/**
 * Whether an event came from the user's own Chrome: a browser navigation from Chrome. The oracle's browser sends no user
 * agent, so its events carry no `via` and count for either browser. @param {any} e
 */
export const fromChrome = (e) => !e.via || (e.via === 'browser' && e.browser === 'chrome');
/** Whether an event came from MoPilot's in-app browser (or the oracle's browser). @param {any} e */
export const fromAppBrowser = (e) => !e.via || (e.via === 'browser' && e.browser === 'app-browser');

/** Whether an app logged events of `types`, every one of them in the user's Chrome. @param {any} app @param {string[]} types */
export function allInChrome(app, types) {
  const mine = types.flatMap((t) => eventsOf(app, t));
  return mine.length > 0 && mine.every(fromChrome);
}

/**
 * Whether every one of `wanted` (a page's or vendor's key) has a `viewed` event in the in-app browser, keyed by `keyOf`.
 * @param {any} app @param {string[]} wanted @param {(e: any) => string} keyOf
 */
export function viewedInApp(app, wanted, keyOf) {
  const seen = new Set(eventsOf(app, 'viewed').filter(fromAppBrowser).map(keyOf));
  return wanted.every((k) => seen.has(k));
}

/** The non-blank lines of a text, trimmed. @param {string} text */
export const linesOf = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** The first line of a text that names `needle` and is not skipped. @param {string} text @param {string} needle @param {(l: string) => boolean} skip */
export const lineNaming = (text, needle, skip) => linesOf(text).find((l) => !skip(l) && has(l, needle));

/** Whether a word stands on its own in a text, any case ("EU" in "EU (Dublin)", not in "Europe"). @param {string} text @param {string} word */
export const wordIn = (text, word) => new RegExp(`(?<![A-Za-z0-9])${word}(?![A-Za-z0-9])`, 'i').test(text);

/** "yes" or "no" when a line says exactly one of them, else null. @param {string} line */
export function yesNo(line) {
  const yes = wordIn(line, 'yes');
  const no = wordIn(line, 'no');
  return yes === no ? null : yes ? 'yes' : 'no';
}
