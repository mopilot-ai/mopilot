// The Codex adapter's app-server messages: answers, server requests as cards, and notifications mapped to their chat.
const { identityKey } = require('../../shared/identityKey.mjs');
const { isInvalidStreamNotification } = require('../../shared/streamDelta.mjs');
const { RpcError } = require('./codexConnection.cjs');
const { CodexGoals } = require('./codexGoals.cjs');
const { requestThread, declineAnswer } = require('../capabilities/contract/serverRequests.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');
const { skyProblemOfItem } = require('../../shared/skyComputerUse.mjs');
const { segmentKey } = require('../platform/segmentOwner.cjs');

/** A compaction in a turn the user started by asking for it carries trigger 'manual'. */
function markManualCompaction(p, turns) {
  const mark = (it) => (it?.type === 'contextCompaction' && !it.trigger ? { ...it, trigger: 'manual' } : it);
  if (p.item && turns.has(p.turnId)) return { ...p, item: mark(p.item) };
  if (p.turn?.items?.length && turns.has(p.turn.id)) return { ...p, turn: { ...p.turn, items: p.turn.items.map(mark) } };
  return p;
}

/**
 * The cua_repl step that failed because MoPilot declined its approval carries `mopilotDeclined` with
 * why (`cleanupBlocked`: the plugin's last release had failed; `stopped`: its turn ended while the request
 * waited for a release), so the thread does not read it as the user's "no". `declined` maps
 * structured thread/turn keys to their owner and reason; the first such failed step of the turn takes its key.
 */
function markHostDeclined(method, p, declined) {
  const it = p.item;
  if (method !== 'item/completed' || it?.type !== 'mcpToolCall' || it.server !== 'cua_repl') return p;
  // A null turn marks a request the app-server could not tie to a turn.
  const key = [identityKey(p.threadId, p.turnId ?? null), identityKey(p.threadId, null)].find((k) => declined.has(k));
  if (!key || skyProblemOfItem(it)?.kind !== 'notApproved') return p;
  const { reason } = declined.get(key);
  declined.delete(key);
  return { ...p, item: { ...it, mopilotDeclined: reason } };
}

/** Server requests the windows show as cards; main answers all others (capabilities/contract/serverRequests.cjs). */
const isServerRequest = (msg) => msg && msg.method && msg.id != null;

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

class CodexEvents extends CodexGoals {
  /** @this {CodexAdapter} */
  onMessage(msg) {
    if (!msg) return;
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    const p = msg.params || {};
    if (msg.method === 'remoteControl/status/changed') return void this.remoteControl.onStatus(p);
    // a legacy approval names its thread `conversationId`
    const raw = (isServerRequest(msg) ? requestThread(p) : p.threadId) ?? p.thread?.id ?? null;
    if (raw && this.leases.has(raw)) this.leases.get(raw).at = this.now();
    if (isServerRequest(msg)) {
      // a helper thread never asks the user anything
      if (raw && this.hidden.has(raw)) return void this.respond(msg.id, declineAnswer(msg.method));
      // the next native operation after a stop waits for the plugin's release (only it, not the turn)
      const held =
        msg.method === 'mcpServer/elicitation/request' && p.serverName === 'cua_repl' && raw ? this.nativeLifecycle.pending(raw) : null;
      if (held) {
        // answered elsewhere (serverRequest/resolved) or its turn ended while it waited: it never surfaces as a card.
        // Its turn is the one the app-server names, else the thread's running turn.
        this.heldRequests.set(msg.id, { threadId: raw, turnId: p.turnId ?? this.turnOf.get(raw) ?? null });
        const live = () => this.heldRequests.delete(msg.id);
        this.nativeLifecycle.ready(held).then(
          () => live() && this.serverRequest(msg, raw),
          (e) => {
            if (!live()) return;
            this.respond(msg.id, { action: 'decline', content: null, _meta: null });
            // the step this declines reads as blocked by the failed release, not as the user's "no"
            this.hostDeclined.set(identityKey(raw, p.turnId ?? this.turnOf.get(raw) ?? null), { threadId: raw, reason: 'cleanupBlocked' });
            this.emit({ kind: 'toast', level: 'error', text: `Native browser and computer control is blocked: ${userError(e)}` }, 'any');
          },
        );
        return;
      }
      return void this.serverRequest(msg, raw);
    }
    if (isInvalidStreamNotification(msg.method, p)) return;
    if (msg.method === 'serverRequest/resolved') this.heldRequests.delete(p.requestId);
    if (msg.method === 'turn/completed' && raw) this.droppedWithTurn(raw, p.turn?.id ?? null);
    if (raw && this.hidden.has(raw)) return void this.hidden.get(raw).on(msg.method, p);
    if (raw && msg.method === 'item/started') this.turnChanges?.itemStarted(raw, p.item);
    this.turnCommands.observe(msg.method, p);
    this.nativeLifecycle.observe(msg);
    this.bookkeep(msg.method, p);
    this.backgroundWork.observe(msg.method, p);
    const out = this.mapped(msg.method, p);
    const connection = this.init;
    const sourceProcess = this.server.proc;
    const current = () => this.init === connection && this.server.proc === sourceProcess;
    const complete = () => {
      if (!current()) return;
      this.observe(msg);
      if (out) this.emit({ kind: 'notification', chatId: out.chatId, method: msg.method, params: out.params });
    };
    if (msg.method === 'turn/completed' && p.turn?.id && out && this.turnChanges) {
      this.turnChanges
        .finish(raw, p.turn.id, { checkpoint: true })
        .then((diff) => {
          if (current() && diff !== undefined)
            this.emit({
              kind: 'notification',
              chatId: out.chatId,
              method: 'turn/diff/updated',
              params: { threadId: out.params.threadId, turnId: p.turn.id, diff },
            });
        })
        // no diff for this turn; observe() still runs
        .catch((error) => noteIgnored("capture a Codex turn's changes", error))
        .finally(complete);
      // The controller starts the next queued turn when it observes completion.
      // Finish capturing before the next turn can write, then settle main before showing completion:
      // a follow-up sent after the UI says stopped must not queue behind the still-busy old turn.
      return;
    }
    if (msg.method === 'turn/completed') return complete();
    if (out) this.emit({ kind: 'notification', chatId: out.chatId, method: msg.method, params: out.params });
    this.observe(msg);
  }

