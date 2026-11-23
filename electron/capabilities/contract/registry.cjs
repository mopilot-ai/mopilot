// The capability registry: the tools Sage gives agents (computer use, browser control, ...), the @host-portable: loads in the Host process without Electron (host/boundary.json).
// approval hook in front of them and a local operation log. Every call goes through invoke() in main,
// and runs once per call id however many windows or channels see the request.
const { identityKey } = require('../../../shared/identityKey.mjs');
const { observe } = require('../../../shared/observations.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { wellFormedText } = require('../../../shared/textPrefix.mjs');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { guarded } = require('./actionGuard.cjs');
const callPhases = require('./callPhases.cjs');
const { localBrowserRefusal, protectBrowserResult } = require('./localBrowserData.cjs');
const { HostScope, toolNeeds } = require('./hostScope.cjs');
const { TurnTokens, callTurnThread } = require('./turnTokens.cjs');
const { CallSurfaces } = require('./callSurfaces.cjs');
const { OperationLog } = require('./operationLog.cjs');
const { TaintLedger } = require('./taintLedger.cjs');
const { untrustedScreen, sourceOf } = require('./untrustedScreen.cjs');

/** The surface a tool needs from its chat's Host: its own `needs` (null: none), else by its name. */
const toolNeedsOf = (tool) => (tool.needs === undefined ? toolNeeds(tool.name) : tool.needs);

/** What the race against an abort answers when the call was aborted. */
const ABORTED = Symbol('aborted');
/** Why a call ended early, as the agent is told: its harness quit, the user stopped the turn, or the harness cancelled it. */
const ABORT_REASONS = {
  quit: 'The harness quit before this finished',
  stopped: 'The turn was stopped before this finished',
  cancelled: 'The harness cancelled this call before it finished',
};

/** observe: reads only. act: changes something that can be undone. irreversible: can't be undone. */
const POLICIES = new Set(['observe', 'act', 'irreversible']);

class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v);

/** Checks args against the top level of a JSON schema (required keys and property types); returns an error or null. */
function checkArgs(schema, args) {
  if (!schema) return null;
  if (typeOf(args) !== 'object') return 'arguments must be an object';
  for (const k of schema.required || []) if (args[k] === undefined) return `missing argument: ${k}`;
  for (const [k, p] of Object.entries(schema.properties || {})) {
    if (args[k] === undefined || !p || !p.type) continue;
    const t = typeOf(args[k]);
    const want = [].concat(p.type);
    if (!want.includes(t) && !(t === 'integer' && want.includes('number'))) return `argument ${k} must be ${want.join(' or ')}`;
  }
  return null;
}

/** A handler may return a string, a content item, a list of them, or {content}. */
function toContent(out) {
  if (out == null) return [];
  // text goes on to the harness as JSON, whose parsers refuse half of an emoji (a page or label cut short)
  if (typeof out === 'string') return [{ type: 'text', text: wellFormedText(out) }];
  if (Array.isArray(out)) return out.flatMap(toContent);
  if (Array.isArray(out.content)) return toContent(out.content);
  if (out.type) return contentBlocks([out]).map((b) => (typeof b.text === 'string' ? { ...b, text: wellFormedText(b.text) } : b));
  // JSON.stringify writes a lone half as the escape \udXXX, which those parsers refuse too: clean the strings first
  return [{ type: 'text', text: JSON.stringify(out, (_k, v) => (typeof v === 'string' ? wellFormedText(v) : v)) }];
}

/**
 * The answer of a handler whose result ends the agent's turn (`{ endsTurn: true, ...answer }`, the wrap-up box), without
 * the flag, which is the registry's to pass on (`endsTurn` on the result); null for any other answer.
 * @param {unknown} out
 */
function turnEnd(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out) || /** @type {any} */ (out).endsTurn !== true) return null;
  return Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'endsTurn'));
}

