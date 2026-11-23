// MoMo in main (#2139): its services made once at startup over one folder (<userData>/momo), with their IPC, tools and Reset stores: memory, the main chat, local sources, the trust layer (audit log, sentinel, trust gate, the approval card it asks through) and Ask MoMo, then its background work (app/momoBackground.cjs). Each handler and tool refuses while MoMo isn't allowed for the account; work that touches the disk starts only once it is.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { momoAllowed, onMomoAccess } = require('../momo/access.cjs');
const { momoDir, momoWorkspace, registerMomoStore, memoryFilesReset } = require('../momo/stores.cjs');
const { isMomoMeta, isMomoDataMeta } = require('../../shared/momoChat.mjs');
const { ownerOf: chatOwning } = require('../platform/segmentOwner.cjs');
const { ChatStarter } = require('../platform/chatStart.cjs');
const { isQuickChatSender } = require('../session/quickChat.cjs');
const { MemoryStore } = require('../momo/memory.cjs');
const { effortSources } = require('../momo/brainEffort.cjs');
const { OpenLoopStore } = require('../momo/openLoops.cjs');
const { createLoopActs } = require('../momo/loopActs.cjs');
const { registerLoopsIpc } = require('../momo/loopsIpc.cjs');
const { registerLoopTools } = require('../momo/loopTools.cjs');
const { openMomoDrafts } = require('./momoDrafts.cjs');
const { openMomoDraftSend } = require('./momoDraftSend.cjs');
const { recentNudges } = require('./momoNudges.cjs');
const { registerMemoryIpc } = require('../momo/memoryIpc.cjs');
const { MAX_PASS_TOKENS } = require('../momo/memoryPass.cjs');
const { createFactAliases } = require('../momo/factAliases.cjs');
const { registerMemoryTools } = require('../momo/memoryTools.cjs');
const { setMomoContextProvider, memoryContextProvider } = require('../momo/contract/context.cjs');
const { readMomoPrefs } = require('../../shared/momoPrefs.mjs');
const { createMomoMainChat } = require('../momo/mainChat.cjs');
const { registerMomoMainChatIpc, brainChangedTo } = require('../momo/mainChatIpc.cjs');
const { settledFor } = require('../momo/settle.cjs');
const { openChannels, channelsOn, channelContext, registerMomoChannels } = require('./momoChannels.cjs');
const { registerMomoAskIpc } = require('../momo/askIpc.cjs');
const { AuditLog } = require('../momo/audit.cjs');
const { resetGrant } = require('../platform/helperOffline.cjs');
const { Sentinel } = require('../momo/sentinel.cjs');
const { isolateMomoChats } = require('../momo/isolation.cjs');
const { SiteList } = require('../momo/sentinelSites.cjs');
const { riskyUnasked } = require('./momoSiteRisk.cjs');
const { sentinelFileStorage } = require('../momo/sentinelStore.cjs');
const { createTrustGate } = require('../momo/trustGate.cjs');
const { createMomoActionAsk } = require('../momo/actionAsk.cjs');
const { registerMomoDebugAction } = require('../momo/debugAction.cjs');
const { createMomoSources, createConnectAsk } = require('../momo/sources/index.cjs');
const { registerSourcesIpc } = require('../momo/sources/ipc.cjs');
const { registerSourceTools } = require('../momo/sources/tools.cjs');
const { createWriter } = require('../momo/sources/write.cjs');
const { registerWriteTools } = require('../momo/sources/writeTools.cjs');
const { registerOutputs, registerOutputsFor } = require('./momoOutputs.cjs');
const { sourceDecide, sourceAudit, connectorDecide, connectorAudit } = require('../momo/sourceTrust.cjs');
const { createMomoCallGate, chatIdentity } = require('../momo/toolTrust.cjs');
const { addHook, addGuard } = require('../session/hookChain.cjs');
const { openMomoBackground } = require('./momoBackground.cjs');
const { momoMcpSources } = require('./momoMcpSources.cjs');
const { openMomoHistory, pastChatsFor } = require('./momoHistory.cjs');
const { registerHistoryTools } = require('../momo/historyTools.cjs');
const { resetMomoChats } = require('../momo/chatsReset.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isolates } = require('../harness/quirks/index.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');

/**
 * The harnesses MoMo may run on, in the order the app offers them: the first tier, then each admitted basic one whose
 * quirks confine it (#2278).
 * @param {{ list: () => { id: string, state: string }[] } | null | undefined} admission
 */
const harnessKinds = (admission) => [
  'claude',
  'codex',
  ...(admission?.list() ?? []).filter((h) => h.state === 'admitted' && isolates(h.id)).map((h) => `acp:${h.id}`),
];

/**
 * The macOS helper's client for Calendar and Reminders, read from computer use at each call (it is set up after MoMo);
 * until there is one, a call is refused as the helper being unavailable (sources/eventKit.cjs).
 * @param {{ computerUse?: { helper?: { call: (method: string, params?: object, opts?: object) => Promise<any> },
 *   releaseHelper?: () => 'stopped' | 'none' | 'busy', offlineStatus?: (kind: 'eventkit' | 'permissions') => Promise<any>,
 *   helperInfo?: { bundleId: string } } | null }} live
 * @param {typeof resetGrant} [reset] clears macOS's record of the helper's answer (tccutil; tests pass a fake)
 */
function lazyHelper(live, reset = resetGrant) {
  return {
    call: (/** @type {string} */ method, /** @type {object} */ params, /** @type {object} */ opts) => {
      const helper = live.computerUse?.helper;
      if (!helper) return Promise.reject(Object.assign(new Error('computer use is not set up yet'), { reason: 'helper_unavailable' }));
      return helper.call(method, params, opts);
    },
    // the helper is quit while System Settings is open on a privacy list, and its grants are read by one launched for the read
    release: () => live.computerUse?.releaseHelper?.() ?? 'none',
    offlineStatus: (/** @type {'eventkit'} */ kind) =>
      live.computerUse?.offlineStatus?.(kind) ?? Promise.reject(new Error('computer use is not set up yet')),
    // a request macOS answered without its prompt clears the helper's own record once (#2999); a test's fake helper on a socket has none
    resetGrant: (/** @type {'calendar' | 'reminders'} */ entity) => {
      const cu = live.computerUse;
      const bundleId = cu?.helperInfo?.bundleId;
      return !cu?.helper || /** @type {any} */ (cu.helper).connectTo || !bundleId ? Promise.resolve(false) : reset(entity, { bundleId });
    },
  };
}

/**
 * The account a MoMo chat's current segment runs on, for its audit entries: the account pool's pin for its native
 * session (the pool pins Codex threads by their id), else the chat's saved login; an ACP harness keeps none here.
 * @param {{ accounts?: { pins?: Map<string, { id?: string }> } | null }} live
 * @returns {(rec: any, segment: any) => string | undefined}
 */
/**
 * The URL a MoMo chat's tab in `browser` shows now, from the browser that owns it (the in-app browser's tabs, the panel
 * browser, the user's Chrome over the relay), never opening one: the named tab, else the chat's current one; null
 * when there is none or it can't be read (MoMo's gate then counts the page as a new host).
 * @param {{ browserTabs?: any, panelBrowser?: any, chromeRelay?: any }} live
 * @returns {(chatId: string, browser: string, tabId: unknown) => string | null}
 */
const momoPageOf = (live) => (chatId, browser, tabId) => {
  if (browser === 'sage_browser') return live.panelBrowser?.currentUrl(chatId) ?? null;
  const tabs = browser === 'chrome' ? live.chromeRelay?.tabs : live.browserTabs;
  const named = tabId != null && tabId !== '';
  const tab = named ? tabs?.list(chatId).find((/** @type {any} */ t) => String(t.id) === String(tabId)) : tabs?.current(chatId);
  return tab?.url || null;
};

/**
 * The account a harness runs a new chat on with no pick of its own: Codex's and Claude Code's active login (MoMo's own
 * Codex app-server signs in to it too), a basic harness's own sign-in (its one instance, named by its id).
 * @param {any} live
 * @param {unknown} kind a segment's harness kind
 * @returns {string | undefined}
 */
const accountInUse = (live, kind) => {
  const k = parseKind(kind);
  if (!k) return undefined;
  const instances = live.identity?.instances(k.family) ?? [];
  return (k.basic ? instances.find((/** @type {any} */ i) => i.account === k.basic) : instances.find((/** @type {any} */ i) => i.active))
    ?.account;
};

/** The account a chat runs on: its pool pin (Codex), else the one it saved, else the one its harness has in use. */
const momoAccountOf = (live) => (rec, segment) =>
  live.accounts?.pins?.get(segment?.nativeId)?.id ?? rec?.meta?.account?.id ?? accountInUse(live, segment?.kind);

/**
 * @param {object} deps
 * @param {string} deps.userData the app's data folder (app.getPath('userData'))
 * @param {any} deps.ipcMain
 * @param {any} deps.live main's late-bound services (electron/main.cjs)
 * @param {{ setIsolated: (fn: (chatId: string) => boolean) => void }} deps.claude electron/harness/claude/index.cjs (MoMo's chats' sessions)
 * @param {() => any} deps.readState ui-state.json (prefs)
 * @param {(channel: string, payload?: unknown) => void} deps.broadcastAll
 * @param {{ commandMainWindow: (cmd: string, ...args: any[]) => Promise<void>, readyMainWindow: () => Promise<unknown>,
 *   chatInView?: (chatId: string) => boolean }} deps.appWindows
 * @param {any} deps.chatStart how main makes a chat with no window (ChatStarter's options, app/automations.cjs)
 * @param {(kind: string, o?: { unattended?: boolean }) => Promise<boolean>} deps.usable a harness can run now
 * @param {(controller: any, chatId: string, item: object, origin: null) => Promise<any>} deps.sendRun a run's first message,
 *   through the ChatController (app/automations.cjs sendRunMessage)
 * @param {{ safeStorage: any, dialog: any, shell: any, BrowserWindow: any }} [deps.electron] Electron's (tests pass fakes)
 * @param {() => boolean} [deps.allowed] the closed-alpha gate (tests)
 * @param {(cb: (allowed: boolean) => void) => () => void} [deps.onAccess] its changes (tests)
 */
function openMomo({
  userData,
  ipcMain,
  live,
  claude,
  readState,
  broadcastAll,
  appWindows,
  chatStart,
  usable,
  sendRun,
  electron,
  allowed = momoAllowed,
  onAccess = onMomoAccess,
}) {
  const isMomoChat = (/** @type {string} */ chatId) => isMomoMeta(live.chats?.records.get(chatId)?.meta);
  // first, before any store, IPC or tool: the security boundary holds even when a service after it can't be made
  const dir = momoDir(userData);
  isolateMomoChats(live, claude, isMomoChat, momoWorkspace(dir));
  const { safeStorage, dialog, shell, BrowserWindow } = electron ?? require('electron');
  const momoChatIds = () => [...live.chats.records].filter(([, r]) => isMomoMeta(r?.meta)).map(([id]) => id);
  const owner = (/** @type {{ chatId: string, segmentId: string }} */ ctx) => chatOwning(live.chats?.records, ctx);
  const broadcast = (/** @type {string} */ channel) => broadcastAll(channel);

  // memory: its tab, its tools and the context a MoMo chat's turn carries
  // saved facts' search aliases (momo/factAliases.cjs), matched by the memory's search and written in the background
  const factAliases = createFactAliases({ dir, safeStorage, store: () => memory });
  const memory = new MemoryStore({ dir, safeStorage, isMomoChat, aliases: () => factAliases.lookup() });
  // L4 open loops (P4): kept and reset with the memory
  const loops = new OpenLoopStore({ dir, safeStorage });
  /** @type {any} the routines and the memory pass, made last (openMomoBackground below), before any IPC call can come */
  let background = null;
  registerMemoryIpc(ipcMain, {
    store: memory,
    allowed,
    broadcast,
    // the day's background tokens: the shared cap and each kind's share (memory pass, search aliases)
    background: () => ({ ...background.backgroundBudget.usage(), maxTokensPerPass: MAX_PASS_TOKENS }),
  });
  // a background chat that answers with data (the memory pass, search aliases) reads what the user said: it never writes
  // memory itself, and its turns carry no memory context (shared/momoChat.mjs isMomoDataMeta)
  const passChat = (/** @type {string} */ chatId) => isMomoDataMeta(live.chats?.records.get(chatId)?.meta);
  if (live.capabilities) registerMemoryTools(live.capabilities, { store: memory, allowed, isMomoChat, owner, passChat });
  // the user's open loops: the Memory tab, a nudge's card and MoMo's tool change them the same way (dismissing one also
  // spaces out its kind, through the nudge check made below)
  const loopAct = createLoopActs({ loops, dismissed: (kind) => background?.nudges?.dismissed(kind) });
  registerLoopsIpc(ipcMain, { loops, act: loopAct, allowed, broadcast });
  if (live.capabilities) registerLoopTools(live.capabilities, { loops, act: loopAct, allowed, isMomoChat, owner, passChat });
  // channels and groups (A2): the registry, sealed beside the memory; a channel's own instructions go into its chat's turns only
  const channelStore = openChannels({ dir, safeStorage });
  // the drafts MoMo writes for the user (A3): a card in the chat, never sent by MoMo
  openMomoDrafts({ ipcMain, live, shell, broadcastAll, allowed, isMomoChat, owner, passChat });
  setMomoContextProvider(
    memoryContextProvider({
      store: memory,
      allowed,
      isMomoChat: (/** @type {string} */ chatId) => isMomoChat(chatId) && !passChat(chatId),
      name: () => readMomoPrefs(readState()?.prefs?.momo).persona.name,
      // what MoMo's other chats said that bears on the turn (the index below, made once the turn can start)
      history: (chatId, query) => pastChatsFor(history.index, chatId, query),
      // the reminders MoMo showed in this chat lately: the user may be answering one
      nudges: (chatId) => recentNudges(live.chats?.record(chatId)?.meta?.notes, Date.now()),
      channel: channelContext(channelStore.channels, () => channelsOn(readState)),
    }),
  );
  const memoryFiles = memoryFilesReset(dir, { idle: () => memory.idle() });
  registerMomoStore('memory', async () => {
    await loops.erase();
    await memoryFiles();
  });

  // the trust layer: one audit log and one sentinel per data folder, each holding its folder's lock while it writes
  const audit = new AuditLog({ dir: path.join(dir, 'audit'), safeStorage });
  const storage = sentinelFileStorage({ file: path.join(dir, 'approvals.bin'), safeStorage });
  const harnessOf = (/** @type {string} */ chatId) => live.controller?.ref(chatId)?.kind;
  // the approval card, through the app's ApprovalBroker (computer use sets it up after MoMo: looked up at each ask)
  const asks = createMomoActionAsk({
    broker: () => live.computerUse?.broker ?? null,
    harnessOf,
    sourceName: (id) => sentinel.sources.get(id)?.name,
  });
  // the sites MoMo may open after a private read are checked against the browser's site risk (sentinelSites.cjs)
  const sentinel = new Sentinel({ askUser: asks.askUser, allowed, storage, sites: new SiteList({ risky: riskyUnasked }) });
  // each entry names the chat's harness and account (#2284, #2373): the gate fills in what a caller leaves out
  const identity = chatIdentity(() => live.chats, momoAccountOf(live));
  const trust = createTrustGate({ sentinel, audit, identity });
  // every call of a MoMo chat goes through it, on every harness's channel (#2283)
  live.capabilities?.setChatGate(createMomoCallGate({ trust, sentinel, identity, pageOf: momoPageOf(live) }));
  // E2E runs: a MoMo tool whose change asks, for the fake harnesses
  if (live.capabilities && process.env.SAGE_DEBUG_TOOLS === '1')
    registerMomoDebugAction(live.capabilities, { trust, sentinel, allowed, isMomoChat, owner, harnessOf });
  registerMomoStore('approvals', async () => {
    for (const id of momoChatIds()) sentinel.clearChat(id);
    sentinel.revokeAll();
    await sentinel.close();
    fs.rmSync(path.join(dir, 'approvals.bin'), { force: true });
  });
  // the log deletes its own folder in its queue, and the next entry starts it again (#2307)
  registerMomoStore('audit', () => audit.erase());
  // a deleted MoMo chat's taint and runs go with it
  if (live.chatDeletion)
    addHook(live.chatDeletion, 'onDeleted', (/** @type {{ chatId: string }} */ r) => {
      if (!isMomoChat(r.chatId)) return;
      sentinel.clearChat(r.chatId);
      asks.withdrawChat(r.chatId);
      connects.withdrawChat(r.chatId);
    });

  // local sources: each read decided by the sentinel and recorded in the audit log
  const sources = createMomoSources(
    {
      dir,
      safeStorage,
      allowed,
      decide: sourceDecide(sentinel, identity),
      audit: sourceAudit(audit, identity),
      // computer use is set up after MoMo (app/startup.cjs): its helper is looked up on each call
      helper: lazyHelper(live),
    },
    {
      // a connector's call: the sentinel decides it (a change asks on the card) and the audit log records it
      decide: connectorDecide(sentinel, identity),
      audit: connectorAudit(audit, identity),
      openExternal: (/** @type {string} */ url) => shell.openExternal(url),
      // the test connector, for the E2E runs (as momo_debug_action)
      fake: process.env.SAGE_DEBUG_TOOLS === '1',
      // the MCP servers coding chats use, read only, for the ones the user allows into MoMo
      mcp: momoMcpSources(),
    },
  );
  // writes to Calendar and Reminders (#2139 P5): the same trust gate as every other change, on every harness
  const writer = createWriter({
    hub: sources.hub,
    eventKit: sources.eventKit,
    ledger: sources.writeLedger,
    trust,
    sentinel,
    audit,
  });
  registerSourcesIpc(ipcMain, {
    sources,
    writer,
    allowed,
    // main's own folder dialog over the window that asked
    pickFolder: async (/** @type {any} */ e) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) throw new Error('Not an app window');
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    broadcast,
    openExternal: (/** @type {string} */ url) => shell.openExternal(url),
  });
  // MoMo's files (Outputs): behind the `momo.outputs` flag, read on every call; its IPC here, its tools with the other tools below
  registerOutputs(ipcMain, { sources, allowed, shell, dialog, BrowserWindow, broadcast });
  // the draft card's Send: the user's click, through the connector hub's trust layer (momoDraft:accounts, :send, :state)
  openMomoDraftSend({ ipcMain, hub: sources.connectorHub, live, broadcastAll, allowed, isMomoChat });
  // a tool that finds Calendar or Reminders not connected asks on a card in its chat; a routine's unattended run has a scope and is not asked
  const connects = createConnectAsk({
    broker: () => live.computerUse?.broker ?? null,
    hub: sources.hub,
    harnessOf,
    attended: async (/** @type {string} */ chatId) => (await sources.hub.scope(chatId)) === null,
  });
  if (live.capabilities) {
    registerSourceTools(live.capabilities, { sources, allowed, isMomoChat, owner, connectAsk: connects });
    registerWriteTools(live.capabilities, { writer, allowed, isMomoChat, owner });
    registerOutputsFor(live.capabilities, { sources, trust, sentinel, allowed, isMomoChat, owner });
    // the coding-side MCP servers the user allowed into MoMo (#2999): their tools join these, for MoMo's chats only
    sources.mcpProxy.attach({ registry: live.capabilities, isMomoChat, owner });
    void sources.mcpProxy.sync();
  }
  registerMomoStore('sources', async () => {
    sources.hub.reset();
    await sources.writeLedger.erase();
    await sources.outputs.erase();
  });
  registerMomoStore('connectors', async () => {
    sources.connectorHub.reset();
    sources.mcpProxy.reset();
    await sources.mcpAllowlist.erase();
    return sources.connectorVault.erase();
  });

  // the main chat, made in MoMo's own workspace on MoMo's brain
  const mainChat = createMomoMainChat({
    dir,
    chatStarter: new ChatStarter(chatStart),
    controller: live.controller,
    chats: live.chats,
    prefs: { get: () => readState()?.prefs, patch: (/** @type {object} */ set) => live.patchPrefs?.(set) === true },
    accounts: {
      codex: () => live.accounts,
      claude: live.claudeTurns,
      claudeLogins: () => (live.identity?.instances('claude') ?? []).filter((i) => i.kind !== 'sageKey').map((i) => i.account),
      laneOf: (/** @type {string} */ harness, /** @type {string} */ account) =>
        (live.identity?.instances(harness) ?? []).find((i) => i.account === account)?.billing ?? null,
    },
    allowed,
    usable: (/** @type {string} */ kind) => usable(kind),
    kinds: () => harnessKinds(live.acpAdmission),
    changed: (/** @type {string} */ id) => broadcastAll('chats:changed', { id, chat: live.chats.get(id) }),
    brainChanged: brainChangedTo(broadcastAll),
    env: () => live.acpHost?.envOf?.() ?? process.env,
    // the model lists a brain's effort is checked against
    efforts: effortSources(live),
  });
  registerMomoMainChatIpc(ipcMain, { service: mainChat, allowed, activity: () => live.momoActivity });
  // channels: each one's chat is a MoMo chat made on MoMo's brain (A2)
  const channelsApi = registerMomoChannels(ipcMain, {
    store: channelStore,
    mainChat,
    live,
    allowed,
    readState,
    broadcastAll,
    history: () => history.index,
  });
  // a message to a MoMo chat goes after the brain change a window made just before it (#3907): the effort and model it shows
  if (live.controller) addGuard(live.controller, 'beforeDispatch', (/** @type {{ chatId: string }} */ e) => settledFor(mainChat, e.chatId));
  // the channels' registry (channels.json) goes with the chats it names
  registerMomoStore('chats', () =>
    resetMomoChats({ live, ids: momoChatIds, clear: (id) => sentinel.clearChat(id), dir, mainChat }).then(() => channelStore.erase()),
  );
  // the index of MoMo's past chats (#2999), fed by every MoMo chat's finished turn
  const history = openMomoHistory({ dir, safeStorage, live, chatIds: momoChatIds, allowed, harnessOf });
  if (live.capabilities) registerHistoryTools(live.capabilities, { index: history.index, allowed, isMomoChat, owner });

  // Ask MoMo in Quick Chat: MoMo's main chat, and only it
  registerMomoAskIpc(ipcMain, {
    isQuickChat: (/** @type {unknown} */ sender) => isQuickChatSender(live.mini, sender),
    allowed,
    mainChat: () => mainChat.ensureMainChat(),
    ready: () => appWindows.readyMainWindow(),
    send: (/** @type {string} */ chatId, /** @type {object} */ item, /** @type {number} */ senderId) =>
      live.controller.send(chatId, item, senderId, true),
    openMomo: async () => {
      await appWindows.commandMainWindow('momo');
      live.mini?.hide();
    },
  });

  /** MoMo is allowed (at startup, or again): intents a quit left open are settled and the approvals read. */
  const start = () => {
    if (allowed() !== true) return;
    audit.settleUnfinished().catch((error) => noteIgnored("settle MoMo's unfinished actions", error));
    sentinel.load().catch((error) => noteIgnored("read MoMo's remembered approvals", error));
    history.start();
  };
  // and turned off: no approval card it put up stays to be answered
  onAccess((on) => {
    if (on) return start();
    asks.withdrawAll();
    connects.withdrawAll();
  });
  start();

  const core = {
    dir,
    memory,
    loops,
    factAliases,
    audit,
    sentinel,
    trust,
    asks,
    connects,
    sources,
    mainChat,
    channelsApi,
    isMomoChat,
    owner,
    history: history.index,
  };
  // routines and MoMo's notices (app/momoBackground.cjs)
  background = openMomoBackground(core, {
    ipcMain,
    live,
    readState,
    broadcastAll,
    appWindows,
    usable,
    sendRun,
    safeStorage,
    allowed,
    onAccess,
  });
  return {
    ...core,
    ...background,
    history: history.index,
    historyIndexer: history.indexer,
    /** At quit: the trust layer's queued writes and the chat index go to disk, and the folder locks are let go. */
    close: () => {
      history.index.flush();
      return Promise.all([sentinel.close(), audit.close()]).then(() => undefined);
    },
  };
}

module.exports = { openMomo, lazyHelper, isolateMomoChats, harnessKinds, momoAccountOf, momoPageOf };
