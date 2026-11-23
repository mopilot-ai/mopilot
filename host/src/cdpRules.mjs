// What a tab's CDP commands and events may be (host/src/browserHost.mjs): the commands the service keeps for itself, and how large a page's event may get before it is dropped.

/** A CDP method as `Domain.method`. */
export const METHOD = /^[A-Za-z]+\.[A-Za-z]+$/;
/** The Target methods a tab's own session may call: auto-attach of its frames, and its own info. Every other Target and Browser method is the service's alone. */
export const TARGET_ALLOWED = new Set(['Target.setAutoAttach', 'Target.getTargetInfo']);
/** Methods a tab's session must not call: they move the download folder the service fixed. */
export const REFUSED = new Set(['Page.setDownloadBehavior']);
/** The CDP domains the app's browser tools speak: only these reach the browser; every other (`Browser`, `SystemInfo`, `Storage`, `Tracing`, `Memory`, `ServiceWorker`, ...) and any domain a later Chromium adds is the service's alone. */
export const ALLOWED_DOMAINS = new Set([
  'Accessibility',
  'Animation',
  'Console',
  'CSS',
  'Debugger',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'Emulation',
  'Fetch',
  'Input',
  'IO',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'PerformanceTimeline',
  'Runtime',
  'Security',
  'Target',
]);
/** Whether a tab may be sent to `url`: a web page, or the blank one. Not a file on the Host, nor a page of the browser itself. @param {unknown} url */
export function navigable(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' || u.href === 'about:blank';
  } catch {
    return false;
  }
}
/** The most a page event's parameters may be when serialized: half a wire frame (shared/host/frames.mjs), so the event and its envelope always fit. */
export const MAX_EVENT = 4 * 1024 * 1024;

/**
 * @typedef {{ type: 'cdp', targetId: string, sessionId: string, method: string, params: object }
 *   | { type: 'opened', targetId: string, openerId: string, url: string }
 *   | { type: 'closed', targetId: string }
 *   | { type: 'download', targetId: string, guid: string, [key: string]: unknown }
 *   | { type: 'dropped', targetId: string, sessionId: string, method: string }
 *   | { type: 'exit' }} BrowserEvent what a chat hears about its tabs; `sessionId` is '' for a tab's own session
 */

/** Navigation and dialog commands that change what a tab shows. */
const MOVES = new Set([
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
  'Page.handleJavaScriptDialog',
  'DOM.setFileInputFiles',
]);
/** Pointer events that press nothing: a hover or a scroll changes no page state worth telling. */
const PASSIVE = new Set(['mouseMoved', 'mouseWheel']);
/**
 * What a command does to the page as a person would, for the record of calls sent and not answered (./callIntents.mjs): `input`, `navigation`, or
 * null for one that only reads or hovers. Script evaluation is not told apart here; the tool call that sent it is recorded by the relay.
 * @param {string} method @param {any} [params] @returns {'input' | 'navigation' | null}
 */
export function acts(method, params) {
  if (MOVES.has(method)) return method === 'DOM.setFileInputFiles' || method === 'Page.handleJavaScriptDialog' ? 'input' : 'navigation';
  return method.startsWith('Input.') && !PASSIVE.has(params?.type) ? 'input' : null;
}
