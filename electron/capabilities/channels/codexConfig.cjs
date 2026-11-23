// Codex's tool channel: a per-thread config fragment on thread/start, thread/fork and thread/resume.
// It adds sage-mcp as mcp_servers.sage_<nonce> (MoPilot's host tools). With approvalPolicy "never"
// Codex fails MCP calls that aren't pre-approved, so the server's tools are approved up front; MoPilot authorizes each call in its own handlers.
//
// Desktop and browser control depends on the thread's path:
// - native (native.codex.enabled, and the vendor runtime for at least one surface exists on this Mac,
//   nativeAvailability.cjs): the vendor's bundled plugin unified-computer-use@openai-bundled is switched
//   on, so the thread uses Codex's own Browser (the user's Chrome) and Computer use, with its
//   instructions and approvals. sage-mcp is still added for MoPilot's other host tools, and keeps
//   MoPilot's own tools for a surface whose runtime is missing (the model is told which). The plugin's
//   in-app browser ("iab") is MoPilot's pane, served per thread by browser/iabBackend.cjs.
// - managed: the plugin is switched off and sage-mcp is the only way the agent works the desktop.
// - helper (a thread MoPilot runs for itself): the plugin is off and there is no sage-mcp.
// The user's own node_repl (wired to the Sky computer-use and browser services) goes off on every path
// when their config defines one: the override needs an existing server to switch off (X14). codex_apps
// has no such switch; features.apps=false removes it, which MoPilot leaves to the user for now.
// An already-loaded thread keeps its path until it is unloaded and resumed: a resume while it is loaded carries the
// same config again, since Codex may shut the loaded thread down and spawn it from that request's config (#2500).
const { noteIgnored } = require('../../ignored.cjs');
const { callBackends, hasBackend } = require('./codexBrowserBackends.cjs');
const { ContextNotes } = require('./contextNotes.cjs');
const { surfaceNote, shownTools } = require('../contract/surfaceNote.cjs');
const { withSessionsNote } = require('../contract/sessionsNote.cjs');
const { isCodexChildThreadId } = require('../../../shared/codexAgentRelations.mjs');
const { CodexThreadParents } = require('../contract/codexParents.cjs');
const { turnThreadOf } = require('./codexTurnThread.cjs');
const { chromeSelectionNote, readChromeInstances } = require('../browser/codexChromePick.cjs');
const crypto = require('node:crypto');

