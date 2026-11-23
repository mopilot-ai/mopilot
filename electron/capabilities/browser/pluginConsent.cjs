// Codex's Browser plugin asks for each site on its own card; an accepted answer for its in-app browser becomes the chat's MoPilot site grant there, so the iab backend doesn't ask twice.
//
// On a native Codex thread the plugin's site consent (an mcpServer/elicitation/request from
// connector "browser-use" for access_browser_origin) reaches the chat as a card
// (src/harness/elicitation.ts). Main sees the request on its way to the windows and the window's answer
// on its way back (codex:respond). A consent becomes a grant only for its own browser and scope (D7):
// - only when the thread's plugin works in MoPilot's in-app browser (the thread has an iab backend)
//   and the card doesn't name an outside browser (connector_name "Chrome" and the like): the user's Chrome
//   keeps its own table and its own vendor prompts;
// - only for site access (access_browser_origin): the raw-DevTools consent (…_with_raw_cdp) is the plugin's
//   own permission, and MoPilot checks each such command itself (iabBackend.cjs);
// - in the in-app browser's table, recorded on OriginGrants.consented() with the same scope: the plugin's
//   plain accept lasts for the chat, persist "always" saves this one site ("all sites" too saves only this one).
// Per-action confirmations on high-risk sites still ask (origins.cjs act()).

const ORIGIN_TOOLS = new Set(['access_browser_origin', 'access_browser_origin_with_raw_cdp']);
/** The consent that grants site access; the raw-DevTools one grants nothing in MoPilot. */
const ACCESS_TOOL = 'access_browser_origin';
/** A connector name that is a browser outside MoPilot (the plugin's Chrome backend names the user's browser). */
const OUTSIDE_BROWSER = /\b(chrome|chromium|edge|brave|opera|vivaldi|arc|firefox|safari)\b/i;
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The thread, origin, tool and browser of a Browser plugin site consent request, or null for any other
 * message. `browser`: 'chrome' when the card names an outside browser, else null (the thread decides).
 * @param {any} msg
 * @returns {{ threadId: string, origin: string, tool: string, browser: 'chrome' | null } | null}
 */
function siteConsentOf(msg) {
  if (!msg || msg.method !== 'mcpServer/elicitation/request' || msg.id == null) return null;
  const p = msg.params || {};
  const meta = p._meta && typeof p._meta === 'object' ? p._meta : {};
  if (meta.connector_id !== 'browser-use' || !ORIGIN_TOOLS.has(meta.tool_name)) return null;
  const params = meta.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params : {};
  const origin = text(meta.origin) ?? text(params.origin);
  const threadId = text(p.threadId);
  if (!origin || !threadId) return null;
  const browser = OUTSIDE_BROWSER.test(text(meta.connector_name) ?? '') ? 'chrome' : null;
  return { threadId, origin, tool: meta.tool_name, browser };
}

/**
 * The scope an answer grants, or null when it does not allow: 'always' for persist "always" (one site or
 * all sites), 'chat' for any other accept.
 * @param {any} result
 * @returns {'chat' | 'always' | null}
 */
function consentScope(result) {
  if (!result || result.action !== 'accept') return null;
  return result._meta && result._meta.persist === 'always' ? 'always' : 'chat';
}

/**
 * @param {{ grants: () => { consented: (chatId: string, origin: string, scope: 'once' | 'chat' | 'always') => boolean } | null | undefined,
 *           chatOf: (threadId: string) => string, inApp: (threadId: string) => boolean }} o
 *   grants: the in-app browser's site grants (OriginGrants, browser 'iab'), once they exist; chatOf: the chat a thread (or a
 *   subagent's thread) belongs to; inApp: whether the thread's plugin works in MoPilot's in-app browser (it has an iab backend)
 */
function pluginSiteConsent(o) {
  /** request id -> { threadId, origin, tool, browser } */
  const pending = new Map();
  return {
    /** Sees every app-server message; never consumes one. */
    observe(msg) {
      const c = siteConsentOf(msg);
      if (c) pending.set(msg.id, c);
      // answered elsewhere, or withdrawn: nothing will come back for it
      else if (msg?.method === 'serverRequest/resolved') pending.delete(msg.params?.requestId);
      return false;
    },
    /** A window answered request `id`; returns whether a grant was recorded. */
    answered(id, result) {
      const c = pending.get(id);
      if (!c) return false;
      pending.delete(id);
      const scope = consentScope(result);
      // its own browser and scope only: site access in the in-app browser
      if (!scope || c.tool !== ACCESS_TOOL || c.browser || o.inApp(c.threadId) !== true) return false;
      const grants = o.grants();
      if (!grants) return false;
      return grants.consented(o.chatOf(c.threadId), c.origin, scope) === true;
    },
  };
}

module.exports = { pluginSiteConsent, siteConsentOf, consentScope };
