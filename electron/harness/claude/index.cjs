// The Claude Code harness in main: composes its section modules around one shared state and serves the claude:* IPC. @host-portable: loads in the Host process without Electron (host/boundary.json).
// Claude Code harness: drives the user's own, unmodified `claude` binary through the Agent SDK.
// Sage never reads, stores or refreshes Claude.ai (subscription) credentials. The CLI uses whatever
// login the user made themselves with `claude auth login`; we only scrub inherited auth variables so
// that login is what gets used (see design/multi-harness).
// The one credential Sage does keep is an optional Anthropic API key for pay-as-you-go usage. It is
// kept encrypted with safeStorage in a private file (electron/platform/secretFile.cjs; never saved without the OS
// key), stays in this process, and is handed to the CLI as ANTHROPIC_API_KEY; the renderer only ever learns whether one is set and its last four characters.
//
// Sections (each a factory over the state from electron/harness/claude/state.cjs, none requiring another's instance):
// claudeAuth (credential and environment), claudeCli (the binary), claudeQueries (bounded helper queries),
// claudeCatalog (slash commands), claudeSessionOptions (what a process starts with), claudeSessions (the live
// processes), claudeChromeSessions (Claude in Chrome across them) and claudeTranscripts (the files on disk).
const { clock } = require('../../platform/ports/clock.cjs');
const { createDeleteSession } = require('./delete.cjs');
const { createForks } = require('./forks.cjs');
const { createRename } = require('./rename.cjs');
const { createUserTitle } = require('./userTitle.cjs');
const { forkPoint } = require('./transcriptEdits.cjs');
const { createLinkedClaudeFork } = require('./linkedFork.cjs');
const { searchCaller } = require('../../platform/searchScans.cjs');
const { paths } = require('../../platform/ports/paths.cjs');
const { openExternal } = require('../../platform/ports/openExternal.cjs');
const { ClaudeAccounts } = require('./accounts.cjs');
const { claudeBilling } = require('../../identity/contract/claudeBilling.cjs');
const { createState, noChromeLink } = require('./state.cjs');
const { createAuth } = require('./auth.cjs');
const { createCli, unrefTimer } = require('./cli.cjs');
const { createQueries, withGatewayModels } = require('./queries.cjs');
const { createUsageSchedule, loginAccounts } = require('./usageSchedule.cjs');
const { createCatalog, mergeCatalog } = require('./catalog.cjs');
const { createDesignLogin } = require('./designLogin.cjs');
const {
  Channel,
  buildSessionOptions,
  buildUserMessage,
  flagSettings,
  planApproval,
  restoreMode,
  elicitationResult,
} = require('./sessionOptions.cjs');
const { createSessions } = require('./sessions.cjs');
const { createClaudeGovernor } = require('./governor.cjs');
const { createWarm } = require('./warm.cjs');
const { readTaskOutput, keepAlive, hasActivity } = require('./tasks.cjs');
const { claudeProcesses } = require('../routeProcesses.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { claudeLedgerAccount } = require('../../ledger/accounts.cjs');
const { createChromeSessions } = require('./chromeSessions.cjs');
const { serverIdOf } = require('./loginIdentity.cjs');
const { createIdentityApi } = require('./identityApi.cjs');
const { readCliLogin } = require('./cliLoginRead.cjs');
const {
  createTranscripts,
  transcriptPath,
  findTranscript,
  findSessionCwd,
  sessionSettings,
  goalStatus,
  checkpoints,
  presence,
} = require('./transcripts.cjs');

/**
 * The Claude Code harness: one state the sections share, made once by main (docs/architecture/modularization.md §3:
 * main or the app factories make the singletons); a test makes its own for fresh state. `handedOff`: the app's browser-layer check for a page handed to the user's Chrome (none in a process without a browser). `sdk`: how the Agent SDK is loaded when the default import is not wanted. `spawn`: how Claude Code is started when the SDK's own spawn is not wanted.
 */
function createClaudeHarness(o = /** @type {import('./state.cjs').HarnessOptions} */ ({})) {
  const state = createState(o);
  const transcripts = createTranscripts(state);
  // the one edge back: a credential change restarts idle CLIs, looked up when it happens
  const auth = createAuth(state, { restartIdle: () => cliSessions.restartIdle() });
  const cli = createCli(state, auth, o.preferHighestCli);
  const queries = createQueries(state, { auth, cli });
  // one schedule for every window and the identity layer: a login's /usage runs only when it is due
  const usageSchedule = createUsageSchedule({
    read: (bin, account) => queries.usage(bin, account),
    measuredAt: (configId) => state.accts?.usageFetchedAt(configId) ?? null,
    onLeft: (...read) => state.onLoginLeft(...read),
    configIdOf: (account) => auth.configIdOf(account),
    active: () => state.activeAccount(),
    // two logins of one server account are one quota (#1312)
    ...loginAccounts(() => state.accts),
  });
  const catalog = createCatalog(state, { auth, queries });
  const chrome = createChromeSessions(state);
  const cliSessions = createSessions(state, { auth, cli, catalog, chrome, handedOff: o.handedOff });
  /** When idle CLIs end: the reaper's limits, the cap and memory pressure (harness/claude/governor.cjs). */
  const governor = createClaudeGovernor({
    sessions: () => state.sessions,
    retirable: cliSessions.retirable,
    retire: cliSessions.retire,
    held: cliSessions.remote.holds,
  });
  state.beforeStart = governor.makeRoom;
  const { prewarm, prewarmTaken, prewarmDrop, warm } = createWarm(state, cliSessions, governor);
  const deleteSession = createDeleteSession(state, cliSessions, unrefTimer);
  const forks = createForks(state, forkPoint, deleteSession, findTranscript);
  const renameSession = createRename(
    () => state.sdk(),
    findTranscript,
    (sessionId) => state.sessions.get(`claude:${sessionId}`)?.q,
  );
  /** The Claude Design sign-in, made when the IPC is registered. @type {ReturnType<typeof createDesignLogin> | null} */
  let designLogin = null;
  /** How long each CLI gets to run its exit hooks when the app quits (quitting itself waits at most 3 s, electron/app/lifecycle.cjs). */
  const QUIT_GRACE_MS = 2500;

  /** MoPilot credits: the CLI talks to the MoPilot gateway with the device's key. */
  const setGatewayKeyProvider = (fn) => (state.gatewayKey = fn);
  /** MoPilot's gateway capability table by model (main wires mopilot.modelCaps); null when unknown. */
  const setGatewayCapsProvider = (fn) => (state.gatewayCaps = fn);
  /** The model router (app/ipc/routing.cjs) for "Your own provider"; a saved or removed config restarts the idle CLIs it changes. */
  const setRouting = (r) => ((state.routing = () => r), r.onChange(() => cliSessions.restartIdle()));

  /** The capability registry and tool sessions (electron/capabilities) every new session gets its tools from. */
  function setTools(t) {
    state.sageTools = t;
  }

  /** The plugin store's delivery (electron/plugins/delivery.cjs): every new session loads its plugins. */
  function setPlugins(p) {
    state.plugins = p;
  }

  /** (key) => chatId: the chat a session key belongs to (main's controller.chatOf), for processes started without one. */
  function setChatOf(fn) {
    state.chatOf = (key) => fn(key) ?? key;
  }

  /** (chatId) => boolean: the chat is kept apart from the coding side (MoMo's): no CLAUDE.md, no auto memory. */
  const setIsolated = (fn) => (state.isolated = fn);
  /** (fn) => void: called when a probe or a session's getSettings has new answers. */
  const setProbeListener = (fn) => (state.onProbe = fn);

  /** Pass a result through, after telling the listener that the account or billing mode may have changed. */
  const tell = (v) => (state.onProbe(), v);
  /** What a running session's getSettings last said (null: no live session, or not read yet). */
  const appliedOf = (key) => state.sessions.get(key)?.applied ?? null;

  /** Main learns of each change: (chatId, link | null, key) — null once the session on `key` is gone. */
  function setChromeLinkListener(fn) {
    state.onChromeLink = fn ?? noChromeLink;
  }

  /** When each live CLI process started, for the stale-config check (electron/harness/routes.cjs). @type {Map<string, number>} */
  const processStarts = new Map();
  /** Main learns of each CLI process start: (chatId, key), so the chat's controller plan reads what the process runs. */
  function setProcessListener(fn) {
    state.onProcess = (chatId, key) => {
      processStarts.set(key, clock.now());
      fn(chatId, key);
    };
  }
  /** The live CLI processes, and restarting the idle ones that started before a config change. */
  const routeProcesses = claudeProcesses({
    sessions: () => state.sessions,
    started: processStarts,
    retire: (key) => cliSessions.retire(key),
    keepAlive,
  });

  /** Whether the live CLI on `key` runs Claude in Chrome; null when no process runs for it. */
  const nativeChromeOf = (key) => state.sessions.get(key)?.nativeChrome ?? null;

  /** Registry names that this live process can call; null before it starts. */
  const toolsOf = (key, names) => {
    const session = state.sessions.get(key);
    const server = state.sageTools?.sessions?.get(session?.toolKey)?.serverName;
    const naming = require('../../capabilities/contract/surfaceNote.cjs').claudeNames(server);
    return session ? names.filter((name) => session.sageTools?.has(naming.name(name))) : null;
  };

  /** Main's segment scope for Claude in Chrome (electron/session/segmentScope.cjs): which sessions' links are their chat's. */
  function setChromeScope(fn) {
    state.chromeScope = fn;
  }

  /** Sage's own session on this key is mid-turn, on a prompt it sent or one the CLI woke itself for (its writes aren't another app's). */
  const ownBusy = (key) => {
    const s = state.sessions.get(key);
    return !!(s?.busy || s?.woken);
  };
  /** How many /loop wake-ups and cron jobs the session holds (quitting drops them). */
  const scheduled = (key) => {
    const s = state.sessions.get(key);
    return s ? s.sched.crons + (s.sched.wakeAt > clock.now() ? 1 : 0) : 0;
  };

  /** A CLI process is running for this session key. */
  const isLive = (key) => state.sessions.has(key);

  /** What the main-side turn code (electron/harness/claude/adapter.cjs) reads and asks of this module. */
  const turnApi = {
    isLive,
    /** Start an existing chat's CLI before it sends (electron/harness/claude/warmOnOpen.cjs, harness/claude/warm.cjs warm). */
    warm,
    detect: (bin) => cli.detect(bin, false, false),
    control: (key, method, arg) => cliSessions.control(key, method, arg),
    title: (...args) => queries.title(...args),
    rename: (sessionId, name) => renameSession(sessionId, name),
    /** The name the chat was given (not its CLI's own title, which getSessionInfo counts too), or null. */
    userTitle: createUserTitle(findTranscript),
    goalStatus: (sessionId) => goalStatus(sessionId),
    /** A session's folder from its transcript, read without blocking the main process (a Promise). */
    sessionCwd: (sessionId) => findSessionCwd(sessionId),
    sessionSettings,
    findTranscript: (sessionId) => findTranscript(sessionId),
    /** Whether a session has a transcript on disk, in any project folder. */
    hasTranscript: async (sessionId) => (await findTranscript(sessionId)) !== null,
    /** The logins ({active, accounts}); the active one is what a new chat runs on. */
    accounts: () => state.accts?.view() ?? { active: state.activeAccount(), accounts: [] },
    /** (fn) => void: fn(account) hears that a login works again (a verified check passed, or its status reads signed in again). */
    onLoginWorks: (fn) => (state.onLoginWorks = fn),
    onLoginLeft: (fn) => (state.onLoginLeft = fn),
    /** Read the CLI login before use, or refresh its known binary immediately after sign-in. */
    readCliLogin: async (bin, refresh = false) => readCliLogin(state.accts, refresh ? (bin ?? null) : await cli.findBinary(bin), refresh),
    /** A key or MoPilot credits run the whole harness: there is no other login to move a chat to. */
    keyMode: () => auth.authMode() !== 'subscription',
    /** Whether a round costs money (an API key, the user's own provider), so a goal's round limit applies (claudeGoalRoundLimit). */
    metered: () => {
      const v = state.accts?.view();
      const a = v?.accounts?.find((x) => x.id === v.active);
      const b = claudeBilling(auth.authMode(), auth.readBase(), a?.authMethod, auth.cloudRoute());
      return b.label === 'API key' || b.mode === 'routed';
    },
  };

  /** Readers of every session event besides the hooks, each on its own (the request ledger, electron/ledger/claudeTap.cjs). */
  const observers = new Set();
  /** @param {(evt: any) => void} fn @returns {() => void} stops it */
  function observe(fn) {
    observers.add(fn);
    return () => observers.delete(fn);
  }
  /** One reader of a session event; one that throws costs neither the others nor the broadcast to the windows. */
  function hear(fn, evt) {
    try {
      fn?.(evt);
    } catch (error) {
      noteIgnored(`handle a Claude Code ${evt.kind} event`, error);
    }
  }
  /**
   * The server account each process's login was when it started (null while not known): a process keeps the token it
   * started with, so its turns' figures are that account's even after the login is signed in again as another (#1582).
   */
  const startedAs = new Map();
  const PROCESS_ENDS = new Set(['closed', 'error']);
  const serverAccountAt = (key) => {
    const s = state.sessions.get(key);
    return s && state.accts && s.billing === 'subscription' ? serverIdOf(state.accts, s.account) : null;
  };
  /** A turn's report of its login's plan usage, kept in main's usage store (harness/claude/usageSchedule.cjs). */
  function noteLiveUsage(evt) {
    if (evt.msg?.type === 'rate_limit_event') usageSchedule.heard(evt.account, evt.msg.rate_limit_info, evt.serverAccount);
    else if (evt.msg?.type === 'assistant' && evt.msg.error === 'rate_limit') usageSchedule.limited(evt.account, evt.serverAccount);
  }
  /** The account a session event's turn runs on, as the request ledger names it (electron/ledger/accounts.cjs). */
  const ledgerAccount = (evt) => claudeLedgerAccount(evt, { view: () => state.accts?.view(), ...auth.ledgerMarks });

  /**
   * @param ipcMain
   * @param broadcast (channel, payload) => void
   * @param {object} [hooks]
   * @param [hooks.onEvent] sees each event before the windows (electron/session/controller.cjs)
   * @param [hooks.onControl] (key, method) => void: a window interrupted a session
   * @param [hooks.onPermission] (requestId) => void: a window answered a request
   * @param [hooks.onWatch] (key, file) => void: a session's transcript is watched
   * @param [hooks.onUnwatch] (key) => void: it no longer is
   * @param [hooks.pages] () => what a transcript's page takes from the app: `liveTurn(key)` and `diffs(key, turnIds)` (turnReads.cjs)
   */
  function register(ipcMain, broadcast, hooks = {}) {
    state.watchHooks = { onWatch: hooks.onWatch, onUnwatch: hooks.onUnwatch };
    state.emit = (evt) => {
      if (evt.kind === 'processStarted') startedAs.set(evt.key, serverAccountAt(evt.key));
      // a fork a CLI ran is a chat's now: a window can no longer discard it
      if (evt.kind === 'processStarted') forks.claim(evt.key);
      if (PROCESS_ENDS.has(evt.kind)) startedAs.delete(evt.key);
      // a turn's output on a login: it is in use, so its usage is read as often as the active one's
      if (evt.kind === 'message' && evt.login && evt.account) {
        evt.serverAccount = startedAs.get(evt.key) ?? null;
        usageSchedule.used(evt.account);
        // what it says of the login's plan usage is the newest reading there is, with no window open too
        hear(noteLiveUsage, evt);
      }
      hear(hooks.onEvent, evt);
      for (const fn of observers) hear(fn, evt);
      broadcast('claude:event', evt);
    };
    const accounts = new ClaudeAccounts({
      userData: paths.userData(),
      broadcast: (evt) => broadcast('claude:accounts', evt),
      run: (bin, args, account) => cli.run(bin, args, 15000, account),
      signedIn: (id) => {
        usageSchedule.clear(id);
        state.onLoginWorks(id);
      },
      forgotten: (id) => usageSchedule.forget(id),
    });
    state.accts = accounts;

    ipcMain.handle('claude:detect', (_e, override, force, verify, account) => cli.detect(override, force, verify, account ?? undefined));
    // sign the CLI's own login out right away (no terminal needed: it takes no input)
    ipcMain.handle('claude:logout', async (_e, bin) => {
      await cli.run(bin, ['auth', 'logout'], 30000);
    });
    ipcMain.handle('claude:apiKey', () => auth.apiKeyInfo());
    ipcMain.handle('claude:setApiKey', async (_e, key, baseUrl) => tell(await auth.setApiKey(key, baseUrl)));
    ipcMain.handle('claude:setAuthMode', async (_e, mode, configId) => tell(await auth.setAuthMode(mode, configId)));
    ipcMain.handle('claude:setCloudEnv', async (_e, on) => tell(await auth.setCloudEnv(on)));
    ipcMain.handle('claude:clearApiKey', async () => tell(await auth.clearApiKey()));
    auth.artifacts.registerIpc(ipcMain, tell);
    cliSessions.remote.registerIpc(ipcMain);
    ipcMain.handle('claude:probe', (_e, bin, account) => queries.probe(bin, account ?? undefined));
    // reason: 'background' (a timer), 'surface' (a surface showing the login opened) or 'now' (the user asked)
    ipcMain.handle('claude:usage', (_e, bin, account, reason) => usageSchedule.usage(bin, account ?? undefined, reason));
    /* Several Claude Code logins (electron/harness/claude/accounts.cjs). Each call returns the renderer-safe view. */
    ipcMain.handle('claude:accounts', () => accounts.view());
    // a refresh can change the login in use's billing, and a removal the login in use itself: only then are the capabilities read again
    const inUse = (v) => JSON.stringify(v.accounts.find((a) => a.id === v.active));
    ipcMain.handle('claude:refreshAccounts', async (_e, bin) => {
      const before = inUse(accounts.view());
      const v = await accounts.refresh(await cli.findBinary(bin));
      return inUse(v) === before ? v : tell(v);
    });
    ipcMain.handle('claude:addAccount', async (_e, bin) => {
      const b = await cli.findBinary(bin);
      if (!b) throw new Error('Claude Code is not installed');
      return accounts.startLogin(b);
    });
    ipcMain.handle('claude:cancelAccountLogin', () => accounts.cancelLogin());
    ipcMain.handle('claude:reloginCommand', async (_e, bin, id) => accounts.reloginCommand(await cli.findBinary(bin), String(id)));
    // a sign-in for these logins ended: a backoff or an answer kept from before no longer holds their usage back (#1582)
    ipcMain.handle('claude:signInEnded', (_e, ids) => {
      for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string') usageSchedule.clear(id);
    });
    ipcMain.handle('claude:removeAccount', async (_e, bin, id) => tell(accounts.remove(await cli.findBinary(bin), String(id))));
    ipcMain.handle('claude:setActiveAccount', async (_e, id) => tell(await accounts.setActive(String(id))));
    ipcMain.handle('claude:setAccountAutoSwitch', (_e, on) => accounts.setAutoSwitch(!!on));
    // sends go through the ChatController (session:claudeSend), so its turn bookkeeping sees each one
    ipcMain.handle('claude:control', (_e, key, method, arg) => {
      hooks.onControl?.(key, method);
      return cliSessions.control(key, method, arg);
    });
    ipcMain.handle('claude:permission', (_e, requestId, result) => {
      hooks.onPermission?.(requestId);
      return cliSessions.resolvePermission(requestId, result);
    });
    ipcMain.handle('claude:presence', () => presence());
    ipcMain.handle('claude:list', (_e, opts = {}) => transcripts.listSessions(opts.limit ?? 200, opts.offset ?? 0));
    // each search box's newest search (by window and box) replaces the one it ran before
    ipcMain.handle('claude:search', (e, term, limit, scope) => transcripts.searchSessions(term, limit, searchCaller(e, scope)));
    // the window reads a page of built turns, never the raw transcript (tens of MB for a long chat)
    ipcMain.handle('claude:turns', (_e, sessionId, opts) => {
      forks.claim(`claude:${sessionId}`);
      return transcripts.windowPage(String(sessionId), opts, hooks.pages?.());
    });
    ipcMain.handle('claude:subagentItems', (_e, sessionId, agentId, opts) => transcripts.subagentItems(sessionId, agentId, opts));
    // a background task's output file, its last 64 KB (only `…/tasks/<id>.output` files are read)
    ipcMain.handle('claude:taskOutput', (_e, taskId, file) => readTaskOutput(String(taskId), String(file)));
    ipcMain.handle('claude:info', (_e, sessionId) => transcripts.info(sessionId));
    ipcMain.handle('claude:rename', (_e, sessionId, t) => (forks.claim(`claude:${sessionId}`), renameSession(sessionId, t)));
    forks.register(ipcMain);
    ipcMain.handle('claude:checkpoints', (_e, sessionId) => checkpoints(sessionId));
    ipcMain.handle('claude:rewind', (_e, key, opts, uuid, dryRun) => cliSessions.rewind(key, opts, uuid, !!dryRun));
    ipcMain.handle('claude:mcp', (_e, bin, args, account, cwd, mode) =>
      cli.mcpCommand(bin, args, account ?? undefined, cwd ?? undefined, mode),
    );
    ipcMain.handle('claude:mcpLoginCommand', (_e, bin, name, account, mode) => cli.mcpLoginCommand(bin, name, account ?? undefined, mode));
    // /design-login in a Claude Code chat (electron/harness/claude/designLogin.cjs): progress goes to the windows under the window's id
    const login = createDesignLogin({
      findBinary: cli.findBinary,
      cleanEnv: auth.cleanEnv,
      openExternal: (url) => openExternal(url),
      broadcast: (evt) => broadcast('claude:designLogin', evt),
    });
    designLogin = login;
    ipcMain.handle('claude:designLogin', (_e, id, bin, account) => login.start(id, bin, account));
    ipcMain.handle('claude:designLoginCode', (_e, id, code) => login.code(id, code));
    ipcMain.handle('claude:designLoginCancel', (_e, id) => login.cancel(id));
    ipcMain.handle('claude:extras', (_e, ...args) => queries.extras(...args));
    ipcMain.handle('claude:catalog', (_e, bin, cwd, account) => catalog.catalog(bin, String(cwd ?? ''), account ?? undefined));
    state.broadcastCatalog = (evt) => broadcast('claude:catalog', evt);
    ipcMain.handle('claude:watch', (_e, sessionId) => (forks.claim(`claude:${sessionId}`), transcripts.watch(sessionId)));
    ipcMain.handle('claude:sessionSettings', (_e, sessionId) => sessionSettings(sessionId));
    ipcMain.handle('claude:unwatch', (_e, sessionId) => transcripts.unwatch(sessionId));

    // unpersisted side chats exist only in their process, so they're kept until the app quits
    const reaper = clock.setInterval(governor.reap, 60 * 1000);
    reaper.unref?.();
    if (state.reaperTest) globalThis.__claudeReap = (ms) => governor.reap(clock.now() + ms);
  }

  /**
   * A CLI the quit waits for: its exit closes a Claude in Chrome tab group, ends an interrupted turn whose result the
   * chat should still get, or leaves background commands for MoPilot to reap (#1486).
   * @param {{ busy?: boolean, tasks: any, chrome?: { hasGroup(): boolean } | null }} s
   */
  const waitsOnQuit = (s) => !!s.busy || hasActivity(s.tasks) || !!s.chrome?.hasGroup();

  /**
   * Quitting: every CLI ends the way an idle one retires (its input closes, so its exit hooks run and Claude in Chrome
   * closes a tab group left with only blank tabs), and is closed by the SDK after `graceMs`. The quit waits only for the
   * CLIs waitsOnQuit names. An idle one finishes exiting on its own after the app is gone: the SDK sends it SIGTERM as
   * the app exits, and the CLI shuts down gracefully on it (SessionEnd hooks too).
   * @returns {Promise<unknown>} once every CLI the quit waits for quit or was closed
   */
  function closeAll(graceMs = QUIT_GRACE_MS) {
    transcripts.unwatchAll();
    designLogin?.cancelAll();
    // shutdown: a running turn is interrupted first (quitting was confirmed), so it does no more work while the CLI exits
    for (const [key, s] of state.sessions)
      if (s.busy) cliSessions.control(key, 'interrupt').catch((error) => noteIgnored('interrupt a Claude Code turn on quit', error));
    const waits = [];
    for (const [key, s] of [...state.sessions]) {
      const wait = waitsOnQuit(s);
      const ended = cliSessions.retire(key, graceMs);
      if (wait) waits.push(ended);
    }
    return Promise.allSettled(waits);
  }

  /** Pieces the identity layer reads (electron/identity/drivers/claude.cjs). */
  const identity = createIdentityApi({ state, auth, cli, usageSchedule });

  return {
    setIsolated,
    Channel,
    setChromeLinkListener,
    setChromeScope,
    setProcessListener,
    routeProcesses,
    nativeChromeOf,
    toolsOf,
    chromeLinks: chrome.chromeLinks,
    chromeLinkOf: chrome.chromeLinkOf,
    chromeReconnect: chrome.chromeReconnect,
    chromeBrowsers: chrome.chromeBrowsers,
    chromeSelect: chrome.chromeSelect,
    retire: cliSessions.retire,
    retireChat: cliSessions.retireChat,
    reap: governor.reap,
    governor,
    timing: state.timing,
    nativeChromeFor: auth.nativeChromeFor,
    elicitationResult,
    messages: transcripts.messages,
    ...transcripts.turnReads,
    replies: transcripts.replies,
    info: transcripts.info,
    listSessions: transcripts.listSessions,
    summarize: queries.summarize,
    turnApi,
    forkLinkedSession: createLinkedClaudeFork({ sdk: () => state.sdk(), findTranscript }),
    prewarm,
    prewarmTaken,
    prewarmDrop,
    visionAuth: auth.visionAuth,
    probeInfo: queries.probeInfo,
    // a login's models when no window has asked yet (Chrome's side panel menu, app/chromePanelOptions.cjs)
    probe: queries.probe,
    // a folder's commands with no window (Chrome's side panel / menu, app/chromePanelCommands.cjs)
    catalog: catalog.catalog,
    appliedOf,
    setProbeListener,
    register,
    deleteSession,
    send: cliSessions.send,
    // a card answered with no window (Chrome's side panel, app/chromePanel.cjs), as claude:permission answers one
    resolvePermission: cliSessions.resolvePermission,
    closeAll,
    mopilotChanged: auth.mopilotChanged,
    billingSig: auth.billingSig,
    version: cli.version,
    versionOf: cli.versionOf,
    scrubProcessEnv: auth.scrubProcessEnv,
    cleanEnv: auth.cleanEnv,
    artifactsOf: auth.artifactsOf,
    findBinary: cli.findBinary,
    setGatewayKeyProvider,
    setGatewayCapsProvider,
    setRouting,
    withGatewayModels,
    setTools,
    setPlugins,
    setChatOf,
    setChatNames: forks.setChatNames,
    authMode: auth.authMode,
    buildSessionOptions,
    buildUserMessage,
    flagSettings,
    identity,
    planApproval,
    restoreMode,
    forkPoint,
    mergeCatalog,
    transcriptPath,
    ownBusy,
    ownWrites: (key) => transcripts.ownWrites(key.slice('claude:'.length)),
    scheduled,
    observe,
    ledgerAccount,
  };
}

module.exports = { createClaudeHarness };
