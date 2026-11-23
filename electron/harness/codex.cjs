// The Codex adapter in main: CodexAdapter's state over its layer modules (codexConnection to codexTurns), and its exports. @host-portable: loads in the Host process without Electron (host/boundary.json).
const { clock } = require('../platform/ports/clock.cjs');
const { NativeCodexLifecycle, chatCleanupState } = require('../capabilities/contract/codexLifecycle.cjs');
const { CodexIsolation } = require('./codexIsolation.cjs');
const { probeCodex } = require('./versions.cjs');
const { provisionalTitle } = require('../../shared/title.mjs');
const { withSelections } = require('../../shared/selections.mjs');
const { AppServer } = require('./codexProcess.cjs');
const { permissionParams, sandboxPolicyFor, buildInput, turnParams, chatPrefs } = require('./codexParams.cjs');
const { RpcError, BACKOFF_MS } = require('./codexConnection.cjs');
const { ThreadLocked, RELEASE_IDLE_MS } = require('./codexLeases.cjs');
const { CODEX_API } = require('./codexApi.cjs');
const { CodexTurns, goalErrorMessage } = require('./codexTurns.cjs');
const { CodexTurnCommands } = require('./codexTurnCommands.cjs');
const { CodexBackgroundWork } = require('./codexBackgroundWork.cjs');
const { CodexRemoteControl } = require('./codexRemoteControl.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { unrecordedError } = require('./codexUnrecorded.cjs');
const { userError } = require('../../shared/userError.mjs');
const { computerDown } = require('../capabilities/contract/codexSkyDown.cjs');

/** The chat's line when Codex Computer Use's service didn't start: this chat can't switch, new chats use MoPilot's. */
const SKY_DOWN_NOTE = "Codex Computer Use didn't start. Start a new chat to use MoPilot's.";

/* ------------------------------------------------------------------ */
/* the adapter: its state, and its methods in layers                   */
/* ------------------------------------------------------------------ */
// The `codex app-server` process (codexProcess.cjs), the one JSON-RPC connection to it, and everything Sage does
// with Codex turns and threads (design layers "Harness adapter"). Every request for a chat goes to the native thread
// nativeOf(chat) names. App-server messages are handled here once and reach the windows as item events
// (`codex:item`): notifications already mapped to their chat, approval cards, writer leases, and the steps of a turn
// this adapter started. CodexAdapter holds the state and extends the layers that act on it, each in its own module
// and typed against the adapter: codexConnection (requests, restarts) <- codexGoals <- codexEvents (app-server
// messages) <- codexLeases <- codexApi <- codexTurns.
class CodexAdapter extends CodexTurns {
  /** @returns {import('../../shared/peerMessages').PeerAdapterCapabilities} */
  peerCapabilities() {
    return { messaging: true, read: true, steer: true, toolChannel: 'channel.codex.threadConfigMcp' };
  }
  /**
   * The thread has no session behind it: Codex recorded nothing of it before a restart (codexUnrecorded.cjs), so a resume
   * fails with "no rollout found" (#2502). Any other failure is left to the send, which shows it.
   * @param {{ id: string }} ref
   */
  async sessionGone(ref) {
    if (this.unrecorded.has(ref.id) || this.leases.has(ref.id)) return false;
    try {
      await this.ensureResumed(ref.id);
      return false;
    } catch (e) {
      return unrecordedError(e);
    }
  }
  /**
   * @param {object} o
   * @param o.server AppServer
   * @param [o.nativeOf] (chatId) => { kind, id } the chat's current segment (ChatController.ref)
   * @param [o.chatOf] (nativeId) => chatId
   * @param [o.state] SessionStore: a chat's turn, queue and approvals keep its thread held
   * @param [o.prefs] () => the user's prefs (model, effort, permission, serviceTier)
   * @param [o.chatConfig] (chatId) => the chat's own model, effort and serviceTier (meta.config, D-29)
   * @param [o.keepSelection] (chatId, picked) => void: save the ones the chat has none of yet into meta.config
   * @param [o.probe] the runtime probes (versions.cjs); null runs none
   * @param [o.clientInfo] the app-server's client id
   * @param [o.emit] (event, target?) => void: an item event for every window, or (target set) for one
   * @param [o.observe] (msg) => void: sees each notification and server request after the windows
   * @param [o.turnChanges] TurnChanges: each turn's file changes
   * @param [o.onExit] (reason) => void: the app-server went away
   * @param [o.now] () => ms
   * @param [o.tools] MoPilot's tools for each thread (capabilities/channels/codexConfig.cjs)
   * @param [o.stopLog] (line) => void: the steps of a Stop, with no words of the chat in them
   * @param [o.log] (line) => void: the native stop timings
   * @param [o.onStopped] (chatId, turnId) => void: the app-server accepted a stop of a native turn
   * @param [o.provider] () => the model provider a new thread gets (identity/contract/codexProvider.cjs)
   * @param [o.providers] the CodexProviders the provider and a key still being stored for it come from
   * @param [o.backoff] the waits between crash restarts
   * @param [o.onStatus] (status) => void: restarting {attempt, inMs}, switched {from, to}, ready, gaveUp {copy, pinned}
   * @param [o.onFirstStart] () => void: the first app-server process is ready
   * @param [o.onSkyProblem] (threadId, problem) => void
   * @param [o.onNativeReset] (threadId) => void: MoPilot reset a native thread's plugin JS kernel
   * @param [o.goalStore] - { read() => {[threadId]: entry}, write(map) }: the threads whose goal is active,
   *   or was paused because MoPilot quit, kept across runs (WP5-4)
   * @param [o.isolated] (chatId) => boolean: the chat is kept apart from the coding side (MoMo's): its thread's memory is off
   */
  constructor(o) {
    super();
    this.server = o.server;
    this.nativeOf = o.nativeOf;
    this.chatOf = o.chatOf ?? ((id) => id);
    this.state = o.state;
    this.prefs = o.prefs ?? (() => ({}));
    this.chatConfig = o.chatConfig ?? (() => null);
    this.keepSelection = o.keepSelection ?? (() => false);
    this.isolation = new CodexIsolation({
      isolated: o.isolated ?? (() => false),
      chatOf: (threadId) => this.chatOf(threadId),
      held: (threadId) => this.server.isolated?.threads?.has(threadId) === true,
      call: (method, params) => this.call(method, params, 0, {}),
      unrecorded: (threadId) => this.unrecorded.has(threadId),
    });
    this.isolation.decides = typeof o.isolated === 'function';
    /** the runtime probes (versions.cjs); null runs none */
    this.probe = o.probe === undefined ? probeCodex : o.probe;
    this.clientInfo = o.clientInfo ?? { name: 'sage_codex_desktop', title: 'MoPilot', version: '' };
    this.emit =
      o.emit ??
      (() => {
        /* no listener */
      });
    this.observe =
      o.observe ??
      (() => {
        /* no listener */
      });
    this.turnChanges = o.turnChanges ?? null;
    this.onExit =
      o.onExit ??
      (() => {
        /* no listener */
      });
    this.now = o.now ?? (() => clock.now());
    /** When a thread was last loaded or worked in, or sent an event of its own (codexConnection.cjs USES_THREAD); 0: never. */
    this.lastActivity = 0;
    /** Threads with an open voice session (thread/realtime/start until stop or closed). */
    this.realtime = new Set();
    /** The main app-server's Remote Control link to the user's devices (codexRemoteControl.cjs). */
    this.remoteControl = new CodexRemoteControl({ request: (method, params) => this.request(method, params), note: noteIgnored });
    /** What reads each server event before the adapter does (electron/session/voice.cjs ends a writer its server closed). */
    this.serverObservers = new Set();
    /**
     * MoPilot's tools for each thread (capabilities/channels/codexConfig.cjs): sage-mcp added
     * to thread/start, fork and resume, its token rotated on each resume, and the thread's control path
     * (native: the vendor's computer-use plugin on; managed; helper). Null: threads start as Codex has them.
     */
    this.tools = o.tools ?? null;
    /**
     * Cleanup after a native thread (the vendor's computer-use plugin) used Browser or Computer use:
     * the plugin's turn_ended hook on the same connection, and the next turn waits for it.
     */
    /** native thread -> its plugin release status; a chat's strip shows its threads' together */
    this.cleanupStates = new Map();
    this.nativeLifecycle = new NativeCodexLifecycle({
      call: (method, params, timeoutMs) => this.call(method, params, timeoutMs),
      isNativeThread: (id) => this.isNative(id),
      isLoadedThread: (id) => this.tools?.isLoadedThread?.(id) === true,
      // one map of sub-agents for the injection, this lifecycle and the controller (codexParents.cjs)
      ...(o.tools?.parents ? { parents: o.tools.parents } : {}),
      // a stopped turn whose end was not confirmed in time: the app-server says whether it still runs
      // (by its status alone, newest first asked for explicitly; a turn not listed counts as ended)
      turnRunning: (threadId, turnId) =>
        this.call('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc' }, 10_000).then((r) =>
          (r?.data ?? []).some((t) => t?.id === turnId && t.status === 'inProgress'),
        ),
      // the bounded wait gave up: the next turn goes ahead, and the user is told it may join the stopped one
      onStopUnconfirmed: () =>
        this.emit(
          {
            kind: 'toast',
            level: 'error',
            text: 'Codex never confirmed the stopped turn ended, so this message was sent anyway. If Codex still seems busy with the old task, press Stop again.',
          },
          'any',
        ),
      // MoPilot reset the plugin's JS kernel on Stop: the apps its programs bound are gone
      onReset: (threadId) => this.onNativeReset(threadId),
      onError: (_id, error) =>
        this.emit({ kind: 'toast', level: 'error', text: `Native control cleanup failed: ${userError(error)}` }, 'any'),
      // per thread, shown per chat: a chat that switched threads shows a failure of any of them
      onState: (id, nativeCleanup) => {
        if (nativeCleanup) this.cleanupStates.set(id, nativeCleanup);
        else this.cleanupStates.delete(id);
        const chatId = this.chatOf(id);
        this.state?.patch(chatId, { nativeCleanup: chatCleanupState(this.cleanupStates, (thread) => this.chatOf(thread) === chatId) });
      },
      // native work on a thread whose last release failed: the turn stops rather than act on held resources
      onBlocked: (id, turnId, text) => {
        this.emit({ kind: 'toast', level: 'error', text }, 'any');
        // the turn may have ended already; the error toast was shown
        this.request('turn/interrupt', { threadId: id, turnId }).catch((error) => noteIgnored('stop a blocked native Codex turn', error));
      },
      onTiming: (t) => this.log(`[native-stop] ${t.event} thread=${t.threadId} turn=${t.turnId} ms=${t.ms} ok=${t.ok}`),
      onSkyProblem: (id, problem, turnId) => {
        this.onSkyProblem(problem);
        if (problem.kind === 'serviceUnavailable') this.skyDown(id, turnId);
      },
      now: () => this.now(),
    });
    /** (problem) => void: Codex Computer Use (Sky) reported a problem in a native thread (the settings status reads it) */
    this.onSkyProblem =
      o.onSkyProblem ??
      (() => {
        /* no problem listener configured */
      });
    /** (threadId) => void: MoPilot reset a native thread's plugin JS kernel (Codex Computer Use's bound apps are gone) */
    this.onNativeReset =
      o.onNativeReset ??
      (() => {
        /* no reset listener */
      });
    /** (line) => void: the native stop timings (stop -> idle, stop -> released) */
    this.log = o.log ?? ((line) => console.info(line));
    /** content-free lines of the stop path (a Host's log: host/src/codexFamily.mjs); none unless given */
    this.stopLog = o.stopLog ?? (() => undefined);
    /** (chatId, turnId) => void: the app-server accepted a stop of a native turn; the chat is idle from here */
    this.onStopped =
      o.onStopped ??
      (() => {
        /* no listener */
      });
    /** the model provider a new thread gets (identity/contract/codexProvider.cjs): independent of the tools, so it also applies without sage-mcp */
    this.provider = o.provider ?? (() => o.providers?.current() ?? null);
    /** a key still being stored for that provider: a thread opened meanwhile waits for it (codexConnection call) */
    this.providerPending = () => o.providers?.pending() ?? null;
    /** every added key's provider definition, so a thread that ran on a key resumes on it (#2213) */
    this.keptProviders = () => o.providers?.definitions() ?? {};
    this.seq = 0;
    /** requests in flight: id -> { resolve, reject } */
    this.pending = new Map();
    /** initialize, once per app-server process */
    this.init = null;
    /** the app-server failed or exited, and no one has connected again since */
    this.down = false;
    /** when the current process answered initialize (0: not yet) */
    this.readyAt = 0;
    /** crash restarts in a row, the pending one (a timer, or 'connecting'), and the waits between them */
    this.restarts = 0;
    /** @type {NodeJS.Timeout | 'connecting' | null} */
    this.restartTimer = null;
    this.backoff = o.backoff ?? BACKOFF_MS;
    /** starts in a row of the copy in use that ended before initialize answered */
    this.failedStarts = 0;
    /** (status) => void: restarting {attempt, inMs}, switched {from, to}, ready, gaveUp {copy, pinned} */
    this.onStatus =
      o.onStatus ??
      (() => {
        /* no listener */
      });
    this.onFirstStart =
      o.onFirstStart ??
      (() => {
        /* no listener */
      });
    /** native threads whose active goal was paused when Codex quit; set paused again once it is back */
    this.pauseOnReconnect = new Set();
    /** cua_repl requests held until the plugin's release confirmed: request id -> { threadId, turnId } */
    this.heldRequests = new Map();
    /** Structured thread/turn tuple -> {threadId, reason}; null turn means any turn of that thread. */
    this.hostDeclined = new Map();
    /** each native thread's running command items by turn: Stop ends the stopped turn's (#1940) */
    this.turnCommands = new CodexTurnCommands();
    /** each thread's background commands and running sub-agents, on its chat's session for every window (codexBackgroundWork.cjs) */
    this.backgroundWork = new CodexBackgroundWork({
      list: (threadId, ms) => this.call('thread/backgroundTerminals/list', { threadId }, ms, { background: true }),
      turning: () => this.running,
      rootOf: (id) => this.tools?.parents?.rootOf(id) ?? id,
      ownCommand: (id, item) => !!this.turnCommands.running.get(id)?.has(item) || this.turnCommands.stopping.has(identityKey(id, item)),
      shown: (threadId) => this.showsWork(threadId),
      publish: (threadId, work) => this.publishWork(threadId, work),
    });
    /** native threads with a compaction the user asked for on its way, and the turns those became */
    this.compacting = new Set();
    this.manualCompactions = new Set();
    /** each native thread's goal status, as last heard */
    this.goals = new Map();
    /** native thread -> its running turn's id */
    this.turnOf = new Map();
    this.goalStore = o.goalStore ?? null;
    /** goals left active by a run that ended without pausing them: paused before any thread is resumed */
    this.recovering = null;
    this.recoveredOnce = false;
    /** the config effort and recommended model, refreshed between turns; last-good data survives a failed refresh */
    this.defaultsP = null;
    this.defaultsGood = null;
    this.modelListP = null;
    /** @type {number | null} null while a refresh is in flight */
    this.defaultsAt = 0;
    this.userServersP = null;
    /** the folder-trust entries of the user's config, by path (codexTrust.cjs), read with userServersP */
    this.userTrust = {};
    /** what info() last read, and when */
    this.infoP = null;
    this.infoAt = 0;
    /** writer leases (design §07): native thread -> { at, pinned } */
    this.leases = new Map();
    this.resuming = new Map();
    this.releasing = new Set();
    /** permission updates for a running goal or voice session (codexRunPermission.cjs runPermission): native thread -> the last one, and its number */
    this.permissionRuns = new Map();
    this.permissionGens = new Map();
    /** native thread -> what its chat's permission was when applyPermission last set it (codexParams.cjs permissionKey) */
    this.permissionKeys = new Map();
    /** threads started for a new chat's composer that no send took yet (codexPrewarm.cjs): not leased, not the windows' */
    this.prewarmed = new Set();
    /** threads Sage started that no turn has recorded a user message on yet: Codex keeps nothing of them on disk (codexUnrecorded.cjs) */
    this.unrecorded = new Set();
    /** the unrecorded threads an app-server exit took with it: thread -> its folder (null: not known); a chat on one needs a new thread (#5160) */
    this.lostUnrecorded = new Map();
    /** what Sage last heard of each native thread: cwd, name, preview, ephemeral */
    this.meta = new Map();
    /** native threads with a turn running */
    this.running = new Set();
    /** helper threads (titles, handoff notes): their events stay here; thread -> listener */
    this.hidden = new Map();
    /** chat -> the provisional title it was given, until the generated one replaces it */
    this.titling = new Map();
    this.server.listeners.add((evt) => this.onServer(evt));
    this.server.stderrListeners?.add((text) => this.remoteControl.onStderr(text));
    // its answers' hooks run before main's intercept chain reads the answer (a switch claims the thread it started)
    this.server.ahead?.add((msg) => this.answerHook(msg));
  }

  /** The chats kept apart from the coding side (MoMo's), set by main once MoMo's services are made (app/momo.cjs). */
  setIsolated(/** @type {(chatId: string) => boolean} */ isolated) {
    this.isolation.isolated = isolated;
    this.isolation.decides = true;
  }

  /**
   * Codex Computer Use's service didn't start on native thread `id` (#1381): new chats already go to MoPilot's
   * computer use (nativeAvailability.cjs); this thread can't switch (codexSkyDown.cjs), so its chat says so, once.
   */
  skyDown(id, turnId) {
    if (!computerDown(this.tools, id) || !turnId) return;
    const item = { type: 'statusNote', id: `computer-${turnId}`, kind: 'computer', text: SKY_DOWN_NOTE };
    const out = this.mapped('item/completed', { threadId: id, turnId, item });
    if (out) this.emit({ kind: 'notification', chatId: out.chatId, method: 'item/completed', params: out.params });
  }
}

module.exports = {
  AppServer,
  CodexAdapter,
  CODEX_API,
  BACKOFF_MS,
  ThreadLocked,
  RpcError,
  buildInput,
  withSelections,
  permissionParams,
  sandboxPolicyFor,
  turnParams,
  chatPrefs,
  goalErrorMessage,
  provisionalTitle,
  RELEASE_IDLE_MS,
};
