// Action memory's anchors in main (#3571, G4): what a browser call is about to act on, read from the page agent as
// locator steps (pageAgentAnchor.cjs) and prefixed with the frame elements of each out-of-process frame it is in. An anchor
// names a recorded step's target in the plan a replay hands back.
const { noteIgnored } = require('../../ignored.cjs');
const { callsOf, targetKey } = require('./routineSteps.cjs');

/**
 * The anchor of a ref or a point in a tab: { steps, weak, secret }, { frame: true } for a point inside a cross-origin
 * frame, or null. A ref inside an out-of-process frame gets the steps to each frame element above it.
 * @param {any} tab a browser host tab (tab.cjs)
 * @param {string} key a targetKey: 'ref:<ref>' or 'at:<x>,<y>'
 */
async function anchorIn(tab, key) {
  if (key.startsWith('at:')) {
    const [x, y] = key.slice(3).split(',').map(Number);
    return tab.agent('anchor', { x, y });
  }
  const ref = key.slice(4);
  let sessionId = tab.frameOf(ref);
  const own = await tab.agent('anchor', { ref }, sessionId);
  if (!own?.steps) return own ?? null;
  let steps = own.steps;
  let weak = !!own.weak;
  while (sessionId) {
    const frame = tab.frames.get(sessionId);
    if (!frame) return null;
    const owner = await tab.ownerRef(frame);
    const up = await tab.agent('anchor', { ref: owner }, frame.parent);
    if (!up?.steps) return null;
    steps = [...up.steps, { k: 'frame' }, ...steps];
    weak = weak || !!up.weak;
    sessionId = frame.parent;
  }
  return { steps, weak, secret: !!own.secret };
}

/**
 * The anchors of every target a call is about to act on (a batch's actions included), keyed by targetKey, on the chat's
 * tab the call names or its current one. A target that can't be read is left out: its step is kept without an anchor,
 * and a replay hands off there.
 * @param {any} tabs the chat's browser tabs (host.cjs BrowserTabs, routed)
 * @param {string} chatId
 * @param {string} tool
 * @param {any} args
 * @returns {Promise<{ anchors: Map<string, any>, url: string | null }>}
 */
async function anchorsBefore(tabs, chatId, tool, args) {
  const anchors = new Map();
  const tabId = args?.tabId ?? args?.tab_id ?? null;
  /** @type {any} */
  let tab = null;
  try {
    // a chrome_* call names Chrome's own tab id (chromeTools.cjs), a browser_* call the host's
    const byChromeId = typeof tabId === 'number' ? tabs.list?.(chatId).find((/** @type {any} */ t) => t.backend?.tabId === tabId) : null;
    tab = byChromeId ?? (tabId != null ? await tabs.resolve(chatId, tabId) : tabs.current(chatId));
  } catch (error) {
    // the call itself says the tab is gone
    noteIgnored('find the tab a recorded browser step acts on', error);
  }
  if (!tab) return { anchors, url: null };
  // a target several actions share is read once
  const keys = [...new Set(callsOf(tool, args).map((c) => targetKey(c.args)))].filter(Boolean);
  if (keys.length)
    await tabs.run(tab, async () => {
      for (const key of keys)
        try {
          anchors.set(key, await anchorIn(tab, key));
        } catch (error) {
          // a stale ref or a page that went away: the step is kept unanchored
          noteIgnored('anchor a recorded browser step', error);
        }
    });
  return { anchors, url: typeof tab.url === 'string' ? tab.url : null };
}

/** The chat's current page address, or null without a tab. */
const currentUrl = (tabs, chatId) => {
  const tab = tabs.current(chatId);
  return tab && typeof tab.url === 'string' ? tab.url : null;
};

/**
 * A browser family's adapter for the recorder and the replay (browser_* on the in-app browser, chrome_* on the user's
 * Chrome): its tabs, or a function giving them once they are up.
 * @param {any} source
 */
function browserAdapter(source) {
  const tabs = () => (typeof source === 'function' ? source() : source) ?? null;
  return {
    up: () => !!tabs(),
    anchorsBefore: (/** @type {string} */ chatId, /** @type {string} */ tool, /** @type {any} */ args) => {
      const t = tabs();
      return t ? anchorsBefore(t, chatId, tool, args) : Promise.resolve({ anchors: new Map(), url: null });
    },
    url: (/** @type {string} */ chatId) => {
      const t = tabs();
      return t ? currentUrl(t, chatId) : null;
    },
  };
}

module.exports = { anchorIn, anchorsBefore, currentUrl, browserAdapter };