class Registry {
  /**
   * @param {{ approve?: (req: { chatId: string, segmentId: string, tool: string, policy: string, args: any }) => boolean | Promise<boolean>,
   *           log?: InstanceType<typeof OperationLog>, now?: () => number, taint?: InstanceType<typeof TaintLedger>, screen?: ResultScreen | null }} [o]
   */
  constructor(o = {}) {
    this.tools = new Map();
    this.approve = o.approve || null;
    this.log = o.log || new OperationLog();
    this.now = o.now || Date.now;
    /** @type {((chatId: string, refusal: import('./controlRefusals.cjs').Refusal) => void) | null} a call refused a no-go app (computer use sets it) */
    this.onNoGo = null;
    // call key -> promise of its result, so a repeated call id gets the first run's result
    this.calls = new Map();
    this.maxCalls = 1000;
    /** the chats kept apart from the coding side and the only tools they may use (setChatScope); none until main sets them */
    this.apart = (/** @type {string} */ _chatId) => false;
    this.apartAllows = (/** @type {string} */ _name, /** @type {string} */ _chatId) => true;
    /** @type {ChatGate | null} what runs each call of a chat kept apart (setChatGate); until main sets it, such a call is refused */
    this.chatGate = null;
    // chat -> the calls running for it, so they stop when its harness quits
    this.running = new Map();
    /** @type {WeakMap<AbortController, string>} each running call's segment, for abortSegment */
    this.segmentOf = new WeakMap();
    /** who else hears that a chat's calls were stopped (the Codex plugin's iab backend: its commands aren't Registry calls) */
    /** @type {Set<(chatId: string) => void>} */
    this.abortListeners = new Set();
    this.surfaces = new CallSurfaces(
      (chatId) => this.running.get(chatId) ?? [],
      (tool) => (toolNeedsOf(tool) === 'desktop' ? 'cu' : toolNeedsOf(tool)), // a Host's own desktop is computer use to the person too
      (error) => noteIgnored("tell a listener that a chat's tool calls changed", error),
    );
    /** every call's `(chat, turn)` token, retired when its chat's turn ends or its calls are stopped (./turnTokens.cjs) */
    this.turns = new TurnTokens();
    /** @type {TurnThreadRule} the Codex thread a call's turn is kept for, else null (setTurnThread) */
    this.turnThread = () => null;
    /** @type {InstanceType<typeof HostScope> | null} which tools the chat's owner Host can serve (setHostScope) */
    this.hostScope = null;
    /** @type {((name: string) => boolean) | null} true for a tool no agent session is shown (../visibility.cjs); null: none */
    this.hidden = null;
    /** @type {((name: string) => string) | null} */
    this.hiddenMessage = null;
    /** @type {Set<(name: string) => string | null>} what a call to a tool that doesn't exist is told instead (a guessed name) */
    this.unknownHints = new Set();
    /** G3's guard: the origins that tainted each chat's turn, and the screen every successful result passes through */
    this.taint = o.taint ?? new TaintLedger();
    /** @type {ResultScreen | null} */
    this.screen = o.screen === undefined ? untrustedScreen(this.taint) : o.screen;
  }

  /** The chat's turn ended (main's turn ledger, every harness): its host scope thaws and its taint goes. */
  turnEnded(/** @type {string} */ chatId) {
    this.hostScope?.thaw(chatId);
    this.taint.turnEnded(chatId);
  }

  /** What a call to `name`, which isn't a tool, is told: the tool to use when a hint knows it (every harness's channel). */
  unknownMessage(/** @type {string} */ name) {
    for (const hint of this.unknownHints) {
      const told = hint(String(name));
      if (told) return told;
    }
    return `Unknown tool: ${name}`;
  }

  /**
   * The app-wide visibility rule (../visibility.cjs ToolVisibility.hides): a hidden tool stays
   * registered but is left out of list() and refused by invoke(), on every harness's channel.
   * @param {((name: string) => boolean) | null} hidden
   * @param {((name: string) => string) | null} [message] what a call to a hidden tool is told
   */
  setHidden(hidden, message = null) {
    this.hidden = typeof hidden === 'function' ? hidden : null;
    this.hiddenMessage = typeof message === 'function' ? message : null;
  }

  /**
   * Which Codex thread a call's `(chat, turn)` token belongs to: each thread of a chat (its own, each sub-agent's) has
   * its own turn, so one thread's turn ending leaves the others' calls alone. Null (Claude Code, ACP): the chat's turn.
   * `meta`: what the harness said about the call (an MCP call's `_meta`), which may name the thread it came from; the
   * rule answers `{ thread, named }` then (named: the call named its thread), or a bare thread id, which does not
   * (./turnTokens.cjs callTurnThread).
   * @param {TurnThreadRule} fn
   */
  setTurnThread(fn) {
    this.turnThread = fn;
  }

