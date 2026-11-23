// The Chrome side panel's main end (capabilities/browser/chromePanel.cjs): chats, projects and scheduled tasks as the app's sidebar has them, pinning, the harnesses a new chat can use now, the model, effort, permission and harness menus (chromePanelOptions.cjs), the / menu (chromePanelCommands.cjs), @ chat references (chromePanelMentions.cjs), Dictate (chromePanelDictate.cjs), files attached (chromePanelFiles.cjs), a new chat (in a project) or a follow-up sent from main with no window, a chat's history and cards followed live, a card's answer and Stop through the chat's harness, and opening MoPilot at a chat or a page.
const path = require('node:path');
const { createReviewOps } = require('../remote/review/ops.cjs');
const { pushSettingsFor } = require('../remote/pushSettingsOps.cjs');
const { createMirrorWiring } = require('./chromePanelMirror.cjs');
const { CHAT_GONE_TEXT } = require('../chrome-extension/src/panelErrors.mjs');
const { ChromePanel } = require('../capabilities/browser/chromePanel.cjs');
const { acceptSendReceipt } = require('../../shared/sendReceipt.mjs');
const { withoutHiddenBlocks } = require('../../shared/userText.mjs');
const { preparePanelTab } = require('../capabilities/browser/chromePanelTab.cjs');
const { PanelWatch, rowsOf, turnState, withoutPictureOnlyRows } = require('../capabilities/browser/chromePanelLive.cjs');
const { stateOf } = require('../remote/chatState.cjs');
const { createHistoryReader } = require('./chromePanelHistory.cjs');
const { createOpenReads } = require('./chromePanelOpenRead.cjs');
const { ChatSignals } = require('./chromePanelSignals.cjs');
const { createPhoneLists } = require('./chromePanelPhoneLists.cjs');
const { withChatNotes } = require('../../shared/chatNotes.mjs');
const { PanelQuestions } = require('../capabilities/browser/chromePanelQuestions.cjs');
const { cardOf, answerOf } = require('../capabilities/browser/chromePanelCards.cjs');
const { versionOf, currentApproval } = require('../capabilities/browser/chromePanelEpoch.cjs');
const { browserUseApproval, allowsAllSites } = require('../../shared/elicitation.mjs');
const { claudeAnswer } = require('../../shared/claudeAnswer.mjs');
const { approvalRequest } = require('../../shared/approvalRequest.mjs');
const { approvalHarness } = require('../../shared/approvalOrigin.mjs');
const { chatModel } = require('../capabilities/computerUse.cjs');
const { readable } = require('../momo/contract/toolIsolation.cjs');
const { ChatStarter } = require('../platform/chatStart.cjs');
const { ProjectsStore, phoneProjects } = require('../platform/projects.cjs');
const { makeProjectlessFolder, projectlessRoot, slugOf } = require('../platform/projectlessFolder.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { answerLiveAcpCard } = require('../harness/acp/cardAnswer.cjs');
const { HARNESS_LABEL } = require('../../shared/handoff.mjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { addHook } = require('../session/hookChain.cjs');
const { momoAllowed } = require('../momo/access.cjs');
const { openPhoneItems } = require('./chromePanelPhones.cjs');
const { createPanelOptions } = require('./chromePanelOptions.cjs');
const { createPanelMachine } = require('./chromePanelMachine.cjs');
const { PanelFiles } = require('./chromePanelFiles.cjs');
const { createPanelCommands } = require('./chromePanelCommands.cjs');
const { createPanelMentions } = require('./chromePanelMentions.cjs');
const { browserSettings } = require('./chromeBrowserSettings.cjs');
const { createPanelDictation } = require('./chromePanelDictate.cjs');
const { shapeStart, startChat } = require('./chromePanelShape.cjs');
const { typed } = require('./chromePanelInput.cjs');
const { carryInputGuard } = require('../session/contract/inputGuard.cjs');
const { panelIdentity } = require('./chromePanelIdentity.cjs');
const { createRecentList } = require('./chromePanelRecent.cjs');
const { readPhoneUsage } = require('../remote/usage.cjs');
const { createHarnessStates } = require('./chromePanelHarnessStates.cjs');
const { createChatAccount } = require('./chromePanelChatAccount.cjs');
const { readPhoneAccounts, setPhoneAutoSwitch } = require('../remote/accounts.cjs');
/**
 * @param {object} d
 * @param {any} d.live main's late-bound services: chats, controller, acpAdmission, peerRuntime (a chat's history), and
 *   where a card's answer goes: acpHost, codex, siteConsent, computerUse (MoPilot's own cards)
 * @param {{ resolvePermission: (id: string, answer: object) => boolean } & Parameters<typeof createPanelOptions>[0]['claude']
 *   & Parameters<typeof createPanelCommands>[0]['claude'] & { identity: ReturnType<typeof import('../harness/claude/identityApi.cjs').createIdentityApi> }} d.claude
 *   Claude Code's sessions (electron/harness/claude/index.cjs)
 * @param {Record<string, (archived: boolean) => Promise<any[]>>} d.sources each harness's sessions (ipc/chatList.cjs chatSources, kept fresh)
 * @param {string} d.projectsFile the saved projects (<userData>/projects.json)
 * @param {string} d.home the home folder
 * @param {() => any} d.prefs the app's prefs
 * @param {(kind: string) => Promise<boolean>} d.usable the harness can run now (installed, signed in, not switched off)
 * @param {ConstructorParameters<typeof ChatStarter>[0]} d.starter how main makes a chat with no window
 * @param {(chatId: string, item: object) => Promise<import('../../shared/sendReceipt.mjs').SendReceipt>} d.send a message to a chat: starts an idle chat's turn, queues for a busy one
 * @param {(chatId: string | null, page?: string) => unknown} d.open shows MoPilot, at the chat or the page named
 * @param {() => Promise<{ id: string, name: string, next: number | null }[]>} d.scheduled the scheduled tasks, soonest first
 * @param {(channel: string, payload: unknown) => void} d.broadcast to every window (a pin shows in the app's sidebar)
 * @param {() => Date} [d.now]
 * @param {InstanceType<typeof PanelFiles>} [d.files] where attached files are kept
 * @param {(chatId: string) => Promise<string | null>} d.cwdOf the chat's folder (session/chatProject.cjs)
 * @param {{ policy?: object, momoAllowed?: () => boolean, version?: string, host?: () => any }} [d.remote] what paired phones are told and allowed (remote/service.cjs)
 */
function createChromePanel({
  live,
  claude,
  sources,
  projectsFile,
  home,
  prefs,
  usable,
  starter,
  send,
  open,
  scheduled,
  broadcast,
  now = () => new Date(),
  files = new PanelFiles(),
  cwdOf,
  remote = {},
}) {
  const starts = new ChatStarter(starter);
  /** The saved projects, read from their file each time (the windows write it). */
  const projectsOf = () => new ProjectsStore(projectsFile).list().projects;
  /** Whether a harness can start a chat now: installed, signed in, not switched off; a basic one also admitted. */
  async function usableNow(/** @type {string} */ id) {
    const basic = parseKind(id)?.basic;
    if (basic && !live.acpAdmission?.admitted(basic)) return false;
    return usable(id).catch((error) => {
      noteIgnored(`check ${id} for the Chrome side panel`, error);
      return false;
    });
  }
  /** The harnesses a new chat can use, in the order the app's picker lists them: Claude Code, Codex, then basic ones. */
  async function harnesses() {
    const basic = (live.acpAdmission?.list() ?? [])
      .filter((h) => h.state === 'admitted')
      .map((h) => ({ id: `acp:${h.id}`, label: h.label ?? h.id }));
    const all = [...['claude', 'codex'].map((id) => ({ id, label: HARNESS_LABEL[id] })), ...basic];
    const ok = await Promise.all(all.map((h) => usableNow(h.id)));
    return all.filter((_h, i) => ok[i]);
  }
  const harnessStates = createHarnessStates({ live, labels: HARNESS_LABEL, usable: usableNow, blocker: (id) => menus.switchBlocker(id) });
  /** The harness a chat runs on now, as the panel names it. */
  const labelOf = (/** @type {string | null} */ kind) => {
    const k = parseKind(kind);
    if (!k) return null;
    return k.basic ? (live.acpAdmission?.list().find((h) => h.id === k.basic)?.label ?? k.basic) : HARNESS_LABEL[k.family];
  };
  /** A chat the panel may open, write to or mention: one main knows (a record, or one started a moment ago with none yet), never one of MoMo's (kept apart from the coding side: electron/momo/contract/toolIsolation.cjs). */
  const reachable = (/** @type {string} */ chatId) =>
    live.chats.records.has(chatId) ? readable(live.chats, chatId) : live.controller.state.has(chatId);
  /** A panel request's own chat, when it names one: refused unless reachable (a request for a new chat names none). @type {<P extends { chatId?: string | null }>(p: P) => P} */
  const ownChat = (p) => {
    if (p?.chatId && !reachable(p.chatId)) throw new Error("That chat isn't in MoPilot.");
    return p;
  };
  /** The harness kind a chat runs on now. */
  const kindOf = (/** @type {string} */ chatId) =>
    live.chats.records.get(chatId)?.segments.at(-1)?.kind ?? live.controller.ref(chatId)?.kind ?? null;
  /** How a card names the chat's agent. */
  const agentOf = (/** @type {string} */ chatId, approval = null) =>
    labelOf(approvalHarness(approval, kindOf(chatId)) ?? null) ?? 'The agent';
  /**
   * A card's answer through the harness that asked, as the window's goes (src/store/notifications.ts sendAnswer): true
   * once the harness took it, false when the card was gone already.
   */
  function deliver(/** @type {any} */ a, /** @type {any} */ result) {
    const id = a.id;
    if (String(a.method).startsWith('sage/')) return !!live.computerUse?.broker.answer(id, result);
    if (String(id).startsWith('cperm-')) {
      // what the CLI asked about, as the window's card carries it (shared/approvalRequest.mjs): main holds the request
      const req = approvalRequest(a, null, null);
      const meta = /** @type {{ input?: Record<string, any> | null, suggestions?: unknown[] | null } | undefined} */ (req.params._claude);
      live.controller.resolveApproval(id);
      return claude.resolvePermission(id, claudeAnswer(req.method, meta?.input ?? {}, result, meta?.suggestions));
    }
    // { optionId } (a reject the harness doesn't offer is null: cancelled); a Host chat's card is answered on its Host, as a window's is
    if (a.method === 'acp/permission') return answerLiveAcpCard(live, String(id), result.optionId ?? null);
    // Codex: only a card main still holds for the current app-server (controllerEvents.cjs onCodexOutgoing)
    if (!live.controller.onCodexOutgoing({ id, result })) return false;
    live.codex.respond(id, result);
    // the Browser plugin's site consent: MoPilot's site card for the same site doesn't ask again
    live.siteConsent?.answered(id, result);
    return true;
  }
  const questions = new PanelQuestions(live, { reachable, agent: agentOf });
  /** A native all-sites grant is offered only when Codex's current managed requirements permit it. */
  async function cardOptions(a) {
    const req = approvalRequest(a, null, null);
    if (req.method !== 'mcpServer/elicitation/request' || !browserUseApproval(req.params)?.choices.some((c) => c.value === 'allSites'))
      return {};
    try {
      return { allowAllSites: allowsAllSites(await live.codex.request('configRequirements/read', {})) };
    } catch (error) {
      noteIgnored('read managed browser approval requirements for the side panel', error);
      return { allowAllSites: false };
    }
  }
  const historyOf = createHistoryReader(live);
  /** The turns of a side chat a phone made (nothing saves them, so the phone feed keeps them); null for any other chat. */
  const forkTurns = (/** @type {string} */ chatId, /** @type {{ exceptLive?: boolean }} */ o = {}) =>
    lists.sideChatIds().has(chatId) ? phones.turnsOf(chatId, o) : null;
  const opened = createOpenReads({ live, reachable, historyOf, forkTurns });
  /** The approvals main holds for a chat as cards, each with the version an answer must name. */
  async function approvalsAt(/** @type {string} */ chatId) {
    const offered = live.controller.state.get(chatId).approvals.map((a) => ({ a, version: versionOf(live.controller.state, chatId, a) }));
    return Promise.all(
      offered.map(async ({ a, version }) => ({
        ...cardOf(a, agentOf(chatId, a), await cardOptions(a)),
        version,
      })),
    );
  }
  /** The cards a paired phone sees for a chat: the same ones the panel reads (read below), without the rest of the chat. */
  async function cardsOf(/** @type {string} */ chatId) {
    const record = live.chats.records.get(chatId);
    const history = record ? await opened.cardTurns(chatId) : { turns: [] };
    const approvals = await approvalsAt(chatId);
    return [
      ...questions.read(chatId, history.turns),
      ...approvals.filter((c) => currentApproval(live.controller.state, chatId, c.id, c.version)),
    ];
  }
  /**
   * The chat's recent full-history rows and notes, its cards, and the current harness and account. A panel watches the
   * chat from now (`watch`); a phone's snapshot only reads it. `may` says whether the chat may be read at each step.
   */
  async function read(/** @type {string} */ chatId, { watch: watched = true, may = reachable } = {}) {
    const record = live.chats.records.get(chatId);
    const present = () => may(chatId) && (!record || live.chats.records.has(chatId));
    if (!present()) throw new Error(CHAT_GONE_TEXT);
    if (watched) watch.watch(chatId);
    // a chat started a moment ago has nothing saved yet (no rows until its harness writes them); while main runs its turn the history is read open, so calls in progress read as running
    const running = stateOf(live.controller.state.get(chatId)?.turn) !== 'idle';
    let history;
    try {
      const fork = forkTurns(chatId);
      const none = { turns: [], earlierContentOmitted: false };
      history = fork ? { ...none, turns: fork } : record ? await historyOf(chatId, record, running) : none;
    } catch (error) {
      if (!present()) throw new Error(CHAT_GONE_TEXT);
      throw error;
    }
    if (!present()) throw new Error(CHAT_GONE_TEXT);
    const approvals = await approvalsAt(chatId);
    if (!present()) throw new Error(CHAT_GONE_TEXT);
    const identity = await panelIdentity(live, claude, chatId);
    if (!present()) throw new Error(CHAT_GONE_TEXT);
    const latest = live.chats.records.get(chatId);
    const kind = kindOf(chatId);
    const notes = Array.isArray(latest?.meta?.notes) ? latest.meta.notes : [];
    const { rows, clipped } = rowsOf(withChatNotes(history.turns, notes), { running });
    let account = null;
    try {
      account = live.capsService?.accountLabel(chatId) ?? null;
    } catch (error) {
      noteIgnored('read a panel account label', error);
    }
    /** @type {string | null} */
    let menuOwner = null;
    try {
      if (kind) menuOwner = menus.owner(chatId);
    } catch (error) {
      noteIgnored('read the panel menu owner', error);
    }
    const family = parseKind(kind)?.family;
    const limitWarning = signals.warningOf(chatId, family);
    return {
      chatId,
      ...identity,
      rows: withoutPictureOnlyRows(rows),
      omitted: !!history.earlierContentOmitted || clipped,
      harness: labelOf(kind),
      account,
      model: kind ? chatModel(kind, latest, prefs()) : null,
      menuOwner,
      ...turnState(live.controller.state.get(chatId)?.turn, history.turns),
      // a usage window nearly used up, and the usage limit the chat stopped on (none from a harness with no such signal, none while a turn runs)
      ...(limitWarning ? { limitWarning } : {}),
      ...(running ? {} : signals.limitField(chatId, family, rows.at(-1))),
      approvals: [
        ...questions.read(chatId, history.turns),
        ...approvals.filter((c) => currentApproval(live.controller.state, chatId, c.id, c.version)),
      ],
    };
  }
  const lists = createPhoneLists({
    live,
    reachable,
    historyOf,
    recent: (limit, archived) => panel.o.recent(limit, archived),
    cwdOf,
    prefs,
    projectCwd: (id) => projectPath(id),
  });
  const machine = createPanelMachine({ live, labelOf });
  const menus = createPanelOptions({
    live,
    claude,
    prefs,
    kindOf,
    labelOf,
    usable: usableNow,
    onMachine: (chatId) => machine.machineOf(chatId) !== null,
  });
  const slash = createPanelCommands({ live, claude, prefs, kindOf, cwdOf, home });
  const mentions = createPanelMentions({
    peerRuntime: { readReference: (id, assistantOnly) => live.peerRuntime.readReference(id, assistantOnly) },
    known: reachable,
  });
  /** A saved project's folder, by its id (a new chat's / menu reads it). */
  const projectPath = (/** @type {string | null | undefined} */ id) => (id ? (projectsOf().find((p) => p.id === id)?.path ?? null) : null);
  const answering = new Set();
  const delivered = async (chatId, item) => {
    const receipt = await send(chatId, carryInputGuard(item, { ...item, followUp: prefs()?.followUp === 'steer' ? 'steer' : 'queue' })); // as the app's composer: queue, or steer where the harness can
    const error = acceptSendReceipt(receipt);
    return error
      ? `Your message is queued. ${error}`
      : receipt.action === 'held'
        ? 'Your message is waiting to be sent.'
        : receipt.action === 'discarded'
          ? `The message was discarded before it reached the harness.\n\nMessage: ${withoutHiddenBlocks(item.text)}`
          : null;
  };
  const phones = openPhoneItems({
    service: () => panel.service,
    chatOf: (key) => live.controller.chatOf(key),
    forks: () => lists.sideChatIds(),
    asked: (chatId) => lists.sideChatQuestions(chatId),
    ...opened,
  });
  live.phoneLiveImage = phones.liveImage;
  const mirrors = createMirrorWiring({ live, cwdOf });
  const recent = createRecentList({ sources, live, home, projects: projectsOf, prefs, changed: () => panel.service.onChatsChanged(false) });
  const panel = new ChromePanel({
    mirror: mirrors.mirror,
    remote: {
      momoAllowed,
      phoneAbsent: (pairId) => live.remote?.presence?.isAbsent(pairId) === true,
      momo: () => live.momoRemote ?? null,
      pushSettings: pushSettingsFor({ live, prefs, momoOn: momoAllowed }),
      policy: mirrors.policy,
      ...remote,
    },
    sendCheck: (id) => live.controller.stopCheck?.(id),
    recent: recent.read,
    invalidateRecent: recent.invalidate,
    browserSettings: (p) => browserSettings({ setup: live.chromeRelay, grants: live.chromeGrants }, p),
    projects: () => phoneProjects(projectsOf()),
    scheduled,
    pin: (chatId, pinned) => {
      if (!live.chats.records.has(chatId) || !reachable(chatId)) return false;
      // the same flag the app's Pin sets; its windows show it at once
      if (live.chats.patchMeta(chatId, { pinned: pinned ? true : null }))
        broadcast('chats:changed', { id: chatId, chat: live.chats.get(chatId) });
      return true;
    },
    turn: (chatId) => (reachable(chatId) ? live.controller.state.get(chatId)?.turn : undefined),
    usage: (p) => readPhoneUsage(live, claude.identity, undefined, p.refresh ? 'now' : 'surface'),
    accounts: () => readPhoneAccounts(live),
    setChatAccount: createChatAccount({ live, kindOf, labelOf, broadcast }),
    setAutoSwitch: (p) => setPhoneAutoSwitch(live, claude.identity, p),
    harnesses,
    harnessStates,
    usable: usableNow,
    dictation: createPanelDictation({ live, prefs }),
    ...files.remoteOps(),
    commands: ({ projectId, ...target }) => slash.commands({ ...ownChat(target), cwd: projectPath(projectId) }),
    // a chat on a machine adds its machine's agents and a held move (chromePanelMachine.cjs)
    options: async (p) => machine.options(p, await menus.options(ownChat(p))),
    choose: (p) => menus.choose(ownChat(p)),
    permit: (p) => menus.permit(ownChat(p)),
    switchHarness: async (p) => (await machine.switchTo(ownChat(p))) ?? menus.switchTo(p),
    start: async ({
      harness,
      text,
      projectId,
      model,
      effort,
      attachments,
      skills: names,
      tab,
      deadline,
      retainOnError,
      permission,
      account,
      worktree,
      nativeMessageId,
    }) => {
      // an attachment or a skill that isn't there refuses the message before a chat is made for it
      files.take(attachments);
      const project = projectId === null ? null : projectsOf().find((p) => p.id === projectId);
      if (project === undefined) throw new Error("That project isn't in MoPilot.");
      // the skills the menu listed for that folder (home for a chat with none), before anything is made
      const skills = await slash.skills(names, { harness, cwd: project ? String(project.path) : null });
      const references = await mentions.references(text);
      const shaped = await shapeStart({ live, starts, harness, project: project ?? null, account, worktree });
      // a project's chat runs in its folder (or its worktree); any other in a folder of its own
      const made = shaped.cwd
        ? /** @type {const} */ ({ ok: true, path: shaped.cwd })
        : makeProjectlessFolder(projectlessRoot(prefs(), home), now().toISOString().slice(0, 10), slugOf(text.split('\n')[0]));
      if (!made.ok) throw new Error(`Couldn't create the chat folder: ${made.error}`);
      const chatId = await startChat(starts, shaped, made.path);
      // Set the chat's mode before its first message can run.
      if (permission !== undefined) await menus.permit({ chatId, value: permission });
      // filed under its project, as one started in the project from the app
      if (project) live.chats.patchMeta(chatId, { projectId: project.id });
      const stopped = live.controller.stopCheck?.(chatId);
      const prepared = await preparePanelTab(live, chatId, text, tab, deadline);
      let deliveryWarning;
      try {
        stopped?.();
        if (deadline !== undefined && Date.now() >= deadline)
          throw new Error('This message took too long to prepare. Retry it when ready.');
        deliveryWarning = await delivered(
          chatId,
          typed(
            { text: prepared.text, model, effort, attachments, nativeMessageId, chromePanelTab: prepared.target },
            files,
            skills,
            references,
          ),
        );
      } catch (error) {
        if (!retainOnError) throw error;
        // Keep the created chat reachable for a retry; a successful page admission remains owned by that chat.
        watch.watch(chatId);
        return { chatId, error: messageOf(error) };
      }
      files.sent(attachments);
      watch.watch(chatId);
      const warning = [prepared.warning, deliveryWarning].filter(Boolean).join('\n');
      return tab || warning ? { chatId, warning: warning || null } : chatId;
    },
    read,
    ...lists,
    // for paired phones (electron/remote/service.cjs): the SessionState, who may be reached, the cards up, and the last rows
    get state() {
      return live.controller.state;
    },
    reachable,
    cardsOf,
    review: createReviewOps({ cwdOf, live, history: historyOf }),
    cardAnswer: answerOf,
    items: phones.items,
    send: async (p, assertCurrent, admit) => {
      const { chatId } = p;
      if (!reachable(chatId)) throw new Error("That chat isn't in MoPilot.");
      // Validate attached input before moving a tab; sending starts only after its exact handoff settles.
      files.take(p.attachments);
      const skills = await slash.skills(p.skills, { chatId });
      const references = await mentions.references(p.text);
      assertCurrent?.();
      const prepared = await preparePanelTab(live, chatId, p.text, p.tab, p.deadline);
      assertCurrent?.();
      admit?.();
      const deliveryWarning = await delivered(
        chatId,
        typed({ ...p, text: prepared.text, chromePanelTab: prepared.target }, files, skills, references),
      );
      files.sent(p.attachments);
      lists.sideChatAsked(chatId, p.text);
      watch.watch(chatId);
      return { warning: [prepared.warning, deliveryWarning].filter(Boolean).join('\n') || null };
    },
    answer: async ({ chatId, approvalId, choice, values, version }) => {
      ownChat({ chatId });
      if (values !== undefined && JSON.stringify(values).length > 200_000)
        throw new Error('This answer is too large. Shorten it and try again.');
      if (questions.handles(approvalId)) return questions.answer(chatId, approvalId, choice, values, version);
      const a = currentApproval(live.controller.state, chatId, approvalId, version);
      if (!a) return false;
      if (answering.has(version)) return false;
      answering.add(version);
      try {
        const options = await cardOptions(a);
        if (!currentApproval(live.controller.state, chatId, approvalId, version)) return false;
        const result = answerOf(a, choice, agentOf(chatId, a), values, options);
        if (result == null) throw new Error('Choose an option offered by this request.');
        return !!(await deliver(a, result));
      } finally {
        answering.delete(version);
      }
    },
    // the chat's Stop, on any harness (ChatController.stopChat)
    stop: (chatId) => live.controller.stopChat(ownChat({ chatId }).chatId),
    // MoPilot opened at a MoMo chat would show it outside MoMo's page; an unknown chat opens the window as before
    open: (chatId, page) => {
      if (chatId && live.chats.records.has(chatId) && !readable(live.chats, chatId)) throw new Error("That chat isn't in MoPilot.");
      return open(chatId, page);
    },
  });
  /** every chat's usage warnings, heard whether or not a panel shows the chat (a panel opened mid-turn reads what came before) */
  const signals = new ChatSignals({
    // Codex's windows are the pool's, for the login that serves the chat (identity/accounts/limits.cjs servingLogin); none when it cannot be told
    codexLimits: (chatId) => {
      try {
        return live.identity?.driver('codex')?.chatLimits?.(live.controller.ref(chatId).key) ?? null;
      } catch (error) {
        noteIgnored('read the usage windows of the login serving a Codex chat', error);
        return null;
      }
    },
  }).follow(live.controller);
  const watch = new PanelWatch({ chatOf: (key) => live.controller.chatOf(key), push: (event) => panel.push(event) });
  // every harness's live events, for the chats a panel shows (session/controllerEvents.cjs)
  // a failure here is the panel's: the controller always goes on with the event
  // beside the others' (the orchestrator reads a linked session's edits, app/orchestration.cjs)
  addHook(live.controller, 'onLiveEvent', (family, e) => {
    try {
      watch.event(family, e);
    } catch (error) {
      noteIgnored('follow a chat for the Chrome side panel', error);
    }
    try {
      signals.event(family, e, (key) => live.controller.chatOf(key));
    } catch (error) {
      noteIgnored('read a usage warning for the Chrome side panel', error);
    }
    phones.live(family, e);
  });
  return Object.assign(panel, { forgetChat: phones.forget });
}

/** Where the saved projects are. */
const projectsFileOf = (userData) => path.join(userData, 'projects.json');

module.exports = { createChromePanel, projectsFileOf };
