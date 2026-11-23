// Harness event interpretation on the shared ChatController owner: Codex, ACP and Claude turn, approval and task events.
const { clock } = require('../platform/ports/clock.cjs');
const { acpStateUpdate } = require('../../shared/acpSessionState.mjs');
const { leaveLinkedPlan } = require('./linkedPlan.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { ControllerNames } = require('./controllerNames.cjs');
const { claudeTurnOver } = require('../../shared/claudeTurnOver.mjs');
const { claudeResultFailed } = require('../../shared/claudeResult.mjs');
const { ownTable } = require('../../shared/ownTable.mjs');
const { contentBlocks, normalizeContentBlock } = require('../../shared/contentBlocks.mjs');
const crypto = require('node:crypto');
const { acpFormCardId } = require('../../shared/panelCardIds.mjs');
const { RENDERER_METHODS, requestThread } = require('../capabilities/contract/serverRequests.cjs');
const { provisionalTitle } = require('../../shared/title.mjs');
const { acpStop, isLimitError, stopErrorText } = require('../../shared/acpStop.mjs');
const { followCodexReadState } = require('../harness/codexReadState.cjs');
const { codexCompaction, claudeCompaction } = require('../harness/compactionSignals.cjs');
const { observeCompaction, retireCompaction } = require('./compactionQueue.cjs');
const { noteTurnProgress, codexProgress, claudeProgress } = require('./turnProgress.cjs');
const { turnSource } = require('./controllerSwitch.cjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */

const LABEL = ownTable({ codex: 'Codex', claude: 'Claude Code' });
/** What a chat says when its harness quits mid-turn (design copy: "harness 中途退出"). */
const crashText = (kind) => `${LABEL[kind] ?? kind} quit while working. Pending approvals were cancelled · Your queued messages are kept`;

const busy = (s) => s.turn === 'running' || s.turn === 'awaitingUser';
// A background agent may ask after its root turn ended; its approval still needs teardown.
const needsCrashCleanup = (s) => busy(s) || s.approvals.length > 0;
const pending = (s) => !!s.activeTurn && String(s.activeTurn.id).startsWith('pending-');
/** The text of a user message's content blocks. @param {{ content?: unknown }} user */
const textOfUser = (user) =>
  (Array.isArray(user.content) ? user.content : []).map((/** @type {any} */ b) => (typeof b?.text === 'string' ? b.text : '')).join('');
/** The source a Codex app-server event names: every Codex chat, whichever thread. */
const CODEX_SOURCE = Object.freeze({ kind: 'codex' });

// This layer owns no state: every event uses the controller instance and its current session/turn.
class ControllerEvents extends ControllerNames {
  /**
   * What a turn's notification says: the harness's note when it gave one (a reply cut off, a usage limit), else for a
   * finished turn its last words, else "Task complete"; a failed turn says it failed, with its cause when it had one
   * (never the agent's last words, which read as a success).
   * @param {string | null | undefined} text
   * @param {string} outcome
   * @param {string | null} [summary]
   * @param {string | null} [error] the failure's text
   */
  endBody(text, outcome, summary = null, error = null) {
    if (summary) return summary;
    if (outcome === 'completed') return text || 'Task complete';
    const why = String(error ?? '').trim();
    return why ? `The turn ended with an error: ${why}` : 'The turn ended with an error';
  }
  /* -- Codex events (app-server messages, as main sees them) ---------- */
  /** @this {ChatController} */
  onCodexMessage(msg) {
    if (!msg || !msg.method) return;
    const p = msg.params || {};
    // a reader of chats' live activity (Chrome's side panel, app/chromePanel.cjs) sees each notification first
    if (msg.id == null) /** @type {{ onLiveEvent?: (family: string, e: any) => void }} */ (this).onLiveEvent?.('codex', msg);
    // thread/started, a spawn item or a sub-agent's activity names a sub-agent's parent, so what it asks reaches the chat
    this.parents.observe(msg);
    if (msg.id != null) {
      const thread = requestThread(p);
      // answered or withdrawn already (a request held for the plugin's release can arrive late): no card
      if (this.resolvedRequests.has(msg.id)) return;
      if (RENDERER_METHODS.has(msg.method) && thread) {
        const chatId = this.requestChat(thread);
        if (this.state.has(chatId)) this.addApproval(chatId, { id: msg.id, method: msg.method, params: p, source: { kind: 'codex' } });
      }
      return;
    }
    if (msg.method === 'serverRequest/resolved') {
      this.resolvedRequests.add(p.requestId);
      if (this.resolvedRequests.size > 500) this.resolvedRequests.delete(this.resolvedRequests.values().next().value);
      return void this.resolveApproval(p.requestId);
    }
    if (msg.method === 'thread/readState/changed') return void followCodexReadState(this, p);
    observeCompaction(this, codexCompaction(msg));
    if (codexProgress(msg.method) && p.threadId) {
      const chat = this.chatOf(p.threadId);
      if (this.state.has(chat) && turnSource(this, chat, { kind: 'codex', key: p.threadId })) noteTurnProgress(this.state, chat);
    }
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && p.threadId) {
      const text = String(p.item.text ?? '').trim();
      const chat = this.chatOf(p.threadId);
      if (!this.state.has(chat) || !turnSource(this, chat, { kind: 'codex', key: p.threadId })) return;
      const s = this.state.get(chat);
      if (text && busy(s) && (!p.turnId || pending(s) || s.activeTurn?.id === p.turnId) && p.item.phase !== 'commentary')
        this.rt(chat).lastText = text;
    }
    if (msg.method !== 'turn/started' && msg.method !== 'turn/completed') return;
    const chatId = this.chatOf(p.threadId);
    // only chats a window opened or sent to; hidden helper threads (titles) never are
    if (!p.threadId || !this.state.has(chatId) || !turnSource(this, chatId, { kind: 'codex', key: p.threadId })) return;
    const s = this.state.get(chatId);
    const r = this.rt(chatId);
    const id = p.turn?.id ?? null;
    if (msg.method === 'turn/started') {
      clock.clearTimeout(r.grace);
      if (pending(s)) return void this.nameTurn(chatId, id);
      // turn/start's answer named it first: this is the turn the user started, not one the harness began
      if (s.activeTurn && s.activeTurn.id === id) return;
      retireCompaction(this, chatId);
      // a turn the harness started itself (a goal's next round, an automation): no one is watching it
      r.token = id;
      this.state.step(chatId, 'start', { turnId: id });
      return;
    }
    // a native stop already ended this turn here (codexStopped): its late completion must not end the next one
    if (id && r.stopped === id) return void (r.stopped = null);
    if (!busy(s)) return;
    if (!pending(s) && id && s.activeTurn?.id !== id) return;
    if (p.turn?.status === 'interrupted') r.interrupted = true;
    // rateLimitExceeded is a pause, not an end of quota: only the toast says it
    else if (p.turn?.error?.codexErrorInfo === 'usageLimitExceeded') this.onLimit(chatId);
    this.end(chatId, { outcome: p.turn?.status === 'completed' ? 'completed' : 'failed' });
  }

  /**
   * The app-server accepted the stop of a native Codex turn (CodexAdapter.interruptNative): the chat is
   * idle now, while the plugin releases the browser or computer in the background. Its turn/completed
   * arrives later and is then ignored.
   */
  /** @this {ChatController} */
  codexStopped(chatId, turnId) {
    if (!this.state.has(chatId) || !this.isCurrentSource(chatId, { kind: 'codex' })) return;
    const s = this.state.get(chatId);
    if (!busy(s) || s.activeTurn?.id !== turnId) return;
    const r = this.rt(chatId);
    r.interrupted = true;
    this.end(chatId, { outcome: 'failed' });
    r.stopped = turnId;
  }

  /**
   * A window's answer to a Codex server request. True to send it: only a card main holds for the current app-server,
   * taken once. False for anything else (a second window's answer, a card withdrawn or answered, or one from an
   * app-server that has since restarted and may reuse the id for a new request): the answer is never sent.
   */
  /** @this {ChatController} */
  onCodexOutgoing(msg) {
    if (!msg || msg.id == null) return false;
    return this.takeApproval(msg.id, 'codex');
  }

  /**
   * A window's answer to a card `kind` raised: true when main still holds that card for that harness, and it is
   * taken now (once). The id a card was drawn with is a claim, not proof: answered elsewhere, withdrawn, or raised
   * by a process that has since restarted (Codex numbers its requests from 0 again), it is retired.
   */
  /** @this {ChatController} */
  takeApproval(id, kind) {
    for (const chatId of this.state.all()) {
      if (this.rt(chatId).approvalOwners.get(id)?.kind !== kind) continue;
      const s = this.state.get(chatId);
      if (!s.approvals.some((x) => x.id === id)) continue;
      const approvals = s.approvals.filter((x) => x.id !== id);
      this.setApprovals(chatId, approvals);
      return true;
    }
    return false;
  }

  /**
   * The app-server went away: every Codex chat mid-turn crashes, and an active goal is paused so it
   * doesn't carry on by itself once Codex is back. Returns the native threads whose goal it paused.
   */
  /** @this {ChatController} */
  onCodexExit() {
    // the next app-server numbers its requests from the start again: ids seen so far name nothing
    this.resolvedRequests.clear();
    const paused = [];
    for (const chatId of this.state.all()) {
      // a chat on another harness (or a kind this build doesn't know) loses only the cards Codex raised
      if (!this.isCurrentSource(chatId, CODEX_SOURCE)) {
        this.clearSourceApprovals(chatId, CODEX_SOURCE);
        continue;
      }
      const ref = this.ref(chatId);
      retireCompaction(this, chatId);
      const { goal } = this.state.get(chatId);
      if (goal?.status === 'active') {
        this.state.patch(chatId, { goal: { ...goal, status: 'paused' } });
        paused.push(ref.id);
      }
      // a chat switching away from Codex keeps its start's turn for the new harness, and loses only Codex's cards
      if (turnSource(this, chatId, CODEX_SOURCE)) this.crash(chatId, crashText('codex'), CODEX_SOURCE);
      else this.clearSourceApprovals(chatId, CODEX_SOURCE);
    }
    return paused;
  }

  /** @this {ChatController} */
  onAcpEvent(e) {
    if (!e || !e.key) return;
    /** @type {{ onLiveEvent?: (family: string, e: any) => void }} */ (this).onLiveEvent?.('acp', e);
    const chatId = this.chatOf(e.key);
    // the name the harness (or a machine's Host) gave the chat: its notifications carry it, as a Codex chat's carry its name
    if (e.kind === 'threadName') return void this.rememberName(chatId, e.name);
    this.learnSavedName(chatId);
    if (e.kind === 'question') {
      if (!this.isCurrentSource(chatId, { kind: 'acp', key: e.key })) {
        if (e.question.status === 'pending') {
          const owner = this.acp?.questions.owner(chatId, e.question.id);
          if (owner) this.acp.questions.retire(owner.chat);
        } else if (this.state.has(chatId)) {
          // A retired segment may settle its own old card, never replace a newer segment's cards.
          const questions = this.state.get(chatId).questions.map((q) => (q.id === e.question.id ? e.question : q));
          this.state.patch(chatId, { questions });
        }
        return;
      }
      this.state.patch(chatId, { questions: e.questions });
      if (e.question.status === 'pending')
        this.say('approval', chatId, { title: `${e.question.harness} needs input`, body: '', cardId: acpFormCardId(e.question.id) });
      return;
    }
    if (!this.state.has(chatId)) return;
    const s = this.state.get(chatId);
    const r = this.rt(chatId);
    switch (e.kind) {
      case 'turnStart':
        // a chat nobody has named yet is known by its first words, as a local chat's notification does (a Host's name arrives after the first turn)
        if (e.user) this.rememberName(chatId, provisionalTitle(textOfUser(e.user)), true);
        if (!turnSource(this, chatId, { kind: 'acp', key: e.key })) return;
        this.turnSnapshots?.begin(chatId, e.key, e.cwd, e.turnId);
        r.token = e.turnId;
        if (pending(s) && s.activeTurn.compact)
          return void this.state.patch(chatId, { turn: 'running', activeTurn: { ...s.activeTurn, id: e.turnId } });
        return void this.state.step(chatId, 'start', { turnId: e.turnId, human: !!e.human });
      case 'turnEnd': {
        if (!turnSource(this, chatId, { kind: 'acp', key: e.key })) return;
        if (!busy(s)) return;
        if (e.turnId && !pending(s) && s.activeTurn?.id !== e.turnId) return;
        if (e.stopReason === 'cancelled') r.interrupted = true;
        // as the chat reads it (shared/acpStop.mjs): a cut-off reply is complete, with a note the notification repeats
        const stop = acpStop(e.stopReason, stopErrorText(e.error));
        // a chat on a machine ran out on that machine's account: going on by itself would pick a harness by this Mac's logins
        if (e.stopReason !== 'cancelled' && !e.onMachine && isLimitError(e.error)) this.onLimit(chatId);
        return void this.end(chatId, {
          outcome: stop.status === 'completed' && !stop.error ? 'completed' : 'failed',
          summary: stop.note?.text ?? null,
          error: stop.error,
        });
      }
      case 'permission':
        return void this.addApproval(chatId, {
          id: e.requestId,
          method: 'acp/permission',
          source: { kind: 'acp', key: e.key },
          params: { toolCall: e.toolCall ?? null, options: e.options ?? [] },
        });
      case 'permissionCancelled':
        return void this.resolveApproval(e.requestId, chatId);
      // the harness worked with no prompt running and was cancelled: that session's MoPilot calls stop too (#1319 G18)
      case 'unattended':
        return void this.onInterrupt(chatId, e.key);
      case 'closed':
        if (!turnSource(this, chatId, { kind: 'acp', key: e.key }))
          return void this.clearSourceApprovals(chatId, { kind: 'acp', key: e.key });
        return void this.crash(chatId, e.error ?? 'The harness exited', { kind: 'acp', key: e.key });
      case 'session': {
        if (!this.isCurrentSource(chatId, { kind: 'acp', key: e.key })) return;
        const next = {
          modes: e.modes ?? null,
          configOptions: e.configOptions ?? null,
          commands: e.switched || e.fresh ? (e.commands ?? null) : (e.commands ?? s.acp?.commands ?? null),
          usage: e.switched || e.fresh ? (e.usage ?? null) : (e.usage ?? s.acp?.usage ?? null),
          anchors: e.anchors ?? {},
          ...(typeof e.caps?.audio === 'boolean' ? { audio: e.caps.audio } : {}),
        };
        // An activated segment starts on its own mode, not a Plan chip derived from the prior ACP owner.
        if (e.switched) return void this.state.patch(chatId, { acp: next, plan: acpPlanOn(next, this.acpPlan(this.ref(chatId).kind)) });
        return void this.patchAcp(chatId, next);
      }
      case 'state':
        if (!this.isCurrentSource(chatId, { kind: 'acp', key: e.key })) return;
        return void this.patchAcp(chatId, { ...(s.acp ?? { modes: null, configOptions: null, commands: null, usage: null }), ...e.state });
      case 'update': {
        if (!this.isCurrentSource(chatId, { kind: 'acp', key: e.key })) return;
        this.turnSnapshots?.acpUpdate(chatId, e.key, e.update);
        const next = acpStateUpdate(s.acp, e.update);
        // the session's catalog, mode or usage changing is not the turn moving
        // a session a switch is leaving neither moves nor writes the switching start's turn
        const ours = turnSource(this, chatId, { kind: 'acp', key: e.key });
        if (!next && ours) noteTurnProgress(this.state, chatId);
        if (
          ours &&
          e.update?.sessionUpdate === 'agent_message_chunk' &&
          e.update.content?.type === 'text' &&
          busy(s) &&
          (!e.turnId || e.turnId === s.activeTurn?.id)
        ) {
          // a replacement (a Host chat's whole message after a lost delta) takes the place of the text it names
          const kept = r.lastText ?? '';
          const before =
            typeof e.replaces === 'string' && kept.endsWith(e.replaces) ? kept.slice(0, kept.length - e.replaces.length) : kept;
          r.lastText = before + String(normalizeContentBlock(e.update.content)?.text ?? '');
        }
        if (next) this.patchAcp(chatId, next);
        return;
      }
    }
  }

  /** The chat's acp state, and the Plan chip: on while the mode or config value the quirks mark as plan is the current one. */
  /** @this {ChatController} */
  patchAcp(chatId, next) {
    const s = this.state.get(chatId);
    const marker = this.acpPlan(this.ref(chatId).kind);
    const before = acpPlanOn(s.acp, marker);
    const after = acpPlanOn(next, marker);
    // only a change in that mode or value moves the chip, so a turn's usage update can't undo a toggle in flight
    this.state.patch(chatId, before !== after ? { acp: next, plan: after } : { acp: next });
  }

  /** @this {ChatController} */
  onClaudeControl(key, method) {
    if (method !== 'interrupt') return;
    const chatId = this.chatOf(key);
    if (!this.isCurrentSource(chatId, { kind: 'claude', key })) return;
    const r = this.rt(chatId);
    r.interrupted = true;
    this.noteStop(chatId);
    // the CLI drops queued prompts on interrupt, so the next result ends the turn
    r.outstanding = Math.min(r.outstanding, 1);
  }

  /** @this {ChatController} */
  onClaudeEvent(e) {
    if (!e || !e.key) return;
    /** @type {{ onLiveEvent?: (family: string, e: any) => void }} */ (this).onLiveEvent?.('claude', e);
    const chatId = this.chatOf(e.key);
    if (e.kind === 'threadName') return void this.rememberName(chatId, e.name);
    // An active native compaction may establish its own hold; other events remain passive until registration.
    if (!e.msg?.parent_tool_use_id) observeCompaction(this, claudeCompaction(e));
    if (!this.state.has(chatId)) return;
    const s = this.state.get(chatId);
    const r = this.rt(chatId);
    switch (e.kind) {
      case 'message': {
        const m = e.msg || {};
        // a sub-agent's tool calls write to the same folder
        this.turnSnapshots?.claudeMessage(chatId, e.key, m);
        const ours = turnSource(this, chatId, { kind: 'claude', key: e.key });
        if (claudeProgress(m) && ours) noteTurnProgress(this.state, chatId);
        if (m.parent_tool_use_id) return void noteSubagentCalls(r, m);
        if (!this.isCurrentSource(chatId, { kind: 'claude', key: e.key })) return;
        if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          const text = contentBlocks(m.message.content)
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
          if (text && ours) r.lastText = text;
        }
        if (m.type === 'system' && m.subtype === 'init' && m.permissionMode)
          this.state.patch(chatId, {
            permission: m.permissionMode,
            ...(m.permissionMode === 'plan' && this.chats.records.get(chatId)?.meta?.config?.permission === 'plan' ? { plan: true } : {}),
          });
        // a mode change (setPermissionMode, EnterPlanMode, an approved plan): plan follows what Claude reports
        if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) {
          try {
            leaveLinkedPlan(this.chats, chatId, m.permissionMode);
          } catch (error) {
            noteIgnored('save a linked chat leaving plan mode', error);
          }
          this.state.patch(chatId, { permission: m.permissionMode, plan: m.permissionMode === 'plan' });
        }
        // a session a switch is leaving neither starts nor ends the chat's turn
        if (!ours) return;
        // the CLI's own turn-over signal: a steer it folds into the running loop gets no result of its own (#1834)
        if (m.type === 'system' && m.subtype === 'session_state_changed')
          return void (claudeTurnOver(r, m.state, r.token) && busy(s) && this.end(chatId));
        if (m.type === 'result') {
          if (!busy(s)) return;
          // a result whose only errors are the CLI's diagnostics (a steered prompt's leftover) ends its prompt as a success does
          const failed = claudeResultFailed(m);
          if (--r.outstanding > 0 && !r.interrupted && (m.subtype === 'success' || !failed)) return;
          if (m.subtype === 'success' && !m.is_error && typeof m.result === 'string') r.lastText = m.result;
          return void this.end(chatId, { outcome: failed ? 'failed' : 'completed' });
        }
        // Claude Code started work on its own (a background task finished)
        const starts = m.type === 'assistant' || (m.type === 'stream_event' && m.event?.type === 'message_start');
        if (starts && !busy(s)) {
          retireCompaction(this, chatId);
          r.outstanding = 1;
          r.interrupted = false;
          r.token = `auto-${crypto.randomUUID()}`;
          // the CLI is already running for it: its 'idle' ends this turn too (claudeTurnOver)
          r.cliRanFor = r.token;
          this.state.step(chatId, 'start', { turnId: r.token });
        }
        return;
      }
      case 'permission':
        // all of the CLI's request: every window builds the same card from it (src/harness/approvalRequests.ts)
        return void this.addApproval(chatId, {
          id: e.requestId,
          method: 'claude/permission',
          source: { kind: 'claude', key: e.key },
          params: {
            toolName: e.toolName,
            input: e.input,
            title: e.title ?? null,
            displayName: e.displayName ?? null,
            toolUseID: e.toolUseID ?? null,
            agentID: e.agentID ?? null,
            suggestions: e.suggestions ?? null,
            blockedPath: e.blockedPath ?? null,
            description: e.description ?? null,
            decisionReason: e.decisionReason ?? null,
          },
        });
      case 'elicitation':
        return void this.addApproval(chatId, {
          id: e.requestId,
          method: 'mcpServer/elicitation/request',
          source: { kind: 'claude', key: e.key },
          params: {
            serverName: e.serverName,
            message: e.title ? `${e.title}: ${e.message}` : e.message,
            mode: e.mode,
            url: e.url ?? null,
            requestedSchema: e.requestedSchema ?? null,
            elicitationId: e.elicitationId ?? null,
            displayName: e.displayName ?? null,
            description: e.description ?? null,
            claude: true,
          },
        });
      case 'permissionCancelled':
        return void this.resolveApproval(e.requestId, chatId);
      case 'tasks':
        // finished tasks stay listed across the session's processes (electron/harness/claude/tasks.cjs)
        return void this.updateSourceTasks(chatId, e.key, e.tasks);
      case 'processStarted':
        if (this.isCurrentSource(chatId, { kind: 'claude', key: e.key })) retireCompaction(this, chatId);
        return;
      case 'settings':
        if (!this.isCurrentSource(chatId, { kind: 'claude', key: e.key })) return;
        return void this.state.patch(chatId, { ultracode: { on: !!e.ultracode, available: !!e.available, probe: e.probe ?? 'ok' } });
      case 'remoteControl':
        if (!this.isCurrentSource(chatId, { kind: 'claude', key: e.key })) return;
        return void this.state.patch(chatId, {
          remoteControl: { state: e.state, url: e.url ?? null, error: e.error ?? null, wanted: !!e.wanted },
        });
      case 'closed':
      case 'error':
        // the process is gone, and its background tasks with it: they stay listed as stopped
        this.updateSourceTasks(chatId, e.key, null);
        if (!turnSource(this, chatId, { kind: 'claude', key: e.key }))
          return void this.clearSourceApprovals(chatId, { kind: 'claude', key: e.key });
        retireCompaction(this, chatId);
        if (!needsCrashCleanup(s)) return;
        if (r.interrupted) return void this.end(chatId, { drain: false });
        // a goal that was running is held for Resume; the error itself is shown by the window (src/harness/claude.ts)
        this.claudeTurns.crashed(chatId);
        return void this.crash(chatId, crashText('claude'), { kind: 'claude', key: e.key });
    }
  }
}

const SUBAGENT_CALLS_MAX = 500;
/** Remembers the tool_use ids a sub-agent's message carries (it has a parent_tool_use_id), so a tool call can be told apart. */
function noteSubagentCalls(r, m) {
  const calls = r.subagentCalls;
  if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) return;
  for (const b of m.message.content) if (b?.type === 'tool_use' && b.id) calls.add(b.id);
  while (calls.size > SUBAGENT_CALLS_MAX) calls.delete(calls.values().next().value);
}

/** Whether the basic harness is in the mode, or has the config value, its quirks mark as plan. */
function acpPlanOn(acp, marker) {
  if (!marker || !acp) return false;
  if (typeof marker.mode === 'string') return acp.modes?.currentModeId === marker.mode;
  if (typeof marker.configOption === 'string')
    return (acp.configOptions ?? []).find((o) => o.id === marker.configOption)?.currentValue === marker.value;
  return false;
}

module.exports = { ControllerEvents, LABEL, crashText, busy, needsCrashCleanup, pending, noteSubagentCalls, acpPlanOn, acpStateUpdate };
