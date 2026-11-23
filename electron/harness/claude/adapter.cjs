// The Claude Code adapter, in main (WP5-9, WP5-11; A15, A23). The ChatController calls it for every
// Claude turn, so a turn can start with no window open. It decides what a turn runs with (model,
// effort, permission, account, whether the session resumes), brings a live CLI in line, sends the
// message through the controller's bookkeeping (`send`), steers and interrupts, writes the chat's
// title, and keeps the goal: the Sage-held pause, resume, the round limit, and the step the CLI
// needs after a crash. Windows follow it through events (`claude:event`): turnStarting shows the
// message at once, turnStarted / turnFailed finish it. What stays in a window is only how SDK
// messages become thread items (src/harness/claudeTranslate.ts).
//
// The process and the SDK session itself are electron/harness/claude/index.cjs (`api` here).
const { clock } = require('../../platform/ports/clock.cjs');
const { claudeAuthFailed } = require('../../../shared/loginRefused.mjs');
const crypto = require('node:crypto');
const { assertInputCurrent, carryInputGuard, clientIdOf } = require('../../session/contract/inputGuard.cjs');
const os = require('node:os');
const { liveControls } = require('../../../shared/claudeSettings.mjs');
const { claudeTurnSettings } = require('./turnSettings.cjs');
const { startClaudeTurn, keepTurnSelection, claudeTurnInput } = require('./turnStart.cjs');
const {
  reconcilePermission,
  retireNativeSettings,
  ownsNative,
  observeNativePermission,
  permissionReportVersion,
  reportedSettings,
} = require('./permissions.cjs');
const { autoTitle, isFirstOutput } = require('./title.cjs');
const { FirstOutputGate } = require('../firstOutputGate.cjs');
const { setClaudeOwn, claudePreflight, applyClaudeSwitch } = require('./own.cjs');
const { goalNotice } = require('../../../shared/goalNotice.mjs');
const { FAST_BLOCKED_TEXT } = require('../../../shared/caps.mjs');
const { decideClaudeSwitch, claudeLoginFor, LIMIT_HOLD_MS } = require('../../identity/contract/switch.cjs');
const { LoginMarks } = require('../../identity/contract/loginMarks.cjs');
const { fileMarksStore } = require('../../identity/contract/accountDirs.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { matchesSource } = require('../../session/contract/route.cjs');
const {
  claudeGoalAfterTurn,
  claudeGoalClearPlan,
  claudeGoalExtended,
  claudeGoalOverLimit,
  claudeGoalPausePlan,
  claudeGoalResumePlan,
  claudeGoalRoundLimit,
  canExtendClaudeGoal,
  lastGoalStatus,
  parseClaudeGoalMessage,
  reduceClaudeGoal,
} = require('../../../shared/claudeGoals.mjs');

const busy = (s) => s.turn === 'running' || s.turn === 'awaitingUser';
const sleep = (ms) => new Promise((r) => clock.setTimeout(r, ms));
const sessionOf = (key) => String(key).replace(/^claude:/, '');
const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** How long a result waits for a window to say the chat is handing over to another login. */
const HANDOVER_GRACE_MS = 150;

class ClaudeAdapter {
  /** @returns {import('../../../shared/peerMessages').PeerAdapterCapabilities} */
  peerCapabilities() {
    return { messaging: true, read: true, steer: true, toolChannel: 'channel.claude.sdkMcp' };
  }
  /**
   * @param {object} o
   * @param o.api electron/harness/claude/index.cjs `turnApi`: isLive, control, title, rename, info, goalStatus, sessionCwd (async), accounts, metered, onLoginWorks, onLoginLeft
   * @param [o.marksFile] the file what main saw of each login is kept in between runs (identity/contract/accountDirs.cjs)
   * @param o.probeInfo (account) => the last probe ({models, fastBlocked}) or null
   * @param o.state SessionStore
   * @param o.prefs () => the app's prefs (permission, claudeSelection, claudeBin)
   * @param o.send (chatId, key, opts, input, priority, meta) => Promise<{elsewhere}>: ChatController.claudeSend
   * @param o.enqueue (chatId, item) => void: a message of Sage's own through the controller (a /goal command)
   * @param o.interrupted (key) => void: tell the controller the user stopped the turn
   * @param o.chatOf (key) => chatId
   * @param o.ref (chatId) => the chat's NativeRef ({kind, id, key})
   * @param o.emit (event, target?) => boolean: to windows (`claude:event`); a window id, 'any', 'shown' (app windows on screen), or all when omitted
   * @param o.setGoal (chatId, goal) => boolean: the chat's goal in the session state (and its file); true when it changed
   * @param o.notifyGoal (chatId, {status, body}) => void
   * @param o.moved (chatId, {account, note}) => void: the chat's login and the note about it, kept in its file (WP3-7)
   * @param [o.served] (chatId, account) => void: the login a turn of the chat starts on, kept in its file by main (#2538)
   * @param [o.savedAccount] (chatId) => the login kept in the chat's file (its meta.account id), or null
   * @param [o.savedSettings] (chatId) => per-chat settings kept in meta.config, including linked-session grants
   * @param [o.keepSelection] (chatId, picked) => void: save the model and effort the chat has none of yet into meta.config
   * @param [o.pinnedModel] (chatId) => the model main runs the chat on whatever a window pushes (a MoMo chat's brain), or null
   * @param [o.pinnedEffort] (chatId) => the effort pinned with that model, or null
   * @param [o.limitHit] (chatId) => void: the chat ran out of usage with no login to move to (session/limitContinue.cjs)
   * @param o.notifyLimit (chatId, reason) => void: the system notification when a limit or lapsed login stops a chat nobody is watching
   * @param [o.resumeMs] how long after a login switch the chat continues
   * @param [o.home] the folder a chat without one runs in
   * @param [o.now] () => ms
   * @param [o.graceMs] how long a result waits for a window to say the chat is handing over to another login
   */
  constructor(o) {
    this.api = o.api;
    this.probeInfo = o.probeInfo ?? (() => null);
    this.state = o.state;
    this.prefs = o.prefs;
    this.sendTo = o.send;
    this.enqueue = o.enqueue;
    /**
     * The tool channel cancels each call itself: the Agent SDK aborts a call's signal when the CLI cancels it
     * (sdkMcp passes it to the Registry), so a Stop leaves the chat's other calls, such as a background agent's, running.
     */
    this.cancelsToolCalls = true;
    this.markInterrupted =
      o.interrupted ??
      (() => {
        /* no listener */
      });
    this.chatOf = o.chatOf;
    this.refOf = o.ref;
    this.emit = o.emit ?? (() => false);
    this.writeGoal = o.setGoal;
    this.notifyGoal =
      o.notifyGoal ??
      (() => {
        /* no listener */
      });
    this.savedAccount = o.savedAccount ?? (() => null);
    this.savedSettings = o.savedSettings ?? (() => null);
    this.keepSelection = o.keepSelection ?? (() => false);
    this.pinnedModel = o.pinnedModel ?? (() => null);
    this.pinnedEffort = o.pinnedEffort ?? (() => null);
    this.moved =
      o.moved ??
      (() => {
        /* no listener */
      });
    this.notifyLimit =
      o.notifyLimit ??
      (() => {
        /* no listener */
      });
    this.limitHit = o.limitHit ?? (() => undefined);
    this.served = o.served ?? (() => undefined);
    this.resumeMs = o.resumeMs ?? 800;
    this.home = o.home ?? os.homedir();
    this.clock = o.now ?? (() => clock.now());
    this.graceMs = o.graceMs ?? HANDOVER_GRACE_MS;
    /** key -> the settings the live CLI session was started with, so changes apply in place */
    this.live = new Map();
    /** native key -> turn starts in flight (the session isn't live until the first is sent) */
    this.startingTurns = new Map();
    /** key -> {cwd, ephemeral, forkFrom, fresh}: sessions a window created and named to us (not yet sent to) */
    this.sessions = new Map();
    /** Chats with a title helper in flight; follow-ups must never start a second helper. */
    this.titling = new Set();
    /** key -> its title helper, held until the session's first turn shows output */
    this.firstOutput = new FirstOutputGate();
    /** chatId -> {model, effort, account}: what the chat itself picked, pushed by the windows */
    this.own = new Map();
    /** chats whose current turn ran a goal loop: its end decides whether the goal was met */
    this.goalTurns = new Set();
    /** Own restarts awaiting Goal set; old-turn feedback cannot change their fresh limit. */
    this.goalRestarts = new Map();
    /** Already-sent restarts retired by Pause/Clear; their late Goal set is still obsolete. */
    this.retiredGoalSets = new Map();
    /** Delayed goal work, latest per operation and chat; released when it settles or is superseded. */
    this.goalWork = { settle: new Map(), resume: new Map(), plan: new Map() };
    /** chats whose CLI quit mid-turn with a goal running: Resume clears the CLI's goal before setting it again */
    this.goalCrashed = new Set();
    /** chats a window is moving to another login with their goal carried over */
    this.handover = new Set();
    /** login -> { limitedUntil, expired, left }: what main has seen of each login (identity/contract/switch.cjs) */
    /** the switch policy (identity/contract/switch.cjs) the pieces of this folder that move a chat read */
    this.policy = { decideClaudeSwitch, claudeLoginFor };
    this.marks = new LoginMarks(o.marksFile ? fileMarksStore(o.marksFile) : undefined);
    // a login signed in again is a place a chat that runs out can move to again
    this.api.onLoginWorks?.((account) => this.marks.works(account));
    this.api.onLoginLeft?.((account, left, at, resetsAt) => this.marks.seen({ login: true }, account, left, at, this.clock(), resetsAt));
    /** chatId -> when it last moved to another login automatically */
    this.recent = new Map();
    /** chatId -> the id windows give its latest turn (ct-<uuid>), for the note that follows it */
    this.lastTurn = new Map();
    /** chats waiting to go on at another login once their turn ends, with the goal to set again there (null: none) */
    this.resume = new Map();
    /** chats whose limit stopped them with nowhere to go: said once per turn */
    this.stuck = new Set();
    /** the last fast-mode blocker a session reported */
    this.fastBlocked = null;
  }

  /* -- what windows tell us ------------------------------------------ */
  /** A session a window just created (a new chat, a side chat, a later segment): its first message starts it, not resumes it. */
  registerSession(key, info = {}) {
    if (typeof key !== 'string' || !key) return false;
    this.sessions.set(key, {
      cwd: typeof info.cwd === 'string' && info.cwd ? info.cwd : null,
      ephemeral: !!info.ephemeral,
      forkFrom: typeof info.forkFrom === 'string' && info.forkFrom ? info.forkFrom : null,
      fresh: info.resume !== true,
    });
    return true;
  }

  /** A session no message has started yet (it has no transcript). */
  isFresh(key) {
    return !!this.sessions.get(key)?.fresh;
  }

  /**
   * The chat's session is gone: no message started it in this run (it is not registered fresh), no CLI holds it and no
   * transcript is on disk, so a resume would fail with "No conversation found" (#2502).
   */
  async sessionGone(ref) {
    if (this.isFresh(ref.key) || this.api.isLive(ref.key)) return false;
    return !(await this.api.hasTranscript(ref.id));
  }

  /** The folder a session runs in: the one it was created with, else the one its transcript names (read async). */
  async cwdOf(ref) {
    return this.sessions.get(ref.key)?.cwd || (await this.api.sessionCwd(ref.id)) || null;
  }

  /** What the chat itself picked (its model and effort, the login it runs on); null clears, a field left out stays (claudeOwn.cjs). */
  setOwn(chatId, own) {
    return setClaudeOwn(this, chatId, own);
  }

  /** A window is moving the chat to another login and will set its goal again there. */
  setHandover(chatId, on) {
    if (on) this.handover.add(chatId);
    else this.handover.delete(chatId);
  }

  /** The login a chat runs on: its pick, kept within its billing lane (identity/contract/switch.cjs claudeLoginFor). */
  accountOf(chatId) {
    return claudeLoginFor(this.pickOf(chatId), this.api.accounts(), this.marks, this.clock(), false);
  }

  /** The login a chat picked or moved to: what its file keeps (main's moves and the user's picks), else what a window pushed (#2538). */
  pickOf(chatId) {
    return this.savedAccount(chatId) ?? this.own.get(chatId)?.account ?? null;
  }

  /** The login a chat with a pick of its own runs on; null without one (the harness's active instance serves it). */
  pickedLogin(chatId) {
    return this.pickOf(chatId) ? this.accountOf(chatId) : null;
  }

  /* -- turns ----------------------------------------------------------- */
  /**
   * What a turn runs with: the defaults, then the chat's own pick, then the message's own (a
   * scheduled task's model and effort win for its run).
   */
  settings(chatId, opts) {
    return claudeTurnSettings(this, chatId, opts);
  }

  /**
   * Start a turn for a message on the chat's Claude session. Windows follow it through events:
   * turnStarting (the message at once), then turnStarted or turnFailed.
   * @returns {Promise<{ started: boolean, turnId?: string, itemId?: string, error?: string, discarded?: boolean }>}
   */
  async startTurn(chatId, ref, item, origin = null) {
    return startClaudeTurn(this, chatId, ref, item, origin, noteIgnored);
  }

  /** startTurn's work, counted in startingTurns while it runs. */
  async beginTurn(chatId, ref, item, origin, current) {
    const key = ref.key;
    const reportVersion = permissionReportVersion(this, key);
    const opts = item.opts || {};
    if (opts.goalRestart && (!this.goalRestartCurrent(chatId, opts.goalRestart) || !this.awaitingGoalSet(chatId, key)))
      return { started: false, discarded: true };
    const text = String(item.text ?? '');
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const to = origin ?? 'any';
    claudePreflight(this, chatId, key);
    const st = this.settings(chatId, opts);
    keepTurnSelection(this, chatId, opts, st);
    const clientId = clientIdOf(item);
    this.retiredGoalSets.delete(chatId);
    const restarting = this.goalRestarts.get(chatId);
    if (!opts.goalClear && !opts.goalRestart) this.goalRestarts.delete(chatId);
    this.lastTurn.set(chatId, `ct-${clientId}`);
    if (opts.goalRestart && this.awaitingGoalSet(chatId, key)) this.goalRestarts.get(chatId).started = true;
    this.discardStaleContinuation(chatId);
    const want = { model: st.model, effort: st.effort, permission: st.permission, fast: st.fast, account: st.account };
    this.state.patch(chatId, { modality: 'image' }); // Claude models take images: computer use answers with screenshots
    this.emit(
      {
        kind: 'turnStarting',
        key,
        chatId,
        clientId,
        itemId: item.id,
        turnId: `ct-${clientId}`,
        text,
        attachments,
        opts,
        model: st.picked,
        account: st.account,
      },
      to,
    );
    this.served(chatId, st.account);
    try {
      // a session moving to another account restarts as that account (electron/harness/claude/index.cjs), so it takes
      // these settings fresh, and the old process's are forgotten before it goes (D-84)
      const cur = this.api.isLive(key) ? this.live.get(key) : undefined;
      const controls = liveControls(cur, want);
      if (!controls) this.live.delete(key);
      for (const [method, arg] of controls ?? []) {
        await this.api.control(key, method, arg);
        if (!current() || !ownsNative(this, key)) throw new Error('The Claude Code session changed while its settings were updated.');
      }
      // the session's own folder even with its CLI running: send() may still replace that CLI (another account, billing,
      // a write from another app, read-only), and the new one resumes there; only an unknown one waits for its transcript
      const cwd = this.sessions.get(key)?.cwd || (await this.api.sessionCwd(ref.id)) || this.home;
      if (!current() || !ownsNative(this, key)) throw new Error('The Claude Code session changed before this turn was sent.');
      const sess = this.sessions.get(key) ?? {};
      const sessionOpts = {
        bin: st.prefs.claudeBin,
        sessionId: ref.id,
        resume: !sess.fresh,
        cwd,
        forkFrom: sess.forkFrom || undefined,
        ephemeral: !!sess.ephemeral,
        ...(st.additionalDirectories ? { additionalDirectories: st.additionalDirectories } : {}),
        ...want,
        basePermission: st.basePermission,
      };
      const { content, meta } = claudeTurnInput(item, clientId);
      if (opts.goalRestart && !this.goalRestartCurrent(chatId, opts.goalRestart)) return { started: false, discarded: true };
      if (opts.goalRestart) this.goalRestarts.get(chatId).sent = true;
      assertInputCurrent(item);
      // armed before the send: the CLI may answer before sendTo resolves; the title is written beside its start (title.cjs)
      const titled = chatId === key && sess.fresh && !sess.ephemeral && !sess.forkFrom ? this.firstOutput.arm(key) : null;
      const sending = this.sendTo(chatId, key, sessionOpts, content, undefined, meta);
      if (titled) this.autoTitle(chatId, ref, text, cwd, st, titled, sending);
      const { elsewhere } = await sending;
      // Acceptance belongs to the original process even if it retired before its receipt; never replay that input.
      if (!current() || !ownsNative(this, key)) return { started: true, turnId: `ct-${clientId}`, itemId: clientId };
      this.live.set(key, reportedSettings(this, key, want, reportVersion));
      if (this.sessions.has(key)) this.sessions.set(key, { ...sess, fresh: false, forkFrom: null });
      this.emit({ kind: 'turnStarted', key, chatId, clientId, text, want, elsewhere: Array.isArray(elsewhere) ? elsewhere : [] }, to);
      return { started: true, turnId: `ct-${clientId}`, itemId: clientId };
    } catch (e) {
      this.firstOutput.open(key);
      if (restarting && this.goalRestarts.get(chatId) === restarting && this.awaitingGoalSet(chatId, key))
        this.setGoal(chatId, claudeGoalAfterTurn(restarting.goal, null, this.clock() / 1000));
      this.emit({ kind: 'turnFailed', key, chatId, clientId, error: String(e?.message ?? e) }, to);
      return { started: false, error: errText(e) };
    }
  }

  /** A follow-up into the running turn (priority "now"); without a live session it is a turn of its own. */
  async steer(chatId, ref, item, origin = null) {
    const key = ref.key;
    if (!this.api.isLive(key) || !this.live.has(key)) {
      // the turn is still starting: a second start would run beside it (and reset what the first owes), so this
      // waits first in the queue for the next turn (ChatController.steer)
      if (this.startingTurns.has(key)) return { started: false, error: 'The turn is still starting' };
      return this.startTurn(chatId, ref, item, origin);
    }
    const opts = item.opts || {};
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const content = { text: String(item.text ?? ''), attachments: attachments.map(({ previewUrl: _p, ...a }) => a) };
    const clientId = clientIdOf(item);
    // Shown before it goes: send() resolves only after a process scan, and by then the CLI may have
    // finished the turn and answered this message. Told before any of that, the window counts its
    // result in the turn and puts the reply after it.
    this.emit({ kind: 'steered', key, chatId, text: String(item.text ?? ''), attachments, clientId }, origin ?? 'any');
    try {
      await this.sendTo(chatId, key, {}, content, 'now', carryInputGuard(item, { human: !!opts.human, uuid: clientId }));
    } catch (e) {
      // it never reached Claude: the window takes it back, and the ChatController sends it as the next turn
      this.emit({ kind: 'steerFailed', key, chatId, clientId }, origin ?? 'any');
      return { started: false, error: errText(e) };
    }
    return { started: true, ...(item.peer ? { turnId: this.state.get(chatId).activeTurn?.id ?? null, itemId: clientId } : {}) };
  }

  /** The chat's first message is being sent: name it now (title.cjs); its fallback helper waits for the turn's output. */
  autoTitle(chatId, ref, text, cwd, st, ready, sending) {
    return autoTitle(this, chatId, ref, text, cwd, st, ready, sending).catch((error) => noteIgnored('name a Claude Code chat', error));
  }

  /** Stop pressed (or Sage stopping a run): a goal that is active is paused first, since interrupt leaves it active. */
  async stop(chatId) {
    if (this.state.get(chatId).goal?.status === 'active') return this.pauseGoal(chatId);
    return this.interrupt(chatId);
  }

  /** End the running turn. Windows mark their open turn interrupted first, so the end reads as a stop. */
  async interrupt(chatId, key = this.keyOf(chatId)) {
    this.emit({ kind: 'interrupting', key });
    this.markInterrupted(key);
    try {
      await this.api.control(key, 'interrupt');
    } catch (e) {
      this.emit({ kind: 'toast', level: 'error', text: `Couldn't stop: ${errText(e)}` }, 'any');
    }
  }

  /**
   * The app's permission changed: each live CLI takes it now, mid-turn too, instead of at its chat's
   * next turn. Claude in Chrome follows the session's mode on every action (bypassPermissions skips
   * its per-site checks), so Full access stops its prompts at once. A CLI in plan mode keeps it (an
   * approved plan returns to the chat's permission); a move into or out of read-only restarts the CLI
   * at its next turn instead (D-28).
   * @returns {Promise<string[]>} the sessions that took the new mode
   */
  async permissionChanged(chatId = null) {
    const keys = [...new Set([...this.live.keys(), ...this.startingTurns.keys()])].filter(
      (key) => chatId === null || this.chatOf(key) === chatId,
    );
    const updated = await Promise.all(keys.map(async (key) => ((await reconcilePermission(this, key)) ? key : null)));
    return updated.filter((key) => key !== null);
  }

  /** The native session the chat's messages go to. */
  keyOf(chatId) {
    return this.refOf(chatId).key;
  }

  /* -- events from the CLI --------------------------------------------- */
  /** Every claude:event main sees, once (windows each see them too, but only for display). */
  observe(e) {
    if (!e || !e.key) return;
    const chatId = this.chatOf(e.key);
    if (isFirstOutput(e)) this.firstOutput.open(e.key);
    // `login` false: the process ran on a key or MoPilot credits, so what it says is not about the login; `account`: its login
    if (e.kind === 'message') return this.onMessage(chatId, e.key, e.msg || {}, { login: e.login !== false, account: e.account });
    if (e.kind === 'closed' || e.kind === 'error') {
      this.live.delete(e.key);
      retireNativeSettings(this, e.key);
    }
  }

  onMessage(chatId, key, m, scope = { login: true }) {
    try {
      if (!matchesSource(this.refOf(chatId), { kind: 'claude', key })) return;
    } catch (error) {
      noteIgnored('read the selected session for a Claude message', error);
      return;
    }
    if (observeNativePermission(this, key, m))
      this.permissionChanged(chatId).catch((error) => noteIgnored('restore the current permission after Claude left plan mode', error));
    const account = scope.account ?? this.live.get(key)?.account ?? this.accountOf(chatId);
    if (m.type === 'rate_limit_event') {
      this.marks.usage(scope, account, m.rate_limit_info, this.clock());
      if (m.rate_limit_info?.status === 'rejected') this.limited(chatId, key, account, 'limit', scope);
      return;
    }
    if (m.type === 'assistant' && m.error === 'rate_limit') this.limited(chatId, key, account, 'limit', scope);
    // the login lapsed or is refused for its organization: an assistant message says so while `auth status` still says "logged in"
    if (m.type === 'assistant' && claudeAuthFailed(m)) {
      this.marks.expired(scope, account);
      this.limited(chatId, key, account, 'expired', scope);
    }
    if (m.type === 'system' && m.subtype === 'init' && this.live.get(key)?.fast) {
      // only a session that asked for fast mode reports a meaningful reason
      const r = m.fast_mode_disabled_reason ?? null;
      if (r && FAST_BLOCKED_TEXT[r]) this.fastBlocked = r;
      else if (m.fast_mode_state === 'on') this.fastBlocked = null;
    }
    if (m.type === 'result') {
      if (!m.is_error && scope.login) this.marks.works(account); // a turn that answered proves the login works
      if (!busy(this.state.get(chatId))) this.retiredGoalSets.delete(chatId);
      this.stuck.delete(chatId);
      this.continueAfterSwitch(chatId);
      // a usage limit hands the goal to the next login: it is not settled here
      const handing = this.handover.delete(chatId);
      // Main can drain the next turn before this result is observed. Its final result owns settlement.
      if (busy(this.state.get(chatId))) return;
      if (this.awaitingGoalSet(chatId, key)) {
        const pending = this.goalRestarts.get(chatId);
        if (pending.started) this.setGoal(chatId, claudeGoalAfterTurn(pending.goal, null, this.clock() / 1000));
        return;
      }
      if (this.goalTurns.delete(chatId)) this.settleLater(key, chatId, handing);
      return;
    }
    const e = parseClaudeGoalMessage(m);
    if (!e) return;
    const retired = this.retiredGoalSets.get(chatId);
    if (e.kind === 'set' && retired?.key === key && retired.condition === e.condition) return;
    if (this.awaitingGoalSet(chatId, key)) {
      if (e.kind !== 'set') return;
      this.goalRestarts.delete(chatId);
    }
    if (e.kind === 'set' || e.kind === 'check') this.goalTurns.add(chatId);
    const next = reduceClaudeGoal(this.goal(chatId), e, {
      chatId,
      limit: claudeGoalRoundLimit(this.api.metered()),
      now: this.clock() / 1000,
    });
    if (next === undefined) return;
    this.setGoal(chatId, next);
    if (claudeGoalOverLimit(next))
      // the goal is already marked budget-limited before the plan runs; a failed stop is shown by interrupt()
      this.pauseGoal(chatId, 'budgetLimited').catch((error) => noteIgnored('pause a Claude Code goal at its round limit', error));
  }

  /**
   * The login a chat runs on can't serve it (a limit, or a lapsed login): move the chat to another
   * login of the same billing type, say so in the chat, and go on there once the turn that ran out has
   * ended (continueAfterSwitch). No window is needed (WP3-7).
   */
  limited(chatId, key, account, reason, scope = { login: true }) {
    this.discardStaleContinuation(chatId);
    if (this.resume.has(chatId) || this.stuck.has(chatId)) return;
    const goal = this.goal(chatId);
    const now = this.clock();
    if (reason === 'limit') this.marks.limited(scope, account, now, LIMIT_HOLD_MS);
    const d = decideClaudeSwitch({
      account,
      reason,
      view: this.api.accounts(),
      marks: this.marks.snapshot(),
      now,
      recent: this.recent.get(chatId) ?? [],
      ephemeral: !!this.sessions.get(key)?.ephemeral,
      // a key ran out, not the login: another login is no way out either
      keyMode: !scope.login || !!this.api.keyMode?.(),
      goal,
    });
    this.recent.set(chatId, d.recent);
    if (d.action !== 'switch') return this.unresolved(chatId, key, reason);
    applyClaudeSwitch(this, chatId, key, account, d, now);
    this.queueContinuation(chatId, key, d.carried ? goal.objective : null);
    // the turn that just ran out isn't the goal's end: it is not settled
    if (d.carried) this.handover.add(chatId);
  }

  /**
   * Nothing to move to on its own: another provider or pay-per-use is only offered, which takes a
   * window. With none open the chat pauses instead (its goal is held for Resume) and one notification goes out.
   */
  unresolved(chatId, key, reason) {
    this.stuck.add(chatId);
    if (reason === 'limit') this.limitHit(chatId);
    // only an app window on screen can offer the other harness: hidden ones (Quick Chat's) count as none
    if (this.emit({ kind: 'limitUnresolved', key, chatId, reason }, 'shown')) return;
    const goal = this.goal(chatId);
    if (goal?.status === 'active' && goal.objective) {
      this.goalCrashed.add(chatId);
      this.setGoal(chatId, { ...goal, status: 'usageLimited', updatedAt: this.clock() / 1000 });
    } else this.notifyLimit(chatId, reason);
  }

  /** A delayed action belongs to the goal snapshot, native session and turn that scheduled it. */
  captureGoalWork(chatId, key, kind) {
    const context = { kind, key, goal: this.goal(chatId), turn: this.lastTurn.get(chatId) };
    this.goalWork[kind].set(chatId, context);
    return context;
  }

  goalWorkCurrent(chatId, context, requireIdle = true) {
    try {
      return (
        this.goalWork[context.kind].get(chatId) === context &&
        this.goal(chatId) === context.goal &&
        this.lastTurn.get(chatId) === context.turn &&
        (!requireIdle || !busy(this.state.get(chatId))) &&
        matchesSource(this.refOf(chatId), { kind: 'claude', key: context.key })
      );
    } catch (error) {
      noteIgnored('read the selected session for delayed goal work', error);
      return false;
    }
  }

  releaseGoalWork(chatId, context) {
    const work = this.goalWork[context.kind];
    if (work.get(chatId) === context) work.delete(chatId);
  }

  /** A crashed or superseded turn cannot keep the duplicate-limit guard occupied. */
  discardStaleContinuation(chatId, force = false) {
    const pending = this.resume.get(chatId);
    if (!pending || (!force && this.goalWorkCurrent(chatId, pending.context, false))) return;
    this.resume.delete(chatId);
    this.releaseGoalWork(chatId, pending.context);
    this.handover.delete(chatId);
  }

  /** Capture ownership when the limit occurs, before the result or a user's goal change arrives. */
  queueContinuation(chatId, key, goal) {
    const context = this.captureGoalWork(chatId, key, 'resume');
    this.resume.set(chatId, { goal, context });
  }

  /** The turn that ran out has ended: continue on the new login, with a goal that was running set again as Sage's own message. */
  continueAfterSwitch(chatId) {
    const pending = this.resume.get(chatId);
    if (!pending) return;
    const { goal, context } = pending;
    this.resume.delete(chatId);
    clock.setTimeout(() => {
      try {
        if (!this.goalWorkCurrent(chatId, context)) return;
        this.enqueue(chatId, { text: goal ? `/goal ${goal}` : 'Continue where you left off.', attachments: [], opts: {} });
      } finally {
        this.releaseGoalWork(chatId, context);
      }
    }, this.resumeMs);
  }

  /** The loop ended on its own. A window moving the chat to another login says so just after the result. */
  settleLater(key, chatId, handingAlready) {
    const context = this.captureGoalWork(chatId, key, 'settle');
    clock
      .setTimeout(() => {
        if (handingAlready || !this.goalWorkCurrent(chatId, context) || this.handover.delete(chatId)) {
          this.releaseGoalWork(chatId, context);
          return;
        }
        // the goal stays active; the next result settles it
        this.settleGoal(key, chatId, context).catch((error) => noteIgnored('settle a Claude Code goal', error));
      }, this.graceMs)
      .unref?.();
  }

  /** Met (complete) or not, from the transcript's last goal check. */
  async settleGoal(key, chatId, context = this.captureGoalWork(chatId, key, 'settle')) {
    try {
      if (context.goal?.status !== 'active' || !this.goalWorkCurrent(chatId, context)) return;
      const read = async () => {
        try {
          const text = await this.api.goalStatus(sessionOf(key));
          return text ? lastGoalStatus(text) : null;
        } catch {
          return null;
        }
      };
      let status = await read();
      if (!this.goalWorkCurrent(chatId, context)) return;
      // the CLI may still be flushing its transcript when the result arrives
      if (!status?.met) {
        await sleep(400);
        if (!this.goalWorkCurrent(chatId, context)) return;
        status = (await read()) ?? status;
        if (!this.goalWorkCurrent(chatId, context)) return;
      }
      const next = claudeGoalAfterTurn(context.goal, status, this.clock() / 1000);
      if (next) this.setGoal(chatId, next);
    } finally {
      this.releaseGoalWork(chatId, context);
    }
  }

  /** The CLI quit mid-turn: an active goal can't go on, so it is held for Resume, which clears first. */
  crashed(chatId) {
    this.retireGoalRestart(chatId);
    this.discardStaleContinuation(chatId, true);
    const goal = this.goal(chatId);
    this.goalTurns.delete(chatId);
    if (goal?.status !== 'active' || !goal.objective) return;
    this.goalCrashed.add(chatId);
    this.setGoal(chatId, { ...goal, status: 'paused', updatedAt: this.clock() / 1000 });
  }

  /* -- goals ------------------------------------------------------------ */
  goal(chatId) {
    return this.state.get(chatId).goal;
  }

  retireGoalRestart(chatId) {
    const pending = this.goalRestarts.get(chatId);
    if (pending?.sent) this.retiredGoalSets.set(chatId, { key: pending.key, condition: pending.goal.objective });
    this.goalRestarts.delete(chatId);
  }

  goalRestartCurrent(chatId, token) {
    const pending = this.goalRestarts.get(chatId);
    return (
      pending?.id === token && matchesSource(this.refOf(chatId), { kind: 'claude', key: pending.key }) && pending.goal === this.goal(chatId)
    );
  }

  awaitingGoalSet(chatId, key) {
    const pending = this.goalRestarts.get(chatId);
    return pending?.key === key && pending.goal === this.goal(chatId);
  }

  setGoal(chatId, goal) {
    if (this.goalRestarts.get(chatId)?.goal !== goal) this.retireGoalRestart(chatId);
    const prev = this.goal(chatId);
    const changed = this.writeGoal(chatId, goal);
    this.discardStaleContinuation(chatId);
    const notice = changed ? goalNotice(prev, goal) : null;
    if (notice) this.notifyGoal(chatId, notice);
    return changed;
  }

  /** Resolves once the chat has no turn running (or after a while, if the CLI never answers). */
  async whenIdle(chatId, ms = 10_000) {
    const until = clock.now() + ms;
    while (busy(this.state.get(chatId)) && clock.now() < until) await sleep(40);
  }

  /** Sage's own /goal commands go out without origin human; a "/goal clear" the user typed keeps it. */
  async runPlan(chatId, plan, human, onDone) {
    const context = this.captureGoalWork(chatId, this.keyOf(chatId), 'plan');
    try {
      for (const a of plan) {
        if (!this.goalWorkCurrent(chatId, context, false)) return;
        if (a.kind === 'interrupt') {
          await this.interrupt(chatId, context.key);
          if (!this.goalWorkCurrent(chatId, context, false)) return;
          await this.whenIdle(chatId);
        } else {
          this.enqueue(chatId, {
            text: a.text,
            attachments: [],
            opts: {
              ...(human ? { human: true } : {}),
              ...(a.text === '/goal clear' ? { goalClear: true } : { goalRestart: this.goalRestarts.get(chatId)?.id }),
            },
          });
          // An own queued command can start immediately; it does not supersede the rest of its plan.
          context.turn = this.lastTurn.get(chatId);
        }
      }
      if (this.goalWorkCurrent(chatId, context, false)) onDone?.();
    } finally {
      this.releaseGoalWork(chatId, context);
    }
  }

  /**
   * Pause (or Stop, or the round limit): stop the loop, then clear the CLI's goal, which interrupt()
   * alone would leave active for the next message. Sage keeps the condition for Resume.
   */
  async pauseGoal(chatId, status = 'paused') {
    const goal = this.goal(chatId);
    const plan = claudeGoalPausePlan(goal, busy(this.state.get(chatId)));
    if (!goal || !plan.length) return;
    this.setGoal(chatId, { ...goal, status, updatedAt: this.clock() / 1000 });
    this.goalTurns.delete(chatId);
    await this.runPlan(chatId, plan, false);
  }

  /** Resume sends the condition again; "Goal set" from the CLI then restarts the round count. */
  async resumeGoal(chatId) {
    const goal = this.goal(chatId);
    const plan = claudeGoalResumePlan(goal, this.goalCrashed.delete(chatId));
    if (!goal || !plan.length) return;
    this.setGoal(chatId, {
      ...goal,
      status: 'active',
      updatedAt: this.clock() / 1000,
      claude: { iterations: 0, lastReason: null, limit: goal.claude?.limit ?? null },
    });
    this.goalRestarts.set(chatId, { id: crypto.randomUUID(), key: this.keyOf(chatId), goal: this.goal(chatId) });
    await this.runPlan(chatId, plan, false);
  }

  /** "10 more rounds" on a goal paused at the round limit: resume it with a fresh limit of that many. */
  async extendGoal(chatId) {
    const goal = this.goal(chatId);
    if (!goal || !canExtendClaudeGoal(goal)) return;
    this.setGoal(chatId, claudeGoalExtended(goal, this.clock() / 1000));
    this.goalRestarts.set(chatId, { id: crypto.randomUUID(), key: this.keyOf(chatId), goal: this.goal(chatId) });
    await this.runPlan(chatId, claudeGoalResumePlan(goal, this.goalCrashed.delete(chatId)), false);
  }

  /** Clear: stop a running loop, clear the CLI's goal if it still has one, and forget the condition. */
  async clearGoal(chatId, human = false) {
    const goal = this.goal(chatId);
    // after a crash the CLI may still hold the goal Sage shows as paused
    const plan = this.goalCrashed.delete(chatId)
      ? [{ kind: 'send', text: '/goal clear' }]
      : claudeGoalClearPlan(goal, busy(this.state.get(chatId)));
    // held (not active) while the loop stops, so its last rounds don't bring the goal back
    if (goal?.status === 'active') this.setGoal(chatId, { ...goal, status: 'paused' });
    this.goalTurns.delete(chatId);
    await this.runPlan(chatId, plan, human, () => this.setGoal(chatId, null));
  }

  /** The goal button a window pressed. */
  goalAction(chatId, action, human = false) {
    switch (action) {
      case 'pause':
        return this.pauseGoal(chatId);
      case 'resume':
        return this.resumeGoal(chatId);
      case 'extend':
        return this.extendGoal(chatId);
      case 'clear':
        return this.clearGoal(chatId, human);
      default:
        return Promise.reject(new Error(`Unknown goal action ${action}`));
    }
  }
}

module.exports = { ClaudeAdapter, HANDOVER_GRACE_MS };
