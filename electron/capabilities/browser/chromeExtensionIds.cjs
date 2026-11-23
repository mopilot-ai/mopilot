// The ids MoPilot's own Chrome extension may have (#1632): the dev key's, loaded unpacked, and the Chrome Web Store's; the one place main checks an origin or picks the extension's page.
//
// The unpacked extension's id is fixed by the public key in electron/chrome-extension/manifest.json. The store
// assigns its own id when the item is created. The edition configuration controls whether a packaged build offers
// that listing and registers a native host. The socket, pairing page and profile probe use these same ids.
const { desktop } = require('../../../shared/edition.json');

/** The id Chrome gives the extension loaded unpacked: fixed by the public key in its manifest. */
const DEV_EXTENSION_ID = 'jhnfobeoiefjfneilcdkljfnapchmoej';

/**
 * The edition's Chrome Web Store listing, or null when it uses the unpacked extension.
 * @type {string | null}
 */
const STORE_EXTENSION_ID = desktop.chromeWebStoreId;

/** What a Chrome extension id is: 32 letters a to p. */
const ID_SHAPE = /^[a-p]{32}$/;

/**
 * The ids main accepts, the store's first (it is the one users install), then the dev key's. A store id that isn't an
 * extension id is left out.
 * @param {{ storeId?: string | null }} [o]
 * @returns {string[]}
 */
function extensionIds({ storeId = STORE_EXTENSION_ID } = {}) {
  return storeId && ID_SHAPE.test(storeId) && storeId !== DEV_EXTENSION_ID ? [storeId, DEV_EXTENSION_ID] : [DEV_EXTENSION_ID];
}

/** The origin a page of the extension `id` has. @param {string} id */
const originOf = (id) => `chrome-extension://${id}`;

/**
 * Whether a request's Origin header is one of the extension's (exactly: no trailing slash, path or other case).
 * @param {unknown} origin @param {{ storeId?: string | null }} [o]
 */
function allowedOrigin(origin, o) {
  return typeof origin === 'string' && extensionIds(o).some((id) => originOf(id) === origin);
}

/** The extension's page on the Chrome Web Store, or null while no store id is configured. @param {{ storeId?: string | null }} [o] */
function storeUrl(o) {
  const ids = extensionIds(o);
  return ids.length > 1 ? `https://chromewebstore.google.com/detail/${ids[0]}` : null;
}

/**
 * Which of the extension's ids the Chrome profile has, by `state(id)` (chromeProfileExtension.cjs extensionInProfile):
 * the first one turned on, else the first one turned off, else none ('missing', or null when the profile can't be
 * read). `id` is the one to open the pairing page of: the one found, else the store's (or the dev key's without one).
 * @param {(id: string) => 'on' | 'off' | 'missing' | null} state @param {{ storeId?: string | null }} [o]
 * @returns {{ id: string, state: 'on' | 'off' | 'missing' | null }}
 */
function extensionInProfileOf(state, o) {
  const ids = extensionIds(o);
  const states = ids.map((id) => ({ id, state: state(id) }));
  const on = states.find((s) => s.state === 'on');
  if (on) return on;
  const off = states.find((s) => s.state === 'off');
  if (off) return off;
  return { id: ids[0], state: states.some((s) => s.state === 'missing') ? 'missing' : null };
}

module.exports = {
  DEV_EXTENSION_ID,
  STORE_EXTENSION_ID,
  extensionIds,
  originOf,
  allowedOrigin,
  storeUrl,
  extensionInProfileOf,
};
