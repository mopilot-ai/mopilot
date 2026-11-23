// Linked sessions in main: the orchestrator and its journal, the ChatController hooks it shares with the other
// services, its agent tools on every harness, and what windows read of it.
const { OrchestrationJournal } = require('../session/orchestration/journal.cjs');
const { Orchestrator } = require('../session/orchestration/service.cjs');
const { ChatStarter } = require('../platform/chatStart.cjs');
const { registerSessionTools, registerRemoteControlTool } = require('../capabilities/tools/sessions.cjs');
const { registerSessionManagement } = require('./sessionManagement.cjs');
const { registerWindowTools } = require('../capabilities/tools/windowTools.cjs');
const { registerPaneTools } = require('../capabilities/tools/paneTools.cjs');
const { addHook, addGuard } = require('../session/hookChain.cjs');
const { excerptOf } = require('../../shared/sideSessions.mjs');
const { proposalStatus, queuedOverOffers, releaseOffers } = require('../session/orchestration/proposals.cjs');
const { boxed } = require('../session/orchestration/turnBox.cjs');
const { actOnChild } = require('../session/orchestration/childWork.cjs');
const { RUNNERS } = require('../session/orchestration/bringBack.cjs');
const { userWordsOf } = require('../session/userWords.cjs');
const { attachLimitContinue } = require('./limitContinue.cjs');
const { quotaOf } = require('../session/orchestration/autoHarness.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { channelKey } = require('../../shared/killSwitch.cjs');
const { EditedPaths } = require('../session/editedPaths.cjs');
const { turnBegan } = require('../session/orchestration/childUsage.cjs');
const path = require('node:path');
const { worktreeHistory } = require('../session/orchestration/placement.cjs');
const { createChildOptions, createSharedNotes } = require('../session/orchestration/childSetup.cjs');
const { createParentNotesGrant } = require('../session/orchestration/parentNotes.cjs');
const { archiveFamily } = require('../session/orchestration/lifecycle.cjs');
const { beforePlanDispatch, planTurnFinished, nativePlanEvent } = require('../session/orchestration/planAcceptance.cjs');

/**
 * What windows read: the links and the delivered items, without the bookkeeping (driven item ids, waiting notes).
 * @returns {import('../../shared/orchestration').OrchestrationView}
 */
function orchestrationView(data, now = Date.now(), defaultWorktree = (_parentId) => true) {
  const children = {};
  for (const [id, c] of Object.entries(data.children)) {
    children[id] = {
      parentId: c.parentId,
      ...(c.detached ? { detached: true } : {}),
      ...(c.awaitingBrief ? { awaitingBrief: true } : {}),
      name: c.name,
      title: c.title,
      // its working time (since: the running turn's start), and its declared paths and the files it edited outside them
      worked: c.worked ? { ms: c.worked.ms, turns: c.worked.turns, since: c.worked.since ?? null } : null,
      paths: c.paths ?? null,
      outside: c.outside ?? null,
      harness: c.harness ?? null,
      useWorktree: !!c.useWorktree,
      createdAt: c.createdAt ?? 0,
      lastReport: c.lastReport ? { how: c.lastReport.how, report: c.lastReport.report ?? null, at: c.lastReport.at ?? 0 } : null,
      // what git says its worktree branch did (childWork.cjs), and where the user merged it
      facts: c.facts ?? null,
      merged: c.merged ?? null,
    };
  }
  const proposals = {};
  for (const [id, p] of Object.entries(data.proposals ?? {}))
    proposals[id] = {
      parentId: p.parentId,
      kind: p.kind,
      title: p.args.title,
      prompt: String(p.args.prompt ?? '').slice(0, 4000),
      status: proposalStatus(p, now),
      chatId: p.chatId ?? null,
      expiresAt: p.expiresAt,
      waiting: p.waiting === true,
      // an offer whose call waits, counting down to "Do it here" (proposals.cjs waitForAnswer), and whether it got there
      ...(p.waiting === true && Number.isFinite(p.countdown?.from) && Number.isFinite(p.countdown?.at)
        ? { countdown: { from: p.countdown.from, at: p.countdown.at } }
        : {}),
      ...(p.autoHere === true ? { autoHere: true } : {}),
      // where it would run, as its card says: a fork of the chat, its own worktree, or this folder (the journal keeps
      // the checked start arguments, spawn.cjs startArgs)
      place: p.args.context === 'fork' ? 'fork' : (p.args.useWorktree ?? defaultWorktree(p.parentId)) ? 'worktree' : 'folder',
    };
  const plans = {};
  for (const [id, p] of Object.entries(data.plans ?? {})) plans[id] = { items: p.items, stale: p.stale === true };
  const wrapUps = {};
  // only a question with answers draws the box (a recap alone is the session's status, its parent's report)
  for (const [id, w] of Object.entries(data.wrapUps ?? {})) if (boxed(w)) wrapUps[id] = { recap: w.recap, ask: w.ask, actions: w.actions };
  // sessions made with their brief waiting for others (start_session `after`): which, and whether one failed
  const waiting = {};
  for (const [id, w] of Object.entries(data.dependants ?? {}))
    waiting[id] = { after: w.after, held: w.held ? { by: w.held.by, how: w.held.how } : null };
  return {
    children,
    deliveries: data.deliveries,
    proposals,
    queue: (data.queue ?? []).map((e) => e.chatId),
    plans,
    wrapUps,
    waiting,
    ...(Object.keys(data.parents ?? {}).length ? { families: Object.keys(data.parents) } : {}),
  };
}

/**
 * What a harness can't do now that a brief may need (start_session `needs`, autoHarness.cjs): computer use needs
 * macOS, its remote switch on, and the tool channel that carries MoPilot's tools to that harness.
 * @param {(key: string) => boolean} isEnabled the remote flags (electron/platform/flags.cjs)
 * @param {string} [platform]
 * @returns {(kind: string, need: string) => boolean}
 */
function harnessLacks(isEnabled, platform = process.platform) {
  return (kind, need) => {
    if (need !== 'computer_use') return false;
    const channel = channelKey(kind);
    return platform !== 'darwin' || !isEnabled('shared.computerUse.enabled') || (!!channel && !isEnabled(channel));
  };
}

/**
 * @param {object} d
 * @param d.file the journal (<userData>/orchestration.json)
 * @param d.live main's late-bound services: controller, chats, chatDeletion, capabilities, peerRuntime, codex
 * @param d.prefs () => the app's prefs (the cap on linked sessions working at once)
 * @param d.starter what ChatStarter needs (the same harness and worktree hooks scheduled runs use)
 * @param d.usable (kind) => Promise<boolean>: the harness can run now
 * @param d.send (chatId, item) => Promise<{started?, held?, error?}>: a message that starts an idle chat's turn
 * @param d.projectOf (chatId) => Promise<string | null>
 * @param d.worktreeInfo (path) => {branch, repo} | null
 * @param d.owner (ctx) => chat id | null: the chat a tool call came from
 * @param d.ipcMain
 * @param d.broadcastAll (channel, payload) => void
 * @param [d.appWindows] the app's windows (app/windows.cjs): the window tools ask the one showing the calling chat
 * @param [d.isFlagEnabled] (key) => boolean: the remote flags, for what each harness can do now (harnessLacks)
 */
function createOrchestration({
  file,
  live,
  prefs,
  starter,
  usable,
  send,
  projectOf,
  worktreeInfo,
  owner,
  ipcMain,
  broadcastAll,
  appWindows,
  isFlagEnabled = () => true,
}) {
  const journal = new OrchestrationJournal({
    file,
    publish: (data) =>
      broadcastAll(
        'orchestration:changed',
        orchestrationView(data, Date.now(), (id) => worktreeHistory(orchestrator, id)),
      ),
  });
  const controller = live.controller;
  const notes = createSharedNotes(path.dirname(file));
  const orchestrator = new Orchestrator({
    journal,
    controller,
    chats: live.chats,
    starter: new ChatStarter(starter),
    mainRepair: () => live.mainRepair?.api,
    usable,
    send,
    // a message to a linked session: a steer into a running chat that can take one, else queued (session/familyDelivery.cjs)
    deliverFamily: (chatId, item) => controller.deliverFamily(chatId, item),
    prefs,
    projectOf,
    worktreeInfo,
    // git and gh for a session's facts and its card's Merge and Open PR (bringBack.cjs)
    run: RUNNERS,
    readExcerpt: async (chatId) => excerptOf((await live.peerRuntime.readReference(chatId, false))?.turns) || null,
    // installed now, before any turn: a harness the agent picks runs only when the user's words name it
    said: userWordsOf(controller).said,
    title: (chatId) => live.codex?.chatName(chatId) || null,
    // set once the chats' IPC is up (ipc/chats.cjs); a call before that archives nothing
    archive: (chatId) => live.archiveChat?.(chatId) === true,
    // harness "auto" (autoHarness.cjs): the first tier, then each admitted ACP harness; their usage as the identity
    // registry last saw it (identity/contract/registry.cjs); what each can't do now
    kinds: () => ['codex', 'claude', ...(live.acpAdmission?.list() ?? []).filter((h) => h.state === 'admitted').map((h) => `acp:${h.id}`)],
    quota: (kind) => quotaOf(live.identity?.instances(parseKind(kind)?.family), kind),
    lacks: harnessLacks(isFlagEnabled),
    childOptions: createChildOptions({ live, prefs }),
    prepareNotes: notes.prepare,
    cleanupNotes: notes.cleanup,
    notesDirectory: notes.directory,
    grantParentNotes: createParentNotesGrant({ live }),
    approveStart: async (chatId, { count, continued, signal }) =>
      (
        await live.computerUse?.broker?.ask(
          chatId,
          'sessionStart',
          {
            harness: controller.ref(chatId).kind,
            count,
            continued,
          },
          { signal },
        )
      )?.decision === 'allow',
    remotelyDriven: (chatId) => ['on', 'offline'].includes(live.controller.state.get(chatId)?.remoteControl?.state),
    notifyOffer: (chatId, title) =>
      live.notifier?.notify('approval', chatId, {
        title: `New session for “${title}”, or do it here?`,
        body: 'With no answer in a minute, it’s done here.',
      }),
  });
  // beside the hooks already there (the peer service's, the turn-end ledger's); the orchestrator's own failures are
  // only noted, so they never change what a Stop or a turn's end reports
  const quietly =
    (what, fn) =>
    (...args) =>
      void orchestrator.safely(what, () => fn(...args));
  addGuard(controller, 'beforeDispatch', ({ chatId }) => {
    if (orchestrator.archived(chatId) && (journal.child(chatId) || journal.parent(chatId)))
      throw new Error('This session is archived. Restore it before sending its queued messages.');
  });
  addGuard(
    controller,
    'beforeDispatch',
    quietly('note an input to a linked chat', (e) => orchestrator.dispatching(e)),
  );
  addGuard(
    controller,
    'beforeDispatch',
    quietly('record an accepted plan', (e) => beforePlanDispatch(orchestrator, e)),
  );
  addHook(
    controller,
    'onLiveEvent',
    quietly('record a native plan approval', (family, e) => nativePlanEvent(orchestrator, family, e)),
  );
  addHook(
    controller,
    'onFinished',
    quietly('retire plan approval requests', (e) => planTurnFinished(orchestrator, e)),
  );
  // the linked sessions' status a message carried counts as seen once its harness took it (rosterStatus.cjs)
  addGuard(
    controller,
    'onDispatchResult',
    quietly('note the linked sessions a chat was told about', (e) => orchestrator.roster.settled(e)),
  );
  // a linked session's turns are timed from when main sends them (childUsage.cjs)
  addGuard(
    controller,
    'beforeDispatch',
    quietly("time a linked chat's turn", (e) => turnBegan(orchestrator, e)),
  );
  // the files a linked session with declared paths edits, from every harness's live events (writeScope.cjs)
  const edited = new EditedPaths({
    wanted: (chatId) => !!journal.child(chatId)?.paths?.length,
    chatOf: (key) => controller.chatOf(key),
    requestChat: (thread) => controller.requestChat(thread),
  });
  controller.editedPaths = edited;
  addHook(
    controller,
    'onLiveEvent',
    quietly("note a linked chat's edits", (family, e) => edited.event(family, e)),
  );
  addHook(
    controller,
    'onStopped',
    quietly('note a stopped linked chat', (id) => orchestrator.stopped(id)),
  );
  addHook(
    controller,
    'onFinished',
    quietly("note a linked chat's turn", (e) => orchestrator.finished(e)),
  );
  addHook(
    controller,
    'onAwaitingUser',
    quietly('note a linked chat waiting on the user', (id) => orchestrator.awaitingUser(id)),
  );
  addHook(
    controller,
    'onCrash',
    quietly('note a linked chat whose harness quit', (id) => orchestrator.crashed(id)),
  );
  // an offer's card (proposals.cjs): the user's message queued behind the turn takes precedence over it, as one steered
  // in does, and a turn that was stopped, whose harness quit or that ended lets go of its call
  addHook(
    controller,
    'onQueued',
    quietly('let a queued message take precedence over an offer', (id, item) => queuedOverOffers(orchestrator, id, item)),
  );
  for (const hook of ['onStopped', 'onCrash'])
    addHook(
      controller,
      hook,
      quietly('let go of the offer a turn asked', (id) => releaseOffers(orchestrator, id)),
    );
  addHook(
    controller,
    'onFinished',
    quietly('let go of the offer a turn asked', (e) => releaseOffers(orchestrator, e.chatId)),
  );
  // beside any other service's: a deleted chat leaves the journal (IPC registers the deletion first, ipc/chats.cjs)
  if (live.chatDeletion)
    addHook(
      live.chatDeletion,
      'onDeleted',
      quietly('forget a deleted chat', (receipt) => orchestrator.chatDeleted(receipt.chatId)),
    );
  if (live.capabilities) registerSessionTools(live.capabilities, { orchestrator, owner });
  if (live.capabilities)
    registerSessionManagement(live, { orchestrator, owner, prefs, projectOf, worktreeInfo, userData: path.dirname(file), broadcastAll });
  // a session turns its Remote Control link (Claude Code's, to claude.ai) on or off; other harnesses are told they have none
  if (live.capabilities)
    registerRemoteControlTool(live.capabilities, {
      owner,
      refOf: (id) => live.controller.ref(id),
      claude: { control: (key, method, arg) => live.claudeTurns.api.control(key, method, arg) },
    });
  // a session opens the sessions it started beside it (split view), in a window, or in the main pane
  if (live.capabilities && appWindows)
    registerWindowTools(live.capabilities, {
      owner,
      // an unreadable journal knows no children: only "self" resolves
      journal: () => journal,
      viewedBy: appWindows.viewedBy,
      windows: () => [...appWindows.windows].filter((w) => w !== appWindows.mini),
      createWindow: appWindows.createWindow,
      ipcMain,
    });
  // a session shows its changes, a file, its terminal, tasks or browser beside it, and hands the user a shell
  if (live.capabilities && appWindows)
    registerPaneTools(live.capabilities, {
      owner,
      viewedBy: appWindows.viewedBy,
      windows: () => [...appWindows.windows].filter((w) => w !== appWindows.mini),
      projectOf,
      // its own card ("Allow … to open a terminal?", Allow in this chat / Deny), as a dev server's
      approveTerminal: async (chatId, signal, { cwd }) => {
        const broker = live.computerUse?.broker;
        if (!broker) return false;
        const params = { harness: live.controller.ref(chatId).kind, cwd, tool: 'open_terminal_tab' };
        return (await broker.ask(chatId, 'terminalTab', params, { signal }))?.decision === 'allow';
      },
      // run_in_terminal: its own card names the exact line; a full-access chat is not asked, a read-only one never runs it
      approveCommand: async (chatId, signal, { cwd, command }) => {
        const broker = live.computerUse?.broker;
        if (!broker) return false;
        const params = { harness: live.controller.ref(chatId).kind, cwd, command, tool: 'run_in_terminal' };
        return (await broker.ask(chatId, 'terminalTab', params, { signal }))?.decision === 'allow';
      },
      // the anchor computer use and the browser read; without computer use no card can be shown either
      anchorOf: (chatId) => live.computerUse?.cu.anchor(chatId) ?? 'ask',
      // the local terminals, set by app/updates.cjs (which owns the require); read when a call comes
      pty: { info: (key) => live.pty.info(key), write: (key, data) => live.pty.write(key, data) },
      ipcMain,
    });
  // only the app's own windows, as for peer messages: the journal holds every chat's briefs and reports
  const appWindow = (event) => {
    if (!live.peerRuntime.referenceWindow(event)) throw new Error('Unknown app window');
  };
  ipcMain.handle('orchestration:snapshot', (event) => {
    appWindow(event);
    return orchestrationView(journal.data, Date.now(), (id) => worktreeHistory(orchestrator, id));
  });
  // a click on a proposal's card: start, dismiss, or (an offer) do it here; the user's own click is the authority
  ipcMain.handle('orchestration:task', (event, id, action, options) => {
    appWindow(event);
    return orchestrator.act(String(id), String(action), options ?? null);
  });
  // a chat whose turn ended on its harness's usage limit goes on by itself, with or without a window (Settings → General)
  attachLimitContinue({ live, orchestrator, prefs, broadcastAll });
  // a click on a started session's card: merge its branch here, or open a pull request for it; the click is the authority
  ipcMain.handle('orchestration:child', (event, id, action) => {
    appWindow(event);
    if (action === 'detach') return orchestrator.detach(String(id));
    return actOnChild(orchestrator, String(id), /** @type {'merge' | 'pr'} */ (String(action)));
  });
  ipcMain.handle('orchestration:archiveFamily', (event, id, mode, expectedIds) => {
    appWindow(event);
    return archiveFamily(orchestrator, String(id), mode, expectedIds);
  });
  // what waited in the queue when the app last quit goes as slots free up
  orchestrator.o.defer(() => orchestrator.pump());
  return orchestrator;
}

module.exports = { createOrchestration, orchestrationView, harnessLacks };
