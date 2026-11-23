// MoMo's background work in main (#2139), over the services app/momo.cjs made: routines in the app's one scheduler (live.momoRoutines), routines MoMo proposes (its tool, and setup's starter routines once setup is done) with their page in Settings, how a routine's result reaches MoMo's main chat, MoMo's notices, and its chats kept quiet on the coding side. Each run is a fresh MoMo background chat on MoMo's brain; a turn's end and a harness's quit reach it through the ChatController's hooks. Nothing runs while MoMo isn't allowed: a revoke stops this MoPilot's runs and closes MoMo's notices; Pause stops the runs.
const { registerMomoStore, momoResetting, removeFeedAndTopicFiles } = require('../momo/stores.cjs');
const { readMomoPrefs, roleBrain, isMomoPaused, migrateMomoPrefs } = require('../../shared/momoPrefs.mjs');
const { RoutineStore } = require('../momo/routineStore.cjs');
const { createMomoRoutines, UNATTENDED, ISOLATION } = require('../momo/routines.cjs');
const { createMemoryPass } = require('../momo/memoryPass.cjs');
const { openMomoAliases } = require('./momoAliases.cjs');
const { openMomoNudges } = require('./momoNudges.cjs');
const { openMomoBrief } = require('./momoBrief.cjs');
const { budgetIn } = require('../momo/backgroundBudget.cjs');
const { looksSecret } = require('../momo/memoryTools.cjs');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { isMomoMeta, isMomoDataMeta } = require('../../shared/momoChat.mjs');
const path = require('node:path');
const { createRoutineReporter } = require('../momo/routineReport.cjs');
const { registerRoutinesIpc } = require('../momo/routinesIpc.cjs');
const { registerRoutineTools } = require('../momo/routineTools.cjs');
const { createStarterOffers, createGreeter } = require('../momo/starterRoutines.cjs');
const { createMomoNotices, cardUp } = require('../momo/notices.cjs');
const { openMomoActivity } = require('./momoActivity.cjs');
const { momoQuiet } = require('../momo/quietNotices.cjs');
const { createMomoPushBody, createRoutineOfChat } = require('../momo/pushBody.cjs');
const { addHook } = require('../session/hookChain.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { atLimit: brainAtLimit } = require('../momo/brainLimit.cjs');
const { labelOf, notAllowed } = require('../momo/mainChat.cjs');
const { cheapBrain } = require('../momo/cheapBrain.cjs');
const { registerTasksIpc } = require('../momo/tasksIpc.cjs');
const { openTaskMarks } = require('./momoTaskMarks.cjs');
const { openSuggestions, registerMomoSuggestions } = require('./momoSuggestions.cjs');
const { nextRun } = require('../platform/scheduler.cjs');
const { waitingCards } = require('../momo/tasks.cjs');
const { authoredInput } = require('../session/authoredInput.cjs');

/** What MoMo's chat is told of a routine's run that Pause stopped. */
const PAUSED_TEXT = 'MoMo was paused, so the run was stopped.';

/** Errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them). */
const valueHandle = (/** @type {any} */ ipcMain) => (/** @type {string} */ channel, /** @type {(...args: any[]) => unknown} */ fn) =>
  ipcMain.handle(channel, async (/** @type {unknown} */ _e, /** @type {any[]} */ ...args) => {
    try {
      return { value: await fn(...args) };
    } catch (err) {
      return { error: { message: String(/** @type {any} */ (err)?.message ?? err), code: /** @type {any} */ (err)?.code ?? null } };
    }
  });

/**
 * @param {any} core what app/momo.cjs made: its folder, isMomoChat, owner, the main chat, memory and sources
 * @param {object} deps
 * @param {any} deps.ipcMain
 * @param {any} deps.live
 * @param {() => any} deps.readState
 * @param {(channel: string, payload?: unknown) => void} deps.broadcastAll
 * @param {{ commandMainWindow: (cmd: string, ...args: any[]) => Promise<void>, chatInView?: (chatId: string) => boolean }} deps.appWindows
 * @param {(kind: string, o?: { unattended?: boolean }) => Promise<boolean>} deps.usable
 * @param {(controller: any, chatId: string, item: object, origin: null) => Promise<any>} deps.sendRun how a run's first message
 *   goes through the ChatController (app/automations.cjs sendRunMessage)
 * @param {any} deps.safeStorage
 * @param {() => boolean} deps.allowed
 * @param {(cb: (allowed: boolean) => void) => () => void} deps.onAccess
 */
function openMomoBackground(core, { ipcMain, live, readState, broadcastAll, appWindows, usable, sendRun, safeStorage, allowed, onAccess }) {
  const { dir, isMomoChat, mainChat, sources } = core;
  const prefs = () => readState()?.prefs ?? {};
  const momoPrefs = () => prefs().momo;
  const broadcast = (/** @type {string} */ channel) => broadcastAll(channel);
  const owner = core.owner;
  const meta = (/** @type {string} */ chatId) => live.chats?.records.get(chatId)?.meta;

  // MoMo's notices, and its chats' own banners kept to MoMo
  const notices = createMomoNotices({
    notifier: live.notifier,
    allowed,
    prefs,
    open: (target) => void appWindows.commandMainWindow('momo', target),
    viewing: (t) => t.kind === 'chat' && appWindows.chatInView?.(t.chatId) === true,
    cardUp: (chatId, cardId) => cardUp(live.controller?.state, chatId, cardId),
    // a channel's card: its push names the channel, so a tap opens that channel (A2)
    channelOf: (chatId) => (core.channelsApi.enabled() === true ? (core.channelsApi.registry.byChatId(chatId)?.id ?? null) : null),
  });
  const quiet = momoQuiet(isMomoChat);
  live.notifier?.setQuiet((/** @type {string} */ kind, /** @type {string} */ chatId, /** @type {any} */ opts) => {
    const kept = quiet(kind, chatId);
    // a MoMo chat waiting for an approval says "MoMo needs you" instead, naming the card when the banner did
    if (kept && kind === 'approval') notices.needsYou({ kind: 'chat', chatId, cardId: opts?.cardId });
    return kept;
  });

  const routineStore = new RoutineStore({ dir, safeStorage });
  // the files of MoMo's removed Feed and Topics: deleted once at startup, and again by Reset (routines.json kept beside them)
  // the user's own marks on routine runs (done, archived, deleted from view), erased with the routines
  const taskMarks = openTaskMarks({ dir, safeStorage });
  // what MoMo suggested for Up next (momo/suggestions.cjs), erased with them
  const suggestions = openSuggestions({ dir, safeStorage });
  registerMomoStore('routines', async () => {
    await routineStore.erase();
    await taskMarks.erase();
    await suggestions.erase();
    await brief?.erase();
    removeFeedAndTopicFiles(dir);
  });
  try {
    removeFeedAndTopicFiles(dir);
  } catch (error) {
    noteIgnored("delete the files of MoMo's removed Feed and Topics", error);
  }

  /** A fresh MoMo background chat on `brain`, in MoMo's workspace, tagged `tag` (a routine's run). */
  const startChat = (/** @type {any} */ brain, /** @type {object} */ tag) => mainChat.startBackground(brain, tag);
  const discardChat = (/** @type {string} */ chatId) => live.chatDeletion?.delete(chatId);
  const stopChat = (/** @type {string} */ chatId) => live.controller.stopChat(chatId);
  const send = (/** @type {string} */ chatId, /** @type {object} */ item) => sendRun(live.controller, chatId, item, null);
  /**
   * An input MoMo sends that no human wrote, shown as MoMo's in its chat (session/authoredInput.cjs): every window reads
   * the chat's meta again before the input reaches its transcript.
   */
  const authored = (/** @type {string} */ chatId, /** @type {string} */ text, /** @type {any} */ show) => {
    const item = authoredInput(live.chats, chatId, text, show);
    broadcastAll('chats:changed', { id: chatId, chat: live.chats.get(chatId) });
    return item;
  };

  // per-role brains and rules older builds saved become the one brain and rule, once (#2527)
  const migrated = migrateMomoPrefs(momoPrefs());
  if (migrated && live.patchPrefs?.({ momo: migrated }) !== true)
    noteIgnored("fold MoMo's per-role settings into its one brain", new Error('prefs were not patched'));

  /** What MoMo's work does with its brain now, by its one at-limit rule (brainLimit.cjs). */
  const limitOf = (/** @type {any} */ brain) => brainAtLimit(live.identity, brain, readMomoPrefs(momoPrefs()).atLimit, Date.now(), labelOf);
  // MoMo's main chat while its brain is out and its rule is Pause: nothing is sent, and the chat says why
  live.heldChat = (/** @type {string} */ chatId) => {
    if (allowed() !== true || chatId !== mainChat.current()) return null;
    const brain = roleBrain(momoPrefs());
    const r = brain ? limitOf(brain) : null;
    return r && 'held' in r ? `MoMo is paused: ${r.held}.` : null;
  };

  // setup's last step: MoMo says hello in its main chat
  const greet = createGreeter({ allowed: () => allowed() === true, ensureMainChat: () => mainChat.ensureMainChat(), authored, send });
  valueHandle(ipcMain)('momoChat:greet', () => greet());

  // setup's Notifications row (#2607): one notice, through which macOS asks for permission
  valueHandle(ipcMain)('momoChat:enableNotices', () => {
    if (allowed() !== true) throw notAllowed();
    return notices.welcome();
  });

  // a routine's result, or why it didn't finish, goes to MoMo's main chat (made when there is none yet) as MoMo's message
  const report = createRoutineReporter({
    allowed,
    held: () => isMomoPaused(momoPrefs()) || momoResetting(),
    mainChatId: async () => (await mainChat.ensureMainChat()).chatId,
    send,
    authored,
  });
  /** @type {any} the nudge check (app/momoNudges.cjs), made below once the day's budget is */
  let nudges = null;
  /** @type {any} the morning brief (app/momoBrief.cjs), made below with the nudges */
  let brief = null;
  const routines = createMomoRoutines({
    routines: routineStore,
    // the nudge check runs as a task of its own in the scheduler (momo.nudges)
    nudges: { active: () => nudges?.active() === true, run: () => nudges.run() },
    brief: {
      active: () => brief?.brief.active() === true,
      task: () => brief.brief.task(),
      run: () => brief.brief.run(),
      failed: (e) => brief.brief.failed(e),
    },
    report,
    allowed,
    prefs,
    mainBrain: () => roleBrain(momoPrefs()),
    usable: (kind, o) => usable(kind, o),
    atLimit: limitOf,
    startChat,
    discardChat,
    archiveChat: (chatId) => live.archiveChat?.(chatId),
    stopChat,
    send,
    authored,
    forget: (taskId) => live.runLedger?.forget(taskId),
    sessions: live.sessions,
  });
  // the app's one scheduler runs MoMo's tasks beside the user's (schedulerTasks.cjs)
  live.momoRoutines = routines;
  // the phone's Activity list: routine runs and errands, read while paused too (app/momoActivity.cjs)
  const activity = openMomoActivity({ live, routineStore, allowed, broadcastAll });
  live.momoActivity = activity;
  // each session change (SessionStore's publish, made before MoMo): a MoMo chat's activity is compared shortly
  addHook(live.sessions, 'publish', (/** @type {{ chatId: string }} */ p) => activity.onSessionPatch(p));
  const routinesIpc = registerRoutinesIpc(ipcMain, { routines: routineStore, service: routines, allowed, broadcast });
  // the Tasks tab (A1): derived from the runs, loops and waiting cards, stored nowhere
  registerTasksIpc(ipcMain, {
    loops: core.loops,
    runsSince: (at) => routineStore.routineRunsSince(at),
    routineName: (taskId) => routineStore.get(taskId)?.name,
    cards: () => waitingCards(live.controller, mainChat, core.channelsApi),
    allowed,
    broadcast,
    // the four-tab panel (M0a) behind prefs.momo.tasksPanel
    panel: () => readMomoPrefs(momoPrefs()).tasksPanel,
    marks: taskMarks.marks,
    routines: () => routineStore.list().filter((/** @type {any} */ r) => r.approved),
    nextRun: (/** @type {string} */ rrule, /** @type {number} */ after) => nextRun(rrule, new Date(after)),
    paused: () => isMomoPaused(momoPrefs()),
    brief: () => brief?.row() ?? null,
  });
  // Up next's suggestions (A7): the user's Add, Start and Hide, and MoMo's momo_suggest
  registerMomoSuggestions({ core, live, ipcMain, store: suggestions.store, allowed, momoPrefs, broadcast, meta });
  // MoMo's main chat proposes a routine; the user approves it in Settings › MoMo › Routines
  if (live.capabilities)
    registerRoutineTools(live.capabilities, {
      routines,
      allowed,
      chatMeta: meta,
      owner,
      // a source macOS refuses (connected in MoMo, grant gone) is not ready: the model tells the user to connect it
      connected: () =>
        sources.hub
          .list()
          .filter((s) => s.connected && !s.needsGrant)
          .map((s) => s.id),
      changed: () => routinesIpc.changed(),
    });
  const starters = createStarterOffers({ routines, prefs, allowed, held: () => isMomoPaused(momoPrefs()) || momoResetting() });

  // the day's background tokens: one cap the memory pass and the search aliases both draw on
  const budget = budgetIn(dir, safeStorage);
  // MoMo's background memory pass (memoryPass.cjs): facts from what was said, once a MoMo chat goes quiet and once a day
  const memoryPass = openMemoryPass({
    core,
    live,
    meta,
    allowed,
    safeStorage,
    startChat,
    send,
    authored,
    discardChat,
    limitOf,
    momoPrefs,
    budget,
  });
  // search aliases for the index of past chats (app/momoAliases.cjs), within the same budget
  const { aliases } = openMomoAliases({
    core,
    live,
    allowed,
    safeStorage,
    startChat,
    send,
    authored,
    discardChat,
    limitOf,
    momoPrefs,
    budget,
    // saved facts get their aliases before past chats
    sources: [core.factAliases.source],
  });

  ({ nudges } = openMomoNudges({
    core,
    live,
    allowed,
    safeStorage,
    startChat,
    send,
    authored,
    discardChat,
    limitOf,
    momoPrefs,
    prefs,
    budget,
    notices,
    broadcastAll,
  }));
  brief = openMomoBrief({
    core,
    live,
    allowed,
    safeStorage,
    startChat,
    send,
    authored,
    discardChat,
    limitOf,
    momoPrefs,
    prefs,
    notices,
    broadcastAll,
    mainChat,
    routineStore,
    marks: taskMarks.marks,
    suggestions: suggestions.store,
    ipc: { ipcMain, nextRun: (rrule, after) => nextRun(rrule, new Date(after)), broadcast },
  });

  // the routine a chat is the run of; MoMo's opt-in push body is the name of the one that raised a notice (the phone's push, remote/runtime.cjs)
  const routineOfChat = createRoutineOfChat({ meta, openRun: (chatId) => routineStore.openRun(chatId) });
  const pushBody = createMomoPushBody({ allowed, momoPrefs, routineIdOf: routineOfChat, routine: (id) => routineStore.get(id) });
  live.momoPushBodyOn = pushBody.on;
  live.momoPushBody = pushBody.body;

  // a routine's run reads only the sources its routine names; one whose routine went reads none. A chat whose record is
  // gone is matched by its open run. MoMo's main chat isn't limited here (sources/hub.cjs setScope, read at each check of a read).
  sources.hub.setScope(async (/** @type {string} */ chatId) => {
    const routineId = routineOfChat(chatId);
    if (!routineId) return null;
    const r = routineStore.get(routineId);
    return r ? { sources: r.sources ?? [], name: r.name } : { sources: [], name: null };
  });
  // a turn's end and a harness's quit, for every chat: a run reports and ends
  const quietly =
    (/** @type {string} */ what, /** @type {(...a: any[]) => Promise<unknown> | unknown} */ fn) =>
    (/** @type {any[]} */ ...a) =>
      Promise.resolve()
        .then(() => fn(...a))
        .catch((error) => noteIgnored(what, error));
  if (live.controller) {
    addHook(live.controller, 'onFinished', (/** @type {{ chatId: string }} */ e) =>
      quietly("end a MoMo routine's run", () => routines.finished(e))().then(() => {
        if (isMomoChat(e.chatId)) notices.resolved({ kind: 'chat', chatId: e.chatId });
        // a run's outcome is written by now
        activity.onSessionPatch(e);
        return quietly("run MoMo's memory pass", () => memoryPass.finished(e))()
          .then(quietly("write search aliases for MoMo's past chats", () => aliases.finished(e)))
          .then(quietly("deliver MoMo's nudges", () => nudges.finished(e)))
          .then(quietly("deliver MoMo's morning brief", () => brief.brief.finished(e)));
      }),
    );
    // a batch's chat deleted (Reset deletes MoMo's chats): it never lands
    if (live.chatDeletion) addHook(live.chatDeletion, 'onDeleted', (/** @type {{ chatId: string }} */ r) => aliases.deleted(r.chatId));
    addHook(live.controller, 'onCrash', (/** @type {string} */ chatId) =>
      quietly("end a MoMo routine's run whose harness quit", () => routines.crashed(chatId))(),
    );
  }

  /**
   * Setup's starter routines the user picked, proposed once setup is done (each once ever): the routines page reads again.
   * @param {any} [p] the prefs a change brought (else the ones read now)
   */
  const offerStarters = (p) =>
    quietly("propose MoMo's starter routines", async () => {
      if ((await starters(p)).length) routinesIpc.changed();
    })();

  let paused = isMomoPaused(momoPrefs());
  memoryPass.startDaily();
  aliases.start();
  onAccess((on) => {
    if (on) {
      void offerStarters();
      memoryPass.startDaily();
      aliases.start();
    } else {
      memoryPass.cancelAll();
      aliases.cancelAll();
      nudges.cancelAll();
      brief.brief.cancelAll();
      void quietly("stop MoMo's runs", () => routines.revoked())();
      notices.closeAll();
    }
  });
  void offerStarters();

  return {
    routineStore,
    routines,
    notices,
    activity,
    memoryPass,
    aliases,
    nudges,
    backgroundBudget: budget,
    /**
     * A prefs change (any window's or main's own): Pause stops this MoPilot's routine runs (each ends saying so). Nothing
     * is done while MoMo isn't allowed.
     */
    prefsChanged(/** @type {any} */ next) {
      // setup just finished: the starter routines it picked wait in Settings
      void offerStarters(next);
      const now = isMomoPaused(next?.momo);
      if (now === paused) return;
      paused = now;
      if (allowed() !== true || !now) return;
      void quietly("stop MoMo's runs for Pause", async () => {
        for (const chatId of [...routines.mine]) await routines.giveUp(chatId, PAUSED_TEXT);
      })();
    },
  };
}

/** Keys memory-pass.json kept the pass's own day counts under before it drew on the shared budget (dropped on the next write). */
const LEGACY_KEYS = ['#passes', '#tokens'];

/**
 * How long a MoMo chat stays quiet before its memory pass: the pass's own, or in a development build MoMo runs in
 * (MOPILOT_MOMO_DEV=1, as the E2E runs) MOPILOT_MOMO_PASS_IDLE_MS, so a run need not wait ten minutes.
 * @param {Record<string, string | undefined>} [env]
 */
function passIdleMs(env = process.env) {
  const ms = Number(env.MOPILOT_MOMO_PASS_IDLE_MS);
  return env.MOPILOT_MOMO_DEV === '1' && ms >= 1000 ? ms : undefined;
}

/** What a chat is to the memory pass: MoMo's main chat, a routine's run, a data-only background chat (a pass, aliases), or not MoMo's. */
function passKind(/** @type {any} */ m) {
  if (!isMomoMeta(m)) return null;
  return isMomoDataMeta(m) ? 'pass' : m.momo === 'routine' ? 'routine' : 'main';
}

/**
 * The memory pass with this app's parts: a pass chat is a MoMo background chat, unattended (no computer control,
 * approvals wait) and with no memory tools (app/momo.cjs passChat); progress per chat is sealed in memory-pass.json,
 * which Reset deletes with the memory files.
 * @param {any} d
 */
function openMemoryPass({
  core,
  live,
  meta,
  allowed,
  safeStorage,
  startChat,
  send,
  authored,
  discardChat,
  limitOf,
  momoPrefs,
  timers,
  budget = budgetIn(core.dir, safeStorage),
}) {
  const progress = new SealedJson({
    file: path.join(core.dir, 'memory-pass.json'),
    safeStorage,
    shape: (/** @type {any} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
  });
  return createMemoryPass({
    store: core.memory,
    allowed: () => allowed() === true && !isMomoPaused(momoPrefs()) && !momoResetting(),
    kindOf: (/** @type {string} */ chatId) => passKind(meta(chatId)),
    readTurns: async (/** @type {string} */ chatId) => (await live.peerRuntime?.readReference(chatId, false))?.turns ?? [],
    brain: async () => cheapBrain(roleBrain(momoPrefs()), async () => live.codex?.modelList()),
    atLimit: (/** @type {any} */ brain) => 'held' in limitOf(brain),
    startChat: async (/** @type {any} */ brain, /** @type {object} */ tag) => {
      const chatId = await startChat(brain, { ...tag, isolation: ISOLATION });
      live.sessions?.patch(chatId, { scheduled: UNATTENDED });
      return chatId;
    },
    send: (/** @type {string} */ chatId, /** @type {string} */ text) =>
      send(chatId, authored(chatId, text, { by: 'momo', title: 'Memory' })),
    discardChat,
    seen: {
      get: (/** @type {string} */ chatId) => {
        try {
          return progress.read()[chatId] ?? null;
        } catch {
          return null;
        }
      },
      set: (/** @type {string} */ chatId, /** @type {string} */ turnId) =>
        progress
          .change((/** @type {any} */ v) => {
            v[chatId] = turnId;
            for (const k of LEGACY_KEYS) delete v[k];
          })
          .catch((error) => noteIgnored("save how far MoMo's memory pass read", error)),
    },
    looksSecret,
    // MoMo's own messages in a chat (a routine's result, a nudge) are never read as the user's words
    authoredIds: (/** @type {string} */ chatId) => new Set(Object.keys(meta(chatId)?.authored ?? {})),
    // open loops from what the user says in MoMo's main chat, dates read in the Mac's time zone now
    loops: core.loops ? { store: core.loops, tz: () => Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined,
    budget,
    mainChat: () => core.mainChat.current(),
    idleMs: passIdleMs(),
    timers,
  });
}

module.exports = { openMomoBackground, PAUSED_TEXT, valueHandle, passKind, openMemoryPass, passIdleMs };
