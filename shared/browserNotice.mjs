// The built-in browser's page notices, for main and the pane alike: why a page failed or was stopped, the words the user and the agent see, and the actions a notice offers, each one only where it can work.
//
// A notice's action must be able to do what it says for the state it is shown in (docs/control-plane/edge-cases.md,
// E-X1): Retry reloads the same address, so it is never offered for a page that fails the same way every time (an
// untrusted certificate), for a link to an app (reloading the page that held it changes nothing) or for a page that
// stopped responding (a reload needs its renderer). Those get the way on that works instead: the user's own browser,
// the app the link names (opened only when the user clicks), or stopping the page. A form result that Back or a reload
// could only show by resubmitting the form gets Resubmit (the user's choice, as Chrome's confirm) and Go back.

import { isResubmitError, netErrorMessage, netErrorName, netErrorNote } from './netErrors.mjs';

/**
 * A page notice: `kind` is what happened, `reason` narrows a failure or a block.
 * @typedef {{ kind: string, reason?: string | null }} PageNotice
 */

/** Schemes a page link may never hand to the system: the browser's own, local files and script. */
const NEVER_OPEN = new Set([
  'about',
  'blob',
  'chrome',
  'chrome-extension',
  'chrome-untrusted',
  'data',
  'devtools',
  'file',
  'filesystem',
  'javascript',
  'view-source',
  'ws',
  'wss',
  // system settings panes: a page never opens them, even with the user's click
  'x-apple.systempreferences',
  'ms-settings',
  // network shares and remote sessions, and system handlers a page has no business starting
  'afp',
  'cifs',
  'ftp',
  'nfs',
  'smb',
  'ssh',
  'telnet',
  'vnc',
  'ms-msdt',
  'ms-officecmd',
  'search-ms',
  'shortcuts',
]);

/** Web schemes: blocked only for a user name or password in the address (shared/browser.mjs isWebUrl). */
const WEB = new Set(['http', 'https']);

/** The scheme of a URL ('zoommtg' for zoommtg://...), or '' when it has none. */
export function schemeOf(url) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * What a page that tried to open a non-web address is told: an app link (zoommtg:, slack:, mailto:, tel:) the user
 * may open in its app with a click, or an address the browser never opens (file:, javascript:, chrome:...).
 * @returns {{ reason: 'app-link' | 'address', scheme: string, message: string }}
 */
export function blockedAddress(url) {
  const scheme = schemeOf(url);
  if (scheme && !NEVER_OPEN.has(scheme) && !WEB.has(scheme))
    return {
      reason: 'app-link',
      scheme,
      message: `This page wants to open an app (${scheme}:). Open it only if expected.`,
    };
  if (WEB.has(scheme))
    return {
      reason: 'address',
      scheme,
      message: 'This page tried to open an address with a user name or password in it.',
    };
  return {
    reason: 'address',
    scheme,
    message: `This page tried to open a non-web address${scheme ? ` (${scheme}:)` : ''}, which can't be shown.`,
  };
}

/** Whether a load failure is an untrusted or invalid certificate (Chromium's ERR_CERT_*, codes -200 to -299). */
export function isCertificateError(code, description = '') {
  return (typeof code === 'number' && code <= -200 && code > -300) || /(^|::)ERR_CERT_/.test(String(description));
}

/**
 * The notice for a page that failed to load: Chrome's words for the error, with its code as the notice's `detail`.
 * @returns {{ reason: 'certificate' | 'resubmit' | 'load', message: string, detail: string }}
 */
export function loadFailure(code, description = '') {
  const what = description || String(code);
  if (isCertificateError(code, description))
    return {
      reason: 'certificate',
      message: `This site's certificate isn't trusted (${what}), so it won't open here.`,
      detail: what,
    };
  const name = netErrorName(code, description);
  const message = netErrorMessage(name);
  if (!message) return { reason: 'load', message: `Couldn't load this page (${what}).`, detail: what };
  return { reason: isResubmitError(name) ? 'resubmit' : 'load', message, detail: name };
}

/** What an agent's call says when the page it opened failed to load: why, and what the user can do. */
export function loadFailureNote(description) {
  const what = String(description || 'unknown error');
  if (isCertificateError(null, what))
    return `Couldn't load this page: its security certificate isn't trusted (${what}). The built-in browser never bypasses certificate errors, so retrying won't help. Tell the user; the browser pane offers to open the site in their own browser.`;
  return netErrorNote(netErrorName(null, what), what);
}

/** What an agent's navigate says when Chromium refused to open `url` (Page.navigate's errorText): why, and what to do. */
export function openFailureNote(url, errorText) {
  const what = String(errorText || 'unknown error');
  return netErrorNote(netErrorName(null, what), what, `Couldn't open ${url}`);
}

/** Whether a tab's failure (its description) is a form result only resubmitting shows again: no agent resubmits it. */
export const isResubmitFailure = (description) => isResubmitError(netErrorName(null, description));

/** Why an agent's reload of a form result was refused, and what it can do instead. */
export function formReloadNote(tabId) {
  return `Didn't reload ${tabId}: its page is the result of a form submission, and reloading it would submit that form again (it may repeat a submission or payment). If it was only a search or query, submit the form again or open the result's address; otherwise ask the user, who can resubmit from the browser pane.`;
}

