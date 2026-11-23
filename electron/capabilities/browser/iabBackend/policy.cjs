// CDP method classification, action/typing rules and navigation URL policy.
const { fail } = require('./protocol.cjs');
const { AUTO_ATTACH } = require('../documentScripts.cjs');

/**
 * What each CDP domain's commands are, unless CDP_METHODS names the method (D7): 'read' observes the page or
 * sets up the plugin's own observation, 'blocked' is refused. A domain not listed here is refused too.
 * @type {Record<string, 'read' | 'blocked'>}
 */
const CDP_DOMAINS = {
  Accessibility: 'read',
  Animation: 'read',
  Audits: 'read',
  CSS: 'read',
  Console: 'read',
  DOM: 'read',
  DOMDebugger: 'read',
  DOMSnapshot: 'read',
  Debugger: 'read',
  Emulation: 'read',
  Fetch: 'read',
  HeapProfiler: 'read',
  IO: 'read',
  Inspector: 'read',
  LayerTree: 'read',
  Log: 'read',
  Media: 'read',
  Memory: 'read',
  Network: 'read',
  Overlay: 'read',
  Page: 'read',
  Performance: 'read',
  PerformanceTimeline: 'read',
  Profiler: 'read',
  Runtime: 'read',
  WebAudio: 'read',
  // the browser itself, other targets, stored data and credentials: never the plugin's
  Browser: 'blocked',
  CacheStorage: 'blocked',
  Database: 'blocked',
  DOMStorage: 'blocked',
  FedCm: 'blocked',
  IndexedDB: 'blocked',
  Input: 'blocked',
  ServiceWorker: 'blocked',
  Storage: 'blocked',
  SystemInfo: 'blocked',
  Target: 'blocked',
  Tracing: 'blocked',
  WebAuthn: 'blocked',
};

/**
 * Methods whose class differs from their domain's: 'emulated' (answered here), 'write' (acts on the page),
 * 'navigate' (loads a URL), 'viewport' (moves where input lands), 'dialog' (answers a JavaScript dialog: a
 * write when it accepts), 'gesture' (a read, or a write when it runs with a user gesture: accessibility
 * actions), 'read' or 'blocked'.
 * @type {Record<string, 'emulated' | 'write' | 'navigate' | 'viewport' | 'dialog' | 'gesture' | 'read' | 'blocked'>}
 */
const CDP_METHODS = {
  'Target.getTargetInfo': 'emulated',
  'Target.getTargets': 'emulated',
  'Target.closeTarget': 'emulated',
  // MoPilot's own auto-attach stays as it is (the parameters are fixed, see autoAttachParams)
  'Target.setAutoAttach': 'read',
  'Input.dispatchMouseEvent': 'write',
  'Input.dispatchKeyEvent': 'write',
  'Input.insertText': 'write',
  'Page.navigate': 'navigate',
  'Page.navigateToHistoryEntry': 'navigate',
  'Page.reload': 'navigate',
  'Emulation.setDeviceMetricsOverride': 'viewport',
  'Emulation.clearDeviceMetricsOverride': 'viewport',
  'Page.handleJavaScriptDialog': 'dialog',
  // the plugin reads every page through Runtime (as the vendor's own backend does): a call is a read unless it
  // carries a user gesture (an accessibility action); the plugin's raw-CDP access has its own per-site consent
  'Runtime.evaluate': 'gesture',
  'Runtime.callFunctionOn': 'gesture',
  'DOM.setFileInputFiles': 'write',
  'DOM.setAttributeValue': 'write',
  'DOM.setAttributesAsText': 'write',
  'DOM.setNodeValue': 'write',
  'DOM.setNodeName': 'write',
  'DOM.setOuterHTML': 'write',
  'DOM.removeNode': 'write',
  'DOM.removeAttribute': 'write',
  'DOM.moveTo': 'write',
  'DOM.copyTo': 'write',
  'DOM.undo': 'write',
  'DOM.redo': 'write',
  'DOM.focus': 'write',
  'CSS.setStyleTexts': 'write',
  'CSS.setStyleSheetText': 'write',
  'CSS.setRuleSelector': 'write',
  'CSS.setKeyframeKey': 'write',
  'CSS.setMediaText': 'write',
  'CSS.setContainerQueryText': 'write',
  'CSS.setSupportsText': 'write',
  'CSS.setScopeText': 'write',
  'CSS.addRule': 'write',
  'CSS.createStyleSheet': 'write',
  'CSS.setEffectivePropertyValueForNode': 'write',
  'Debugger.setScriptSource': 'write',
  'Debugger.evaluateOnCallFrame': 'write',
  'Debugger.setVariableValue': 'write',
  'Debugger.setReturnValue': 'write',
  'Network.replayXHR': 'write',
  'Page.setDocumentContent': 'write',
  // HTTP-auth credentials are typed by the user, never by an agent
  'Fetch.continueWithAuth': 'blocked',
  'Page.close': 'blocked',
  'Page.crash': 'blocked',
  'Page.deleteCookie': 'blocked',
  'Network.getAllCookies': 'blocked',
  'Network.getCookies': 'blocked',
  'Network.setCookie': 'blocked',
  'Network.setCookies': 'blocked',
  'Network.deleteCookies': 'blocked',
  'Network.clearBrowserCookies': 'blocked',
  'Network.clearBrowserCache': 'blocked',
  'Network.setExtraHTTPHeaders': 'blocked',
  'Network.setRequestInterception': 'blocked',
  'Network.loadNetworkResource': 'blocked',
  'Network.setCookieControls': 'blocked',
  'Network.getCertificate': 'blocked',
};