  /**
   * A thread's turn ended: its earlier declined steps are no longer looked for, and each cua_repl request
   * still held for that turn is answered with a decline now (never left unanswered) whose step reads as
   * stopped with the turn. A request tied to no turn is not this turn's: it waits for its release.
   * @this {CodexAdapter}
   */
  droppedWithTurn(threadId, turnId) {
    for (const [key, owner] of this.hostDeclined) if (owner.threadId === threadId) this.hostDeclined.delete(key);
    if (turnId == null) return;
    for (const [id, h] of this.heldRequests) {
      if (h.threadId !== threadId || h.turnId !== turnId) continue;
      this.heldRequests.delete(id);
      this.respond(id, { action: 'decline', content: null, _meta: null });
      this.hostDeclined.set(identityKey(threadId, turnId), { threadId, reason: 'stopped' });
    }
  }

  /**
   * A server request the windows answer (an approval or input card).
   * @this {CodexAdapter}
   */
  serverRequest(msg, raw) {
    const chatId = raw ? this.chatOf(raw) : null;
    this.emit({ kind: 'request', chatId, request: { id: msg.id, method: msg.method, params: msg.params || {} } });
    this.observe(msg);
  }

  /**
   * What a notification changes here: leases, running turns, what Sage knows of a thread.
   * @this {CodexAdapter}
   */
  bookkeep(method, p) {
    switch (method) {
      case 'thread/started':
        // a prewarmed thread (codexPrewarm.cjs) is leased only once a send takes it
        if (p.thread?.id && !this.prewarmed.has(p.thread.id)) {
          this.meta.set(p.thread.id, p.thread);
          // started here means loaded here, holding its writer lock like a resumed one
          this.hold(p.thread.id, null);
        }
        break;
      case 'thread/closed':
        // unloaded (Sage let go of it, or the app-server did): the next open re-reads it from disk
        this.drop(p.threadId, 'closed');
        this.nativeLifecycle.forget(p.threadId);
        // one with no message yet is gone with it (codexUnrecorded.cjs)
        this.unrecorded.delete(p.threadId);
        break;
      case 'thread/name/updated': {
        const m = this.meta.get(p.threadId);
        if (m) m.name = p.threadName ?? p.name ?? null;
        break;
      }
      case 'turn/started':
        if (p.threadId) this.running.add(p.threadId);
        // its first message is recorded: the thread is on disk from here (a goal's turn names it only here)
        if (p.threadId) this.unrecorded.delete(p.threadId);
        if (p.threadId && p.turn?.id) this.turnOf.set(p.threadId, p.turn.id);
        // the app-server doesn't mark a compaction as the user's (X5): the turn after Sage asked is
        if (p.turn?.id && this.compacting.delete(p.threadId)) this.manualCompactions.add(p.turn.id);
        break;
      case 'thread/settings/updated':
        this.planChip(p.threadId, p.threadSettings?.collaborationMode);
        break;
      case 'turn/completed': {
        // A stopped turn may finish after its replacement started. Only its own completion
        // retires the active turn; unopened chats rely on this state to protect unread output.
        const active = this.turnOf.get(p.threadId);
        if (active && active !== p.turn?.id) break;
        if (p.threadId) this.running.delete(p.threadId);
        if (p.threadId) this.turnOf.delete(p.threadId);
        break;
      }
      case 'thread/goal/updated':
        this.noteGoal(p.threadId, p.goal ?? null);
        break;
      case 'thread/goal/cleared':
        this.noteGoal(p.threadId, null);
        break;
    }
  }

