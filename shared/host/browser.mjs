// The browser requests of the Host wire (docs: design/host/index.html, package 2.6): a chat's tabs in the Host's headless Chromium. Parsers only; schema.mjs mounts them under `browser.*` so the Mac app and the Host share them.

/** A CDP method as `Domain.method`, a target id and a CDP session id. */
const METHOD = /^[A-Za-z]+\.[A-Za-z]+$/;
const ID = /^[\w.:-]{1,200}$/;

/** The methods, for the feature gate (schema.mjs REQUIRES). */
export const BROWSER_METHODS = Object.freeze([
  'browser.open',
  'browser.attach',
  'browser.detach',
  'browser.command',
  'browser.close',
  'browser.release',
  'browser.abort',
  'browser.tabs',
]);

/**
 * @param {(p: any) => { chatId: string, epoch: number }} scoped the chat and epoch every request names
 * @param {(message: string) => Error} bad the schema's error for a request the client got wrong
 * @returns {Record<string, (p: any) => any>}
 */
export function browserParsers(scoped, bad) {
  const targetOf = (/** @type {any} */ p) => {
    if (typeof p.targetId !== 'string' || !ID.test(p.targetId)) throw bad('That browser tab is not one this app knows.');
    return p.targetId;
  };
  return {
    'browser.open': (p) => scoped(p),
    'browser.tabs': (p) => scoped(p),
    'browser.release': (p) => scoped(p),
    'browser.abort': (p) => scoped(p),
    'browser.attach': (p) => ({ ...scoped(p), targetId: targetOf(p) }),
    'browser.detach': (p) => ({ ...scoped(p), targetId: targetOf(p) }),
    'browser.close': (p) => ({ ...scoped(p), targetId: targetOf(p) }),
    'browser.command': (p) => {
      const sessionId = p.sessionId == null || p.sessionId === '' ? '' : p.sessionId;
      if (sessionId !== '' && (typeof sessionId !== 'string' || !ID.test(sessionId)))
        throw bad('That frame of the page is not one this app knows.');
      if (typeof p.method !== 'string' || !METHOD.test(p.method)) throw bad('That browser command is malformed.');
      if (p.params != null && (typeof p.params !== 'object' || Array.isArray(p.params)))
        throw bad('That browser command has parameters this app cannot read.');
      return { ...scoped(p), targetId: targetOf(p), sessionId, method: p.method, params: p.params ?? {} };
    },
  };
}
