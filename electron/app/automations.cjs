// Scheduled tasks in main: where tasks live, the scheduler that starts due ones once, the runner behind it and "Run now", and the chat tools.
const path = require('node:path');
const { ISOLATED_THREAD, DATA_ONLY_THREAD } = require('../harness/codexIsolation.cjs');
const { dataOnlyMeta } = require('../momo/contract/toolIsolation.cjs');
const os = require('node:os');
const { Scheduler, nextRun, rules } = require('../platform/scheduler.cjs');
const { AutomationRunner } = require('../platform/automationRun.cjs');
const { AutomationStore } = require('../platform/automationStore.cjs');
const { RunLedger } = require('../platform/runLedger.cjs');
const { codexApp, claudeDesktop } = require('../platform/nativeSchedulers.cjs');
const { registerPluginSkillTools } = require('../capabilities/tools/pluginSkills.cjs');
const { registerDesign } = require('./design.cjs');
const { registerSimulatorTools } = require('../capabilities/tools/simulatorTools.cjs');
const { pluginDelivery } = require('../plugins/service.cjs');
const { registerScheduledTaskTools } = require('../capabilities/tools/scheduledTasks.cjs');
const { userWordsOf } = require('../session/userWords.cjs');
const { chatModel } = require('../capabilities/computerUse.cjs');
const { ownerOf: chatOwning } = require('../platform/segmentOwner.cjs');
const { familyOf } = require('../session/contract/route.cjs');
const { permissionParams } = require('../harness/codex.cjs');
const { killedReason } = require('../../shared/killSwitch.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const acpQuirks = require('../harness/quirks/index.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { busy } = require('../session/controllerEvents.cjs');
const { queueItem } = require('../session/queueItem.cjs');
const { createOrchestration } = require('./orchestration.cjs');
const { registerHostTools } = require('./hostToolsWiring.cjs');
const { desktop: editionDesktop } = require('../../shared/edition.json');
const { wireChatPictures } = require('./chatPicturesWiring.cjs');
const { createChromePanel, projectsFileOf } = require('./chromePanel.cjs');
const { attachReviewEvents } = require('../remote/reviewEvents.cjs');
const { chatSources } = require('./ipc/chatList.cjs');
const { withMomoTasks } = require('../momo/schedulerTasks.cjs');
const { openMomo } = require('./momo.cjs');
const { wireMomoRemote } = require('../remote/momoOps.cjs');
const { momoPrefsForPhones } = require('./ipc/momoPrefs.cjs');
const { discardWorktree } = require('../platform/discardWorktree.cjs');
const { wireHostSchedules } = require('./hostSchedulesWiring.cjs');
const { scheduledList } = require('./scheduledList.cjs');
const { homeChannel } = require('./homeChannel.cjs');

/**
 * A run's message. In an idle chat it starts now and its start is awaited, so a first send that fails is the run's
 * failure (not "started"); in a chat that is busy (a heartbeat's own chat) it waits in the queue like any message.
 */
function sendRunMessage(controller, chatId, item, origin) {
  if (busy(controller.state.get(chatId))) return Promise.resolve(controller.send(chatId, item, origin));
  return controller.startOrKeep(chatId, queueItem(item, origin));
}

/**
 * @param {import('../main.cjs').AutomationsDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createAutomations({
  ipcMain,
  claude,
  shellEnv,
  gitPlatform,
  readState,
  uiPrefs,
  isFlagEnabled,
  // the app's windows (app/windows.cjs): their emitters, and the windows the window tools ask
  appWindows,
  codexEmit = appWindows?.codexEmit,
  claudeEmit = appWindows?.claudeEmit,
  acpEmit = appWindows?.acpEmit,
  broadcastAll,
  chatProject,
  powerMonitor,
  hostApi,
  run,
  winPaths,
  version,
  live,
  openChat,
}) {
  /** @type {InstanceType<typeof Scheduler>} */
  let scheduler; // assigned at startup, before any window or IPC handler uses it
  /** @type {InstanceType<typeof AutomationRunner>} */
  let automationRunner; // assigned at startup, before any window or IPC handler uses it
  /** @type {InstanceType<typeof AutomationStore>} */
  let store; // assigned at startup, before any window or IPC handler uses it
  /** @type {ReturnType<typeof wireHostSchedules>} the tasks machines fire themselves (phase 2): assigned at startup, before the scheduler or any IPC handler uses it */
  let hostScheds;
  /** Whether each harness family can run a task now: installed, signed in (the kill switch is checked first). */
  const USABLE = {
    // a harness being checked (its binary just changed) is waited for, not taken as unusable; an unattended run checks
    // it again first, since a sign-in can lapse (or be made in a terminal) without its binary changing
    acp: async (kind, { unattended = false } = {}) => {
      const id = String(parseKind(kind)?.basic);
      const h = unattended ? await live.acpAdmission?.verify(id) : await live.acpAdmission?.current(id, { again: true });
      return h?.state === 'admitted';
    },
    claude: async () => {
      try {
        const d = await claude.turnApi.detect(readState().prefs?.claudeBin ?? undefined);
        return d?.state === 'ready' || d?.state === 'apikey';
      } catch (e) {
        console.warn(`scheduled tasks: Claude Code can't be checked: ${e?.message ?? e}`);
        return false;
      }
    },
    codex: async () => {
      try {
        await live.codex.connect();
        const r = await live.codex.accountRead();
        // with saved accounts, an expired sign-in is the re-verify banner's business, not a reason not to run
        return !!r?.account || !r?.requiresOpenaiAuth || !!live.accounts?.view().accounts?.length;
      } catch (error) {
        noteIgnored('check Codex for a scheduled task', error);
        return false;
      }
    },
  };
  /** A basic harness runs only with its tool channel on (sage-mcp carries its tools). */
  const NEEDS_CHANNEL = { acp: true, claude: false, codex: false };
  /** Whether a harness can run a task now: installed, signed in, and not switched off remotely. */
  async function harnessUsableForRun(kind, opts) {
    const family = familyOf(kind);
    if (killedReason(kind, isFlagEnabled, { needsChannel: NEEDS_CHANNEL[family] })) return false;
    return USABLE[family](kind, opts);
  }
  /** How each harness family's windows learn of a chat a run made. */
  const ANNOUNCE = {
    // a durable fork's copied conversation is on disk already (`history`): windows read it when the chat opens
    claude: (e) =>
      claudeEmit({
        kind: 'chatStarted',
        key: e.chatId,
        chatId: e.chatId,
        cwd: e.cwd,
        worktreeOf: e.worktreeOf,
        ...(e.history ? { history: true } : {}),
      }),
    // a chat on a remote machine (`hostId`): its folder is the machine's, and the project it was started for keeps it there
    acp: (e) =>
      acpEmit({
        kind: 'chatStarted',
        key: e.chatId,
        chatId: e.chatId,
        cwd: e.cwd,
        worktreeOf: e.worktreeOf,
        ...(e.hostId ? { hostId: e.hostId, projectId: e.projectId ?? null } : {}),
      }),
    codex: (e) => codexEmit({ kind: 'chatStarted', chatId: e.chatId, cwd: e.cwd, worktreeOf: e.worktreeOf, config: e.config }),
  };
  /** A chat a run made: windows that are open learn of it (a window that opens later reads it from disk). */
  function announceRunChat(e) {
    // the runner names one of the three families
    ANNOUNCE[e.harness](e);
  }
  /** Windows reload the Scheduled list; `by` names the chat that changed a task, for its toast. */
  // a machine that fires its own tasks is sent its set again (electron/app/hostSchedulesWiring.cjs)
  const changed = (e = {}) => (broadcastAll('automation:changed', e), hostScheds?.resync());
  /** The chat a tool call came from, when it owns the segment the call names. */
  const ownerOf = (ctx) => chatOwning(live.chats?.records, ctx);
  /** The harness a chat is on now: its last segment's. */
  const harnessOf = (chatId) => live.chats?.records.get(chatId)?.segments.at(-1)?.kind ?? null;

  /** Validate both attended entrypoints before starting, without replacing explicit run fields. */
  async function runAttended(task, options) {
    const explicit = task && typeof task === 'object' ? task : {};
    // A missing ID can be an unsaved ad-hoc task; known persisted identities require a strict recheck.
    if (explicit.id && (await store.get(explicit.id)) && !(await store.get(explicit.id, true)))
      throw new Error(`Scheduled task "${explicit.id}" no longer exists.`);
    return automationRunner.run(explicit, options);
  }

  /** How main makes a chat with no window (platform/chatStart.cjs): for scheduled runs and for linked sessions alike. */
  function chatStartDeps() {
    return {
      prefs: uiPrefs,
      codexThread: async ({ cwd, isolated = false, meta = null, model, permission }) => {
        const prefs = uiPrefs();
        const r = await live.codex.startThread({
          // a chat kept apart from the coding side (MoMo's): its thread starts without Codex's own tools (codexIsolation.cjs)
          ...(isolated ? { [ISOLATED_THREAD]: true } : {}),
          // and one that may use no tool at all (MoMo's memory pass): its first tool list is empty too
          ...(isolated && dataOnlyMeta(meta) ? { [DATA_ONLY_THREAD]: true } : {}),
          cwd,
          model: model ?? prefs.model,
          ...permissionParams(permission ?? prefs.permission),
          ephemeral: false,
          serviceTier: prefs.serviceTier,
        });
        return r.thread;
      },
      // held by Sage like a new thread: its first message goes from main at once
      codexFork: async (params) => (await live.codex.fork({ ...params, ephemeral: false }, true)).thread,
      claudeSession: (key, info) => live.claudeTurns.registerSession(key, info),
      claudeOwn: (key, options) => live.claudeTurns.setOwn(key, options),
      claudeFork: (sessionId, cwd) => claude.forkLinkedSession(sessionId, cwd),
      acpSession: (key, info) => live.acpTurns.registerSession(key, info),
      chats: live.chats,
      worktree: (cwd, o) => gitPlatform.worktreeAdd(cwd, o),
      discardWorktree,
      script: (cwd, script) => gitPlatform.runScript(cwd, script),
      started: announceRunChat,
      // meta a caller gives a new chat of its own (MoMo's tag) reaches every window before the chat does
      changed: (id) => broadcastAll('chats:changed', { id, chat: live.chats.get(id) }),
    };
  }

  /**
   * Linked sessions (app/orchestration.cjs): chats a chat starts, made the way scheduled runs make theirs. After the
   * sessions open, before any harness session can call a tool.
   * @param {string} userData the app's data folder, where the journal lives
   */
  function registerOrchestration(userData) {
    // a sent picture outlives the temp folder's prune, and goes with its chat (app/chatPicturesWiring.cjs)
    wireChatPictures({ live, userData });
    // live.orchestrator: a new cap in Settings starts what waits (ipc/chats.cjs onPrefs)
    live.orchestrator = createOrchestration({
      file: path.join(userData, 'orchestration.json'),
      live,
      prefs: uiPrefs,
      starter: chatStartDeps(),
      usable: (kind) => harnessUsableForRun(kind),
      send: (chatId, item) => sendRunMessage(live.controller, chatId, item, null),
      projectOf: chatProject,
      worktreeInfo: (dir) => gitPlatform.worktreeInfo(dir),
      owner: ownerOf,
      ipcMain,
      broadcastAll,
      appWindows,
      isFlagEnabled,
    });
    // folders, editors, keep-awake and worktree upkeep for a chat on any harness (app/hostToolsWiring.cjs)
    if (live.capabilities)
      registerHostTools({ live, owner: ownerOf, projectOf: chatProject, prefs: uiPrefs, hostApi, gitPlatform, run, winPaths });
    return live.orchestrator;
  }

  /**
   * Chrome's side panel (app/chromePanel.cjs): the chats it starts are made the way scheduled runs make theirs.
   * @param {string} userData the app's data folder, where the saved projects are
   */
  function registerChromePanel(userData) {
    live.announceRunChat = announceRunChat;
    live.chromePanel = createChromePanel({
      live,
      claude,
      // read when the panel's menu opens, so a chat it just started is there
      sources: chatSources(live, claude),
      projectsFile: projectsFileOf(userData),
      home: os.homedir(),
      prefs: () => readState()?.prefs ?? {},
      usable: (kind) => harnessUsableForRun(kind),
      starter: chatStartDeps(),
      send: (chatId, item) => live.controller.send(chatId, item, null, true),
      open: openChat,
      // the active ones with a time, soonest first (the app's Scheduled list reads the same store)
      scheduled: () => scheduledList(store, (t) => hostScheds?.phoneFields(t), undefined, nextRun),
      broadcast: broadcastAll,
      cwdOf: (chatId) => chatProject(chatId),
      // a phone's machines (app/hostPhone.cjs), whose new chats the windows learn of as a run's (live.announceRunChat)
      remote: { version, host: () => live.hostPhone ?? null, ...homeChannel() },
    });
    // phones that follow a chat hear when its diff changes (remote/reviewEvents.cjs)
    attachReviewEvents({ live });
  }

  function registerScheduler() {
    const codexHome = () => shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex');
    const mopilotHome = () => path.join(os.homedir(), '.mopilot');
    const codex = codexApp({ codexHome });
    const desktop = claudeDesktop();
    store = new AutomationStore({
      codexDir: () => path.join(codexHome(), 'automations'),
      mopilotDir: () => path.join(mopilotHome(), 'automations'),
      codexApp: codex,
      desktop,
      log: (m) => console.warn(m),
    });
    const ledger = new RunLedger({ dir: path.join(mopilotHome(), 'automation-runs'), by: { pid: process.pid, version } });
    automationRunner = new AutomationRunner({
      ...chatStartDeps(),
      usable: harnessUsableForRun,
      // a task on a remote machine starts its chat there (electron/app/ipc/host.cjs), unset while Host is not wired
      machine: () => live.machineChats,
      label: (kind) => {
        const basic = parseKind(kind)?.basic;
        return acpQuirks.describe(basic)?.label ?? basic;
      },
      sessions: { patch: (id, p) => live.sessions.patch(id, p) },
      send: (chatId, item, origin) => sendRunMessage(live.controller, chatId, item, origin),
      remember: async (a, chatId) => {
        if (await store.rememberChat(a, chatId)) changed({ id: String(a.id) });
      },
      record: async (a, chatId, harness) => {
        await ledger.recordManual(String(a.id), chatId, harness);
        changed({ id: String(a.id) });
      },
    });
    // tasks an older MoPilot wrote into the Codex app's folder for another harness move out, so it doesn't run them with Codex
    store.migrate().catch((e) => console.warn(`scheduled tasks: ${e?.message ?? e}`));
    // on unless turned off: a time runs once wherever it runs, so there's no second scheduler to keep clear of
    // (the older runSchedules, off by default to keep clear of the Codex app, is not read)
    const enabled = () => readState().prefs?.schedulerOff !== true;
    /** A scheduled task's run started or failed to: the user is told. */
    const notifyRun = (chatId, task, o) => {
      const title = (chatId && live.codex?.chatName(chatId)) || undefined;
      // a run that failed before it had a chat is named by its task (clicking it opens no chat)
      live.notifier?.notify('scheduled', chatId ?? `automation:${task.id}`, {
        ...(o?.error
          ? { title: o.catchUp ? "Catch-up run didn't start" : "Scheduled task didn't start", body: `${task.name}: ${o.error}` }
          : { title: o?.catchUp ? 'Catch-up run started' : 'Scheduled task started', body: task.name }),
        ...(o?.error ? { group: 'failed', chatTitle: title ?? task.name } : { chatTitle: title }),
      });
    };
    hostScheds = wireHostSchedules({ live, store, ledger, dir: mopilotHome(), announce: announceRunChat, notify: notifyRun, changed });
    // MoMo's routines (live.momoRoutines, electron/momo/routines.cjs) run in this one scheduler, beside the user's
    // tasks and apart from them: their runs, notices and skipped times go to MoMo's service
    const tasks = withMomoTasks(
      {
        // a task its machine fires itself is not this Mac's to fire
        list: async () => (await store.list()).tasks.filter((t) => !hostScheds.firedByMachine(t)),
        // Revalidate a listed candidate before claiming its time or marking it handled in another app.
        validate: async (task) => {
          const current = await store.get(task.id, true);
          if (!current) throw new Error(`Scheduled task "${task.id}" no longer exists.`);
          return current;
        },
        // main runs it itself: with every window closed a due task still starts
        run: (task) => automationRunner.run(task, { unattended: true }),
        notify: (chatId, task, o) => notifyRun(chatId, task, o),
      },
      () => live.momoRoutines,
    );
    // MoMo's service forgets a deleted routine's run history here
    live.runLedger = ledger;
    scheduler = new Scheduler({
      enabled,
      list: tasks.list,
      before: () => store.sync(),
      validate: tasks.validate,
      run: tasks.run,
      skipped: tasks.skipped,
      // MoMo's routines have their own setting: "run schedules" off doesn't stop them
      independent: tasks.independent,
      ledger,
      natives: { 'codex-app': codex, 'claude-desktop': desktop },
      // the session store opens after the IPC handlers register
      sessions: {
        all: () => live.sessions?.all() ?? [],
        has: (id) => !!live.sessions?.has(id),
        get: (id) => live.sessions.get(id),
        approvalToken: (id, requestId) => live.sessions?.approvalToken(id, requestId),
        patch: (id, p) => live.sessions.patch(id, p),
      },
      notify: tasks.notify,
      // a test moves the clock itself: no timer
      tickMs: process.env.MOPILOT_SCHEDULER_TEST ? 0 : undefined,
      log: (m) => console.warn(m),
    });
    // e2e: move the scheduler's clock on instead of waiting for it
    if (process.env.MOPILOT_SCHEDULER_TEST) {
      globalThis.__schedulerAdvance = (ms, markOnly) => {
        scheduler.skew += ms;
        if (!markOnly) return scheduler.tick();
        // only the attention marks catch up: tasks that came due meanwhile start on the next tick
        scheduler.markAttention(scheduler.now());
      };
    }
    // "Run now": the same run as the scheduler's, attended; the chat it made
    ipcMain.handle('automation:run', (e, task) => runAttended(task, { unattended: false, origin: e.sender.id }));
    // a task its machine fires itself says so (fired_by is listed only, never written: automationStore.cjs DERIVED)
    ipcMain.handle('automation:list', async () => hostScheds.marked(await store.list()));
    ipcMain.handle('automation:save', async (_e, task) => {
      const t = await store.save(task && typeof task === 'object' ? task : {});
      changed({ id: String(t.id) });
      return t;
    });
    ipcMain.handle('automation:update', async (_e, id, changes) => {
      const task = await store.update(id, changes);
      if (!task) throw new Error(`Scheduled task "${id}" no longer exists. Your edit was not saved.`);
      changed({ id: String(task.id) });
      return task;
    });
    ipcMain.handle('automation:delete', async (_e, id) => {
      await store.remove(String(id));
      await ledger.forget(String(id));
      changed({ id: String(id) });
    });
    // MoPilot's runs and the Codex app's, newest first
    // what the Scheduled page and Settings say about where tasks run: the scheduler, and each native app
    const appState = async (n) => {
      const installed = n.installed();
      return { installed, running: installed && (await n.running()) };
    };
    ipcMain.handle('automation:apps', async () => ({
      scheduler: enabled(),
      codexApp: await appState(codex),
      claudeDesktop: await appState(desktop),
    }));
    const runsOf = async (id, limit = 20) =>
      [...(await ledger.list(String(id), limit)), ...codex.runs(String(id), limit)]
        .sort((a, b) => b.scheduledFor - a.scheduledFor)
        .slice(0, limit);
    ipcMain.handle('automation:runs', (_e, id) => runsOf(id));
    if (live.capabilities)
      registerScheduledTaskTools(live.capabilities, {
        store,
        // the words linked sessions record from startup (app/orchestration.cjs): a harness, model or effort the agent
        // picks stands only when the user's words name it
        said: (chatId) => userWordsOf(live.controller).said(chatId),
        modelOf: (chatId) => chatModel(harnessOf(chatId), live.chats.records.get(chatId), uiPrefs()),
        run: (task) => runAttended(task, { unattended: false }),
        owner: ownerOf,
        harnessOf,
        cwdOf: (chatId) => chatProject(chatId),
        nextRun: (rule, after) => nextRun(rule, after ?? new Date()),
        describe: (rule) => rules.describe(rule),
        changed,
        runs: runsOf,
        forget: (id) => ledger.forget(id),
        // delete_scheduled_task: the card every time, as for any action that can't be undone
        confirmDelete: async (chatId, signal, task) => {
          const broker = live.computerUse?.broker;
          if (!broker) return 'unavailable';
          const card = {
            harness: live.controller.ref(chatId).kind,
            app: { bundleId: editionDesktop.appId, name: editionDesktop.name },
            verb: `delete the scheduled task "${String(task.name).slice(0, 60)}"`,
            summary: 'It stops running and its run history is removed.',
            allowAlways: false,
            tool: 'delete_scheduled_task',
          };
          const answer = await broker.ask(chatId, 'computerConfirm', card, { signal });
          return answer ? (answer.decision === 'allow' ? 'allow' : 'deny') : 'unanswered';
        },
      });
    // plugin skills for harnesses that don't load them (electron/capabilities/tools/pluginSkills.cjs): they too
    // answer the chat that owns the call, on the harness it is on now
    if (live.capabilities) registerPluginSkillTools(live.capabilities, { delivery: pluginDelivery(), owner: ownerOf, harnessOf });
    // design systems kept as files in the chat's project (electron/app/design.cjs), the same tools on every harness
    if (live.capabilities) live.design = registerDesign({ live, owner: ownerOf, chatProject, uiPrefs, isFlagEnabled });
    // iOS Simulator and Android Emulator tools, each behind its own switch in Settings → General
    if (live.capabilities) registerSimulatorTools(live.capabilities, { owner: ownerOf, prefs: uiPrefs, noteIgnored });
  }

  /** At app ready: the scheduler checks now (catching up what came due while MoPilot was closed), on its interval, and on wake. */
  function start() {
    scheduler.start();
    // a failed check is retried on the next interval
    powerMonitor?.on('resume', () =>
      scheduler.tick().catch((e) => console.warn(`scheduled tasks: the check on wake failed: ${e?.message ?? e}`)),
    );
    hostScheds.start();
  }

  /**
   * MoMo's services (app/momo.cjs): its chats are made the way scheduled runs make theirs. After the sessions, the IPC
   * modules (Reset MoMo's folder defaults, which MoMo's own resets replace) and the tool registry. Never throws.
   * @param {string} userData the app's data folder, where MoMo's folder is
   */
  function registerMomo(userData) {
    // MoMo never fails the app's startup: a service that can't be made is noted, and live.momo stays unset, so every
    // live.momo?. path (the quit, the notice click, the prefs hook) does nothing
    try {
      // phones reach MoMo through the handlers its windows use (remote/momoOps.cjs), and hear what changed, never what
      const wired = wireMomoRemote({ ipcMain, toWindows: broadcastAll });
      live.momo = openMomo({
        userData,
        ipcMain: wired.ipc,
        live,
        claude,
        readState,
        broadcastAll: wired.broadcast,
        appWindows,
        chatStart: chatStartDeps(),
        usable: harnessUsableForRun,
        sendRun: sendRunMessage,
      });
      const prefs = momoPrefsForPhones({ readState, live });
      live.momoRemote = wired.attach({ live, mainChat: live.momo.mainChat, readState, runAttended, ...prefs });
    } catch (error) {
      live.momo = undefined;
      live.momoRemote = undefined;
      noteIgnored('start MoMo', error);
    }
    return live.momo;
  }

  return {
    announceRunChat,
    registerScheduler,
    registerOrchestration,
    registerChromePanel,
    registerMomo,
    start,
    /** @returns {InstanceType<typeof Scheduler>} main's live.scheduler: the "run schedules" setting tells it of changes */
    get scheduler() {
      return scheduler;
    },
  };
}

module.exports = { createAutomations, sendRunMessage };