  /**
   * The chats kept apart from the coding side (MoMo's, electron/momo/contract/toolIsolation.cjs) and the tools they may use: such
   * a chat sees and calls only those (default deny), so a tool added later stays out of it until it is allowed. A list
   * for no chat in particular keeps every tool, so no other chat loses one.
   * @param {(name: string, chatId: string) => boolean} allows (per chat: a data-only MoMo chat may use none)
   * @param {(chatId: string) => boolean} apart
   */
  setChatScope(allows, apart) {
    this.apartAllows = allows;
    this.apart = apart;
  }

  /**
   * What runs each call of a chat kept apart (MoMo's trust gate, electron/momo/toolTrust.cjs), on every harness's channel:
   * it decides the call and runs the handler through `run`, or throws a ToolError to refuse it. Without one, those chats'
   * calls are refused. Other chats' calls never reach it.
   * @param {ChatGate | null} gate
   */
  setChatGate(gate) {
    this.chatGate = typeof gate === 'function' ? gate : null;
  }

  /**
   * The chat's owner Host decides which surfaces its tools may use (./hostScope.cjs): a tool the Host lacks is left out of
   * the chat's list on every channel and refused at call time as `capability_missing`.
   * @param {((chatId: string) => Record<string, boolean> | null | undefined) | null} capsOf the owner Host's capabilities; null/undefined: no remote owner, every tool
   */
  setHostScope(capsOf) {
    this.hostScope = capsOf ? new HostScope({ capsOf, onError: (error) => noteIgnored("read a chat's host capabilities", error) }) : null;
  }

  /** Whether `chatId` is kept apart; a rule that throws keeps it apart (only its own tools stay). */
  isApart(chatId) {
    try {
      return this.apart(chatId) === true;
    } catch (error) {
      noteIgnored('tell whether a chat is kept apart from the chat tools', error);
      return true;
    }
  }

  /**
   * Whether chat `chatId` may see and call `tool`: every chat, unless the tool names the chats it serves (`visibleTo`,
   * MoMo's memory tools; a list for no chat in particular leaves those out), or the chat is kept apart and the tool isn't
   * one it may use (setChatScope). A rule that throws hides the tool.
   * @param {ToolDef} tool
   * @param {string | null | undefined} chatId
   */
  servesChat(tool, chatId) {
    if (typeof chatId === 'string' && chatId && this.isApart(chatId) && !this.apartAllows(tool.name, chatId)) return false;
    if (typeof chatId === 'string' && chatId && this.hostScope?.lacks(chatId, toolNeedsOf(tool))) return false;
    if (typeof tool.visibleTo !== 'function') return true;
    if (typeof chatId !== 'string' || !chatId) return false;
    try {
      return tool.visibleTo(chatId) === true;
    } catch (error) {
      noteIgnored('tell whether a chat may use a tool', error);
      return false;
    }
  }

  /** Whether agents are not shown `name` right now. */
  isHidden(name) {
    if (!this.hidden) return false;
    try {
      return this.hidden(name) === true;
    } catch {
      return false;
    }
  }

  /**
   * The chat's harness quit mid-turn (A23), or the user stopped its turn: calls still running for it end
   * now as 'aborted', and their handlers see ctx.signal abort (a computer-use action stops and lets go of
   * the desktop, a browser_batch stops between steps).
   * @param {string} chatId
   * @param {keyof typeof ABORT_REASONS} [why]
   * @param {string} [segmentId] only that segment's calls (abortSegment)
   */
  abortChat(chatId, why = 'quit', segmentId) {
    if (segmentId) return this.abortSegment(chatId, segmentId, why);
    // first: an executor that hears the abort (the helper, Your Chrome) already refuses the stopped turn's token
    this.turns.retire(chatId);
    this.hostScope?.thaw(chatId);
    for (const fn of this.abortListeners) {
      try {
        fn(chatId);
      } catch (error) {
        // one listener's error must not keep the chat's calls running
        noteIgnored("tell a listener a chat's calls were stopped", error);
      }
    }
    const set = this.running.get(chatId);
    if (!set) return 0;
    this.running.delete(chatId);
    for (const ac of set) ac.abort(ABORT_REASONS[why]);
    return set.size;
  }

