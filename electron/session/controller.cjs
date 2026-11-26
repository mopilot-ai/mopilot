// ChatController: the one place a chat's messages are sent from (design principles[5], arch F01).
// It resolves the chat's current segment (NativeRef) from the v2 chat files, settles a pending
// harness switch first, owns the send queue (each item keeps its full SendOptions, #50), and runs
// the turn state machine (idle, running, awaitingUser, crashed) from the harnesses' own events.
// Every window sends through it, so two windows on one chat queue once and send once.
//
// Codex turns run here through the Codex adapter (electron/harness/codex.cjs), Claude turns through
// the Claude adapter (electron/harness/claude/adapter.cjs), which builds the message from what was typed and
// attached (electron/harness/claude/message.cjs) and sends it through `claudeSend` (controllerSends.cjs), and ACP turns
// through electron/harness/acpTurns.cjs (`acpSend` below). So all of them start with no window open,
// and so does a harness switch: electron/session/switch.cjs settles it and writes the handoff record.
const { clock } = require('../platform/ports/clock.cjs');
const { observe } = require('../../shared/observations.cjs');
const { CodexThreadParents } = require('../capabilities/contract/codexParents.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { toRendererSegment, nativeIdsOf } = require('../platform/chats.cjs');
const { segmentAliases } = require('../../shared/segmentAlias.mjs');
const { RENDERER_METHODS, requestThread } = require('../capabilities/contract/serverRequests.cjs');
const { readImage } = require('../harness/claude/message.cjs');
const { mergeTaskLists, settleTaskList } = require('../harness/claude/tasks.cjs');
const { familyOf, byFamily, matchesSource } = require('./contract/route.cjs');
const { traitsOf } = require('../harness/family.cjs');
const { noteIgnored, ignoring } = require('../ignored.cjs');
const { queueItem } = require('./queueItem.cjs');
const { inputIsGuarded } = require('./contract/inputGuard.cjs');
const { endedTurn } = require('./userTurn.cjs');
const { completePromptSuggestion } = require('./promptSuggestions.cjs');
const { activeCompaction, retireCompaction, guardCompaction, suspendCompactionStart } = require('./compactionQueue.cjs');
const { ControllerApprovals } = require('./controllerApprovals.cjs');
const { folderMutation } = require('./folderMutation.cjs');
const { settleSwitch } = require('./controllerSwitch.cjs');
const {
  LABEL,
  crashText,
  busy,
  needsCrashCleanup,
  pending,
  noteSubagentCalls,
  acpPlanOn,
  acpStateUpdate,
} = require('./controllerEvents.cjs');

/** How long a Codex turn may stay unnamed after turn/start returned before it counts as not started. */
const START_GRACE_MS = 15_000;

/**
 * Stop, by the family of the chat's current segment. Codex interrupts in main, Claude Code interrupts and pauses the goal
 * MoPilot holds, ACP cancels the prompt (acpCancel lets go of the chat's tool calls itself).
 * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (c: ChatController, chatId: string, ref: { key: string }) => Promise<boolean | 'pending'>>}
 */
const STOP = {
  codex: async (c, chatId) => {
    // a turn still starting has no Codex turn to interrupt: its turn/start is not sent (stopGuard)
    c.noteStop(chatId);
    c.interrupting(chatId);
    return c.codex.stopTurn(chatId);
  },
  claude: async (c, chatId) => {
    c.interrupting(chatId);
    await c.claudeTurns.stop(chatId);
    return true;
  },
  acp: async (c, _chatId, ref) => {
    await c.acpCancel(ref.key);
    return true;
  },
};

/**
 * The thread whose chat a request from `thread` is shown in: up its spawn chain, stopping at a thread that is a chat
 * (or a segment of one), whatever spawned it.
 * @param {{ parents: { parentOf(id: string): string | null }, chats: { records: Map<string, unknown> }, chatOf(key: string): string }} ctl
 * @param {string} thread
 */
function requestThreadOf(ctl, thread) {
  let key = thread;
  for (let parent = ctl.parents.parentOf(key); parent && !ctl.chats.records.has(key) && ctl.chatOf(key) === key; )
    [key, parent] = [parent, ctl.parents.parentOf(parent)];
  return key;
}

class ChatController extends ControllerApprovals {
  /**
   * @param {object} o
   * @param o.state SessionStore (electron/session/state.cjs)
   * @param o.chats ChatsStore (electron/platform/chats.cjs): record(id), records
   * @param o.codex the Codex adapter: startTurn, steer, startGoal (chatId, ref, item, origin) => Promise<{started, turnId?}>
   * @param o.claudeTurns the Claude adapter: startTurn, steer, stop, crashed (electron/harness/claude/adapter.cjs)
   * @param o.acpTurns the ACP turn start: startTurn (electron/harness/acpTurns.cjs)
   * @param o.switcher electron/session/switch.cjs: `perform(chatId, pendingSwitch, origin)` settles a switch
   *   ({ready, prefix?, note?, after?}): the new segment and the handoff record
   * @param o.claude - { send(key, opts, message, priority, meta) }
   * @param [o.acp] - { send(key, payload, meta) } (electron/harness/acp.cjs)
   * @param [o.remote] - { stop(chatId, turnId) => Promise | null, owns?(chatId) => boolean }: Stop for a chat on another machine, and whether a chat runs on one, so its queue is never drained here (electron/host/remoteSend.cjs); null for a chat that runs here
   * @param [o.onCrash] (chatId) => void: the chat's harness quit mid-turn
   * @param [o.onSkipped] (chatId) => void: a scheduled run was skipped because it needed approval
   * @param [o.notify] (kind, chatId, opts) => void: the main Notifier
   * @param [o.retract] (chatId) => void: the chat's approval notification is answered
   * @param [o.chatTitle] (chatId) => string | null: the chat's name
   * @param [o.viewing] (chatId) => boolean: a focused window is showing the chat
   * @param [o.labelOf] (kind) => string: a harness's name
   * @param [o.acpPlan] (kind) => what a basic harness's quirks mark as plan
   * @param [o.killed] (kind, chatId) => string | null: why the harness is switched off remotely, or the chat held (MoMo at its limit)
   * @param [o.graceMs] how long a Codex turn may stay unnamed before it counts as not started
   * @param [o.beforeDispatch] shared delivery hook: runs before the native call
   * @param [o.onDispatchResult] shared delivery hook: observes the native call's result
   * @param [o.onStopped] (chatId) => void: a stop was accepted
   * @param [o.onInterrupt] (chatId, segmentId?) => void: the chat's turn (or one ACP segment's) is stopped: let go of its calls now
   * @param [o.onFinished] ({chatId}) => void: a turn finished
   * @param [o.onLimit] (chatId) => void: the running turn is ending on its harness's usage limit (before onFinished)
   * @param [o.parents] the Codex sub-agent map main shares with the tool injection and the plugin lifecycle
   *   (capabilities/contract/codexParents.cjs)
   * @param [o.readImage] (file) => Promise<API image source | null>: how a Claude message's images are read
   *   (electron/harness/claude/message.cjs readImage)
   */
  constructor(o) {
    super();
    this.state = o.state;
    /** @type {any} Durable audio retained before queue admission. */
    this.audioPending = null;
    this.chats = o.chats;
    this.codex = o.codex;
    this.switcher = o.switcher;
    this.claudeTurns = o.claudeTurns;
    this.acpTurns = o.acpTurns;
    /** @type {InstanceType<typeof import('./turnSnapshots.cjs').TurnSnapshots> | null} what Claude and ACP turns change */
    this.turnSnapshots = null;
    /** (chatId) => void: the chat's harness quit mid-turn; stop what it started (tool calls) */
    this.onCrash =
      o.onCrash ??
      (() => {
        /* no crash hook */
      });
    this.onSkipped =
      o.onSkipped ??
      (() => {
        /* no skip hook */
      });
    /** (kind, chatId, opts) => void: the main Notifier (electron/platform/notify.cjs); a turn ending or an approval waiting notifies from here, window or not */
    this.notify =
      o.notify ??
      (() => {
        /* no notifier */
      });
    /** (chatId) => string | null: the chat's name; (chatId) => boolean: a focused window is showing the chat; (kind) => string: a harness's name */
    /** (chatId) => void: the chat's approval notification is answered; it stops holding back later ones */
    this.retract =
      o.retract ??
      (() => {
        /* no notifier to retract from */
      });
    this.chatTitle = (chatId) => o.chatTitle?.(chatId) || /** @type {any} */ (this).names?.get(chatId) || null;
    this.viewing = o.viewing ?? (() => false);
    this.labelOf = o.labelOf ?? ((kind) => LABEL[kind] ?? String(kind));
    this.claude = o.claude;
    this.readImage = o.readImage ?? readImage;
    this.acp = o.acp ?? null;
    /** (chatId, turnId) => Promise | null: a chat that runs on another machine stops there (Stop reaches its Host); null for a chat that runs here */
    this.remote = o.remote ?? { stop: () => null, owns: () => false };
    /** (kind) => {mode} | {configOption, value} | null: what a basic harness's quirks mark as plan (WP6-5) */
    this.acpPlan = o.acpPlan ?? (() => null);
    /** (kind) => string | null: why the harness is switched off remotely (flags.cjs), so no turn starts on it */
    this.killed = o.killed ?? (() => null);
    this.graceMs = o.graceMs ?? START_GRACE_MS;
    // Journal before native dispatch; observe results even when the native turn already finished.
    this.beforeDispatch = o.beforeDispatch ?? null;
    this.chromeContinuationCheck = null;
    this.onDispatchResult = o.onDispatchResult ?? null;
    this.onStopped =
      o.onStopped ??
      (() => {
        /* no stop hook */
      });
    this.onFinished =
      o.onFinished ??
      (() => {
        /* no finish hook */
      });
    this.onLimit = o.onLimit ?? (() => undefined);
    this.onInterrupt =
      o.onInterrupt ??
      (() => {
        /* no interrupt hook */
      });
    /** per chat: the dispatch in flight, Claude's prompts still waiting for a result, interrupted */
    this.rts = new Map();
    this.alias = null;
    /** native session key → chat, for a session a switch is starting before its segment is committed */
    this.claims = new Map();
    /**
     * sub-agent thread id → the thread that spawned it, from every signal Codex sends (thread/started, spawn
     * items, sub-agent activity), so what a sub-agent asks reaches the chat; shared with the tool injection
     * and the plugin lifecycle
     */
    this.parents = o.parents ?? new CodexThreadParents();
    /** Codex server requests the app-server reported resolved: a late copy of one never becomes a card */
    this.resolvedRequests = new Set();
  }

  rt(chatId) {
    let r = this.rts.get(chatId);
    if (!r) {
      r = {
        token: null,
        inputToken: null,
        outstanding: 0,
        interrupted: false,
        grace: null,
        subagentCalls: new Set(),
        approvalOwners: new Map(),
        taskOwners: new Map(),
        lastText: null,
        steering: 0,
        afterSteer: null,
        /** the latest Claude send still reading its images: the next one waits for it to reach claude.send */
        claudeSending: null,
      };
      this.rts.set(chatId, r);
    }
    return r;
  }

  /** Whether a tool call (its tool_use id) was made by a Claude sub-agent, not the main agent. */
  isSubagentCall(chatId, callId) {
    return !!callId && !!this.rts.get(chatId)?.subagentCalls?.has(callId);
  }

  /* -- NativeRef ---------------------------------------------------- */
  /** The native session the chat's next message goes to: its last segment. */
  ref(chatId) {
    const rec = this.chats.record(chatId);
    const seg = rec.segments[rec.segments.length - 1];
    familyOf(seg.kind);
    return { kind: seg.kind, id: seg.nativeId, instance: seg.instance ?? null, key: toRendererSegment(seg).nativeId };
  }
  /** The chat a native session (by its window-side key) belongs to. */
  chatOf(key) {
    // a switch's session belongs to the chat that switched, even when a record keyed by its id exists (segmentAliases)
    this.alias ??= segmentAliases(nativeIdsOf(this.chats.records));
    return this.alias.get(key) ?? this.claims.get(key) ?? key;
  }
  /**
   * A switch is starting `key` for the chat: until its segment is committed, chatOf already answers the chat,
   * so what the session sends while it starts (its lease, thread/started, its first events) is the chat's.
   */
  claim(key, chatId) {
    this.claims.set(key, chatId);
  }
  /** The switch committed the segment (chatOf reads it from there now) or gave up. */
  unclaim(key, chatId) {
    if (this.claims.get(key) === chatId) this.claims.delete(key);
  }
  /** The chat a request from `thread` is shown in: a sub-agent's thread asks in the chat of the thread that spawned it. */
  requestChat(thread) {
    return this.chatOf(requestThreadOf(this, thread));
  }
  /** The thread whose chat a request from `thread` is shown in (requestThreadOf). */
  requestThread(thread) {
    return requestThreadOf(this, thread);
  }
  /** The native session id the chat's next message goes to (Codex: the bare thread id). */
  nativeOf(chatId) {
    return this.ref(chatId).key;
  }
  /** Segments changed (a switch, a reload). */
  invalidate() {
    this.alias = null;
    for (const chatId of this.rts.keys()) activeCompaction(this, chatId);
  }

  /* -- sending ------------------------------------------------------ */
  /** Protocol support belongs to the current adapter; callers do not inspect chat ids. */
  peerCapabilities(chatId) {
    return this.adapterOf(chatId).peerCapabilities?.() ?? { messaging: false, read: false, steer: false };
  }
  /**
   * Whether the chat's harness holds no session for it any more (a restart forgot one no message ever started, #2502), so
   * the next message would resume nothing. An adapter without the check (ACP opens a new session itself) is never gone.
   */
  async sessionGone(chatId) {
    const adapter = this.adapterOf(chatId);
    return adapter.sessionGone ? adapter.sessionGone(this.ref(chatId)) : false;
  }
  /** The turn adapter of the chat's current segment. */
  adapterOf(chatId) {
    return this.adapterFor(this.ref(chatId).kind);
  }
  /** The turn adapter of a segment kind's family. */
  adapterFor(kind) {
    return byFamily({ codex: this.codex, claude: this.claudeTurns, acp: this.acpTurns }, kind);
  }
  /**
   * A message into the running turn. That turn can end while the steer is on its way (main hears the
   * harness's last events before its answer to the steer, or the harness refuses a turn that just
   * ended), so the queue waits for the steer to settle: a message the harness took is never sent again,
   * and one it didn't take is the next turn, sent once. A peer message keeps its own delivery record
   * (electron/session/peerMessages.cjs), which says when it failed.
   */
  obsoleteGoalCommand(chatId, item) {
    return (
      !!item.opts.goalRestart &&
      (!!this.state.get(chatId).pendingSwitch || !this.claudeTurns?.goalRestartCurrent?.(chatId, item.opts.goalRestart))
    );
  }

  async start(chatId, item) {
    const mutation = folderMutation(this, chatId);
    if (mutation) {
      const stops = this.rt(chatId).stops ?? 0;
      await mutation;
      if ((this.rt(chatId).stops ?? 0) !== stops || this.state.get(chatId).turn !== 'idle')
        return { started: false, error: 'The chat changed while waiting for its folder.' };
    }
    if (require('./voice.cjs').voiceWriter(this, chatId)) return { started: false, error: 'Voice conversation is still active' };
    if (this.obsoleteGoalCommand(chatId, item)) return { started: false, discarded: true };
    retireCompaction(this, chatId);
    const r = this.rt(chatId);
    let off = null;
    try {
      off = this.killed(this.ref(chatId).kind, chatId);
    } catch (error) {
      // the harness is not known to be switched off: the start below reports its own failure
      noteIgnored('check whether the harness is switched off', error);
    }
    if (off) {
      // refused before anything runs: the chat shows why, and the message waits in the queue like after a crash
      clock.clearTimeout(r.grace);
      Object.assign(r, { token: null, inputToken: null, outstanding: 0, interrupted: false, grace: null });
      this.state.patch(chatId, {
        turn: 'crashed',
        activeTurn: null,
        crashed: off,
        // Peer delivery owns blocked recovery in its journal; ordinary input stays queued.
        queue: item.peer || inputIsGuarded(item) ? this.state.get(chatId).queue : [item, ...this.state.get(chatId).queue],
      });
      try {
        await this.onDispatchResult?.({ chatId, item, result: { started: false, blocked: off, error: off, code: 'harness_turned_off' } });
      } catch (error) {
        // the chat already shows why; the delivery service records its own failure
        noteIgnored('report a refused start to the delivery service', error);
      }
      return { started: false, error: off };
    }
    const token = `pending-${item.id}`;
    const startAttempt = {}; // A retry keeps its input token but owns a distinct native start attempt.
    const stops = r.stops ?? 0;
    clock.clearTimeout(r.grace);
    Object.assign(r, { token, inputToken: token, startAttempt, outstanding: 0, interrupted: false, grace: null, stopsAtStart: stops });
    this.state.step(chatId, 'start', { turnId: token, human: !!item.opts.human });
    // a Stop from here until the harness has the prompt means it is not sent
    const release = this.stopGuard(chatId, item);
    const compactionGuard = guardCompaction(this, chatId, item);
    let res;
    let dispatched = false;
    try {
      // Maintenance acts on existing context; the next message carries a pending switch's handoff.
      const ps = !item.opts.compact && (this.state.get(chatId).pendingSwitch ?? this.switcher?.pendingContinue?.(chatId));
      if (ps) ({ item, res } = await settleSwitch(this, chatId, item, ps, () => r.token !== token || r.startAttempt !== startAttempt));
      if (!res) {
        dispatched = true;
        res = await this.dispatch(chatId, 'turn', item, item.origin);
      }
    } catch (e) {
      res = { started: false, error: String(e?.message ?? e) };
    }
    if (!dispatched) {
      try {
        await this.onDispatchResult?.({ chatId, item, result: res });
      } catch (error) {
        // the turn ends below either way; the delivery service records its own failure
        noteIgnored('report a failed start to the delivery service', error);
      }
    }
    release();
    compactionGuard.release();
    if (compactionGuard.owner && !res?.started && !item.peer) {
      return { ...res, ...suspendCompactionStart(this, chatId, item, compactionGuard.owner, token, startAttempt) };
    }
    // A retry must carry the context prepared for the new harness.
    if (!res?.started) res = { ...res, retryItem: item };
    if (r.token !== token || r.startAttempt !== startAttempt) return res;
    const s = this.state.get(chatId);
    if (!res?.started) {
      if (s.activeTurn?.id === token) {
        this.end(chatId, { drain: false, outcome: 'failed' });
        if (res.error && (r.stops ?? 0) === stops && r.startAttempt === startAttempt && !this.state.get(chatId).activeTurn)
          this.state.patch(chatId, { turn: 'crashed', crashed: res.error });
      }
      return res;
    }
    // turn/start named the turn (turn/started may have done it first)
    if (res.turnId && s.activeTurn?.id === token) this.nameTurn(chatId, res.turnId);
    // a turn the harness names only later (a Codex goal's, by turn/started): one that is never named didn't start
    if (pending(this.state.get(chatId)) && traitsOf(this.ref(chatId).kind).namesTurnLate)
      r.grace = clock.setTimeout(() => {
        if (r.token === token && this.state.get(chatId).activeTurn?.id === token) this.end(chatId, { drain: false, outcome: 'failed' });
      }, this.graceMs);
    r.grace?.unref?.();
    return res;
  }

  /** Whether an event still belongs to the chat's selected native session. */
  isCurrentSource(chatId, source) {
    try {
      const ref = this.ref(chatId);
      return matchesSource(ref, source);
    } catch (error) {
      noteIgnored('read the selected session for a harness event', error);
      return false;
    }
  }

  sourceMatches(owner, source) {
    return owner?.kind === source.kind && (source.key == null || owner.key === source.key);
  }

  /** Keep ownership only for live cards (no routing data in their shape), set with the turn's `step` (its end, its crash) if any. */
  setApprovals(chatId, approvals, step = /** @type {['start' | 'end' | 'crash', any?] | null} */ (null)) {
    const owners = this.rt(chatId).approvalOwners;
    const ids = new Set(approvals.map((a) => a.id));
    for (const id of owners.keys()) if (!ids.has(id)) owners.delete(id);
    void (step ? this.state.step(chatId, step[0], step[1], { approvals }) : this.state.patch(chatId, { approvals }));
    if (!approvals.length) this.settled(chatId);
  }

  /** An old source may close after a switch; its cards go without ending the replacement turn. */
  clearSourceApprovals(chatId, source) {
    const s = this.state.get(chatId);
    const owners = this.rt(chatId).approvalOwners;
    const approvals = s.approvals.filter((a) => !this.sourceMatches(owners.get(a.id), source));
    if (approvals.length === s.approvals.length) return;
    this.setApprovals(chatId, approvals);
  }

  /** Task levels and exits settle only the reporting process's jobs, preserving live jobs from other segments. */
  updateSourceTasks(chatId, key, next) {
    const s = this.state.get(chatId);
    const owners = this.rt(chatId).taskOwners;
    const current = this.isCurrentSource(chatId, { kind: 'claude', key });
    const owned = s.tasks.filter((t) => owners.get(t.id) === key || (!owners.has(t.id) && current));
    const incoming = Array.isArray(next) ? next : [];
    const updated = (next === null ? settleTaskList(owned) : mergeTaskLists(owned, incoming)).map((t) => ({
      ...t,
      source: { kind: 'claude', key },
    }));
    const ids = new Set(updated.map((t) => t.id));
    const other = s.tasks.filter((t) => !owned.includes(t) && !ids.has(t.id));
    const tasks = mergeTaskLists([], [...updated, ...other]);
    for (const t of updated) owners.set(t.id, key);
    const kept = new Set(tasks.map((t) => t.id));
    for (const id of owners.keys()) if (!kept.has(id)) owners.delete(id);
    this.state.patch(chatId, { tasks });
  }

  /** A sub-agent's request belongs to its own work, so a parent reply cannot end it. */
  approvalOutlivesTurn(chatId, approval) {
    const p = approval.params;
    if (approval.method === 'claude/permission')
      return (typeof p?.agentID === 'string' && p.agentID.length > 0) || this.isSubagentCall(chatId, p?.toolUseID);
    const thread = requestThread(p);
    return RENDERER_METHODS.has(approval.method) && this.parents.parentOf(thread) !== null && this.chatOf(thread) !== chatId;
  }

  /**
   * The turn is over: idle, then the next queued message unless the user stopped it.
   * @param {string} chatId
   * @param {{ drain?: boolean, outcome?: string, summary?: string | null, error?: string | null }} [opts] summary: what its notification says; error: why a failed turn failed
   */
  end(chatId, { drain = true, outcome = 'completed', summary = null, error = null } = {}) {
    const r = this.rt(chatId);
    retireCompaction(this, chatId, r.compaction?.phase !== 'complete' || !drain || r.interrupted || outcome !== 'completed');
    clock.clearTimeout(r.grace);
    const interrupted = r.interrupted;
    observe({ kind: 'run-end', chatId, outcome: interrupted ? 'cancelled' : outcome === 'completed' ? 'completed' : 'failed' });
    if (interrupted) {
      this.interrupting(chatId);
      this.recordStopped(chatId);
    }
    const finished = drain && !interrupted && busy(this.state.get(chatId));
    const text = r.lastText;
    const activeTurn = this.state.get(chatId).activeTurn;
    const completion = {
      chatId,
      inputToken: r.inputToken,
      ...endedTurn(activeTurn),
      text,
      completed: finished && outcome === 'completed',
    };
    Object.assign(r, { token: null, inputToken: null, outstanding: 0, interrupted: false, grace: null, lastText: null });
    const approvals = this.state.get(chatId).approvals.filter((a) => {
      const owner = r.approvalOwners.get(a.id);
      if (owner && !this.isCurrentSource(chatId, owner)) return true;
      return !interrupted && this.approvalOutlivesTurn(chatId, a);
    });
    this.setApprovals(chatId, approvals, ['end']);
    completePromptSuggestion(this, chatId, activeTurn, completion.completed);
    const finishFailed = (error) => noteIgnored('run the turn-finished hook', error);
    try {
      Promise.resolve(this.onFinished(completion)).catch(finishFailed);
    } catch (error) {
      finishFailed(error);
    }
    if (finished && !approvals.length) this.sayTurnEnd(chatId, text, outcome, summary, error);
    if (r.steering) r.afterSteer = drain && !interrupted ? 'drain' : 'hold';
    else if (drain && !interrupted) this.drain(chatId)?.catch(ignoring('send the next queued message'));
  }

  /** A system notification for the chat; main's Notifier applies Settings → General → Notifications. */
  say(kind, chatId, opts) {
    try {
      this.notify(kind, chatId, {
        chatTitle: this.chatTitle(chatId) || undefined,
        ...opts,
        body: prefixUnits(String(opts.body ?? ''), 180),
        viewing: this.viewing(chatId),
      });
    } catch (error) {
      // a notification failure must not affect the turn
      noteIgnored(`show the ${kind} notification`, error);
    }
  }
  settled(chatId) {
    try {
      this.retract(chatId);
    } catch (error) {
      // a notification failure must not affect the turn
      noteIgnored('withdraw the chat notifications', error);
    }
  }
  kindOf(chatId) {
    try {
      return this.ref(chatId).kind;
    } catch {
      return 'codex';
    }
  }

  /**
   * The harness went away with a turn or approvals pending (A23): the turn is 'crashed', its cards are gone, the tool calls
   * it started are stopped, and the queue stays until the user sends it.
   */
  crash(chatId, reason, source) {
    retireCompaction(this, chatId);
    const s = this.state.get(chatId);
    const r = this.rt(chatId);
    const approvals = source
      ? s.approvals.filter((a) => {
          const owner = r.approvalOwners.get(a.id);
          return owner && !this.sourceMatches(owner, source);
        })
      : [];
    if (!needsCrashCleanup({ ...s, approvals: s.approvals.filter((a) => !approvals.includes(a)) })) return false;
    clock.clearTimeout(r.grace);
    Object.assign(r, { token: null, inputToken: null, outstanding: 0, interrupted: false, grace: null });
    this.setApprovals(chatId, approvals, ['crash', { reason }]);
    try {
      this.onCrash(chatId);
    } catch (error) {
      // a failing crash hook must not stop the crash from being recorded
      noteIgnored('run the harness crash hook', error);
    }
    return true;
  }

  /**
   * The chat's turn is being stopped: the interrupt hook lets go of its running tool calls at once, unless the
   * current adapter's channel cancels each call itself (Claude Code: the SDK's per-call signal), so work that
   * outlives the turn there (a background agent's calls) keeps running.
   */
  interrupting(chatId) {
    try {
      if (this.adapterOf(chatId).cancelsToolCalls !== true) this.onInterrupt(chatId);
    } catch (error) {
      // a failing hook must not keep the stop from reaching the harness
      noteIgnored('stop the tool calls of a stopped turn', error);
    }
  }

  /**
   * Stop the chat's turn on the user's behalf (Esc during computer use, or computer use needing an OK
   * nobody was there to give): Codex pauses its goal and interrupts in main, Claude pauses the goal Sage
   * holds and interrupts, ACP cancels. Resolves true when it was handled.
   */
  recordStopped(chatId) {
    try {
      this.onStopped(chatId);
    } catch {
      this.say('turn', chatId, {
        title: 'Stop could not be saved',
        body: 'The chat stays paused for peer messages in this app run. Its pause could not be saved for restart.',
      });
    }
  }

  async stopChat(chatId) {
    retireCompaction(this, chatId);
    this.recordStopped(chatId);
    const ref = this.ref(chatId);
    return byFamily(STOP, ref.kind)(this, chatId, ref);
  }
}

module.exports = { noteSubagentCalls, acpStateUpdate, acpPlanOn, ChatController, queueItem, crashText, START_GRACE_MS };
