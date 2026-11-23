// The desktop requests of the Host wire (G8, #3903): a chat's lease on the Host's one desktop and the helper calls it may make while it holds it. Parsers and the allowlist only; schema.mjs mounts them under `desktop.*` so the Mac app and the Host share them.

/** A bundle id, as the helper validates one. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
/** A client-made id for one call: the Host answers a repeat of it with the first answer instead of acting twice. */
const CALL_ID = /^[\w.:-]{8,100}$/;
/** Where a chat lives when that cannot be told: a tool call for it fails, and is never run on this Mac in its place (electron/capabilities/hostDesktop.cjs). */
export const UNKNOWN_OWNER = '\u0000unknown-owner';
/** The most apps one lease may name. */
const MAX_APPS = 64;
/** What a lease grants when it is not a list of apps: any app the helper's hard floor lets through. */
export const ANY_APP = '*';
/** The only requests a lease with no apps yet may make: a chat looks up the apps it will ask for before it has any grant. */
export const LOOKUPS = Object.freeze(new Set(['apps.list', 'apps.resolve', 'displays.list']));

/** The methods, for the feature gate (schema.mjs REQUIRES). */
export const DESKTOP_METHODS = Object.freeze(['desktop.lease', 'desktop.call', 'desktop.release', 'desktop.abort', 'desktop.state']);

/**
 * The helper methods a lease may call: what the `desktop_*` tools need, and nothing else. Not here on purpose: permission
 * prompts and settings (`permissions.*`), the deny list (`deny.set`), `shutdown`, scripts and shortcuts (`app.script`,
 * `shortcuts.*`), the pasteboard, recording, speech, EventKit and activity reads, and hiding the other apps.
 */
export const DESKTOP_CALLS = Object.freeze([
  'screenshot',
  'ax.snapshot',
  'ocr.elements',
  'target.info',
  'input.click',
  'input.type',
  'input.key',
  'input.scroll',
  'input.move',
  'input.drag',
  'input.button',
  'input.release',
  'input.cursor',
  'input.paste',
  'apps.list',
  'apps.resolve',
  'apps.open',
  'displays.list',
  'ax.press',
  'ax.focus',
  'text.focused',
  'text.insert',
  'screen.settle',
  'app.windows',
  'app.screenshot',
  'app.zoom',
  'app.press',
  'app.focus',
  'app.setText',
  'app.key',
  'app.click',
  'app.drag',
  'app.scroll',
  'app.filePanel',
  'app.menu',
  'app.menuRefresh',
  'app.bringToCurrentSpace',
  'app.marks',
  'app.cancel',
]);

/** The calls that only look: they change nothing on the desktop, so a repeat is harmless and is not remembered. */
export const DESKTOP_READS = Object.freeze(
  new Set([
    'screenshot',
    'ax.snapshot',
    'ocr.elements',
    'target.info',
    'input.cursor',
    'apps.list',
    'apps.resolve',
    'displays.list',
    'text.focused',
    'screen.settle',
    'app.windows',
    'app.screenshot',
    'app.zoom',
    'app.marks',
  ]),
);

const ALLOWED = new Set(DESKTOP_CALLS);

/** Whether the helper method is one a lease may call. @param {unknown} method */
export const desktopCallAllowed = (method) => typeof method === 'string' && ALLOWED.has(method);

/**
 * @param {(p: any) => { chatId: string, epoch: number }} scoped the chat and epoch every request names
 * @param {(message: string) => Error} bad the schema's error for a request the client got wrong
 * @returns {Record<string, (p: any) => any>}
 */
export function desktopParsers(scoped, bad) {
  return {
    'desktop.lease': (p) => {
      const apps = p.apps === ANY_APP ? ANY_APP : p.apps;
      if (apps !== ANY_APP) {
        // an empty list is a lease with no apps yet: only the lookups (LOOKUPS) are served until the chat has grants
        if (!Array.isArray(apps) || apps.length > MAX_APPS || !apps.every((a) => typeof a === 'string' && BUNDLE_ID.test(a)))
          throw bad('Name the apps this chat may control, or none yet.');
      }
      return { ...scoped(p), apps: apps === ANY_APP ? ANY_APP : [...new Set(/** @type {string[]} */ (apps))] };
    },
    'desktop.release': (p) => scoped(p),
    'desktop.abort': (p) => scoped(p),
    'desktop.state': (p) => scoped(p),
    'desktop.call': (p) => {
      if (!desktopCallAllowed(p.method)) throw bad('That desktop action is not one a Host serves.');
      if (typeof p.callId !== 'string' || !CALL_ID.test(p.callId)) throw bad('That desktop action has no valid call id.');
      if (p.params != null && (typeof p.params !== 'object' || Array.isArray(p.params)))
        throw bad('That desktop action has parameters this app cannot read.');
      return { ...scoped(p), callId: p.callId, method: p.method, params: p.params ?? {} };
    },
  };
}
