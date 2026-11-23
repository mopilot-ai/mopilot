// Claude in Chrome across the live Claude Code sessions (BU-07): each session's link, reconnecting the extension and picking the browser.
const chromeLink = require('./chromeLink.cjs');

/** @param {import('./state.cjs').ClaudeState} state */
function createChromeSessions(state) {
  /** Reads a session's link again (`why`: what prompted it, electron/harness/claude/chromeLink.cjs); tells main when it changed. */
  async function checkChromeLink(s, why) {
    const link = await chromeLink.readLink(s.q);
    if (s.link.set(link, why) && state.sessions.get(s.key) === s) state.onChromeLink(s.chatId, s.link.state, s.key);
    return s.link.state;
  }

  /**
   * The sessions whose Claude in Chrome is their chat's: a chat's current Claude segment (electron/session/segmentScope.cjs),
   * not a switched chat's leftover CLI or a side chat.
   */
  const linked = () => [...state.sessions.values()].filter((s) => s.link && state.chromeScope(s.chatId, s.key));

  /** The live sessions that run Claude in Chrome: their chat and last link; `refresh` reads each again first (Settings opened). */
  async function chromeLinks(refresh = false) {
    const live = linked();
    if (refresh) await Promise.all(live.map((s) => checkChromeLink(s, 'refresh')));
    return live.map((s) => ({ key: s.key, chatId: s.chatId, link: s.link.state }));
  }

  /**
   * The terminal's Reconnect extension, for one chat's sessions, or with no chat for every session whose link
   * is down. Answers each session's link afterwards.
   */
  async function chromeReconnect(chatId) {
    const out = [];
    for (const s of linked()) {
      if (chatId ? s.chatId !== chatId : s.link.state?.connected !== false) continue;
      /** @type {string | null} */
      let error = null;
      await chromeLink.reconnect(s.q).catch((e) => (error = chromeLink.errorText(e)));
      out.push({ chatId: s.chatId, link: await checkChromeLink(s, 'reconnect'), error });
    }
    return out;
  }

  /** The browsers paired with Claude in Chrome, as a connected session lists them; [] with none connected. */
  async function chromeBrowsers() {
    for (const s of state.sessions.values()) {
      if (s.link?.state?.connected !== true) continue;
      const list = await chromeLink.listBrowsers(s.q);
      if (list.length) return list;
    }
    return [];
  }

  /** Moves one session to the browser `id`, as the terminal's Select browser does. */
  async function selectIn(s, id) {
    /** @type {string | null} */
    let error = null;
    await chromeLink.selectBrowser(s.q, id).catch((e) => (error = chromeLink.errorText(e)));
    return { chatId: s.chatId, link: await checkChromeLink(s, 'select'), error };
  }

  /**
   * Every connected chat uses the browser picked in settings. A chat whose turn runs moves when the turn ends
   * (pendingBrowser, applied by browserAfterTurn), so its task isn't moved to another browser midway.
   */
  async function chromeSelect(id) {
    const out = [];
    for (const s of linked()) {
      if (s.link.state?.connected !== true) continue;
      if (s.busy) {
        s.pendingBrowser = id;
        out.push({ chatId: s.chatId, link: s.link.state, error: null, deferred: true });
      } else out.push(await selectIn(s, id));
    }
    return out;
  }

  /** A session's turn ended with a browser picked in settings meanwhile (s.pendingBrowser): it applies now. */
  async function browserAfterTurn(s) {
    const id = s.pendingBrowser;
    s.pendingBrowser = null;
    return selectIn(s, id);
  }

  /** The link last read by the live session on `key` (a chat's segment), or null when it runs none. */
  const chromeLinkOf = (key) => state.sessions.get(key)?.link?.state ?? null;

  return { checkChromeLink, chromeLinks, chromeLinkOf, chromeReconnect, chromeBrowsers, chromeSelect, browserAfterTurn };
}

module.exports = { createChromeSessions };
