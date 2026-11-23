// The edge driver's offered actions (bench/drivers/edge.mjs): which it must never click (account sign-in, the system
// browser, Chrome when skipped) and how one click went, judged from the UI before and after it.
import { plainQuotes } from './plainText.mjs';

/**
 * A harness account's "sign-in has expired" banner (`.acct-banner`): app-wide, about the VM's own login, never caused
 * by the scenario. Its actions (Re-check, Use another account, Sign in in terminal) are not graded, and its text is not
 * an error a click raised. Other `.acct-banner`s (a harness that keeps quitting) still count.
 * `ACCOUNT_BANNER_TEXT` is the same test as a regular-expression source for the driver's in-page scripts.
 */
export const ACCOUNT_BANNER_TEXT = String.raw`sign-in\b.*\bhas expired`;
const ACCOUNT_BANNER = new RegExp(ACCOUNT_BANNER_TEXT, 'i');
// actions that start signing in to a real account: the driver never takes them
const ACCOUNT_SIGN_IN = /sign in in terminal|^(sign|log) ?in\b|^re-?authenticate/i;

/** @param {{ label?: string, where?: string, context?: string }} o an offered action, or a banner's class and text */
export const isAccountBanner = (o) => /\bacct-banner\b/.test(o.where ?? '') && ACCOUNT_BANNER.test(o.context ?? '');

/**
 * Why the driver must not click an offered action, or null to click it.
 * @param {{ label: string, where?: string, context?: string }} o @param {boolean} skipChrome
 */
export function skipReason(o, skipChrome) {
  if (isAccountBanner(o)) return 'account sign-in banner: not graded';
  if (ACCOUNT_SIGN_IN.test(o.label)) return 'account sign-in: the driver never signs in';
  // the system browser opens on its default profile, which in a bench VM is a signed-in, synced one: no flag can
  // redirect it, so no run clicks it (the first nightly left Chrome open there on the webauthn-get fixture)
  if (/\bopen in (?:your|the default|default) browser\b/i.test(o.label)) return "the system browser's default profile is a real one";
  if (skipChrome && /chrome/i.test(o.label)) return "this VM's Chrome is another run's";
  return null;
}

/**
 * How one click on an offered action went, from the UI before and after it.
 * - `dead-end`: it raised an error, or changed nothing at all.
 * - `stalled`: it is still busy (e.g. "Connecting to Chrome…") when the driver stops waiting.
 * - `worked`: anything else visibly changed (the notice closed, a tab opened, a message was sent).
 * `pane` is the pane's front tab and whether the page shows (an action that brings a tab forward changes only it);
 * `events` counts what the fixture page reported (a reload reports "loaded" again even when the page looks the same).
 * @typedef {{ alerts: string[], notices: string[], tabs: number, chatLength: number, view: string, pane?: string, events?: number }} UiSnap
 * @param {UiSnap} before
 * @param {UiSnap & { busy?: boolean }} after
 */
export function classifyClick(before, after) {
  const fresh = after.alerts.filter((a) => !before.alerts.includes(a));
  const errorish = /fail|can't|cannot|couldn't|could not|error|unable|not available|isn't available/i;
  // the app's own copy says "can’t": the pattern is written plain
  const newErrors = [...fresh, ...after.notices.filter((n) => !before.notices.includes(n))].filter((t) => errorish.test(plainQuotes(t)));
  if (newErrors.length) return { result: 'dead-end', detail: newErrors[0].slice(0, 300) };
  if (after.busy) return { result: 'stalled', detail: 'still busy when the driver stopped waiting' };
  const changed =
    after.tabs !== before.tabs ||
    after.chatLength !== before.chatLength ||
    after.view !== before.view ||
    after.pane !== before.pane ||
    after.events !== before.events ||
    after.notices.join('\n') !== before.notices.join('\n') ||
    fresh.length > 0;
  if (!changed) return { result: 'dead-end', detail: 'nothing visible changed' };
  const what = [
    after.tabs !== before.tabs && `tabs ${before.tabs}→${after.tabs}`,
    after.chatLength !== before.chatLength && 'chat changed',
    after.view !== before.view && `view ${after.view}`,
    after.pane !== before.pane && `pane ${after.pane}`,
    after.events !== before.events && 'the page reported',
    after.notices.join('\n') !== before.notices.join('\n') && 'notices changed',
  ].filter(Boolean);
  return { result: 'worked', detail: what.join(', ') || 'new status text' };
}
