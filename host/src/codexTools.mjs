// MoPilot's tools for the Codex threads of a Host: the `tools` object the app's CodexAdapter takes (electron/harness/codexConnection.cjs), kept to what a Host has. Each thread Codex starts, forks or resumes is given the portable sage-mcp (`node host/bin/sage-mcp.mjs`) as an MCP server in its config, with a token of its own; the token ends with the thread, and a thread's calls belong to its chat (so one chat never reaches another's app). The app's CodexToolInjection also serves the vendor's native browser and computer plugins; those belong to the app (they load electron/capabilities/browser/, which a Host does not).
import { fileURLToPath } from 'node:url';

const SHIM = fileURLToPath(new URL('../bin/sage-mcp.mjs', import.meta.url));
const STARTS = new Set(['thread/start', 'thread/fork']);
/** The thread is no longer loaded in the app-server: its tools stop; `archived` and `deleted` are for good. */
const SUSPENDS = new Set(['thread/closed']);
const ENDS = new Set(['thread/archived', 'thread/deleted']);
/** Codex ends a call after 60 s by default; a relayed call waits for a person's card or a page, as long as the app's own do. */
const TOOL_TIMEOUT_SEC = 15 * 60;

/**
 * @param {object} o
 * @param {InstanceType<typeof import('../../electron/capabilities/contract/session.cjs').ToolSessions>} o.sessions the Host's tool sessions
 * @param {() => string | null} o.socketPath where sage-mcp connects; null until the Host's tool socket is listening (then threads start without tools)
 * @param {(params: any) => number | null | undefined} o.pidOf the app-server process a request goes to: the harness whose child sage-mcp must be
 * @param {(threadId: string) => string} o.chatOf the chat a thread's calls are charged to
 */
export function createCodexTools({ sessions, socketPath, pidOf, chatOf }) {
  /** The thread each session key serves, and the session of each thread. @type {Map<string, string>} */
  const byThread = new Map();
  /** The requests that start, fork or resume a thread, until the app-server answers: id -> the session they opened or reused. @type {Map<number | string, { key: string, threadId?: string, opened: boolean }>} */
  const pending = new Map();

  /** The thread's config with the sage server added to what the request already asked for. */
  function withServer(
    /** @type {any} */ msg,
    /** @type {any} */ p,
    /** @type {{ serverName: string, token: string }} */ issued,
    /** @type {string} */ socket,
  ) {
    const server = {
      command: process.execPath,
      args: [SHIM],
      env: { SAGE_MCP_SOCKET: socket, SAGE_MCP_TOKEN: issued.token },
      default_tools_approval_mode: 'approve',
      tool_timeout_sec: TOOL_TIMEOUT_SEC,
    };
    return { ...msg, params: { ...p, config: { ...p.config, mcp_servers: { ...p.config?.mcp_servers, [issued.serverName]: server } } } };
  }

  return {
    /** The user's MCP servers the app-server reads from its own config: nothing here depends on them. */
    setUserServers() {
      /* the Host's threads add only their own server */
    },
    /**
     * The request to the app-server, with this Host's tools added to a thread's config. A thread MoPilot starts for itself (a helper) gets none.
     * @param {any} msg @param {{ helper?: boolean }} [o]
     */
    outgoing(msg, { helper = false } = {}) {
      const socket = socketPath();
      if (!msg || msg.id == null || helper || !socket) return msg;
      const p = msg.params ?? {};
      const resume = msg.method === 'thread/resume' && !!p.threadId;
      if (!STARTS.has(msg.method) && !resume) return msg;
      const harnessPid = pidOf(p) ?? null;
      let key = resume ? byThread.get(p.threadId) : undefined;
      // a thread loaded before keeps its session, with a new token: the app-server respawns its servers from this request
      let issued = key && sessions.get(key) ? sessions.rotate(key, { harnessPid }) : null;
      let opened = false;
      if (!issued) {
        key = `codex:${crypto.randomUUID()}`;
        // a new thread learns its id only from the answer; its calls are charged to its chat, looked up at each call
        issued = sessions.open(key, {
          harnessPid,
          shared: 'codex',
          ...(resume ? { chatId: () => chatOf(p.threadId), segmentId: p.threadId } : {}),
        });
        opened = true;
      }
      pending.set(msg.id, { key: /** @type {string} */ (key), threadId: p.threadId, opened });
      return withServer(msg, p, issued, socket);
    },
    /** Every message the app-server sends: the answers to the requests above, and the end of a thread. Never consumes one. @param {any} msg */
    observe(msg) {
      if (!msg) return false;
      if (msg.method == null && msg.id != null && pending.has(msg.id)) {
        const { key, threadId, opened } = /** @type {NonNullable<ReturnType<typeof pending.get>>} */ (pending.get(msg.id));
        pending.delete(msg.id);
        const id = msg.result?.thread?.id || threadId;
        if (msg.error || !id) {
          // the thread did not load: a session this request opened ends, one it reused waits for the next try
          if (opened) sessions.end(key);
          else sessions.suspend(key);
          return false;
        }
        byThread.set(id, key);
        // the chat is looked up at each call: a harness switch starts the thread before the chat records it
        sessions.assign(key, { chatId: () => chatOf(id), segmentId: id });
        return false;
      }
      const threadId = msg.params?.threadId;
      const key = threadId ? byThread.get(threadId) : undefined;
      if (!key) return false;
      if (SUSPENDS.has(msg.method)) sessions.suspend(key);
      else if (ENDS.has(msg.method)) {
        sessions.end(key);
        byThread.delete(threadId);
      }
      return false;
    },
    /** The app-server went away, and every thread's servers with it: the sessions end, and a thread resumed later gets a new one. */
    exited() {
      for (const { key } of pending.values()) sessions.end(key);
      pending.clear();
      for (const key of byThread.values()) sessions.end(key);
      byThread.clear();
    },
  };
}
