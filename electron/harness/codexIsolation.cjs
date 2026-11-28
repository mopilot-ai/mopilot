// A Codex chat kept apart from the coding side (MoMo's, #2139): each of its turns runs in Codex's strictest sandbox
// (read-only, no network, never asking to escalate), so nothing it runs writes or reaches the network; a read-only shell
// can still read files, which Codex can't turn off per thread (degraded). Codex memory is off from the thread's first turn by its
// own config: the `memories` and `external_agent_memory_import` features off at thread/start, resume and fork (FEATURES_OFF).
// As a second switch, every request that runs the model on its thread (a turn, a goal, a review, a steer, a compaction) goes
// with the thread's memory mode turned off first, and nothing turns it back on; a thread whose memory mode can't be turned
// off runs nothing (the user is told). Checked at each request, never cached, so an app-server restart or an account change
// can't leave a thread on. A thread takes no memory mode before its first user message is recorded (codexUnrecorded.cjs):
// its first turn goes on the config alone, and its memory mode goes off once Codex has recorded that turn (#2276).
// Codex reads the user's AGENTS.md, skills, hooks and memories from CODEX_HOME for the whole process, so the threads run on
// an app-server of their own with MoMo's home (codexIsolatedServer.cjs, codexMomoHome.cjs, #2308); what Codex reads from
// elsewhere (~/.agents/skills, the folder's AGENTS.md) is off by the thread's config (isolateConfig).

const { clock } = require('../platform/ports/clock.cjs');
const { momoHide, pendingMomoChat } = require('../momo/contract/toolIsolation.cjs');
const { unrecordedError } = require('./codexUnrecorded.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** Requests that run the model on a thread. */
const MODEL_RUNS = new Set(['turn/start', 'turn/steer', 'review/start', 'thread/compact/start']);
/**
 * On a thread/start, thread/fork or thread/resume's params: the thread is an isolated chat's, so its config turns off
 * Codex's own shell, exec, image-reading and sub-agent tools, every plugin (the bundled computer use's js REPL reads
 * files) and every MCP server but MoPilot's own (codexConfig.cjs `outgoing`). A symbol: it never reaches Codex.
 */
const ISOLATED_THREAD = Symbol('isolated thread');
/**
 * With ISOLATED_THREAD, on a thread/start's params: the thread is a data-only MoMo chat's (its memory pass,
 * toolIsolation.cjs dataOnlyMeta), so its tool session lists and calls no tool at all, from Codex's first list on.
 */
const DATA_ONLY_THREAD = Symbol('data-only thread');
/**
 * Codex's own tools that read files or run anything, its memory (reading and writing memories, and importing another
 * agent's), its hooks, its skill search and ChatGPT apps: off for an isolated thread (the tools checked on codex-cli 0.163, the rest
 * on 0.162.1).
 */
const FEATURES_OFF = Object.freeze({
  shell_tool: false,
  unified_exec: false,
  view_image: false,
  multi_agent: false,
  code_mode_host: false,
  memories: false,
  external_agent_memory_import: false,
  hooks: false,
  skill_search: false,
  // ChatGPT apps (the codex_apps MCP server, stable and on by default on 0.162.1): their tools reach code mode's ALL_TOOLS and
  // would run outside MoPilot's trust gate (#5824)
  apps: false,
});
/**
 * FEATURES_OFF as MoMo's Codex home carries it (codexMomoHome.cjs): every thread on that app-server has no shell, whatever
 * its start params carry. Without `code_mode_host`: off at the home, Codex turns the whole code-mode host off (every
 * `exec` call fails with "code-mode host is disabled"), where a thread's own config leaves it running (probed on 0.162.1).
 */
const HOME_FEATURES_OFF = Object.freeze(Object.fromEntries(Object.entries(FEATURES_OFF).filter(([k]) => k !== 'code_mode_host')));
/** The switches that give a thread a shell, a way to run commands or a way to read an image from disk. */
const SHELL_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'view_image']);
/**
 * The rest of an isolated thread's config that keeps instructions out (each checked on codex-cli 0.162.1 with
 * `codex debug prompt-input`): no skill list, ~/.agents/skills' included, and no AGENTS.md from its folder or above.
 */
const INSTRUCTIONS_OFF = Object.freeze({ project_doc_max_bytes: 0 });
/** The bundled computer-use plugin, off even when the thread's own config doesn't name it. */
const BUNDLED_PLUGINS = ['unified-computer-use@openai-bundled'];
/** MoPilot's own server on a thread (capabilities/contract/session.cjs): the one MCP server an isolated thread keeps. */
const OWN_SERVER = /^sage_[0-9a-f]{12}$/;

