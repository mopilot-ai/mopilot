// Owns each chat's browser tabs, CDP sessions and serialized actions across every harness.
// HostInput/HostPage/HostCapture implement actions; Tab, pageDialogs and userTurn own their lifecycle gates.
const {
  ATTACH_MS,
  SHOW_MS,
  MAX_TABS,
  BUFFER_MAX,
  PAGE_BACKDROP,
  FRAME_SCRIPT,
  BLACK_PAGE_SCRIPT,
  oneLine,
  isBlank,
  redactUrl,
  normalizeUrl,
  safeFileName,
} = require('./hostUtil.cjs');
const { modifierBits, chord } = require('./keys.cjs');
const { Tab } = require('./tab.cjs');
const { HostCapture } = require('./hostCapture.cjs');
/** @typedef {InstanceType<typeof Tab>} Tab */

// BrowserTabs holds the state and extends the layers that act on it, each in its own module and typed against it with
// @this: hostEvents (subscriptions and page notifications) <- hostTabs (the chats' tabs) <- hostInput (CDP input) <- hostPage (page operations) <- hostCapture (screenshots).
// What used to be private methods are module functions there that take the host.
class BrowserTabs extends HostCapture {
  /**
   * @param {{ appContents: () => any[], panelSession: () => any,
   *           open: (chatId: string, req: { tabKey: string, focus: boolean, owner: any, after?: string | null }) => boolean | void,
   *           spawn?: (chatId: string, history?: { entries: any[], index: number } | null) => any,
   *           close: (tab: Tab) => void, select: (tab: Tab, opts?: { auto?: boolean }) => void,
   *           onSelect?: (chatId: string, wc: any, owner: any) => void,
   *           onChange?: (chatId: string) => void, prepare?: (chatId: string, url: string) => Promise<string> | null,
   *           images: { fromBuffer: (buf: Buffer) => any },
   *           downloadsDir?: (chatId: string) => string,
   *           attachMs?: number, showMs?: number, platform?: NodeJS.Platform,
   *           cursor?: InstanceType<typeof import('./agentCursor.cjs').AgentCursor>,
   *           modelOf?: (chatId: string) => string | null | Promise<string | null>,
   *           inputWhileHidden?: boolean, keepTabsOnTurnEnd?: boolean,
   *           dialogs?: InstanceType<typeof import('./pageDialogs.cjs').PageDialogs>,
   *           hang?: InstanceType<typeof import('./pageHang.cjs').PageHang> }} o
   *   spawn: a new view tab's webContents for the chat (views.cjs), or null to open a pane <webview> through `open`
   *   cursor: draws the agent's pointer, clicks and typing on the page (agentCursor.cjs); none without it
   *   modelOf: the chat's current model, for the screenshot size (capture.cjs); unknown gets the default limits
   *   inputWhileHidden: the pages live in another browser's window and take input while hidden, so a hidden tab is
   *     neither brought forward, waited for nor refused (the user's Chrome: an agent tab in a background tab or a
   *     collapsed group is never brought to the front; its CDP session emulates focus, so Chrome draws it and
   *     routes input into it); the pane's hidden guests can drop input, so by default they are
   *   keepTabsOnTurnEnd: the host owns its tabs across turns (Chrome's chat group); release control without closing any
   *   dialogs: the pages' own dialogs, which the agent sees and answers on its tabs; hang: which pages stopped responding
   */
  constructor(o) {
    super();
    this.o = o;
    /** @type {InstanceType<typeof import('./gifRecorder.cjs').GifRecorder> | null} what browser_gif_creator records, fed by each call that passed its page gate (hostPageGates.cjs) */
    this.gif = null;
    /** @type {InstanceType<typeof import('./devtools/turnTrace.cjs').TurnTraces> | null} the turn trace, fed by each call that passed its page gate (hostPageGates.cjs) */
    this.traces = null;
    this.attachMs = o.attachMs ?? ATTACH_MS;
    this.showMs = o.showMs ?? SHOW_MS;
    /** chat id -> { tabs: Map<tabId, Tab>, selected: tabId | null, changes: string[], revealed: tabId | null, revealOff: boolean,
     *              orphans: Map<tabKey | '', Tab> (pane tabs whose page went without being closed) } */
    this.chats = new Map();
    /** page key (pageKey.cjs) -> how its window lays out that page ('front' | 'back' | 'none') */
    this.layers = new Map();
    /** `${chatId} ${tabKey}` -> resolvers waiting for that tab to attach */
    this.waiting = new Map();
    /** what else lets go when a chat's turn ends or the chat goes (browser_script sessions) */
    this.turnEndListeners = new Set();
    /** who hears about the downloads agent-held tabs save (the Codex Browser plugin's backend, iabBackend.cjs) */
    this.downloadListeners = new Set();
    /** chat id -> how many of its turns have ended: a tab's mark lasts for the turn it was given in and the user's turn after it */
    this.turnsEnded = new Map();
    /** orders agent actions across tabs: the turn's most recent one is its result tab */
    this.useSeq = 0;
    /** who hears about page dialogs and blocked links on the chats' tabs (the Codex Browser plugin's backend, iabBackend.cjs) */
    this.pageListeners = new Set();
    o.dialogs?.on('open', (wc, dialog) => this.pageDialogOpened(wc, dialog));
    o.dialogs?.on('closed', (wc, dialog, result) => this.pageDialogClosed(wc, dialog, result));
    o.hang?.on('change', (wc, hung) => this.pageHung(wc, hung));
  }
}

/** @typedef {{ x: number, y: number, name?: string }} PagePoint a point in the tab's viewport, and the element's name when a ref gave it */

module.exports = {
  BrowserTabs,
  Tab,
  MAX_TABS,
  BUFFER_MAX,
  normalizeUrl,
  redactUrl,
  chord,
  modifierBits,
  safeFileName,
  oneLine,
  isBlank,
  FRAME_SCRIPT,
  BLACK_PAGE_SCRIPT,
  PAGE_BACKDROP,
};