  /**
   * The chat's Plan chip follows the thread's collaboration mode (thread/settings/updated, resume).
   * @this {CodexAdapter}
   */
  planChip(threadId, mode) {
    if (!threadId || !mode?.mode || !this.state) return;
    const chatId = this.chatOf(threadId);
    if (this.state.has(chatId) && this.codexThread(chatId) === threadId) this.state.patch(chatId, { plan: mode.mode === 'plan' });
  }

  /**
   * A thread's background commands and running sub-agents (codexBackgroundWork.cjs), on its chat's session while it is
   * the chat's current thread, so every window knows of them without polling the chat. Only a chat main tracks (one a
   * turn ran in) gets it; a sub-agent's own thread is no chat.
   * @this {CodexAdapter}
   */
  publishWork(threadId, { shells, agents }) {
    const chatId = this.chatOf(threadId);
    if (!this.state?.has(chatId)) return;
    // the key the windows know the segment by (toRendererSegment), which their task source compares
    const key = segmentKey('codex', threadId);
    const current = this.showsWork(threadId);
    // a thread the chat switched away from only takes its own record down (the windows already hide it)
    if (!current && this.state.get(chatId).backgroundWork?.source.key !== key) return;
    const work = current && shells + agents ? { source: { kind: 'codex', key }, shells, agents } : null;
    this.state.patch(chatId, { backgroundWork: work });
  }

  /**
   * Whether a chat shows the thread's background work: the thread is the current segment of a chat main tracks.
   * @this {CodexAdapter}
   */
  showsWork(threadId) {
    const chatId = this.chatOf(threadId);
    const ref = this.state?.has(chatId) ? this.nativeOf?.(chatId) : null;
    return ref?.kind === 'codex' && ref.id === threadId;
  }

  /**
   * The notification as the windows get it: under its chat, or null when it isn't theirs.
   * @this {CodexAdapter}
   */
  mapped(method, p) {
    // a prewarmed thread no send took yet is no chat's: the windows never list it, nor hear it go (codexPrewarm.cjs)
    const warm = p.threadId ?? p.thread?.id;
    if (this.prewarmed.size && this.prewarmed.has(warm)) {
      if (method === 'thread/deleted' || method === 'thread/closed') this.prewarmed.delete(warm);
      return null;
    }
    if (this.manualCompactions.size) p = markManualCompaction(p, this.manualCompactions);
    if (this.hostDeclined.size) p = markHostDeclined(method, p, this.hostDeclined);
    if (this.turnCommands.stopping.size) p = this.turnCommands.markStopped(method, p);
    const raw = p.threadId ?? null;
    if (raw) {
      const chatId = this.chatOf(raw);
      if (method === 'thread/tokenUsage/updated') p = { ...p, tokenUsageSource: { harness: 'codex', nativeId: raw } };
      if (chatId !== raw && (method === 'thread/closed' || method === 'mcpServer/startupStatus/updated')) {
        p = { ...p, sourceThreadId: raw };
      }
      // a later segment's thread: its own name never becomes the chat's
      if (chatId !== raw && ['thread/name/updated', 'thread/deleted', 'thread/archived'].includes(method)) return null;
      return { chatId, params: chatId === raw ? p : { ...p, threadId: chatId } };
    }
    if (method === 'thread/started' && p.thread?.id) {
      if (this.chatOf(p.thread.id) !== p.thread.id) return null;
      return { chatId: p.thread.id, params: p };
    }
    return { chatId: null, params: p };
  }
}

module.exports = { CodexEvents };
