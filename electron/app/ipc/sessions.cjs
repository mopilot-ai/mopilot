// IPC for chat sessions: snapshots, sends, queued messages, caps, and the Claude and ACP turns main runs.
const { noteIgnored } = require('../../ignored.cjs');
const { shownBy } = require('../../session/viewing.cjs');
const { isQuickChatSender } = require('../../session/quickChat.cjs');
const { leaveLinkedPlan } = require('../../session/linkedPlan.cjs');
const { traitsOf } = require('../../harness/family.cjs');
const { harnessCaps } = require('../../session/harnessCaps.cjs');
const { forgetHandoffs } = require('../../capabilities/browser/handoffPages.cjs');
const { checkHandoffContinuation, installHandoffContinuationGuard } = require('../../capabilities/browser/handoffContinuation.cjs');
const { preparePlanInput, takePlanInput } = require('../../session/orchestration/planAcceptance.cjs');
const { removeQueuedForUser } = require('../../session/orchestration/userRemoval.cjs');
const { voiceWriter } = require('../../session/voice.cjs');
const { assertRetryAdmission } = require('../../session/retryAdmission.cjs');
const { pickPendingModel } = require('../../session/pendingModel.cjs');
const { isMomoMeta } = require('../../../shared/momoChat.mjs');
const { momoSessionPatch } = require('../../../shared/momoCommands.mjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const {
    execWindows,
    peerWindowChats,
    restoreGoal,
    persistHeldGoal,
    temporarySegment,
    readyMainWindow,
    quickRequests,
    viewedBy,
    claude,
    announceRunChat,
    live,
  } = deps;
  live.peerRuntime.registerIpc(ipcMain);
  installHandoffContinuationGuard(live, deps.chromeHandoffRoute);
  require('../../session/questionIpc.cjs').registerQuestions(ipcMain, deps);
  ipcMain.handle('session:snapshot', (e, chatId) => {
    if (typeof chatId !== 'string' || !chatId) return null;
    // a chat a window follows: the controller tracks its turns from here on
    const st = live.sessions.get(chatId);
    if (execWindows.has(e.sender) && (!live.mini || live.mini.isDestroyed() || e.sender !== live.mini.webContents)) {
      // Temporary forks have native state but no durable chat file. Keep their routing record in memory
      // so a side pane can follow them and use the same messaging boundary as a saved chat.
      if (!live.chats.records.has(chatId)) {
        if (temporarySegment(live.controller.ref(chatId))) live.chats.records.set(chatId, live.chats.record(chatId));
        // A new chat on a harness whose first meta write never comes (an ACP chat has no model or account to save) is
        // known only to its window until it has a record; without one, peer messaging rejects that window as the source.
        else live.chats.ensure(chatId);
      }
      if (live.chats.records.has(chatId)) {
        let follows = peerWindowChats.get(e.sender.id);
        if (!follows) {
          follows = new Set();
          peerWindowChats.set(e.sender.id, follows);
          e.sender.once('destroyed', () => peerWindowChats.delete(e.sender.id));
        }
        follows.add(chatId);
      }
    }
    // a goal MoPilot held (on a harness whose goal it holds) before the app quit comes back paused
    if (!st.goal) {
      try {
        const held = live.chats.record(chatId).meta.goalHeld;
        if (held && traitsOf(live.controller.ref(chatId).kind).holdsGoal) live.sessions.patch(chatId, { goal: restoreGoal(held, chatId) });
      } catch (error) {
        // the chat starts without its held goal; the window still gets its snapshot
        noteIgnored("restore a chat's held goal", error);
      }
    }
    return live.sessions.snapshot(chatId);
  });
  // the chats with a card waiting, so a window that opens late shows them (and the sidebar marks them)
  ipcMain.handle('session:withApprovals', () => live.sessions.all().filter((id) => live.sessions.get(id).approvals.length));
  ipcMain.handle('session:pendingModel', (_e, chatId, harness, model, effort) =>
    pickPendingModel(live.sessions, chatId, harness, model, effort),
  );
  // a goal quitting paused says so (the window only knows it's paused)
  ipcMain.handle('session:patch', (_e, chatId, asked) => {
    // a MoMo chat never turns plan mode on, sets a goal, or takes a permission or harness switch from a window (shared/momoCommands.mjs)
    const partial =
      asked && typeof asked === 'object' && isMomoMeta(live.chats?.records.get(chatId)?.meta) ? momoSessionPatch(asked) : asked;
    if (partial?.plan === false) leaveLinkedPlan(live.chats, chatId);
    const hasGoal = !!partial && typeof partial === 'object' && 'goal' in partial;
    const changed = live.sessions.clientPatch(
      chatId,
      hasGoal ? { ...partial, goal: live.codex.annotateGoal(chatId, partial.goal) } : partial,
    );
    // a goal Sage holds for Claude is kept in the chat's file (electron/session/goalHeld.cjs)
    if (hasGoal) persistHeldGoal(chatId);
    return changed;
  });
  // what the chat can do now; `hint` is what the window knows and main doesn't yet (a new chat's harness, its own model)
  ipcMain.handle('session:caps', (_e, chatId, hint) => {
    const h = hint && typeof hint === 'object' ? hint : {};
    const clean = {
      kind: typeof h.kind === 'string' ? h.kind : undefined,
      model: typeof h.model === 'string' ? h.model : undefined,
      temporary: h.temporary === true,
      elsewhere: h.elsewhere === true,
    };
    // unknown (null): the window keeps the caps unloaded and asks again on the chat's next change or capsChanged
    return live.capsService
      .get(typeof chatId === 'string' && chatId ? chatId : null, clean)
      .catch((error) => (noteIgnored("read a chat's capabilities", error), null));
  });
  // what a new chat on one harness gets once its session opens: that harness's Settings page ("What works in MoPilot")
  ipcMain.handle('session:harnessCaps', (_e, kind) =>
    typeof kind === 'string' && kind
      ? harnessCaps(live.capsService, kind, live.acpAdmission, live.capabilityHealth).catch(
          (error) => (noteIgnored("read a harness's capabilities", error), null),
        )
      : null,
  );
  ipcMain.handle('session:send', async (e, chatId, item) => {
    checkHandoffContinuation(live, deps.chromeHandoffRoute, chatId, item);
    const humanInput = !item?.peer && !item?.sideSession && !item?.authored;
    // Native plan reads may await disk. Only this window's current chat may claim its displayed plan button.
    const observedWindow = () =>
      !e.sender.isDestroyed() &&
      execWindows.has(e.sender) &&
      (shownBy(viewedBy, e.sender.id, chatId) || peerWindowChats.get(e.sender.id)?.has(chatId));
    const source = () => humanInput && observedWindow();
    // Peer, linked-session and authored-input identity are created only by main, never a renderer send argument.
    if (item && typeof item === 'object') {
      const { peer: _peer, sideSession: _sideSession, authored: _authored, ...clean } = item;
      item = clean;
    }
    if (isQuickChatSender(live.mini, e.sender)) {
      await readyMainWindow();
      if (!isQuickChatSender(live.mini, e.sender)) throw new Error('Invalid Quick Chat sender');
      if (!live.quickState?.owns(chatId)) throw new Error('Invalid Quick Chat thread');
      return quickRequests.send(chatId, item, async () => {
        checkHandoffContinuation(live, deps.chromeHandoffRoute, chatId, item);
        item = await preparePlanInput(
          live,
          chatId,
          item,
          () => humanInput && !e.sender.isDestroyed() && isQuickChatSender(live.mini, e.sender) && live.quickState.owns(chatId),
        );
        assertRetryAdmission(live.controller.state, chatId, item, !!voiceWriter(live.controller, chatId));
        return live.host.send(chatId, live.peerRuntime.userTurn(chatId, takePlanInput(item)), {
          origin: e.sender.id,
          waitForDelivery: true,
        });
      });
    }
    // a chat on a remote machine: kept, then sent in order (null for a chat that runs here)
    const remoteSend = live.remoteSend?.();
    const remote = remoteSend ? await remoteSend.send(chatId, item, e.sender.id, typeof item?.id === 'string' && item.id !== '') : null;
    if (remote) return remote;
    const prepared = preparePlanInput(live, chatId, item, source);
    item = prepared && typeof prepared.then === 'function' ? await prepared : prepared;
    item = takePlanInput(item);
    assertRetryAdmission(live.controller.state, chatId, item, !!voiceWriter(live.controller, chatId));
    return live.host.send(chatId, observedWindow() ? live.peerRuntime.userTurn(chatId, item) : item, {
      origin: e.sender.id,
      waitForDelivery: true,
    });
  });
  ipcMain.handle(
    'session:removeQueued',
    (_e, chatId, qid) => live.remoteSend?.()?.remove(chatId, qid) ?? removeQueuedForUser(live, chatId, qid),
  );
  ipcMain.handle(
    'session:sendNow',
    async (e, chatId, qid) => (await live.remoteSend?.()?.sendNow(chatId, qid)) ?? live.controller.sendNow(chatId, qid, e.sender.id, true),
  );
  // a Claude session a window just created, and what a chat has picked for itself; the adapter in main starts the turns
  ipcMain.handle('session:claudeNew', (e, key, info) => {
    const o = info && typeof info === 'object' ? info : {};
    const ok = live.claudeTurns.registerSession(String(key), o);
    // a chat Quick Chat started: the other windows list it like one started there (Codex windows learn from thread/started)
    if (ok && !o.ephemeral && e.sender === live.mini?.webContents) {
      announceRunChat({ harness: 'claude', chatId: String(key), cwd: o.cwd, worktreeOf: null });
    }
    return ok;
  });
  ipcMain.handle('session:claudeOwn', (_e, chatId, own) => live.claudeTurns.setOwn(String(chatId), own));
  ipcMain.handle('session:claudeHandover', (_e, chatId, on) => live.claudeTurns.setHandover(String(chatId), !!on));
  ipcMain.handle('session:claudeGoal', (_e, chatId, action, human) => live.claudeTurns.goalAction(String(chatId), String(action), !!human));
  // Stop on a Claude chat: pauses its goal when one is active, then interrupts; only the turn a button showed (turnId)
  ipcMain.handle('session:claudeStop', (_e, chatId, turnId) => live.host.stop(String(chatId), turnId));
  // a chat cleared (/clear starts a new chat): its idle Claude CLIs end gracefully, so Claude in Chrome's exit
  // hook closes a tab group left with only blank tabs; on every harness its Your Chrome instance ends once idle
  ipcMain.handle('session:release', (_e, chatId) => {
    live.chromeChannel?.release(String(chatId));
    // the sites it handed to the user's Chrome for a sign-in (browser/handoffPages.cjs)
    forgetHandoffs(String(chatId));
    // its tabs in the user's Chrome over MoPilot's extension or relay leave its group (at its turn's end if one runs)
    live.chromeRelay?.tabs.release(String(chatId));
    return { claude: claude.retireChat(String(chatId), { cleared: true }), acp: live.acpHost.retireChat(String(chatId)) };
  });
  ipcMain.handle('session:acpNew', (_e, key, info) => {
    const ok = live.acpTurns.registerSession(String(key), info && typeof info === 'object' ? info : {});
    // an ACP chat has one segment, which starts here: its controller plan is decided now
    live.controllerPlans.loaded(String(key));
    return ok;
  });
  ipcMain.handle('session:acpCancel', (_e, key, turnId) => live.controller.acpCancel(String(key), turnId));
  // a new chat started from this one (on any harness) carries its handoff record
  ipcMain.handle('session:handoffNote', async (_e, chatId, targetLabel) => {
    try {
      return { text: await live.switchRunner.summaryNote(String(chatId), String(targetLabel)) };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  });
  // the switch sheet: what a switch to `harness` would change about who controls each surface
  ipcMain.handle('session:controllerChanges', (_e, chatId, harness) => live.controllerPlans.preview(String(chatId), String(harness)).lines);
  ipcMain.on('session:ready', (e) => {
    const wc = e.sender;
    if (execWindows.has(wc)) return;
    execWindows.add(wc);
    wc.once('destroyed', () => execWindows.delete(wc));
  });
}

module.exports = { register };