/** What the agent learns when a page it drives tried to open an app link or another non-web address. */
export function blockedAddressNote(tabId, url) {
  const b = blockedAddress(url);
  if (b.reason === 'app-link')
    return `app_link ${tabId}: the page tried to open a ${b.scheme}: link, which opens an app, not a web page. The built-in browser doesn't open apps; the browser pane offers the user "Open in app". Tell the user rather than clicking it again.`;
  return `blocked_address ${tabId}: the page tried to open a ${b.scheme || 'non-web'} address, which the built-in browser never opens. Use an http or https address, or tell the user.`;
}

/** The pane's words for a page whose renderer crashed (not the memory guard's stop): unlike a hung page, it is gone. */
export const CRASHED_MESSAGE = 'This page crashed. Reload it to continue.';

/** The pane's words for a page that stopped responding. */
export const UNRESPONSIVE_MESSAGE = "This page isn't responding: a script is busy. Wait, reload or close it.";

/** The error every browser call on a page that stopped responding fails with, at once instead of after its timeout. */
export function unresponsiveNote(tabId) {
  return `${tabId} isn't responding: a script on the page is busy, so browser actions on it fail until it responds again. Don't retry it now: tell the user, who can wait, reload or close the tab from the browser pane.`;
}

/**
 * Every action a page notice can offer, with its label. The pane has a handler for each (PageNotice.tsx).
 * @type {Record<'retry' | 'reload' | 'stop' | 'chrome' | 'openBrowser' | 'openApp' | 'dismiss' | 'wait' | 'restart' | 'closeTab' | 'closeWindow' | 'resubmit' | 'back', string>}
 */
export const NOTICE_ACTIONS = {
  retry: 'Retry',
  // a form result: sends the form again (a reload can't: Electron cancels a reload that would resubmit)
  resubmit: 'Resubmit',
  back: 'Go back',
  // a crashed page: Retry's reload, in a new renderer, under the word for what it does
  reload: 'Reload',
  stop: 'Stop loading',
  chrome: 'Continue in Chrome',
  openBrowser: 'Open in your browser',
  openApp: 'Open in app',
  dismiss: 'Dismiss',
  wait: 'Wait',
  restart: 'Reload',
  closeTab: 'Close tab',
  closeWindow: 'Close window',
};

/** The kinds of main's page events the pane shows as a notice with actions (BrowserPanel); the rest are page state. */
export const PANE_NOTICE_KINDS = ['failed', 'crashed', 'slow', 'blocked', 'unresponsive'];

/** Notices main lets the user put away (windows.cjs dismiss): the page itself is fine, or shows its own error. */
export const DISMISSABLE = ['failed', 'blocked'];

/**
 * What a notice's close button does (every notice has one, as ChatGPT's browser banners do; #1523): a notice main
 * can put away is Dismissed there; a page that stopped responding may still recover, so closing its notice is Wait;
 * a crashed or slow page's notice is only hidden in the pane until main says it again (main keeps the state), as
 * Wait hides a hung page's.
 * @param {PageNotice} notice
 * @returns {'dismiss' | 'wait' | 'hide'}
 */
export const noticeCloseAction = (notice) =>
  DISMISSABLE.includes(notice.kind) ? 'dismiss' : notice.kind === 'unresponsive' ? 'wait' : 'hide';

/**
 * The actions a page notice offers as buttons, in order: only those that can work for its kind and reason. Dismiss is
 * the notice's close button (noticeCloseAction), never a button of its own.
 * @param {PageNotice} notice
 * @param {{ loading?: boolean, back?: boolean, chat?: boolean, url?: string, popup?: boolean }} [ctx] loading: the page is still
 *   loading; back: it has an earlier page (a form result opened in a new tab has none to go back to); chat: the pane is beside a chat (a hand-off has someone to continue); url: the page's address (only a
 *   web address opens in the user's browser); popup: the page is a popup window of the tab (it closes as a window)
 * @returns {(keyof typeof NOTICE_ACTIONS)[]}
 */
export function noticeActions(notice, { loading = false, back = true, chat = false, url = '', popup = false } = {}) {
  const web = /^https?:\/\//i.test(url);
  /** @type {(keyof typeof NOTICE_ACTIONS | false)[]} */
  let out;
  if (notice.kind === 'unresponsive') out = ['wait', 'restart', popup ? 'closeWindow' : 'closeTab'];
  else if (notice.kind === 'blocked') out = [notice.reason === 'app-link' && 'openApp'];
  else if (notice.kind === 'failed' && notice.reason === 'certificate') out = [web && 'openBrowser'];
  else if (notice.kind === 'failed' && notice.reason === 'input') out = [];
  else if (notice.kind === 'failed' && notice.reason === 'resubmit') out = ['resubmit', back && 'back'];
  else if (notice.kind === 'crashed') out = ['reload', chat && 'chrome'];
  else out = ['retry', loading && 'stop', chat && 'chrome'];
  return /** @type {(keyof typeof NOTICE_ACTIONS)[]} */ (out.filter(Boolean));
}