const contracts = require('./codexThreadContracts.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { routedSurfaces, chromeToolsNote, loadedChromeSurfaces, ownChromeNote } = require('./codexPluginChrome.cjs');
const { ISOLATED_THREAD, isolateConfig, sessionHide, startOwner } = require('../../harness/codexIsolation.cjs');
const {
  issuedThreadConfig,
  nativeThreadConfig,
  helperThreadConfig,
  mergeConfig,
  inAppBrowserNote,
  notesWithoutBrowserTools,
  scopeNote,
  IN_APP_BROWSER_CONTEXT,
} = contracts;

/** Both surfaces native: what a native thread gets when no probe narrows it. */
const ALL_SURFACES = Object.freeze({ chrome: true, computer: true });
const NO_SURFACES = Object.freeze({ chrome: false, computer: false });

const STARTS = new Set(['thread/start', 'thread/fork']);
const UNLOADS = new Set(['thread/closed', 'thread/archived', 'thread/deleted']);

/**
 * Watches the requests windows send the app-server and the messages it sends back, and gives every
 * thread its own sage-mcp session: opened on thread/start (or fork), its token rotated on each
 * thread/resume that loads the thread, suspended when the thread is unloaded and ended when it's
 * archived or deleted, or when the app-server exits.
 */
class CodexToolInjection {
  /**
   * @param {{ sessions: InstanceType<typeof import('../contract/session.cjs').ToolSessions>, command: string, args?: string[], socketPath: string | null,
   *           harnessPid: (params: any) => number | null | undefined, hasTools?: () => boolean,
   *           chatOf?: (threadId: string) => string, disableUserNodeRepl?: () => boolean,
   *           nativeEnabled?: () => boolean, nativeHide?: (name: string) => boolean,
   *           nativeSurfaces?: () => { chrome: boolean, computer: boolean },
   *           nativeHideFor?: (surfaces: { chrome: boolean, computer: boolean }) => (name: string) => boolean,
   *           degradedNote?: (surfaces: { chrome: boolean, computer: boolean }, serverName: string) => string | null,
   *           visibleTools?: (chatId?: string | null) => string[], yourChrome?: () => boolean | 'preferred',
   *           chromeInstances?: () => { chrome: string[], codexApp: string[] },
   *           browserBackends?: { available: () => boolean, has: (threadId: string) => boolean, loaded: (threadId: string, o?: { parent?: string, surfaces?: { chrome: boolean, chromeRoute?: string } }) => unknown,
   *                               unloaded: (threadId: string) => void, exited: () => void } | null,
   *           parents?: InstanceType<typeof CodexThreadParents>,
   *           chromeNote?: (threadId: string) => string | null, chromePending?: (threadId: string) => boolean, onLoaded?: (threadId: string) => void,
   *           pluginConfig?: (o?: { helper?: boolean }) => object, chromeOff?: () => Record<string, any> | null, computerOff?: () => Record<string, any> | null,
   *           defersMcpTools?: () => boolean }} o
   *   defersMcpTools: this Codex defers MCP tools behind its own tool search; else a thread's tools are tiered (mcp/toolTiers.cjs)
   *   chatOf: the chat a thread's requests belong to: the chat it is a segment of (D-1), or for a sub-agent thread
   *     its parent's (ChatController.requestChat)
   *   nativeEnabled: native.codex.enabled (flags.cjs), read when a thread is loaded
   *   nativeSurfaces: which surfaces the vendor runtime can serve on this Mac (nativeAvailability.cjs), read
   *     with nativeEnabled; the plugin goes on when at least one can. Without it, both are taken as served.
   *   nativeHide: sage-mcp tools a native thread must not get, as the vendor plugin already does the
   *     same (MoPilot's computer use, and browser tools that drive the user's own Chrome)
   *   nativeHideFor: nativeHide for the surfaces the thread really gets natively (preferred over nativeHide)
   *   degradedNote: what the model of a native thread is told about a surface the plugin can't serve
   *   visibleTools: the registry tools every session is shown now (names); a thread's own `hide` applies on top
   *   yourChrome: sage_browser_* drive the user's Chrome (Your Chrome is the browser channel), for a managed thread's note
   *   chromeInstances: the ChatGPT extension's instance ids in the user's Chrome and in the Codex app's in-app
   *     browser (browser/codexChromePick.cjs), read when a native thread with Chrome gets its note
   *   browserBackends: the plugin's in-app browser backend per native thread (browser/iabBackend.cjs), started
   *     when a thread is loaded native and stopped when it is unloaded or the app-server exits; a subagent
   *     thread a native thread spawns gets its own, over its parent's chat
   *   chromeNote: what a native thread's model is told about the user's Chrome when MoPilot serves it
   *     (browser/chromeBackend.cjs), or null
   *   onLoaded: a thread was loaded with its path (the chat's controller plan reads loadedPath)
   *   pluginConfig: the plugin store's part of a thread's config (electron/plugins/codexMirror.cjs threadConfig); a
   *     helper thread asks with { helper: true }
   *   chromeOff: the plugin's cua_repl without its Chrome while MoPilot serves it (codexPluginChrome.cjs), else null
   *   computerOff: the plugin's cua_repl without its computer use, for a thread keeping its Chrome only (#1381), else null
   */
  constructor(o) {
    this.sessions = o.sessions;
    this.command = o.command;
    this.args = [...(o.args ?? [])];
    this.socketPath = o.socketPath;
    this.harnessPid = o.harnessPid;
    this.hasTools = o.hasTools || (() => true);
    this.defersMcpTools = o.defersMcpTools || (() => false);
    this.chatOf = o.chatOf || ((id) => id);
    /** codex.disableUserNodeRepl (flags.cjs): whether the thread's config turns the user's node_repl off */
    this.disableUserNodeRepl = o.disableUserNodeRepl || (() => true);
    this.nativeEnabled = o.nativeEnabled || (() => false);
    this.nativeHide = o.nativeHide || null;
    this.nativeSurfaces = o.nativeSurfaces || (() => ALL_SURFACES);
    this.nativeHideFor = o.nativeHideFor || null;
    this.degradedNote = o.degradedNote || (() => null);
    this.visibleTools = o.visibleTools || (() => []);
    this.yourChrome = o.yourChrome || (() => false);
    this.chromeInstances = o.chromeInstances || (() => null);
    this.browserBackends = o.browserBackends || null;
    this.onLoaded =
      o.onLoaded ||
      (() => {
        /* no listener */
      });
    /** sub-agent thread -> the thread that spawned it, from every signal (shared with the lifecycle and the controller) */
    this.parents = o.parents || new CodexThreadParents();
    this.chromeNote = o.chromeNote || (() => null);
    this.chromePending = o.chromePending || (() => false);
    this.pluginConfig = o.pluginConfig || (() => ({}));
    this.chromeOff = o.chromeOff || (() => null);
    this.computerOff = o.computerOff || (() => null);
    /** loaded native threads whose model has had the in-app browser note since it was loaded or compacted */
    this.noted = new ContextNotes();
    /** request id -> { key, threadId?, opened, native, surfaces } (key null: a native thread without sage-mcp) */
    this.pending = new Map();
    /** thread id -> session key */
    this.byThread = new Map();
    /** threads the running app-server has loaded with MoPilot's config (their path is fixed) */
    this.loaded = new Set();
    /** loaded thread -> the config MoPilot loaded it with ({ fragment, plugins }), sent again on its next resume */
    this.configs = new Map();
    /** loaded threads on the native path (the vendor's computer-use plugin is on) -> the surfaces it serves */
    this.nativeThreads = new Map();
    /** subagent thread -> the native thread that spawned it: it runs with its parent's plugin */
    this.subagents = new Map();
    /** @type {string[]} */
    this.userServers = [];
    /** each user server's entry, and the MCP gateway's check of one (#2999 C4, set by app/gatewayWiring.cjs) */
    this.userServerConfigs = /** @type {Record<string, unknown>} */ ({});
    this.managedServer = /** @type {((entry: unknown) => boolean) | null} */ (null);
    this.managedSig = /** @type {(() => string) | null} the gateway's managed set, for a warm thread's key (codexPrewarm.cjs) */ (null);
  }

  /** The MCP servers the user's own config defines (the adapter reads them once per app-server): names, or name → entry. */
  setUserServers(servers) {
    const record = isJsonRecord(servers) ? servers : {};
    this.userServers = (Array.isArray(servers) ? servers : Object.keys(record)).filter((n) => typeof n === 'string');
    this.userServerConfigs = record;
  }

  /** A thread explicitly configured by this app owns its path; receiver events cannot reparent it. */
  isLoadedThread(threadId) {
    return this.loaded.has(threadId);
  }

  /** Whether a loaded thread runs with the vendor's computer-use plugin on: a native thread, or a subagent one spawned. */
  isNativeThread(threadId) {
    const parent = this.subagents.get(threadId);
    if (parent) return this.isNativeThread(parent);
    return this.nativeThreads.has(threadId) && this.loaded.has(threadId);
  }

  /**
   * The Codex thread whose turn a call on a thread's session is kept for (codexTurnThread.cjs), or null for ACP.
   * @param {string} chatId
   * @param {string} segmentId
   * @param {unknown} [meta] the call's params._meta
   */
  turnThreadOf(chatId, segmentId, meta = null) {
    return turnThreadOf(this, chatId, segmentId, meta, (error) =>
      noteIgnored('find the chat of the Codex thread a tool call came from', error),
    );
  }

  /** Whether a Codex thread (or a subagent of one) gets its tools here: the chat runs on Codex now. */
  hasThread(threadId) {
    return this.byThread.has(this.chatThreadOf(threadId));
  }

  /**
   * The surfaces a native thread loaded now gets, and the cua_repl that leaves the plugin's Chrome out while MoPilot
   * serves it (routedSurfaces, #1319 G28); a chat's controller plan reads the surfaces before its thread loads.
   */
  routedSurfaces() {
    return routedSurfaces(this.nativeEnabled() ? this.nativeSurfaces() : NO_SURFACES, this.chromeOff, this.computerOff);
  }

  /**
   * The path a loaded thread got, fixed until it unloads: the surfaces its vendor plugin serves, whether the plugin's
   * in-app browser ("iab") is MoPilot's pane for it (its backend), and whether it has MoPilot's tools
   * (sage-mcp); null while it isn't loaded.
   */
  loadedPath(threadId) {
    if (!this.loaded.has(threadId)) return null;
    const surfaces = loadedChromeSurfaces(this.nativeThreads.get(threadId) ?? NO_SURFACES, ownChromeNote(this.chromeNote, threadId));
    return { chrome: surfaces.chrome, computer: surfaces.computer, iab: this.#iab(threadId), tools: this.byThread.has(threadId) };
  }

  /** Whether a native thread loaded now would get the plugin's in-app browser backend over MoPilot's pane (IabBackends.available never throws). */
  iabAvailable() {
    return this.browserBackends?.available() === true;
  }

  /** Whether a loaded native thread runs the vendor's computer use (its Codex Computer Use copy may be in use). */
  nativeComputerLoaded() {
    for (const [id, surfaces] of this.nativeThreads) if (surfaces.computer && this.loaded.has(id)) return true;
    return false;
  }

  /**
   * The chat a thread's tool calls are charged to, looked up at each call: a subagent thread's parent's chat, so
   * Stop on that chat aborts them (the registry aborts by chat).
   */
  ownerOf(threadId) {
    return this.chatOf(this.chatThreadOf(threadId));
  }

  /** The thread whose chat a thread works for: a subagent's parent, else the thread itself. */
  chatThreadOf(threadId) {
    return this.subagents.get(threadId) ?? threadId;
  }

  /**
   * A subagent thread a loaded native thread spawned (thread/started names its parent; a collab tool
   * spawn call names its children): it gets its own browser backend, its session id being its own thread id.
   */
  #adopt(threadId, parent) {
    if (!isCodexChildThreadId(threadId, parent) || this.subagents.has(threadId)) return;
    if (!this.isNativeThread(parent)) return;
    const root = this.chatThreadOf(parent);
    if (threadId === root || this.isLoadedThread(threadId)) return;
    this.subagents.set(threadId, root);
    callBackends(this.browserBackends, (b) => b.loaded(threadId, { parent: root, surfaces: this.nativeThreads.get(root) }));
  }

  /** A thread's subagents go with it. */
  #dropSubagents(parent) {
    for (const [id, p] of [...this.subagents])
      if (p === parent) {
        this.subagents.delete(id);
        callBackends(this.browserBackends, (b) => b.unloaded(id));
      }
  }

  /**
   * The additionalContext a native thread's turn/start carries, or null: the in-app browser note while
   * the thread's sage-mcp lists browser_* (else how to select the user's Chrome, when the plugin serves it), and
   * what the plugin can't serve on this Mac, once per load
   * (and again after a compaction). Call contextForwarded once the turn/start went through.
   * @returns {{ key: string, context: { kind: 'application', value: string } } | null}
   */
  turnContext(threadId) {
    if (!threadId || this.noted.has(threadId)) return null;
    // a managed thread is told what MoPilot's tools reach, as Claude Code and ACP sessions are (#1319 G3)
    if (!this.isNativeThread(threadId)) return this.#managedNote(threadId);
    const loaded = this.nativeThreads.get(threadId);
    // a sub-agent thread: Codex starts its turns, not a window
    if (!loaded) return null;
    const own = ownChromeNote(this.chromeNote, threadId);
    const surfaces = loadedChromeSurfaces(loaded, own, this.chromePending(threadId));
    const s = this.sessions.get(this.byThread.get(threadId));
    const parts = [];
    // the parts that name MoPilot's tools or settings follow the scope note; the Chrome rule stands without it
    let scoped = false;
    const tied = (/** @type {string} */ server, /** @type {string} */ text) => {
      if (!scoped) parts.push(scopeNote(server));
      scoped = true;
      parts.push(text);
    };
    const known = surfaces.chrome && !own ? readChromeInstances(this.chromeInstances) : null;
    if (s && this.toolsOf(threadId)?.some((n) => n.startsWith('browser_')))
      tied(s.serverName, inAppBrowserNote(s.serverName, surfaces.chrome, this.#iab(threadId), known, own).value);
    // without browser_* (or sage-mcp): how to select the user's Chrome among the plugin's backends, and the pane's payments
    else parts.push(...notesWithoutBrowserTools(own, surfaces.chrome ? chromeSelectionNote(known) : null, this.#iab(threadId)));
    if (!s && surfaces.chromeRoute === 'backend' && !surfaces.chrome)
      parts.push(
        surfaces.chromePending
          ? "MoPilot's Chrome backend is still starting. Wait for it to finish; do not use another Chrome backend."
          : "MoPilot's Chrome backend could not load for this chat. Reload the chat to retry; do not use another Chrome backend.",
      );
    const chromeTools = !!s && !surfaces.chrome && shownTools(this.visibleTools, s.hide, s.chatId).some((n) => n.startsWith('chrome_'));
    if (chromeTools) tied(s.serverName, chromeToolsNote(s.serverName));
    if (s && ((!surfaces.chrome && !chromeTools) || !surfaces.computer)) {
      /** @type {string | null} */
      let note = null;
      try {
        note = this.degradedNote(surfaces, s.serverName);
      } catch (error) {
        // the note is optional; without it the instructions just omit it
        noteIgnored("write what the native plugin can't serve into a Codex thread's instructions", error);
      }
      if (note) tied(s.serverName, note);
    }
    // the task-list, design-systems and sessions notes for the tools the thread is shown, as every harness gets them
    const notes = s && withSessionsNote(null, shownTools(this.visibleTools, s.hide, s.chatId));
    if (notes) tied(s.serverName, notes);
    if (!parts.length) return null;
    return { key: IN_APP_BROWSER_CONTEXT, context: { kind: 'application', value: parts.join('\n\n') } };
  }

  /** The active session's exact filtered tools, or null before the thread loads. */
  toolsOf(threadId) {
    if (!this.loaded.has(threadId)) return null;
    const s = this.sessions.get(this.byThread.get(threadId));
    return s ? shownTools(this.visibleTools, s.hide, s.chatId) : [];
  }

  /** A managed thread's note on what MoPilot's tools reach (and on starting other sessions), once per load. */
  #managedNote(threadId) {
    const tools = this.toolsOf(threadId);
    const value = tools ? withSessionsNote(surfaceNote(tools, { yourChrome: this.yourChrome() }), tools) : null;
    return value ? { key: IN_APP_BROWSER_CONTEXT, context: { kind: /** @type {const} */ ('application'), value } } : null;
  }

  /** Whether this thread has the plugin's in-app browser backend (not merely whether a thread loaded now would get one). */
  #iab = (/** @type {string} */ threadId) => hasBackend(this.browserBackends, threadId);

  /** Capture the note generation before the asynchronous turn/start. */
  contextReceipt(threadId) {
    return this.noted.capture(threadId);
  }

  /** Only the generation actually carried by this turn/start may be consumed. */
  contextForwarded(threadId, key, receipt) {
    if (key === IN_APP_BROWSER_CONTEXT && this.loaded.has(threadId)) this.noted.acknowledge(threadId, receipt);
  }

  /**
   * A request on its way to the app-server, with the thread's tools added where they belong. `helper`:
   * a thread MoPilot starts for itself gets native control switched off and no sage-mcp session.
   */
  outgoing(msg, { helper = false } = {}) {
    if (!msg || msg.id == null) return msg;
    const p = msg.params || {};
    const userServers = p[ISOLATED_THREAD] ? [] : this.userServers; // MoMo's own Codex home defines none: an entry for one refuses the thread (#2330)
    if (helper) {
      if (!STARTS.has(msg.method)) return msg;
      // off with or without sage-mcp: no vendor or store plugin, no user MCP server; an isolated chat's helper too
      const own = mergeConfig(mergeConfig(p.config, helperThreadConfig({ userServers })), this.pluginConfig({ helper: true }));
      return { ...msg, params: { ...p, config: isolateConfig(p, own) } };
    }
    const resume = msg.method === 'thread/resume' && !!p.threadId;
    if (!STARTS.has(msg.method) && !resume) return msg;
    // a loaded thread keeps the path it has: the same config again, as Codex respawns it from this request (#2500)
    const kept = resume ? this.configs.get(p.threadId) : null;
    if (kept)
      return { ...msg, params: { ...p, config: isolateConfig(p, mergeConfig(mergeConfig(p.config, kept.fragment), kept.plugins)) } };
    // the plugin store's part of a chat thread's config, on every path below; an isolated thread's tools off last
    const plugins = mergeConfig(this.pluginConfig(), contracts.gatewayThreadOff(userServers, this.userServerConfigs, this.managedServer));
    const finish = (config) => isolateConfig(p, mergeConfig(config, plugins));
    const withConfig = (fragment) => ({ ...msg, params: { ...p, config: finish(mergeConfig(p.config, fragment)) } });
    // the plugin goes on only for a surface its runtime can serve here; otherwise the thread stays managed
    const { surfaces, cua } = this.routedSurfaces();
    const native = !p[ISOLATED_THREAD] && !!(surfaces.chrome || surfaces.computer);
    // what the vendor plugin's part of the config is made of (codexThreadContracts.cjs nativeThreadConfig)
    const vendor = { userServers, disableUserNodeRepl: this.disableUserNodeRepl(), cua, chrome: surfaces.chrome };
    if (!this.hasTools()) {
      if (!native) return Object.keys(plugins).length || p[ISOLATED_THREAD] ? withConfig({}) : msg;
      const fragment = nativeThreadConfig(vendor);
      this.pending.set(msg.id, { key: null, threadId: p.threadId, opened: false, native: true, surfaces, config: { fragment, plugins } });
      return withConfig(fragment);
    }
    let key;
    let issued;
    let opened = false;
    // a native thread's sage-mcp leaves out what the vendor plugin really offers here: one controller each
    const hide = sessionHide(p, native ? (this.nativeHideFor ? this.nativeHideFor(surfaces) : this.nativeHide) : null);
    const tiered = !this.defersMcpTools();
    if (STARTS.has(msg.method)) {
      key = `codex:${crypto.randomUUID()}`;
      issued = this.sessions.open(key, { harnessPid: this.harnessPid(p) ?? null, hide, shared: 'codex', tiered, ...startOwner(p, key) });
      opened = true;
    } else {
      key = this.byThread.get(p.threadId);
      issued = key && this.sessions.get(key) ? this.sessions.rotate(key, { harnessPid: this.harnessPid(p) ?? null, hide, tiered }) : null;
      if (!issued) {
        key = `codex:${crypto.randomUUID()}`;
        issued = this.sessions.open(key, {
          harnessPid: this.harnessPid(p) ?? null,
          // looked up at each call: the chat may record this thread only after it loads
          chatId: () => this.ownerOf(p.threadId),
          segmentId: p.threadId,
          hide,
          tiered,
          // one name for every thread, so the tools open the same cached prompt prefix (#2579); the token stays the thread's
          shared: 'codex',
        });
        opened = true;
      }
      this.byThread.set(p.threadId, key);
    }
    const fragment = issuedThreadConfig(this, issued, { ...vendor, native });
    this.pending.set(msg.id, { key, threadId: p.threadId, opened, native, surfaces, config: { fragment, plugins } });
    return withConfig(fragment);
  }

  /** Sees every app-server message; never consumes one. */
  observe(msg) {
    if (!msg) return false;
    if (msg.method == null && msg.id != null && this.pending.has(msg.id)) {
      const { key, threadId, opened, native, surfaces, config } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      const id = (msg.result && msg.result.thread && msg.result.thread.id) || threadId;
      if (msg.error || !id) {
        if (key) {
          if (opened) this.sessions.end(key);
          else this.sessions.suspend(key);
        }
        return false;
      }
      if (key) {
        this.byThread.set(id, key);
        // the owner is looked up at each call, not now: a harness switch starts the thread before it
        // commits the segment that names it (electron/session/switch.cjs), so chatOf(id) is still the id here
        this.sessions.assign(key, { chatId: () => this.ownerOf(id), segmentId: id });
      } else if (this.byThread.has(id)) {
        // loaded without sage-mcp this time: an earlier session for the thread has nothing to serve
        this.sessions.end(this.byThread.get(id));
        this.byThread.delete(id);
      }
      const snapshot = { ...surfaces };
      if (native) this.nativeThreads.set(id, snapshot);
      else this.nativeThreads.delete(id);
      callBackends(
        this.browserBackends,
        (b) => (native ? b.loaded(id, { surfaces: snapshot }) : b.unloaded(id)),
        () => {
          if (this.loaded.has(id) && this.nativeThreads.get(id) === snapshot) {
            this.noted.delete(id);
            this.onLoaded(id);
          }
        },
      );
      this.loaded.add(id);
      this.configs.set(id, config);
      this.noted.delete(id);
      this.onLoaded(id);
      return false;
    }
    // thread/started naming its parent, a spawn call naming its children, a sub-agent's activity item
    for (const [child, parent] of this.parents.observe(msg)) this.#adopt(child, parent);
    const tid = msg.params && msg.params.threadId;
    if (!tid) return false;
    if (UNLOADS.has(msg.method)) {
      this.loaded.delete(tid);
      this.configs.delete(tid);
      this.nativeThreads.delete(tid);
      this.noted.delete(tid);
      this.subagents.delete(tid);
      this.#dropSubagents(tid);
      callBackends(this.browserBackends, (b) => b.unloaded(tid));
    }
    // a compaction may have summarized the note away: the next turn carries it again
    if (
      msg.method === 'thread/compacted' ||
      (msg.method === 'item/completed' && msg.params.item && msg.params.item.type === 'contextCompaction')
    )
      this.noted.delete(tid);
    if (!this.byThread.has(tid)) return false;
    if (msg.method === 'thread/closed') {
      this.sessions.suspend(this.byThread.get(tid));
    } else if (msg.method === 'thread/archived' || msg.method === 'thread/deleted') {
      this.sessions.end(this.byThread.get(tid));
      this.byThread.delete(tid);
    }
    return false;
  }

  /**
   * The app-server went away: every thread's server went with it, so its sessions end (WP5-18), not
   * suspend; a thread resumed after the restart gets a new session.
   */
  exited() {
    callBackends(this.browserBackends, (b) => b.exited());
    this.parents.clear();
    this.loaded.clear();
    this.configs.clear();
    this.nativeThreads.clear();
    this.subagents.clear();
    this.noted.clear();
    for (const { key } of this.pending.values()) if (key) this.sessions.end(key);
    this.pending.clear();
    for (const key of this.byThread.values()) this.sessions.end(key);
    this.byThread.clear();
  }
}

// the thread contracts are this entrypoint's too, each under its own name
module.exports = { ...contracts, CodexToolInjection };
