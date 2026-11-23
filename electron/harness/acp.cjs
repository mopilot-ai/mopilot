// ACP session/turn orchestration and IPC: composes protocol, harness-process and client-method services.
// One process per harness, started on first use with the login shell's env snapshot; each chat is
// one ACP session on it. Chats are keyed by their renderer native id, 'acp:<harness>:<uuid>'; the
// agent's own session id is kept in the chat's transcript (threads/<key>.items.jsonl), which is also
// what the chat's history is read from (history 'sage').
const { clock } = require('../platform/ports/clock.cjs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

const { requestPermission } = require('./acp/permission.cjs');
const { sendPrompt } = require('./acp/prompt.cjs');
const { AcpQuestions } = require('./acp/questions.cjs');
const { RpcError, RpcPeer } = require('./acp/rpc.cjs');
const { AcpAgent, negotiate, spawn, PROTOCOL_VERSION, CLIENT_CAPABILITIES } = require('./acp/agent.cjs');
const { agentFor, releaseOwn } = require('./acp/launch.cjs');
const { guardSetting, holdPin } = require('./acp/isolation.cjs');
const { assertNoInstructions } = require('./instructionFiles.cjs');
const { Terminals, readTextFile, writeTextFile, isSageToolCall, allowOnce, guardIsolated, isIsolated } = require('./acp/clientMethods.cjs');
const { authenticate, loginAgent, signInNeeded } = require('./acp/signin.cjs');
const { listChats, searchChats } = require('./acp/history.cjs');
const { searchScans } = require('../platform/searchScans.cjs');
const { register } = require('./acp/ipc.cjs');
const { applySettings, catalogOf } = require('./acp/settings.cjs');
const { recordSessionUpdate } = require('./acp/sessionUpdates.cjs');
const { AcpTitleSessions } = require('./acp/titleSessions.cjs');
const { renameTitle } = require('./acp/rename.cjs');

const parseKey = (key) => {
  const m = /^acp:([^:]+):(.+)$/.exec(String(key ?? ''));
  return m ? { harness: m[1], id: m[2] } : null;
};
const keyOf = (harness, id) => `acp:${harness}:${id}`;

/**
 * Events ('event', e), each with the chat's key:
 * - turnStart {turnId, user, human, cwd}: a prompt went out (user: the message as the thread shows it; cwd: the chat's folder)
 * - update {turnId, update}: a session/update; turnId is null when no prompt is running
 * - turnEnd {turnId, stopReason, error, usage?}
 * - permission {requestId, toolCall, options} / permissionCancelled {requestId}
 * - session {sessionId, modes, configOptions, models, fresh}: the session is open (new, loaded or resumed; fresh: by session/new)
 * - unattended {reason}: the harness worked with no prompt running; it was cancelled
 * - closed {error}: the harness process went away
 * - transcriptError {error}: the chat's transcript could not be written; its records are kept and written again
 */
const { prepareSessionTools, releasePlugins } = require('./acpSessionTools.cjs');
const { audioEnd, audioHistory } = require('./acp/audio.cjs');

class AcpHost extends EventEmitter {
  /**
   * @param {object} o
   * @param o.items ItemsLog (electron/platform/chats.cjs)
   * @param o.quirks (harness) => {label, bins, args, env} | null
   * @param [o.ids] every harness it knows
   * @param o.resolveBin (harness, forChat?) => absolute path | null, possibly async when waiting for desktop admission
   * @param [o.env] () => env for child processes (the login shell snapshot)
   * @param [o.tools] - { prepare(key, o) => {serverName, mcpServers}, admission(key) => Promise<bool>, end(key) }
   * @param [o.plugins] - { forAcp({mcp, stdio}) => {mcpServers, release, withheld} }: MoPilot's plugins (electron/plugins/delivery.cjs)
   * @param o.pty electron/platform/pty.cjs
   * @param [o.notify] (kind, chatKey, {title, body}) => void
   * @param [o.cwd] where harness processes start (home)
   * @param [o.spawnFn] replaces child_process.spawn (tests)
   * @param [o.admitted] (harness) => null when it may start, else why not
   * @param [o.signedOut] (harness, stage, reason) => void: a chat's session/new or session/prompt (stage) asked for a sign-in
   * @param [o.signedIn] (harness) => void: a chat's prompt went through
   * @param [o.admission] runtime admission (signedOut, signedIn, noteCatalog): stands in for signedOut and signedIn
   * @param [o.defaults] (harness) => { mode?, config? } | null: what a new chat on it starts with
   * @param [o.mcpEnv] (harness, env) => the env layer turning the user's own MCP servers off for its process (acp/ownMcp.cjs)
   * @param [o.remoteRename] (key, name) => Promise | null: the person's name for a chat to its machine (null: the chat runs here)
   * @param [o.dataDir] where quirks may keep files
   * @param [o.now] () => ms
   * @param [o.cancelRetryMs] a Stop the agent ignores is sent again after this long
   * @param [o.cancelForceMs] then the turn ends here after this long
   */
  constructor(o) {
    super();
    this.items = o.items;
    /** each search box's newest search replaces its scan still running */
    this.searches = searchScans();
    this.quirksOf = o.quirks;
    /** every harness id the quirks know */
    this.ids = o.ids ?? [];
    this.resolveBin = o.resolveBin;
    this.envOf = o.env ?? (() => process.env);
    this.tools = o.tools ?? null;
    this.plugins = o.plugins ?? null;
    this.notifyFn =
      o.notify ??
      (() => {
        /* no listener */
      });
    this.cwd = o.cwd ?? process.cwd();
    this.spawnFn = o.spawnFn ?? spawn;
    /** (harness) => null when it may start, else why not (runtime admission) */
    this.admittedFn = o.admitted ?? (() => null);
    /** runtime admission (harness/admission.cjs): sign-in state and what a harness's sessions offer go back to it */
    this.admission = o.admission ?? null;
    this.signedOutFn = o.signedOut ?? ((h, stage, reason) => this.admission?.signedOut(h, stage, reason) ?? null);
    this.signedInFn = o.signedIn ?? ((h) => this.admission?.signedIn(h) ?? null);
    /** (harness) => { mode, config } new chats on it start with (prefs basicDefaults) */
    this.defaultsOf = o.defaults ?? (() => null);
    this.mcpEnvOf = o.mcpEnv ?? (() => ({}));
    this.remoteRename = o.remoteRename ?? (() => null);
    /** where quirks may keep files (dsh's patch) */
    this.dataDir = o.dataDir ?? null;
    this.now = o.now ?? (() => clock.now());
    /** a Stop the agent ignores: cancel again after this long, then end the turn here after the second */
    this.cancelRetryMs = o.cancelRetryMs ?? 5000;
    this.cancelForceMs = o.cancelForceMs ?? 15000;
    this.terminals = new Terminals(o.pty);
    /** harness -> Promise<AcpAgent> */
    this.agents = new Map();
    /** chat key -> Promise<AcpAgent>: a MoMo chat's confined process, its own so no other session shares its MCP servers (#2302) */
    this.isolatedAgents = new Map();
    this.codingAgents = new Map(); // chat key -> a coding chat's own process (#2311)
    /** @type {((key: string) => boolean) | null} whether a chat is kept apart (MoMo's): set by main (app/momo.cjs) */
    this.isolated = null;
    /** key -> chat runtime */
    this.chats = new Map();
    /** chat key -> a send still starting the agent or its session: a Stop then keeps its prompt from going */
    this.starting = new Map();
    /** agent instance -> native session id -> chat runtime */
    this.bySession = new Map();
    /** requestId -> { key, resolve } */
    this.perms = new Map();
    this.permSeq = 0;
    this.questions = new AcpQuestions(this);
    this.titleSessions = new AcpTitleSessions();
    // the transcript is written in the background (electron/platform/transcriptWriter.cjs): a failure reaches the chat
    this.stopWriteErrors = this.items?.onWriteError?.((key, error) => {
      if (parseKey(key)) this.emitEvent({ key, kind: 'transcriptError', error: String(error?.message ?? error) });
    });
  }

  emitEvent(e) {
    this.emit('event', e);
  }
  /** A failure that asks for a sign-in or a setup reads Signed out (admission.cjs); returns it as the chat shows it. */
  authFailed(harness, e, stage, agent) {
    return signInNeeded(this, harness, e, stage, agent);
  }
  label(harness) {
    return this.quirksOf(harness)?.label ?? harness;
  }

  /* -- processes ---------------------------------------------------- */
  /** The harness's process, started on first use; `own`: the key of the chat kept apart whose confined process it is. */
  agent(harness, own = null, isolated = !!own) {
    return agentFor(this, harness, own, isolated);
  }
  onAgentExit(agent, info) {
    // only its own entry: one that failed to start exits late, after the next agent took its place
    const agents = agent.map ?? this.agents;
    if (agent.entry && agents.get(agent.slot) === agent.entry) agents.delete(agent.slot);
    const error = info.error ?? `${this.label(agent.harness)} exited${info.code != null ? ` (${info.code})` : ''}`;
    for (const [key, chat] of this.chats) {
      if (chat.agent !== agent) continue;
      this.chats.delete(key);
      if (chat.sessionId) this.unbindSession(chat, chat.sessionId);
      this.endTools(key, chat);
      this.cancelPermissions(key);
      if (chat.prompting) this.finish(chat, null, error);
      this.emitEvent({ key, kind: 'closed', error });
    }
  }

  /* -- sessions ----------------------------------------------------- */
  assertChatCurrent(chat) {
    if (this.chats.get(chat.key) !== chat) throw new Error('ACP chat closed during this operation');
  }
  bindSession(chat, sessionId) {
    this.assertChatCurrent(chat);
    let sessions = this.bySession.get(chat.agent);
    if (!sessions) this.bySession.set(chat.agent, (sessions = new Map()));
    sessions.set(sessionId, chat);
  }
  unbindSession(chat, sessionId) {
    this.questions.retire(chat);
    this.terminals.releaseSession(chat);
    const sessions = this.bySession.get(chat.agent);
    if (sessions?.get(sessionId) !== chat) return;
    sessions.delete(sessionId);
    if (!sessions.size) this.bySession.delete(chat.agent);
  }
  chatOf(agent, sessionId) {
    return this.bySession.get(agent)?.get(sessionId) ?? null;
  }

  /** The chat's live session: opened now when it has none (new, or loaded/resumed after a restart). */
  /**
   * @param {string} key
   * @param {{ cwd?: string, chatId?: string }} [opts]
   */
  ensure(key, { cwd, chatId } = {}) {
    const live = this.chats.get(key);
    if (live?.ready) return live.ready;
    const k = parseKey(key);
    if (!k) return Promise.reject(new Error(`Not an ACP chat: ${key}`));
    const chat = {
      key,
      harness: k.harness,
      chatId: chatId ?? key,
      // kept apart from the coding side (MoMo's), by the session's chat or the chat that switched to it; fixed for its life
      isolated: this.isolated?.(key) === true || (!!chatId && this.isolated?.(chatId) === true),
      agent: /** @type {InstanceType<typeof AcpAgent> | null} */ (null),
      sessionId: null,
      cwd: null,
      prompting: null,
      serverName: null,
      /** lets go of the plugin folders its session was given (electron/plugins/delivery.cjs) */
      releasePlugins: /** @type {(() => unknown) | null} */ (null),
      loading: false,
      unattendedAt: 0,
    };
    chat.ready = this.open(chat, cwd).catch((cause) => {
      const e = this.authFailed(chat.harness, cause, 'session/new', chat.agent);
      if (this.chats.get(key) === chat) {
        this.chats.delete(key);
        this.endTools(key, chat);
      }
      // a chat that never opened lets go of its plugin folders even when another chat now holds the key
      releasePlugins(chat);
      if (chat.sessionId) this.unbindSession(chat, chat.sessionId);
      throw e;
    });
    this.chats.set(key, chat);
    return chat.ready;
  }

  /** A chat's session is over: its tool channel closes and its plugin folders are let go. */
  endTools(key, chat) {
    this.tools?.end(key);
    releasePlugins(chat);
    if (chat.own) releaseOwn(this, key);
  }

  async open(chat, cwdArg) {
    chat.own = chat.isolated || this.quirksOf(chat.harness)?.mcpScope !== 'session';
    const agent = await this.agent(chat.harness, chat.own ? chat.key : null, chat.isolated);
    this.assertChatCurrent(chat);
    chat.agent = agent;
    const prev = await this.lastSession(chat.key);
    this.assertChatCurrent(chat);
    const cwd = prev?.cwd ?? cwdArg;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('This chat has no folder');
    if (chat.isolated) assertNoInstructions(cwd);
    chat.cwd = cwd;
    const mcpServers = await prepareSessionTools(this, chat, agent, prev);
    this.assertChatCurrent(chat);
    // agent() resolves once initialize() negotiated the caps
    const caps = /** @type {NonNullable<InstanceType<typeof AcpAgent>['caps']>} */ (agent.caps);
    /** @type {{ sessionId?: unknown, modes?: unknown, configOptions?: unknown, models?: unknown } | null} */
    let res = null;
    /** @type {string | null} */
    let note = null;
    if (prev?.sessionId && (caps.loadSession || caps.resume)) {
      chat.sessionId = prev.sessionId;
      this.bindSession(chat, prev.sessionId);
      try {
        // session/load replays the history as updates; the thread already shows it from the transcript
        chat.loading = caps.loadSession;
        res = await agent.request(caps.loadSession ? 'session/load' : 'session/resume', { sessionId: prev.sessionId, cwd, mcpServers });
      } catch (e) {
        this.unbindSession(chat, prev.sessionId);
        chat.sessionId = null;
        note = `Couldn't reopen the ${this.label(chat.harness)} session (${e?.message ?? e}); continuing in a new one`;
      } finally {
        chat.loading = false;
      }
    } else if (prev?.sessionId)
      note = `${this.label(chat.harness)} can't reopen sessions; continuing in a new one with the history shown here`;
    this.assertChatCurrent(chat);
    const fresh = !chat.sessionId;
    if (fresh) {
      chat.state = null; // a failed load's partial replay belongs to the retired native generation
      res = await agent.request('session/new', { cwd, mcpServers });
      if (typeof res?.sessionId !== 'string') throw new Error(`${this.label(chat.harness)} didn't return a session`);
      chat.sessionId = res.sessionId;
      this.bindSession(chat, res.sessionId);
      this.items.append(chat.key, { t: 'session', harness: chat.harness, sessionId: res.sessionId, cwd, at: this.now() });
    }
    if (this.tools && !(await this.tools.admission(chat.key))) {
      throw new Error(`MoPilot can't give ${this.label(chat.harness)} computer and browser control`);
    }
    this.assertChatCurrent(chat);
    chat.state = {
      ...chat.state,
      modes: res?.modes ?? chat.state?.modes ?? null,
      configOptions: res?.configOptions ?? chat.state?.configOptions ?? null,
      models: res?.models ?? agent.initialModels ?? chat.state?.models ?? null,
    };
    // a new session shows what the harness offers new chats; a new chat starts on the defaults chosen for them
    // (an isolated session is on MoMo's mode instead: not what new chats are offered, nor started on)
    if (!prev && !chat.isolated && this.admission?.acceptsBin?.(chat.harness, agent.command, agent.binaryStamp) !== false)
      this.admission?.noteCatalog?.(chat.harness, catalogOf(chat.state));
    const failed = await this.reapplySettings(chat, prev || chat.isolated ? null : (this.defaultsOf(chat.harness) ?? {}));
    if (chat.isolated) await holdPin(this, chat, this.quirksOf(chat.harness).isolation.mode);
    this.assertChatCurrent(chat);
    if (failed.length)
      note = [note, `${this.label(chat.harness)} didn't take ${failed.join(', ')}; it keeps its own`].filter(Boolean).join(' · ');
    // quirks' anchors per mode (readOnly, ask, auto, full) for the computer-use authorization table
    const anchors = this.quirksOf(chat.harness)?.anchors ?? {};
    this.emitEvent({ key: chat.key, kind: 'session', sessionId: chat.sessionId, caps, note, anchors, fresh, ...chat.state });
    return chat;
  }

  /** The chat's mode and config options set on its session (acp/settings.cjs); `defaults` for a new chat. */
  reapplySettings(chat, defaults = null) {
    return applySettings(this, chat, defaults);
  }

  /** Whether the chat's agent takes images (its declared prompt capability), or null before its session opened. */
  takesImages(key) {
    const caps = this.chats.get(key)?.agent?.caps;
    return caps ? !!caps.image : null;
  }

  /** The newest session record in a chat's transcript, read without blocking the main process. */
  async lastSession(key) {
    const recs = await this.items.readAsync(key);
    for (let i = recs.length - 1; i >= 0; i--) if (recs[i].t === 'session') return recs[i];
    return null;
  }

  /* -- turns -------------------------------------------------------- */
  /**
   * Send a prompt. Resolves once it went out ({turnId}); the turn ends with a turnEnd event.
   * @param {object} p
   * @param p.blocks ACP content blocks
   * @param [p.display] the message as the thread shows it
   * @param [p.cwd] for a new chat
   * @param [p.initialPermission] the linked chat's inherited cap, applied only before its first recorded prompt; p.config: acp/prompt.cjs
   */
  send(key, p, meta = {}) {
    return sendPrompt(this, key, p, meta);
  }

  finish(chat, stopReason, error, run = chat.prompting, { forced = false, usage = undefined } = {}) {
    if (!run || chat.prompting !== run) return;
    chat.prompting = null;
    for (const t of run.escalation ?? []) clock.clearTimeout(t);
    // a cancelled prompt may answer with an error; it was still a cancel (unless the agent never stopped)
    const cancel = run.cancelled && !forced;
    const reason = cancel ? 'cancelled' : (stopReason ?? 'error');
    const why = audioEnd(this, chat, run, reason, cancel ? null : error);
    this.items.append(chat.key, { t: 'end', turnId: run.turnId, stopReason: reason, ...why, at: this.now() });
    // a finished turn is on disk now, not at the next batch
    void this.items.flush?.(chat.key);
    const end = { key: chat.key, kind: 'turnEnd', turnId: run.turnId, stopReason: reason, ...why };
    // usage: what the agent's prompt response counted, for the request ledger (electron/ledger/acpTap.cjs)
    this.emitEvent(usage ? { ...end, usage } : end);
    if (chat.retireAfterTurn && this.chats.get(chat.key) === chat) this.close(chat.key);
  }

  /**
   * Stop: session/cancel, and the agent's open permission requests answer 'cancelled'. An agent
   * that ignores it is asked once more after cancelRetryMs; one that still runs after
   * cancelForceMs ends the turn here, as one that did not stop.
   */
  cancel(key) {
    const chat = this.chats.get(key);
    // still starting (no prompt sent yet): the prompt won't go
    const start = this.starting.get(key);
    if (start) start.cancelled = true;
    if (chat) this.questions.retire(chat);
    if (start && !chat?.prompting) return true;
    if (!chat?.sessionId || !chat.agent) return false;
    const run = chat.prompting;
    if (run) {
      run.cancelled = true;
      if (!run.escalation) this.escalate(chat, run);
    }
    this.cancelPermissions(key);
    chat.agent.notify('session/cancel', { sessionId: chat.sessionId });
    return true;
  }

  escalate(chat, run) {
    const live = () => chat.prompting === run && chat.agent && this.chats.get(chat.key) === chat;
    const retry = clock.setTimeout(() => {
      if (!live()) return;
      this.cancelPermissions(chat.key);
      chat.agent.notify('session/cancel', { sessionId: chat.sessionId });
    }, this.cancelRetryMs);
    const force = clock.setTimeout(() => {
      if (!live()) return;
      this.cancelPermissions(chat.key);
      // its late answer to the prompt, if one ever comes, is ignored: the turn is over here
      this.finish(
        chat,
        'error',
        `${this.label(chat.harness)} did not stop when asked. The turn was ended here; anything it was still doing may keep running.`,
        run,
        { forced: true },
      );
    }, this.cancelForceMs);
    retry.unref?.();
    force.unref?.();
    run.escalation = [retry, force];
  }

  cancelPermissions(key) {
    for (const [id, p] of this.perms) {
      if (p.key !== key) continue;
      this.perms.delete(id);
      p.resolve({ outcome: { outcome: 'cancelled' } });
      this.emitEvent({ key, kind: 'permissionCancelled', requestId: id });
    }
  }

  /** The user's answer to a permission card: an optionId, or null to cancel. */
  permission(requestId, optionId) {
    const p = this.perms.get(requestId);
    if (!p) return false;
    this.perms.delete(requestId);
    p.resolve(
      typeof optionId === 'string' && optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
    );
    return true;
  }

  /**
   * The harness worked with no prompt running (unattended): cancel it again, at most once a second,
   * and tell the user once.
   */
  unattended(chat, reason) {
    const now = this.now();
    if (now - chat.unattendedAt < 1000) return;
    const first = !chat.unattendedAt;
    chat.unattendedAt = now;
    chat.agent.notify('session/cancel', { sessionId: chat.sessionId });
    this.emitEvent({ key: chat.key, kind: 'unattended', reason });
    if (first)
      this.notifyFn('approval', chat.chatId, {
        title: `${this.label(chat.harness)} tried to work on its own`,
        body: 'It was stopped. Send a message to continue.',
      });
  }

  /* -- what the agent sends ----------------------------------------- */
  onAgentNotification(agent, method, params) {
    if (this.titleSessions.take(agent, method, params)) return;
    if (method !== 'session/update') {
      // a harness's own extension notification its quirks map onto the thread
      const chat = this.chatOf(agent, params?.sessionId);
      if (chat?.agent === agent) this.extension(chat, method, params);
      return;
    }
    const chat = this.chatOf(agent, params?.sessionId);
    if (!chat || chat.agent !== agent) return;
    this.record(chat, params.update, params._meta);
  }

  /** Run a quirks extension (cursor/update_todos, …): its update goes into the thread; returns its result. */
  extension(chat, method, params) {
    const fn = this.quirksOf(chat.harness)?.extensions?.[method];
    if (typeof fn !== 'function') return undefined;
    const out = fn(params) ?? {};
    if (out.update) this.record(chat, out.update);
    return out.result ?? null;
  }

  record(chat, update, meta) {
    recordSessionUpdate(this, chat, update, meta);
  }

  async onAgentRequest(agent, method, params, context) {
    const titling = this.titleSessions.answer(agent, method, params);
    if (titling !== undefined) return titling;
    if (method === 'elicitation/create') return this.questions.open(agent, params, context);
    const chat = guardIsolated(this, method, this.chatOf(agent, params?.sessionId));
    if (!chat || chat.agent !== agent) throw new RpcError(-32602, `Unknown session: ${params?.sessionId}`);
    switch (method) {
      case 'session/request_permission':
        return this.requestPermission(chat, params);
      case 'fs/read_text_file':
        return readTextFile(params);
      case 'fs/write_text_file':
        return writeTextFile(params);
      case 'terminal/create':
        return this.terminals.create(chat, { cwd: chat.cwd, ...params });
      case 'terminal/output':
        return this.terminals.output(params, chat);
      case 'terminal/wait_for_exit':
        return this.terminals.waitForExit(params, chat);
      case 'terminal/kill':
        return this.terminals.kill(params, chat);
      case 'terminal/release':
        return this.terminals.release(params, chat);
      default: {
        const result = this.extension(chat, method, params);
        if (result === undefined) throw new RpcError(-32601, `Method not found: ${method}`);
        return result;
      }
    }
  }

  requestPermission(chat, params) {
    return requestPermission(this, chat, params);
  }

  /** Change the session's mode (session/set_mode); takes effect from its next turn. */
  async setMode(key, modeId) {
    const chat = await this.live(key);
    this.assertChatCurrent(chat);
    guardSetting(chat, this.quirksOf(chat.harness)?.isolation?.mode, { modeId });
    await chat.agent.request('session/set_mode', { sessionId: chat.sessionId, modeId });
    this.assertChatCurrent(chat);
    this.items.append(key, { t: 'mode', modeId, at: this.now() });
    this.emitEvent({ key, kind: 'state', state: { modes: { ...(chat.state?.modes ?? { availableModes: [] }), currentModeId: modeId } } });
    if (chat.state?.modes) chat.state.modes.currentModeId = modeId;
  }

  /** Change one config option (model, thought level, …): session/set_config_option, applied from the next turn. */
  async setConfigOption(key, configId, value) {
    const chat = await this.live(key);
    this.assertChatCurrent(chat);
    guardSetting(chat, this.quirksOf(chat.harness)?.isolation?.mode, { configId, value });
    const res = await chat.agent.request('session/set_config_option', { sessionId: chat.sessionId, configId, value });
    this.assertChatCurrent(chat);
    // an agent that answers without the options has taken the value all the same
    const configOptions = Array.isArray(res?.configOptions)
      ? res.configOptions
      : (chat.state?.configOptions ?? []).map((o) => (o.id === configId ? { ...o, currentValue: value } : o));
    chat.state = { ...chat.state, configOptions };
    this.emitEvent({ key, kind: 'state', state: { configOptions } });
    this.items.append(key, { t: 'config', configId, value, at: this.now() });
  }

  /** The chat's open session; reopened from its transcript when it has none. */
  live(key) {
    const c = this.chats.get(key);
    if (c?.ready) return c.ready;
    return this.lastSession(key).then((prev) => {
      if (!prev) throw new Error('Send a message first');
      // a session another call opened meanwhile is joined (ensure)
      return this.ensure(key, {});
    });
  }

  /** Sign in with one of the agent's authMethods over ACP (acp/signin.cjs); an aborted signal stops waiting. */
  authenticate(harness, methodId, signal) {
    return authenticate(this, harness, methodId, signal);
  }
  /** A process for signing in: the chat process when one runs, else a short-lived one. */
  agentForLogin(harness) {
    return loginAgent(this, harness);
  }

  /* -- history and listing ------------------------------------------ */
  /** The chat's transcript records (for replay in the window), read without blocking the main process. */
  history(key) {
    return audioHistory(this, key);
  }

  /** Chats with a transcript: id, harness, cwd, first prompt, times (acp/history.cjs). */
  list() {
    return listChats(this.items, parseKey);
  }

  /**
   * Chats whose title or transcript holds `term`, newest first (list() entries); the scan is bounded, and a
   * `caller`'s next search (main's IPC names it by window and box) replaces the one it still runs.
   */
  search(term, limit = 30, caller = null) {
    return this.searches(caller, (replaced) => searchChats(this.items, parseKey, term, limit, replaced));
  }

  /** A chat's title is Sage's (the harness has none over ACP); kept in its transcript. `auto`: not the user's. A person's name for a chat on a machine goes to it too: a promise (acp/rename.cjs), else null. */
  rename(key, name, auto = false) {
    return parseKey(key) ? renameTitle(this, key, name, auto) : null;
  }

  /** The chat's latest title record: the one written in this run at once (no read a rename could slip past), else read. */
  async titleOf(key) {
    return this.titleSessions.latest.get(key) ?? (await this.items.readKindsAsync(key, ['title'])).findLast((r) => r.t === 'title') ?? null;
  }

  /** A title for a chat's first message, written in a hidden session on the chat's agent (acp/titleSessions.cjs); none for a MoMo chat (#2364). */
  titleFor(key, prompt, timeoutMs) {
    const chat = this.chats.get(key);
    const q = chat && this.quirksOf(chat.harness);
    if (!chat?.agent || !chat.cwd || q?.titleSessions === false || isIsolated(this, key)) return Promise.resolve(null);
    return this.titleSessions.write(chat.agent, chat.cwd, prompt, timeoutMs, q?.anchors ?? {});
  }

  /** Delete a chat: its session is let go and its transcript removed. */
  remove(key) {
    if (!parseKey(key)) return;
    this.close(key);
    this.items.remove(key);
  }

  /** Let go of a chat's session (closing the chat for good, or the app quitting). */
  close(key) {
    const chat = this.chats.get(key);
    if (!chat) return;
    void this.items.flush?.(key);
    this.chats.delete(key);
    this.cancelPermissions(key);
    const run = chat.prompting;
    if (run) {
      // its turn ends with the chat: a late answer to the prompt writes nothing (a deleted transcript stays deleted)
      chat.prompting = null;
      for (const t of run.escalation ?? []) clock.clearTimeout(t);
      // the agent stops working for a chat that is gone (session/close alone is optional for an agent)
      if (chat.sessionId) chat.agent.notify('session/cancel', { sessionId: chat.sessionId });
      // the controller and the windows see the turn end (as a Stop), so nothing waits on a chat that is gone
      this.emitEvent({ key, kind: 'turnEnd', turnId: run.turnId, stopReason: 'cancelled', error: null });
    }
    if (chat.sessionId) {
      this.unbindSession(chat, chat.sessionId);
      if (chat.agent?.caps?.close)
        // the chat is closed locally either way
        chat.agent.request('session/close', { sessionId: chat.sessionId }).catch((error) => noteIgnored('close an ACP session', error));
    }
    this.endTools(key, chat);
  }

  /**
   * A chat archived or left with /new: its sessions are let go now, or once a running turn ends (as Claude's
   * CLIs are), so an agent does not keep every chat it ever had open.
   * @returns {number} how many sessions are let go now
   */
  retireChat(chatId) {
    let n = 0;
    for (const chat of [...this.chats.values()]) {
      if (chat.chatId !== chatId) continue;
      // still opening (a send is starting) or running: after that turn
      if (chat.prompting || !chat.sessionId) chat.retireAfterTurn = true;
      else {
        this.close(chat.key);
        n++;
      }
    }
    return n;
  }

  closeAll(restartOnly = false) {
    for (const key of [...this.chats.keys()]) this.close(key);
    if (!restartOnly) this.stopWriteErrors?.(); // the shared transcript writer stops reporting to this host, unless the agents only restart (a Host's lease changed: the next send starts them)
    for (const p of [...this.agents.values(), ...this.isolatedAgents.values(), ...this.codingAgents.values()])
      p.then(
        (a) => a.kill(),
        () => {
          /* an agent that failed to start has nothing to kill */
        },
      );
    this.agents.clear();
    this.isolatedAgents.clear(), this.codingAgents.clear();
  }
}

module.exports = {
  AcpHost,
  AcpAgent,
  RpcPeer,
  RpcError,
  Terminals,
  negotiate,
  isSageToolCall,
  allowOnce,
  readTextFile,
  writeTextFile,
  parseKey,
  keyOf,
  register,
  PROTOCOL_VERSION,
  CLIENT_CAPABILITIES,
};
