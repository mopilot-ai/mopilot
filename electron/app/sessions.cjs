// Chat sessions in main: session state, harness adapters, the ChatController, the ACP host, chat-to-chat messaging, rollouts.
const path = require('node:path');
const { imageDataUrl } = require('../harness/claude/message.cjs');
const os = require('node:os');
const { adapterSettings } = require('../session/adapterSettings.cjs');
const { TranscriptWriter } = require('../platform/transcriptWriter.cjs');
const { SessionStore } = require('../session/state.cjs');
const { localHostFor, remoteRoutes, capsFollowHost } = require('../host/wiring.cjs');
const { createLazyContinueInbox } = require('../host/continueInbox.cjs');
const { remoteNotice } = require('./computerAccess.cjs');
const { ChatController } = require('../session/controller.cjs');
const { TurnSnapshots, savedTurnChanges } = require('../session/turnSnapshots.cjs');
const { pluginDelivery } = require('../plugins/service.cjs');
const { codexPluginCallbacks, attachCodexPluginMirror } = require('../plugins/codexLifecycle.cjs');
const { CapsService } = require('../session/caps.cjs');
const { SwitchRunner } = require('../session/switch.cjs');
const { chromeLinkScope, chromeLinkApplies } = require('../session/segmentScope.cjs');
const { ControllerPlans } = require('../session/controllerPlan.cjs');
const { controllerPlanInputs } = require('./controllerPlanInputs.cjs');
const { heldOf } = require('../session/goalHeld.cjs');
const { PeerRuntime } = require('../session/peerRuntime.cjs');
const { createPeerGate } = require('../session/peerGate.cjs');
const { chatPermission } = require('../session/peerHold.cjs');
const { createPeerNotices } = require('./peerNotices.cjs');
const { createPeerReceiptReader } = require('../session/peerReceipts.cjs');
const { readPeerTranscript: readPeerHistory, readPeerReference, peerHistoryReader } = require('../session/peerTranscript.cjs');
const { createPeerNativeReader, claudePeerSource, acpPeerSource } = require('../session/peerNativeHistory.cjs');
const { createChatProjects } = require('../session/chatProject.cjs');
const { chatFolderGuard } = require('../session/chatFolderGuard.cjs');
const { ExternalWrites } = require('../session/contract/reconcile.cjs');
const { createTranscriptWatchers } = require('./transcriptWatchers.cjs');
const { CodexAdapter, permissionParams } = require('../harness/codex.cjs');
const { codexGoalStore } = require('../harness/codexGoals.cjs');
const { ClaudeAdapter } = require('../harness/claude/adapter.cjs');
const { AcpTurns } = require('../harness/acpTurns.cjs');
const { TITLE_MS } = require('../harness/autoTitle.cjs');
const acp = require('../harness/acp.cjs');
const acpQuirks = require('../harness/quirks/index.cjs');
const { OwnMcp } = require('../harness/acp/ownMcp.cjs');
const { resolveBasic: resolveBasicBin, createHighestBasic } = require('../harness/detect.cjs');
const { pathStatus } = require('../platform/userTools.cjs');
const { openAdmission, NO_SAGE_MCP } = require('./acpAdmission.cjs');
const { ItemsLog } = require('../platform/chats.cjs');
const { turnLedger } = require('../capabilities/turnEnd.cjs');
const { callTurnThread } = require('../capabilities/contract/turnTokens.cjs');
const { TargetLeases } = require('../capabilities/targetLeases.cjs');
const { registryNote } = require('../capabilities/contract/surfaceNote.cjs');
const { killedReason, startHold } = require('../../shared/killSwitch.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { machineAwareLabel } = require('./harnessLabel.cjs');
const { traitsOf } = require('../harness/family.cjs');
const { byFamily } = require('../session/contract/route.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { openHarnessTaps } = require('./harnessTaps.cjs');
const { observeSession } = require('../../shared/observations.cjs');

/**
 * @param {import('../main.cjs').ChatSessionsDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createChatSessions({
  app,
  claude,
  pty,
  shellEnv,
  server,
  clientInfo,
  codexProviders,
  readState,
  uiPrefs,
  preferHighestCli,
  isFlagEnabled,
  gitInfo,
  gitStatus,
  capsChanged,
  appWindows,
  live,
}) {
  const { broadcastAll, codexEmit, claudeEmit, acpEmit, chatInView, execWindows, windowShows, streams } = appWindows;
  const saved = adapterSettings(live);
  // the app's one transcript writer (transcriptWriter.cjs), which every log is given and the quit drains
  live.transcripts = new TranscriptWriter();
  /** @type {InstanceType<typeof SessionStore>} assigned at startup, before any window or IPC handler uses it */
  let sessions;
  /** @type {InstanceType<typeof CapsService>} what each chat can do (electron/session/caps.cjs); assigned at startup, before any window or IPC handler uses it */
  let capsService;
  /** @type {InstanceType<typeof ChatController>} */
  let controller; // assigned at startup, before any window or IPC handler uses it
  /** @type {InstanceType<typeof PeerRuntime>} assigned at startup, before any window or IPC handler uses it */
  let peerRuntime;
  /** @type {Map<number, Set<string>>} */
  const peerWindowChats = new Map();
  /** @type {InstanceType<typeof CodexAdapter>} */
  let codex; // assigned at startup, before any window or IPC handler uses it
  /** @type {InstanceType<typeof ClaudeAdapter>} */
  let claudeTurns; // assigned at startup, before any window or IPC handler uses it
  /** @type {InstanceType<typeof AcpTurns>} */
  let acpTurns; // assigned at startup, before any window or IPC handler uses it
  /** @type {InstanceType<typeof SwitchRunner>} a harness switch's segments and handoff record (electron/session/switch.cjs); assigned at startup, before any window or IPC handler uses it */
  let switchRunner;
  /** Who controls each surface of a chat on its current segment (electron/session/controllerPlan.cjs). */
  /** @type {InstanceType<typeof ControllerPlans>} assigned at startup, before any window or IPC handler uses it */
  let controllerPlans;
  /** what other apps are doing to the chats on screen (WP5-19) */
  /** @type {InstanceType<typeof ExternalWrites> | null} */
  let external = null;
  /** Basic-tier harnesses over ACP (electron/harness/acp.cjs). */
  /** @type {InstanceType<typeof acp.AcpHost>} assigned at startup, before any window or IPC handler uses it */
  let acpHost;
  /** Which basic harnesses passed runtime admission (electron/harness/admission.cjs). */
  /** @type {InstanceType<typeof import('../harness/admission.cjs').Admission>} assigned at startup, before any window or IPC handler uses it */
  let acpAdmission;
  /** The request ledger and context snapshots (electron/app/harnessTaps.cjs), kept in main with or without a window. */
  const taps = openHarnessTaps({ app, readState, claude, live, broadcastAll, chatOf: (id) => controller.chatOf(id) });
  live.ledger = taps.ledger;
  function openAcp() {
    const env = () => shellEnv.childEnv();
    const which = (name) => shellEnv.which(name);
    const manualOf = (id) => readState().prefs?.acpBins?.[id];
    const binaries = preferHighestCli()
      ? createHighestBasic({ env, which, manualOf })
      : { resolveBin: (id) => resolveBasicBin(id, { manual: manualOf(id), which }) };
    const common = {
      quirks: acpQuirks.quirks,
      ids: acpQuirks.ids({ packaged: app.isPackaged }),
      ...binaries,
      // whether the user's terminal runs that same binary (Settings → Other harnesses says when it doesn't)
      pathStatus: (id, bin) => pathStatus(bin, acpQuirks.quirks(id)?.bins ?? []),
      env,
      tools: live.acpTools ?? NO_SAGE_MCP,
      dataDir: path.join(app.getPath('userData'), 'harnesses'),
    };
    // a switch for the harness, the whole basic tier, or its tool channel keeps it from new chats (flags.cjs)
    const killed = (id) => killedReason(`acp:${id}`, isFlagEnabled, { needsChannel: true });
    acpAdmission = openAdmission({ common, app, killed, broadcastAll });
    live.acpOwnMcp = new OwnMcp({ quirksOf: acpQuirks.quirks, prefs: () => readState().prefs, env: common.env });
    acpHost = new acp.AcpHost({
      ...common,
      mcpEnv: (id, env) => live.acpOwnMcp.envFor(id, env),
      remoteRename: (key, name) => remoteRoutes(live).rename(key, name),
      // MoPilot's plugins: their MCP servers join each session's mcpServers
      plugins: pluginDelivery(),
      items: new ItemsLog(path.join(app.getPath('userData'), 'threads'), { writer: live.transcripts }),
      pty,
      cwd: os.homedir(),
      notify: (kind, chatId, opts) => live.notifier?.notify(kind, chatId, opts),
      // Launch the exact copy admission checked. Sign-in can open the selected CLI on a signed-out harness.
      resolveBin: async (id, forChat) => {
        const h = await acpAdmission.current(id, { again: forChat });
        if (forChat && h?.bin && h.state !== 'admitted') throw new Error(`${h.label}: ${h.reason ?? "this version isn't supported"}`);
        return h?.bin ?? null;
      },
      // sign-in failures (and how to set up), successes and new sessions' catalogs go to admission
      admission: acpAdmission,
      defaults: (id) => readState().prefs?.basicDefaults?.[id] ?? null,
    });
    acpHost.on('event', (e) => controller?.onAcpEvent(e));
    acpHost.on('event', (e) => taps.acpEvent(e));
    live.acpOwnMcp.attach(acpHost);
  }
  /** The chat's goal in main's state; one Claude holds is also kept in the chat's file (electron/session/goalHeld.cjs). */
  function writeGoal(chatId, goal) {
    const changed = sessions.patch(chatId, { goal: codex.annotateGoal(chatId, goal) });
    persistHeldGoal(chatId);
    return changed;
  }
  function persistHeldGoal(chatId) {
    try {
      if (traitsOf(controller.ref(chatId).kind).holdsGoal) live.chats.patchMeta(chatId, { goalHeld: heldOf(sessions.get(chatId).goal) });
    } catch (error) {
      // the chat may not be loaded, or its file not writable: the held goal is written again on its next change
      noteIgnored("keep a chat's held goal", error);
    }
  }
  /**
   * A chat's turn ended on any harness (finished, stopped, crashed): the in-app browser, the user's Chrome over
   * MoPilot's extension or relay (B2) and the desktop let go of what it held, once per turn whichever path reports it
   * (electron/capabilities/turnEnd.cjs).
   */
  /**
   * The thread whose turn is the chat's own, when its harness keeps a turn per thread (the Registry's rule, set by
   * agentTools.cjs: a Codex thread); null when the chat has one turn (Claude Code, ACP) or the controller does not know it.
   */
  function ownThreadOf(chatId) {
    try {
      return callTurnThread(live.capabilities?.turnThread(chatId, controller.ref(chatId).id)).thread;
    } catch (error) {
      // a chat with no segment yet: its turn is the chat's
      noteIgnored('find the Codex thread of a chat whose turn ended', error);
      return null;
    }
  }
  // what each chat holds, on every surface, whichever harness took it: its turn end sweeps them all (each bounded),
  // and a switch's handoff record lists them
  const targetLeases = new TargetLeases({
    surfaces: [
      {
        name: 'the built-in browser',
        leases: (chatId) => live.hostTabs?.leases(chatId),
        turnEnded: (chatId) => live.hostTabs?.turnEnded(chatId),
      },
      // the user's Chrome over MoPilot's extension or relay (B2): turn end releases control and keeps every tab
      // in the chat's group; a switch's handoff lists them by Chrome's tab id, on every harness
      {
        name: "the user's Chrome over MoPilot's extension or relay",
        leases: (chatId) => live.chromeRelay?.tabs.leases(chatId),
        turnEnded: (chatId) => live.chromeRelay?.tabs.turnEnded(chatId),
      },
      {
        name: 'the desktop',
        leases: (chatId) => live.computerUse?.leases(chatId),
        turnEnded: (chatId) => live.computerUse?.turnEnded(chatId),
      },
      // Your Chrome: the chat's instance waits for its next call from now, or ends if it was let go during the turn
      {
        name: 'Your Chrome',
        leases: (chatId) => live.chromeChannel?.leases(chatId),
        turnEnded: (chatId) => live.chromeChannel?.turnEnded(chatId),
      },
    ],
  });
  const turnEnds = turnLedger({
    steps: [...targetLeases.steps, (chatId) => live.capabilities?.turnEnded(chatId)],
    abortChat: (chatId, why, segmentId) => live.capabilities?.abortChat(chatId, why, segmentId),
    // the turn's (chat, turn) tokens: the helper, Your Chrome and the in-app browser refuse what it still sends. A
    // Codex thread's end retires only that thread's; a Codex chat's own end its current thread's; a Claude Code or
    // ACP chat's the chat's; a crash every thread's (electron/capabilities/contract/turnTokens.cjs)
    retire: (chatId, thread) => live.capabilities?.turns.retireTurn(chatId, thread),
    retireAll: (chatId) => live.capabilities?.turns.retire(chatId),
    chatOf: (id) => controller.chatOf(id),
    // a sub-agent thread's calls are charged to its parent's chat (codexConfig.cjs ownerOf)
    ownerOf: (id) => controller.requestChat(id),
    // a call that names no thread (a sub-agent sharing its parent's tool session, on a Codex whose calls carry no
    // turn metadata) rides on its spawn group's turn: up its spawn chain to the thread that is its chat's
    // (requestChat's rule), never into another chat's threads. No thread tools yet: it throws, and the ledger retires
    // nothing, as no call has a token for the thread
    rootOf: (id) => {
      const tools = /** @type {NonNullable<typeof live.codexTools>} */ (live.codexTools);
      return controller.requestThread(tools.chatThreadOf(id));
    },
    // whether such a call rode on the thread's turn; when none did, the thread's end retires its own calls at once
    ridden: (chatId, thread) => live.capabilities?.turns.ridden(chatId, thread) !== false,
    threadOf: (chatId) => ownThreadOf(chatId),
    // the store opens after the ledger (openSessions); a report before that, or after it closes, tracks nothing
    running: (chatId) => !!sessions?.running(chatId),
    tracked: (chatId) => !!sessions?.has(chatId),
  });
  function openSessions() {
    // a quit sends what the chats streamed last, and writes the request ledger's last lines and the context snapshots
    app.on('before-quit', () => (streams.flushAll(), taps.flush(), turnChanges.flush()));
    sessions = new SessionStore({
      ownGoal: (chatId) => codex?.ownGoalStatus(chatId),
      publish: (p) => {
        observeSession(
          p.chatId,
          () => sessions.get(p.chatId),
          () => controller.ref(p.chatId),
        );
        broadcastAll('session:patch', p);
        for (const o of [live.computerUse, live.computerAccess, live.chromeRelay, live.chromePanel?.service]) o?.onSessionPatch(p);
        // ChatController.onFinished is taken over by PeerRuntime, so a turn's end is read from the patches
        turnEnds.sessionPatch(p);
      },
    });
    const turnChanges = savedTurnChanges(app.getPath('userData'));
    codex = new CodexAdapter({
      turnChanges,
      server,
      nativeOf: (chatId) => controller.ref(chatId),
      chatOf: (id) => controller.chatOf(id),
      state: sessions,
      prefs: uiPrefs,
      ...saved.codex,
      clientInfo: clientInfo(),
      // a version mismatch or missing permission Codex Computer Use reports shows in Settings → Computer use
      onSkyProblem: (problem) => live.nativeAvailability.noteSkyProblem(problem),
      // a Stop that reset the plugin's JS kernel: the desktop lock forgets the apps it had bound
      onNativeReset: (threadId) => live.computerUse?.nativeHolds.reset(threadId),
      tools: live.codexTools,
      providers: codexProviders,
      emit: (e, target) => (taps.codexEmitted(e), codexEmit(e, target)),
      observe: (msg) => {
        taps.codexMessage(msg);
        controller.onCodexMessage(msg);
        // Codex Computer Use (Sky) programs hold MoPilot's desktop lock while their turn runs
        live.computerUse?.nativeHolds.observe(msg);
        // a turn/completed the controller didn't end (no window opened the chat, an untracked turn) still lets go
        turnEnds.codexMessage(msg);
      },
      onExit: () => {
        // the app-server's last deltas reach the windows before its chats crash
        streams.flushAll();
        controller.onCodexExit();
        live.computerUse?.nativeHolds.clear();
      },
      // Stop on a native thread: idle once the app-server accepts it; the plugin's release runs on behind it
      onStopped: (chatId, turnId) => controller.codexStopped(chatId, turnId),
      // a crashed app-server comes back with backoff; the windows reconnect, or show a banner
      ...codexPluginCallbacks(broadcastAll, capsChanged),
      goalStore: codexGoalStore(path.join(app.getPath('userData'), 'codex-goals.json')),
    });
    attachCodexPluginMirror(codex);
    external = new ExternalWrites({ state: sessions, isCurrent: (chatId, source) => controller.isCurrentSource(chatId, source) });
    claudeTurns = new ClaudeAdapter({
      api: claude.turnApi,
      marksFile: path.join(app.getPath('userData'), 'claude-login-marks.json'),
      probeInfo: (account) => claude.probeInfo(account),
      state: sessions,
      prefs: uiPrefs,
      send: (chatId, key, opts, input, priority, meta) => controller.claudeSend(chatId, key, opts, input, priority, meta),
      enqueue: (chatId, item) => controller.send(chatId, item, null),
      interrupted: (key) => controller.onClaudeControl(key, 'interrupt'),
      chatOf: (key) => controller.chatOf(key),
      ref: (chatId) => controller.ref(chatId),
      emit: claudeEmit,
      setGoal: writeGoal,
      ...saved,
      limitHit: (chatId) => controller.onLimit(chatId),
      notifyLimit: (chatId, reason) =>
        live.notifier?.notify('goal', chatId, {
          title: 'Claude Code',
          body: reason === 'expired' ? 'Sign in again to continue' : 'Usage limit reached · Switch account to continue',
          status: 'usageLimited',
        }),
      // a window that is looking at the chat decides whether to say it; with none, the system does
      notifyGoal: (chatId, n) => {
        if (!claudeEmit({ kind: 'goalNotice', chatId, status: n.status, body: n.body }, 'any'))
          live.notifier?.notify('goal', chatId, { title: 'Claude Code', body: n.body, status: n.status });
      },
    });
    acpTurns = new AcpTurns({
      savedSettings: saved.acpSettings,
      send: (chatId, key, payload, meta) => controller.acpSend(chatId, key, payload, meta),
      rename: (key, name, auto) => acpHost.rename(key, name, auto),
      named: async (key) => (await acpHost.history(key)).some((r) => r.t === 'title'),
      titleOf: (key) => acpHost.titleOf(key),
      writeTitle: (key, text) => acpHost.titleFor(key, text, TITLE_MS),
      // the types the model APIs take, as Claude Code sends them (HEIC, BMP, TIFF… become PNG)
      readImage: imageDataUrl,
      emit: acpEmit,
      // a MoPilot plugin's skill or command (a chip, or typed): the model reads it with plugin_skill_read
      pluginSkills: () => pluginDelivery().skillsFor('acp'),
      // a Stop while the images are read: the prompt is not sent
      turnCheck: (chatId) => controller.turnCheck(chatId),
      toolsNote: () => registryNote(live.capabilities, live.browserControl),
    });
    // Claude in Chrome's link per chat (electron/harness/claude/chromeLink.cjs), kept to the chat's current segment: the
    // status strip and the credential route read it; a switch's segment end below hands the chat the new segment's
    const chromeLinks = chromeLinkScope({ sessions, ref: (chatId) => controller.ref(chatId), linkOf: (key) => claude.chromeLinkOf(key) });
    // Settings counts, reconnects and moves only the sessions a chat's current segment runs (not a switched chat's leftover CLI)
    claude.setChromeScope((chatId, key) => chromeLinkApplies(() => controller.ref(chatId), key));
    claude.setChromeLinkListener((chatId, link, key) => {
      chromeLinks.report(chatId, link, key);
      broadcastAll('claude:chromeLinksChanged');
    });
    // who controls each surface of a chat: decided when a segment starts, again when its own session loads
    controllerPlans = new ControllerPlans({
      chats: live.chats,
      sessions,
      ref: (chatId) => controller.ref(chatId),
      chatOf: (key) => controller.chatOf(key),
      inputs: controllerPlanInputs({ live, isFlagEnabled, claude, claudeTurns }),
    });
    // a Claude CLI's Claude in Chrome is fixed when the process starts
    claude.setProcessListener((chatId, key) => controllerPlans.loaded(key, chatId));
    switchRunner = new SwitchRunner({
      continues: createLazyContinueInbox(app, 'host-inbox'),
      chats: live.chats,
      ref: (chatId) => controller.ref(chatId),
      invalidate: () => controller.invalidate(),
      // the old segment's pending deltas go out before anything the new segment's session sends
      claim: (key, chatId) => (streams.flushChat(chatId), controller.claim(key, chatId)),
      unclaim: (key, chatId) => controller.unclaim(key, chatId),
      changed: (chatId) => broadcastAll('chats:changed', { id: chatId, chat: live.chats.get(chatId) }),
      prefs: uiPrefs,
      home: os.homedir(),
      emit: codexEmit,
      git: { info: gitInfo, status: gitStatus },
      codex: {
        startThread: (params, opts) => codex.startThread(params, opts),
        ensureResumed: (id) => codex.ensureResumed(id),
        threadTurns: (id, page) => codex.threadTurns(id, page),
        summarize: (id, prompt) => codex.summarize(id, prompt),
        cwdOf: (id) => codex.cwdOf(id),
      },
      claude: {
        registerSession: (key, info) => claudeTurns.registerSession(key, info),
        isFresh: (key) => claudeTurns.isFresh(key),
        cwdOf: (ref) => claudeTurns.cwdOf(ref),
        accountOf: (chatId) => claudeTurns.accountOf(chatId),
        allTurns: (sessionId, opts) => claude.allTurns(sessionId, opts),
        summarize: (sessionId, cwd, prompt, bin, account, chatId) => claude.summarize(sessionId, cwd, prompt, bin, account, chatId),
      },
      permissionParams,
      acpHost,
      // segment end: the old segment's Claude in Chrome link leaves the chat (CM-B02), and the new segment's plan is decided
      segmentEnded: (e) => {
        chromeLinks.segmentEnded(e);
        controllerPlans.segmentEnded(e);
      },
      // the handoff record lists the tabs and locks the chat holds (TargetLeases)
      held: (chatId) => targetLeases.held(chatId),
      accounts: { codex: () => live.accounts, claude: claudeTurns },
    });
    controller = new ChatController({
      state: sessions,
      chats: live.chats,
      codex,
      claudeTurns,
      acpTurns,
      killed: (kind, chatId) => startHold(killedReason(kind, isFlagEnabled), live.heldChat, chatId),
      switcher: switchRunner,
      claude,
      acp: acpHost,
      // a chat on another machine is stopped there (electron/host/remoteSend.cjs); null for one that runs here or while Host access is off
      remote: remoteRoutes(live),
      acpPlan: (kind) => acpQuirks.describe(parseKind(kind)?.basic)?.plan ?? null,
      // one map of Codex sub-agents with the tool injection and the plugin lifecycle (codexParents.cjs)
      parents: live.codexTools?.parents,
      // a crash and Stop abort the chat's running tool calls; every end lets go once
      ...turnEnds.hooks,
      beforeDispatch: chatFolderGuard({ chatProject: (chatId) => chatProject(chatId), state: readState, chats: () => live.chats }),
      notify: (kind, chatId, opts) => live.notifier?.notify(kind, chatId, remoteNotice(live.remoteOwners, chatId, opts, kind)),
      retract: (chatId) => live.notifier?.retract(chatId),
      chatTitle: (chatId) => codex?.chatName(chatId) || null,
      viewing: chatInView,
      labelOf: machineAwareLabel(acpQuirks),
      onSkipped: (chatId) =>
        live.notifier?.notify('scheduled', chatId, {
          title: 'Scheduled run skipped: it needed approval',
          body: codex?.chatName(chatId) || '',
          chatTitle: codex?.chatName(chatId) || undefined,
        }),
    });
    new TurnSnapshots({ changes: turnChanges, state: sessions, ...appWindows.turnDiffSink }).attach(controller);
    live.host = localHostFor({ live, controller, sessions, claudeTurns });
    capsService = new CapsService({
      ref: (chatId) => controller.ref(chatId),
      onMachine: (chatId) => controller.remote.owns?.(chatId) === true,
      record: (chatId) => live.chats.record(chatId),
      session: (chatId) => sessions.get(chatId),
      isEnabled: isFlagEnabled,
      codex: () => codex.info(),
      claude,
      claudeLogin: (chatId) => claudeTurns.pickedLogin(chatId),
      instances: (harness) => live.identity?.instances(harness) ?? [],
      chatInstance: (harness, key) => live.identity?.driver(harness)?.chatInstance?.(key) ?? null,
      codexAuth: () => {
        const a = live.accounts?.active();
        return a ? a.kind || 'chatgpt' : null;
      },
      accounts: (harness) => live.identity?.driver(harness)?.lane ?? null,
      // the account exists before the sessions open (app 'ready')
      modelCaps: () => live.mopilot.modelCaps(),
      prefs: uiPrefs,
      acpQuirks: (kind) => acpQuirks.describe(parseKind(kind)?.basic),
    });
    claude.setProbeListener(capsChanged);
    capsFollowHost(capsChanged);
    const peerNotices = createPeerNotices({
      broadcastAll,
      chatInView,
      chats: live.chats,
      notifier: () => live.notifier,
      chatName: (id) => codex.chatName(id),
    });
    peerRuntime = new PeerRuntime({
      file: path.join(app.getPath('userData'), 'peer-messages.json'),
      controller,
      chats: live.chats,
      registry: live.capabilities,
      sourceWindow: (event, expected) => {
        if (event.sender.isDestroyed()) return null;
        // Quick Chat speaks only for the chat it owns (by its stable chat id), as a main window does for the chat it shows
        if (appWindows.mini && !appWindows.mini.isDestroyed() && event.sender === appWindows.mini.webContents)
          return live.quickState.owns(expected) ? expected : null;
        if (!execWindows.has(event.sender)) return null;
        return windowShows(event.sender.id, expected) || peerWindowChats.get(event.sender.id)?.has(expected) ? expected : null;
      },
      referenceWindow: (event) => execWindows.has(event.sender) && !event.sender.isDestroyed(),
      readReference: (id, assistantOnly) => readPeerReference(live.chats.records.get(id), peerNativeReader(), assistantOnly),
      readHistory: peerHistoryReader(live.chats, peerNativeReader),
      projectOf: chatProject,
      channelAvailability: (channel) => (!channel ? 'tool_bridge_unavailable' : !isFlagEnabled(channel) ? 'tool_bridge_disabled' : null),
      temporary: (id) => live.chats.records.has(id) && temporarySegment(controller.ref(id)),
      gate: createPeerGate({
        record: (id) => live.chats.records.get(id),
        state: (id) => sessions.get(id),
        goalStatus: (id) => sessions.goalStatus(id),
        remote: controller.remote,
        ref: (id) => controller.ref(id),
        availability: async (ref, record) => killedReason(ref.kind, isFlagEnabled) || byFamily(PEER_AVAILABILITY, ref.kind)(ref, record),
      }),
      read: (id, options) => readPeerTranscript(id, options),
      readReceipt: createPeerReceiptReader({
        claudeMessages: (id) => claude.messages(id),
        acpHistory: (key) => acpHost.history(key),
        codexTurns: (id, options) => codex.threadTurns(id, options),
      }),
      publish: (journal) => peerNotices.publish(journal),
      permission: (id) =>
        chatPermission({ config: live.chats.records.get(id)?.meta?.config, prefs: uiPrefs(), session: controller.state.get(id) }),
    });
    peerNotices.start(peerRuntime.service.data);
    setInterval(() => codex.releaseIdle(), 2_000).unref();
  }
  /**
   * Each family's temporary native sessions (kept off disk): a basic harness never runs one (a temporary chat picked
   * there runs on Claude Code).
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (ref: { id: string, key: string }) => boolean>}
   */
  const TEMPORARY = {
    codex: (ref) => !!codex.meta.get(ref.id)?.ephemeral,
    claude: (ref) => !!claudeTurns.sessions.get(ref.key)?.ephemeral,
    acp: () => false,
  };
  /** Whether a chat's segment (its NativeRef) is a temporary native session. */
  function temporarySegment(ref) {
    return byFamily(TEMPORARY, ref.kind)(ref);
  }
  /**
   * The login a first-tier chat runs on, to check before a peer message is delivered to it; a basic harness's is its
   * admission (signed in, or not usable).
   */
  const firstTierLogin = (own) => (ref, record) => {
    const instances = live.identity?.instances(ref.kind) ?? [];
    const pinned = own(ref, record);
    const selected = pinned ? instances.find((i) => i.account === pinned) : instances.find((i) => i.active);
    return !selected || selected.status !== 'ok' ? 'login_required' : null;
  };
  /**
   * Why a peer message can't be delivered to a chat's harness now, by family, or null when it can.
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (ref: { kind: string, id: string }, record: any) => string | null | Promise<string | null>>}
   */
  const PEER_AVAILABILITY = {
    codex: firstTierLogin((ref) => live.accounts.pins.get(ref.id)?.id),
    claude: firstTierLogin((_ref, record) => claudeTurns.pickedLogin(record.id)),
    // checked again when it reads signed out (it may have been signed in elsewhere since), and waited for while checked
    acp: async (ref) => {
      const admission = await acpAdmission?.current(String(parseKind(ref.kind)?.basic), { again: true });
      if (admission?.state === 'admitted') return null;
      return admission?.state === 'signin' ? 'login_required' : 'harness_unavailable';
    },
  };
  const { peerProject, chatProject } = createChatProjects({
    chats: () => live.chats,
    codexCwd: (id) => codex.folderOf(id),
    claudeCwd: (ref) => claudeTurns.cwdOf(ref),
    acpCwd: (key) => acpTurns.sessions.get(key)?.cwd,
    acpHistory: (key) => acpHost.history(key),
  });
  function peerNativeReader() {
    return createPeerNativeReader({
      projectOf: peerProject,
      ...claudePeerSource(claude),
      ...acpPeerSource(acpHost),
      codexTurns: (id, options) => codex.threadTurns(id, options),
    });
  }
  async function readPeerTranscript(chatId, options = {}) {
    return readPeerHistory(live.chats.records.get(chatId), options, peerNativeReader());
  }
  const { watchRollout, unwatchRollout, reconcileClaude, forgetClaude, rolloutWatchers } = createTranscriptWatchers({
    broadcast: broadcastAll,
    claude,
    live: {
      get external() {
        return external;
      },
      get controller() {
        return controller;
      },
      get codex() {
        return codex;
      },
    },
  });

  return {
    openAcp,
    openSessions,
    writeGoal,
    persistHeldGoal,
    temporarySegment,
    chatProject,
    watchRollout,
    unwatchRollout,
    reconcileClaude,
    forgetClaude,
    peerWindowChats,
    /** @returns {InstanceType<typeof SessionStore>} */
    get sessions() {
      return sessions;
    },
    /** @returns {InstanceType<typeof CapsService>} */
    get capsService() {
      return capsService;
    },
    /** @returns {InstanceType<typeof ChatController>} */
    get controller() {
      return controller;
    },
    /** @returns {InstanceType<typeof PeerRuntime>} */
    get peerRuntime() {
      return peerRuntime;
    },
    /** @returns {InstanceType<typeof CodexAdapter>} */
    get codex() {
      return codex;
    },
    /** @returns {InstanceType<typeof ClaudeAdapter>} */
    get claudeTurns() {
      return claudeTurns;
    },
    /** @returns {InstanceType<typeof AcpTurns>} */
    get acpTurns() {
      return acpTurns;
    },
    /** @returns {InstanceType<typeof SwitchRunner>} */
    get switchRunner() {
      return switchRunner;
    },
    /** @returns {InstanceType<typeof ControllerPlans>} */
    get controllerPlans() {
      return controllerPlans;
    },
    /** @returns {InstanceType<typeof ExternalWrites> | null} */
    get external() {
      return external;
    },
    /** @returns {InstanceType<typeof acp.AcpHost>} */
    get acpHost() {
      return acpHost;
    },
    /** @returns {InstanceType<typeof import('../harness/admission.cjs').Admission>} */
    get acpAdmission() {
      return acpAdmission;
    },
    get rolloutWatchers() {
      return rolloutWatchers;
    },
  };
}

module.exports = { createChatSessions };