  /**
   * One segment of a chat stopped while another may be current (an ACP session Stop reached after a switch, or one that
   * worked with no prompt: #1319 G17, G18): only its calls end as aborted, the chat's other calls go on.
   * @param {string} chatId
   * @param {string} segmentId
   * @param {keyof typeof ABORT_REASONS} [why]
   */
  abortSegment(chatId, segmentId, why = 'stopped') {
    const set = this.running.get(chatId);
    if (!set) return 0;
    let n = 0;
    for (const ac of [...set])
      if (this.segmentOf.get(ac) === segmentId) {
        set.delete(ac);
        ac.abort(ABORT_REASONS[why]);
        n++;
      }
    if (!set.size) this.running.delete(chatId);
    return n;
  }

  /** Calls `fn(chatId)` whenever a chat's calls are stopped (abortChat); returns a function that stops it. */
  onAbort(fn) {
    this.abortListeners.add(fn);
    return () => this.abortListeners.delete(fn);
  }

  /**
   * @param {ToolDef} tool
   * `authorizesItself`: the handler runs its own policy and cards (computer use: which app a call
   * reaches is only known there), so the approval hook isn't asked.
   */
  register(tool) {
    if (!tool || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name || '')) throw new Error(`bad tool name: ${tool && tool.name}`);
    if (!POLICIES.has(tool.policy)) throw new Error(`tool ${tool.name}: policy must be observe, act or irreversible`);
    if (typeof tool.handler !== 'function') throw new Error(`tool ${tool.name}: no handler`);
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} is already registered`);
    this.tools.set(tool.name, { description: '', schema: { type: 'object', properties: {} }, ...tool });
    return () => this.tools.delete(tool.name);
  }

  has(name) {
    return this.tools.has(name);
  }

  /**
   * What a harness is told about each tool (no handlers); `all`: hidden tools too. `chatId`: the chat the session
   * serves, which a tool that serves only some chats needs (servesChat).
   * @param {{ all?: boolean, chatId?: string | null }} [o]
   */
  list({ all = false, chatId = null } = {}) {
    return [...this.tools.values()]
      .filter((t) => all || (!this.isHidden(t.name) && this.servesChat(t, chatId)))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema, policy: t.policy }));
  }

  /** The approval hook: asked before every act or irreversible call. Without one those calls are refused. */
  setApprover(fn) {
    this.approve = fn;
  }

  /**
   * The single entry point. Runs only in main; a call id seen before returns that call's result
   * instead of running the tool again. Never throws: failures come back as {ok: false, error}.
   * `signal`: the harness's own cancel for this one call (the Agent SDK's, on Claude's channel); it aborts the run.
   * `meta`: what the harness said about the call (an MCP call's `_meta`); the turnThread rule reads the thread from it.
   * @param {string} chatId
   * @param {string} segmentId
   * @param {string} toolName
   * @param {any} args
   * @param {{ lookOnly?: { origins: string[] } | null, callId?: string | null, signal?: AbortSignal | null, meta?: unknown }} [opts]
   * @returns {Promise<{ chatId: string, segmentId: string, tool: string, callId: string | null, ok: boolean, content: any[], endsTurn?: true, error?: { code: string, message: string } }>}
   */
  invoke(chatId, segmentId, toolName, args, { callId = null, signal = null, meta = null, lookOnly = null } = {}) {
    const key = callId != null ? identityKey(chatId, segmentId, String(callId)) : null;
    const request = { chatId, segmentId, tool: toolName, callId };
    const refused = localBrowserRefusal(this.hostScope, request);
    if (refused) return Promise.resolve(refused);
    const protect = (result) => protectBrowserResult(this.hostScope, request, result);
    if (key && this.calls.has(key)) return this.calls.get(key).then(protect);
    // the call's time spans (./callPhases.cjs) are collected for its operation log entry
    const phases = {};
    const p = callPhases.within(phases, () => this.#run(chatId, segmentId, toolName, args ?? {}, callId, signal, meta, lookOnly, phases));
    if (key) {
      this.calls.set(key, p);
      if (this.calls.size > this.maxCalls) this.calls.delete(this.calls.keys().next().value);
    }
    return p.then(protect);
  }

  async #run(chatId, segmentId, toolName, args, callId, signal, meta, /** @type {{ origins: string[] } | null} */ lookOnly, phases) {
    const started = this.now();
    const base = { chatId, segmentId, tool: toolName, callId };
    const tool = this.tools.get(toolName);
    const finish = (res) => {
      observe({ kind: 'tool', chatId, tool: toolName, ok: res.ok, code: res.error?.code, durationMs: this.now() - started });
      this.log.add({
        at: started,
        chatId,
        segmentId,
        tool: toolName,
        policy: tool ? tool.policy : null,
        argKeys: args && typeof args === 'object' ? Object.keys(args) : [],
        outcome: res.ok ? 'ok' : res.error.code,
        ms: this.now() - started,
        ...(Object.keys(phases).length ? { phases } : {}),
      });
      return res;
    };
    const fail = (code, message) => finish({ ...base, ok: false, content: [], error: { code, message: wellFormedText(message) } });
    if (!chatId || !segmentId) return fail('no_owner', 'A tool call must name its chat and segment');
    if (!tool) return fail('unknown_tool', this.unknownMessage(toolName));
    // a session may have listed the tool before the rule changed (a remote switch, the browser channel)
    if (this.isHidden(toolName)) {
      /** @type {string | null} */
      let message = null;
      try {
        message = this.hiddenMessage && this.hiddenMessage(toolName);
      } catch (error) {
        // the generic unavailable message below still tells the agent
        noteIgnored('explain why a tool is unavailable', error);
      }
      return fail('unavailable', message || `${toolName} is unavailable`);
    }
    if (this.hostScope?.lacks(chatId, toolNeedsOf(tool)))
      return fail('capability_missing', `${toolName} isn't available on this chat's host`);
    if (!this.servesChat(tool, chatId)) return fail('unavailable', `${toolName} is unavailable in this chat`);
    const bad = checkArgs(tool.schema, args);
    if (bad) return fail('bad_args', bad);
    // a chat kept apart runs each call through its gate, and nothing runs before there is one
    const gate = this.isApart(chatId) ? (this.chatGate ?? false) : null;
    if (gate === false) return fail('unavailable', `${toolName} can't be checked in this chat yet, so it didn't run`);
    /** The user's approval of an act or irreversible call: null when it may run, else why not (nothing ran). */
    const approval = async () => {
      if (tool.policy === 'observe' || tool.authorizesItself) return null;
      let ok = false;
      try {
        ok =
          !!this.approve &&
          !!(await callPhases.span(
            'approval',
            () => this.approve?.({ chatId, segmentId, tool: toolName, policy: tool.policy, args }),
            this.now,
          ));
      } catch (e) {
        // a prompt that could not be shown fails closed, but it is not the user's refusal: the agent may ask again
        return new ToolError(`Couldn't ask the user to allow this action: ${messageOf(e)}`, 'unavailable');
      }
      return ok ? null : new ToolError('The user did not allow this action', 'denied');
    };
    // a gated call is asked for once its gate allowed it, so a call the gate refuses never shows a prompt
    if (!gate) {
      const refused = await approval();
      if (refused) return fail(refused.code, refused.message);
    }
    const ac = new AbortController();
    /** what the handler is given; it may leave hints for the result screen on it (`screen`: the page's hidden text) */
    const handlerCtx = /** @type {{ chatId: string, segmentId: string, callId: string | null, signal: AbortSignal, screen?: any }} */ ({
      chatId,
      segmentId,
      callId,
      signal: ac.signal,
      // a routine's replay (routineReplay.cjs): main's choice, never in a model's arguments; a tool that can act refuses to
      ...(lookOnly ? { lookOnly } : {}),
    });
    let set = this.running.get(chatId);
    if (!set) this.running.set(chatId, (set = new Set()));
    set.add(ac);
    this.segmentOf.set(ac, segmentId);
    this.surfaces.began(chatId, ac, tool, args);
    // resolves (never rejects, so nothing is left unhandled when the call finishes first) once the call is aborted
    const aborted = new Promise((resolve) => ac.signal.addEventListener('abort', () => resolve(ABORTED), { once: true }));
    // the harness cancelling this one call aborts it like a Stop would, for this call only
    const cancel = () => ac.abort(ABORT_REASONS.cancelled);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    let res;
    /** @type {ToolError | null} */
    let refusal = null;
    try {
      // the handler runs inside the call's guard: once the call is aborted, the helper and Your Chrome refuse its
      // requests and the desktop lock is not taken, however long the handler still runs (./actionGuard.cjs); its
      // `(chat, turn)` token goes to the executors, which refuse it once the turn ended or was stopped
      const run = guarded(
        {
          signal: ac.signal,
          token: (() => {
            const { thread, named } = callTurnThread(this.turnThread(chatId, segmentId, meta));
            return this.turns.issue(chatId, thread, { named });
          })(),
          current: (token) => this.turns.current(token),
          onRefusal: (code, message) => {
            refusal = new ToolError(message, code);
          },
          // an app computer use never controls: the chat's transcript says so (capabilities/contract/controlRefusals.cjs)
          onNoGo: (r) => this.onNoGo?.(chatId, r),
        },
        () => {
          const handle = () => tool.handler(args, handlerCtx);
          if (!gate) return handle();
          return gate({ chatId, segmentId, tool: toolName, policy: tool.policy, args, signal: ac.signal }, async () => {
            const refused = await approval();
            // refused before the handler: nothing was sent (the gate records it so)
            if (refused) throw Object.assign(refused, { notSent: true });
            return handle();
          });
        },
      );
      const out = await Promise.race([run, aborted]);
      if (out === ABORTED) throw refusal ?? new ToolError(String(ac.signal.reason), 'aborted');
      const end = turnEnd(out);
      const content = toContent(end ?? out);
      const screened = this.screen
        ? await callPhases.span(
            'screen',
            async () => this.screen?.({ chatId, tool: toolName, args, content, hints: handlerCtx.screen }),
            this.now,
          )
        : content;
      res = finish({ ...base, ok: true, content: screened, ...(end ? { endsTurn: true } : {}) });
    } catch (e) {
      res = fail(e instanceof ToolError && e.code ? e.code : 'failed', String((e && e.message) || e));
    }
    signal?.removeEventListener('abort', cancel);
    set.delete(ac);
    if (!set.size && this.running.get(chatId) === set) this.running.delete(chatId);
    this.surfaces.changed(chatId);
    return res;
  }

  /** The remote mirrors' view of the running calls (callSurfaces.cjs): who hears a change, and what a chat's calls show now. */
  onCallChange = (/** @type {(chatId: string) => void} */ fn) => this.surfaces.onChange(fn);
  surfaceOf = (/** @type {string} */ chatId) => this.surfaces.of(chatId);
  lastSurfaceOf = (/** @type {string} */ chatId) => this.surfaces.last(chatId);
  forgetSurface = (/** @type {string} */ chatId) => this.surfaces.forget(chatId);
}

