// Other extensions' frames in the tabs a chat's agent holds (#1632): a guard on every page of an attached tab empties and hides them, and an attach they block reloads the tab once and attaches as its new page commits.
//
// Chrome refuses a debugger on a tab that has another extension's frame in it ("Cannot access a chrome-extension://
// URL of different extension") and detaches one as soon as such a frame starts loading. Password managers, recorders and
// shopping helpers inject them (an inline menu, a button), so an agent tab would stop being controllable. Measured in
// Chrome 155 (a test extension injecting a frame, another attaching):
// - nothing over CDP stops the frame before Chrome detaches: a MutationObserver in the page, Network.setBlockedURLs and
//   Fetch interception all lose, since the detach comes as the frame's navigation starts;
// - a guard left in the page does outlive that detach: it empties the frame (srcdoc="", as the ChatGPT extension's
//   foreign-frame monitor does) and the next attach succeeds, so main's next action re-attaches as after any detach;
// - a page that already has such a frame is attached by reloading it and attaching as its new page commits, before most
//   content scripts run; the guard keeps the frames out from then on. A frame injected before the guard lands detaches
//   it again (1 in 6 measured), so the reload is tried twice.
// The guard runs in an isolated world of its own (Page.addScriptToEvaluateOnNewDocument with runImmediately), only in
// tabs this extension attaches, so the user's own tabs are never touched. It also hides the emptied frame, so the
// agent's page reads and screenshots skip it. A frame inside a closed shadow root is out of its reach (only
// chrome.dom, from a content script, opens one): the reloads are tried once a minute per tab, and otherwise the attach
// fails saying which kind of extension to turn off.

export const GUARD_WORLD = 'mopilot-frame-guard';
/** Chrome's refusal (debugger_api.cc, PermissionsData::IsRestrictedUrl) when another extension's frame is in the tab. */
export const FOREIGN_FRAME = /Cannot access a chrome-extension:\/\/ URL of different extension/;
/**
 * Whether Chrome refused a debugger call for another extension's frame. It refuses attach, detach and sendCommand alike
 * (debugger_api.cc checks the tab's frames before anything else), so a detach or a guard command can say it too.
 */
export const isForeignRefusal = (/** @type {unknown} */ error) =>
  FOREIGN_FRAME.test(error instanceof Error ? error.message : String(error));
/** How long a reload may take to commit its new page. */
export const RELOAD_WAIT_MS = 10_000;
/** How many reloads one blocked attach may try. */
export const RELOADS = 2;
/** A tab is reloaded for this at most once in this time: a frame that comes back at once would reload it forever. */
export const RELOAD_AGAIN_MS = 60_000;
export const BLOCKED =
  "Another Chrome extension has a frame in this page (such as a password manager's or a recorder's menu), and Chrome lets no extension control a tab with another extension's frame in it. Ask the user to turn that extension off for this site, or to close its menu, then try again.";

/* eslint-disable no-restricted-globals */
/**
 * Runs in the guard world of each page (serialized with toString: it must not close over anything): every frame of
 * another extension, now and later, in the document and in open shadow roots, is emptied and hidden.
 * @param {string} own this extension's id, whose own pages are left alone
 */
export function guardFrames(own) {
  if (globalThis.__mopilotFrameGuard) return;
  globalThis.__mopilotFrameGuard = true;
  const foreign = (u) => {
    const s = String(u || '').trim();
    if (!s.startsWith('chrome-extension://')) return false;
    try {
      const host = new URL(s).host;
      return !!host && host !== own;
    } catch {
      return false;
    }
  };
  const roots = new WeakSet();
  const fix = (el) => {
    const tag = el.tagName;
    const attr = tag === 'OBJECT' ? 'data' : 'src';
    if (
      (tag === 'IFRAME' || tag === 'FRAME' || tag === 'EMBED' || tag === 'OBJECT') &&
      (foreign(el.getAttribute(attr)) || foreign(el[attr]))
    ) {
      // srcdoc wins over src: the frame shows an empty document of the page's own instead of the extension's
      if (tag === 'IFRAME') {
        if (el.getAttribute('srcdoc') !== '') el.setAttribute('srcdoc', '');
      } else if (el.getAttribute(attr) !== 'about:blank') el.setAttribute(attr, 'about:blank');
      el.style.setProperty('display', 'none', 'important');
    }
    if (el.shadowRoot) watch(el.shadowRoot);
  };
  const sweep = (node) => {
    if (node.nodeType !== 1) return;
    fix(node);
    for (const el of node.querySelectorAll('*')) fix(el);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') fix(r.target);
      for (const n of r.addedNodes) sweep(n);
    }
  });
  const watch = (root) => {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data'] });
    for (const el of root.querySelectorAll('*')) fix(el);
  };
  watch(document);
}
/* eslint-enable no-restricted-globals */

/** The guard as a script for the page, with this extension's id. */
export const guardSource = (/** @type {string} */ own) => `(${guardFrames.toString()})(${JSON.stringify(own)})`;

/** Puts the guard on the tab's page now and on each page it loads while attached; false when it couldn't. Never throws. */
export async function guardTab(chrome, tabId, log) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
      source: guardSource(chrome.runtime?.id ?? ''),
      worldName: GUARD_WORLD,
      runImmediately: true,
    });
    return true;
  } catch (error) {
    log("guard a tab against other extensions' frames", error);
    return false;
  }
}

/** Reloads the tab; true once its new page commits, false when that takes longer than `waitMs` or the reload fails (logged). */
export function reloadToCommit(chrome, tabId, log, waitMs = RELOAD_WAIT_MS) {
  return new Promise((resolve) => {
    const done = (/** @type {boolean} */ ok) => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(on);
      resolve(ok);
    };
    const on = (/** @type {{ tabId: number, frameId: number }} */ d) => {
      if (d.tabId === tabId && d.frameId === 0) done(true);
    };
    const timer = setTimeout(() => done(false), waitMs);
    chrome.webNavigation.onCommitted.addListener(on);
    Promise.resolve(chrome.tabs.reload(tabId)).catch((error) => {
      log('reload a tab to clear another extension’s frame', error);
      done(false);
    });
  });
}