/**
 * A thread's finished config, isolated when its start or resume carries ISOLATED_THREAD: everything off, last, so no
 * other part of the config turns a tool back on.
 * Only the servers the config itself defines are switched off: the thread runs on MoMo's own Codex home, which defines
 * none of the user's, and an entry for a server a home doesn't define is invalid there (#2330).
 * @param {any} params @param {Record<string, any>} config
 */
function isolateConfig(params, config) {
  if (!params?.[ISOLATED_THREAD]) return config;
  const servers = Object.keys(config.mcp_servers ?? {}).filter((n) => !OWN_SERVER.test(n));
  const plugins = [...new Set([...Object.keys(config.plugins ?? {}), ...BUNDLED_PLUGINS])];
  return {
    ...config,
    ...INSTRUCTIONS_OFF,
    skills: { ...config.skills, include_instructions: false },
    features: { ...config.features, ...FEATURES_OFF },
    plugins: Object.fromEntries(plugins.map((n) => [n, { ...config.plugins?.[n], enabled: false }])),
    mcp_servers: {
      ...config.mcp_servers,
      ...Object.fromEntries(servers.map((n) => [n, { ...config.mcp_servers?.[n], enabled: false }])),
    },
  };
}

/**
 * The tool session's rule for a thread that starts isolated: it lists and calls MoMo's tools only, from its first list
 * on, before its chat names the thread (momo/contract/toolIsolation.cjs momoHide); any other thread keeps `hide` as it is.
 * @param {any} params the thread/start or thread/resume params
 * @param {((name: string) => boolean) | null} hide the session's own rule
 */
const sessionHide = (params, hide) =>
  params?.[ISOLATED_THREAD] && params[DATA_ONLY_THREAD] ? () => true : params?.[ISOLATED_THREAD] ? momoHide(hide) : hide;
/**
 * The chat a new thread's tool session serves until its start is answered: for an isolated thread, a MoMo chat's, so
 * MoMo's tools are in the list Codex takes as it starts the thread (#2356); any other thread names none yet.
 * @param {any} params the thread/start params @param {string} key the session's key
 */
const startOwner = (params, key) => (params?.[ISOLATED_THREAD] ? { chatId: pendingMomoChat(key) } : {});

const MEMORY_MODE = 'thread/memoryMode/set';
const SETTINGS_UPDATE = 'thread/settings/update';
const CONFIG_READ = 'config/read';
/** The waits before each try at turning a first turn's memory off, while Codex writes the thread out. */
const RECORD_WAITS_MS = [0, 1_000, 5_000];