/** The classes a command can be. */
const CDP_CLASSES = ['read', 'write', 'navigate', 'viewport', 'dialog', 'gesture', 'emulated', 'blocked'];

/**
 * What a CDP method is: its own entry, else its domain's, else 'blocked'.
 * @param {unknown} method
 * @returns {'emulated' | 'write' | 'navigate' | 'viewport' | 'dialog' | 'gesture' | 'read' | 'blocked'}
 */
function cdpClass(method) {
  if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) return 'blocked';
  if (Object.hasOwn(CDP_METHODS, method)) return CDP_METHODS[method];
  const [domain] = method.split('.');
  return Object.hasOwn(CDP_DOMAINS, domain) ? CDP_DOMAINS[domain] : 'blocked';
}

/** Whether a command of class `kind` with `params` acts on the page (a write) rather than reading it. */
const writes = (/** @type {string} */ kind, /** @type {any} */ params) =>
  kind === 'write' || (kind === 'dialog' && params.accept === true) || (kind === 'gesture' && params.userGesture === true);
/** Whether an input event types text (Enter alone does not). */
const typingInput = (/** @type {string} */ method, /** @type {any} */ p) =>
  method === 'Input.insertText' || (method === 'Input.dispatchKeyEvent' && typeof p.text === 'string' && p.text !== '' && p.text !== '\r');
/** Passive pointer input neither presses a control nor drags one; it may use ordinary task consent. */
const passiveInput = (method, p) => {
  if (method !== 'Input.dispatchMouseEvent') return null;
  if (p.type === 'mouseWheel') return { kind: 'scroll' };
  return p.type === 'mouseMoved' && !(p.buttons > 0) ? { kind: 'hover' } : null;
};
/**
 * The key an input event presses that can submit or press the focused control, in siteRisk's terms, or null: Enter
 * (its keyDown, or the keypress a char event with "\r" makes, which submits a form or presses a button; a "\n" is a
 * new line typed) and the space bar's keyDown, with or without its text (#1384). A release, and other keys, press nothing.
 * @param {string} method
 * @param {any} p
 * @returns {'Enter' | 'Space' | null}
 */
function keyPressed(method, p) {
  if (method !== 'Input.dispatchKeyEvent') return null;
  const down = p.type === 'keyDown' || p.type === 'rawKeyDown';
  if ((down && p.key === 'Enter') || ((down || p.type === 'char') && p.text === '\r')) return 'Enter';
  return down && (p.key === ' ' || p.code === 'Space') ? 'Space' : null;
}
/**
 * What an action's card says it does: the action on the page's origin, and what it presses or types into ("Pay $49.00"),
 * as browser_*'s cards do. The model leaves a payment's ask to this card (#1384), so the user sees there what they pay.
 * @param {string} tool
 * @param {string} url
 * @param {{ detail?: string } | null} sensitive
 */