/**
 * @typedef {{ name: string, description?: string, schema?: object, policy: 'observe'|'act'|'irreversible',
 *             handler: (args: any, ctx: any) => any, authorizesItself?: boolean, visibleTo?: (chatId: string) => boolean, needs?: 'iab' | 'cu' | 'bu' | 'shell' | 'thisMac' | null }} ToolDef
 * `visibleTo`: the chats that may see and call the tool (Registry.servesChat); without it, every chat
 */
/**
 * @typedef {(call: { chatId: string, segmentId: string, tool: string, policy: string, args: any, signal: AbortSignal },
 *            run: () => any) => Promise<any>} ChatGate runs one call of a chat kept apart: `run` asks the user's approval (an act the
 *            tool doesn't authorize itself), then runs the handler (setChatGate)
 */
/** @typedef {(call: { chatId: string, tool: string, args: any, content: any[], hints?: { hidden?: string[] | null } }) => any[] | Promise<any[]>} ResultScreen what a result's content becomes before the agent reads it (./untrustedScreen.cjs); it never throws */
/** @typedef {Omit<ToolDef, 'handler' | 'authorizesItself' | 'visibleTo'>} ToolSpec a tool's definition before its handler is attached */
/** @typedef {{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string, from?: string, screenshotId?: string }} ToolContent one block of a tool result (an image's `from` and `screenshotId` are for the browser tools' screenshot ids, taken off before it leaves them) */
/**
 * @typedef {(chatId: string, segmentId: string, meta?: unknown) => string | null | { thread: string | null, named: boolean }} TurnThreadRule
 * the thread whose turn a call is kept on (setTurnThread)
 */

module.exports = { Registry, OperationLog, ToolError, POLICIES, checkArgs, toContent, sourceOf };