/** Codex's strictest sandbox for a turn: nothing written, no network, and no asking to run outside it. */
const STRICTEST = Object.freeze({ sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
const runsModel = (method, params) => MODEL_RUNS.has(method) || (method === 'thread/goal/set' && params?.status === 'active');

class CodexIsolation {
  /**
   * @param {object} o
   * @param {(chatId: string) => boolean} o.isolated the chat is kept apart (MoMo's)
   * @param {(threadId: string) => string} o.chatOf the chat a thread belongs to
   * @param {(threadId: string) => boolean} [o.held] MoMo's own app-server holds the thread
   * @param {(method: string, params: object) => Promise<unknown>} o.call the app-server, below this gate
   * @param {(threadId: string) => boolean} [o.unrecorded] the thread has no user message Codex recorded yet
   * @param {(ms: number) => Promise<void>} [o.wait]
   */
  constructor(o) {
    this.isolated = o.isolated;
    /** whether anything told it which chats are kept apart (a predicate given, or set once MoMo opened): without it a marked start is refused */
    this.decides = typeof o.isolated === 'function';
    this.chatOf = o.chatOf;
    /** a thread MoMo's own app-server holds is isolated whatever its chat's meta says (the start's mark decided it) */
    this.held = o.held ?? (() => false);
    /** helper threads (a handoff note's fork) of an isolated chat: they run under the same rule, though no chat names them */
    this.helpers = new Set();
    this.call = o.call;
    this.unrecorded = o.unrecorded ?? (() => false);
    this.wait = o.wait ?? ((ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)));
    /** threads whose first turn went before their memory could be turned off: it goes off once Codex answers that turn */
    this.owed = new Set();
  }

  /** Whether `params` names a thread of an isolated chat (checked at once, so other requests wait for nothing). */
  applies(params) {
    const threadId = params?.threadId;
    return typeof threadId === 'string' && (this.helpers.has(threadId) || this.held(threadId) || this.isolated(this.chatOf(threadId)));
  }

  /**
   * Before `method` goes to the app-server for an isolated chat's thread: it runs only with its memory off, and a turn
   * only in the strictest sandbox. Resolves the params to send; throws to refuse.
   */
  async gate(method, params) {
    const threadId = params.threadId;
    if (method === MEMORY_MODE) {
      if (params.mode !== 'disabled') throw new Error("Codex memory stays off in MoMo's chats");
      return params;
    }
    // a thread loaded again (a restart, a fork of it) comes back isolated too
    if (method === 'thread/resume' || method === 'thread/fork') return { ...params, [ISOLATED_THREAD]: true };
    // the settings a goal's or a review's turns run on stay the strictest, whatever permission the chat holds
    if (method === SETTINGS_UPDATE) return { ...params, permissions: null, ...STRICTEST };
    if (!runsModel(method, params)) return params;
    await this.shellOff();
    try {
      await this.call(MEMORY_MODE, { threadId, mode: 'disabled' });
      this.owed.delete(threadId);
    } catch (e) {
      // the thread's first message, which Codex needs before it takes a memory mode: it goes with memory off by its
      // config (FEATURES_OFF), in the strictest sandbox like every turn, and its memory mode goes off once Codex has it
      // (turnStarted); a steer into that first turn while Codex still writes the thread out joins it
      const first = method === 'turn/start' ? this.unrecorded(threadId) : method === 'turn/steer' && this.owed.has(threadId);
      if (!(first && unrecordedError(e)))
        throw new Error(`Couldn't turn off Codex memory for this chat, so it doesn't run: ${e?.message ?? e}`);
      if (method === 'turn/start') this.owed.add(threadId);
    }
    return method === 'turn/start' ? { ...params, ...STRICTEST } : params;
  }

  /**
   * Codex's own shell is off on MoMo's app-server now, read from the effective config at each run (never cached: the app-server
   * may have been restarted with another home). Throws, so the run never starts, when one of SHELL_FEATURES is on or the
   * config can't be read. The thread's own config turns the same switches off (isolateConfig); this is the check that the
   * home's did hold, since Codex's answer to a thread's start lists no tools to look at (#2139).
   */
  async shellOff() {
    let on;
    try {
      // routed to MoMo's app-server by its mark, as a thread/start of an isolated chat is
      const read = /** @type {any} */ (await this.call(CONFIG_READ, { includeLayers: false, [ISOLATED_THREAD]: true }));
      const features = read?.config?.features ?? {};
      // a switch the answer doesn't list as off is not known to be off: a Codex without it, or one that read no home
      on = SHELL_FEATURES.filter((k) => features[k] !== false);
    } catch (e) {
      throw new Error(`Couldn't confirm Codex's shell is off for this chat, so it doesn't run: ${e?.message ?? e}`);
    }
    if (on.length) throw new Error(`Codex's shell isn't confirmed off for this chat (${on.join(', ')}), so it doesn't run`);
  }

  /**
   * Codex answered a turn/start on `threadId`: a first turn that went before its thread could take a memory mode turns
   * it off now, tried a few times while Codex writes the thread out. Should every try fail, the thread's next run asks
   * again (gate) and runs nothing without it. Never throws.
   */
  async turnStarted(threadId) {
    if (!this.owed.has(threadId)) return;
    let last;
    for (const ms of RECORD_WAITS_MS) {
      await this.wait(ms);
      // a run on the thread turned it off meanwhile (gate)
      if (!this.owed.has(threadId)) return;
      try {
        await this.call(MEMORY_MODE, { threadId, mode: 'disabled' });
        this.owed.delete(threadId);
        return;
      } catch (e) {
        last = e;
      }
    }
    // still owed: a steer into the turn may still join it; the next turn/start runs nothing without it
    noteIgnored("turn off Codex memory after a MoMo chat's first turn", last);
  }
}

module.exports = {
  DATA_ONLY_THREAD,
  CodexIsolation,
  STRICTEST,
  ISOLATED_THREAD,
  FEATURES_OFF,
  HOME_FEATURES_OFF,
  SHELL_FEATURES,
  INSTRUCTIONS_OFF,
  isolateConfig,
  sessionHide,
  startOwner,
};