const cardSummary = (tool, url, sensitive) => `${tool} on ${new URL(url).origin}${sensitive?.detail ? ` ("${sensitive.detail}")` : ''}`;
/** A URL's origin (what the site gates decide on), or the URL itself when it has none. */
const siteOf = (/** @type {string} */ url) => {
  try {
    return new URL(url).origin;
  } catch {
    // not a URL (about:blank's origin is "null" anyway): compared as written
    return String(url);
  }
};
/**
 * Whether a command waits for the agent cursor's running glide to arrive (agentCursor.cjs arrival), so it lands under
 * the pointer: every write but a mouse move with a button held (a drag's moves follow at once).
 */
const awaitsCursor = (/** @type {string} */ kind, /** @type {any} */ params) =>
  kind === 'write' && !(params.type === 'mouseMoved' && params.buttons > 0);
/**
 * Shows an input event on the agent cursor (agentCursor.cjs): a press at its point, a wheel turn at its point, typed
 * text in its field; the event then waits for the glide (awaitsCursor). Keys typed one by one show nothing more.
 * @param {{ act: (tab: any, action: any) => Promise<unknown> }} cursor
 * @param {any} tab
 * @param {string} method
 * @param {any} p
 */
function showInput(cursor, tab, method, p) {
  const mouse = method === 'Input.dispatchMouseEvent';
  if (mouse && p.type === 'mousePressed') void cursor.act(tab, { kind: 'click', x: p.x, y: p.y });
  else if (mouse && p.type === 'mouseWheel')
    void cursor.act(tab, { kind: 'scroll', x: p.x, y: p.y, direction: p.deltaY < 0 ? 'up' : 'down' });
  else if (method === 'Input.insertText') void cursor.act(tab, { kind: 'type' });
}
/** Whether a command takes its turn in the tab's action queue (BrowserTabs.run): writes, navigations and the viewport, never a dialog answer. */
const actsOnPage = (/** @type {string} */ kind, /** @type {any} */ params) =>
  kind === 'navigate' || kind === 'viewport' || (kind !== 'dialog' && writes(kind, params));
/**
 * Whether `url` is one the plugin may load: http(s) or about:blank.
 * @param {unknown} url
 */
function urlAllowed(url) {
  if (url === 'about:blank') return true;
  try {
    return ['http:', 'https:'].includes(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

/**
 * What a CDP method gets: 'emulated' (answered here), 'send' (passed to the tab), or an error.
 * @param {unknown} method
 */
function cdpPolicy(method) {
  if (typeof method !== 'string' || !method) throw fail('A CDP method is required.');
  const kind = cdpClass(method);
  if (kind === 'blocked') throw fail(`Browser Use CDP method is not supported in MoPilot's built-in browser: ${method}`);
  return kind === 'emulated' ? 'emulated' : 'send';
}

/**
 * Target.setAutoAttach as MoPilot's tab already runs it (tab.cjs attach): the plugin may filter, but it
 * can't turn auto-attach off, pause new frames or take the sessions out of the flat protocol browser_* rely on.
 * @param {any} params
 */
const autoAttachParams = (params) => ({ ...params, ...AUTO_ATTACH });

/** The URL a command for a child frame's session is about: its own page, when the backend saw it. */
const childUrl = (/** @type {any} */ h, /** @type {string} */ sessionId) => (sessionId && h ? (h.urls.get(sessionId) ?? null) : null);

module.exports = {
  awaitsCursor,
  showInput,
  CDP_DOMAINS,
  CDP_METHODS,
  CDP_CLASSES,
  cdpClass,
  writes,
  typingInput,
  passiveInput,
  keyPressed,
  cardSummary,
  siteOf,
  actsOnPage,
  urlAllowed,
  cdpPolicy,
  autoAttachParams,
  childUrl,
};
