// The unix socket sage-mcp connects to (127.0.0.1 on Windows). A harness launches sage-mcp (native/sage-mcp) as a stdio MCP @host-portable: loads in the Host process without Electron (host/boundary.json).
// server; sage-mcp opens this socket and says `hello {token, pid, ppid}`. Main accepts it only when
// the token belongs to a live session (../contract/session.cjs) and the connecting process is that session's
// harness or a process it started (an ACP adapter runs its CLI, which starts sage-mcp: #1320), as the
// http channel checks it (../httpMcp.cjs). Then tools/list and tools/call go to the capability registry.
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { messageOf, noteIgnored } = require('../../ignored.cjs');
const { JsonReader } = require('../../transport/jsonReader.cjs');
const { hiddenRefusalText } = require('../contract/toolRefusal.cjs');
const { tieredList, moreSurface, moreCall, groupOf, notLoaded, autoLoad, preloadedGroups } = require('./toolTiers.cjs');
const { userChromeOf } = require('../contract/surfaceNote.cjs');
const { CLAUDE_END_TURN } = require('../../../shared/claudeEndTurn.mjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { PrivateSocketListener } = require('../../platform/privateSocket.cjs');
const { LoopbackListener } = require('../../platform/loopbackListener.cjs');
const { peerHoldsWindows } = require('./peerWindows.cjs');
const { core, coreCall } = require('../../platform/core.cjs');

/**
 * Where sage-mcp lives: Contents/Helpers in a packaged app, native/sage-mcp/build in a checkout. On Windows it is the Rust
 * one (core/crates/sage-mcp), beside the core in resources/core, or the core's release build in a checkout; a Linux
 * package has that Rust one beside its core too (a Linux checkout's harnesses run host/bin/sage-mcp.mjs: ./runtime.cjs).
 */
function sageMcpPath({
  packaged = false,
  resourcesPath = process.resourcesPath,
  repoRoot = path.join(__dirname, '../../..'),
  platform = process.platform,
} = {}) {
  if (platform === 'win32')
    return packaged ? path.join(resourcesPath, 'core', 'sage-mcp.exe') : path.join(repoRoot, 'core', 'target', 'release', 'sage-mcp.exe');
  if (platform === 'linux' && packaged) return path.join(resourcesPath, 'core', 'sage-mcp');
  return packaged ? path.join(resourcesPath, '..', 'Helpers', 'sage-mcp') : path.join(repoRoot, 'native/sage-mcp/build', 'sage-mcp');
}

/** How far up from a connecting process its harness may be (a launcher script, an adapter's CLI, a worker process). */
const MAX_DEPTH = 8;

/**
 * `pid` and its ancestors, nearest first, from one reading of the process table (the core's caps.ancestry); null for no
 * pid, or when the table can't be read (the route's error, noted), which every caller takes as not started by the harness.
 * @param {number | null} pid @param {ReturnType<typeof core> | null} [addon]
 * @returns {Promise<number[] | null>}
 */
async function ancestryOf(pid, addon = core()) {
  if (pid === null || !(pid > 1)) return null;
  try {
    const chain = await coreCall('caps.ancestry', addon, String(pid));
    return Array.isArray(chain) ? chain : null;
  } catch (error) {
    noteIgnored('read who started a process', error);
    return null;
  }
}

/**
 * The pid at the far end of unix socket `fd`, by the kernel (the core's caps.peerPid), or null when it can't say (the
 * socket closed meanwhile: the route's error, noted), which every caller refuses.
 * @param {number} fd @param {ReturnType<typeof core> | null} [addon]
 */
async function peerPidOf(fd, addon = core()) {
  try {
    return await coreCall('caps.peerPid', addon, String(fd));
  } catch (error) {
    noteIgnored('read who holds a socket', error);
    return null;
  }
}

/**
 * Whether `pid` is `harnessPid` or was started by it, up to MAX_DEPTH levels: the one ancestry rule both tool channels
 * (this socket and ../httpMcp.cjs) apply to the process at the other end of a connection.
 * @param {number | null} pid @param {number} harnessPid @param {ReturnType<typeof core> | null} [addon]
 */
async function startedBy(pid, harnessPid, addon = core()) {
  return (await ancestryOf(pid, addon))?.slice(0, MAX_DEPTH).includes(harnessPid) ?? false;
}

/**
 * Whether the far end of `socket` is process `pid` and that process was started by `harnessPid` (its child, or further
 * down: startedBy). The pid sage-mcp claims is checked against the kernel: peerHolds. Returns null when it is, or why not.
 * @param {{ socket: any, pid: number, harnessPid: number, execFile?: Parameters<typeof peerHoldsWindows>[0]['execFile'], platform?: NodeJS.Platform, addon?: ReturnType<typeof core> | null }} o
 */
async function verifyPeer({ socket, pid, harnessPid, execFile, platform = process.platform, addon = core() }) {
  if (!Number.isInteger(pid) || pid <= 1) return 'no pid';
  if (!Number.isInteger(harnessPid)) return 'the session has no harness process';
  if (pid === harnessPid) return `process ${pid} is not one the harness started`;
  // started by the harness: its parent, or one further up (the chain starts with pid itself)
  const chain = await ancestryOf(pid, addon);
  if (!chain?.slice(1, 1 + MAX_DEPTH).includes(harnessPid)) return `process ${pid} is not one the harness started`;
  return peerHolds({ socket, pid, execFile, platform, addon });
}

/**
 * Whether process `pid` is at the far end of the unix `socket` main accepted, by the kernel's word (the core's
 * caps.peerPid): a process that only claims a pid is caught. Returns null when it is, or why not; a core that can't say is
 * a refusal. Shared by every socket that checks who is at its other end (sage-mcp here, the Chrome extension's native
 * host: browser/chromeNativeHost.cjs). On Windows the socket is a loopback TCP connection, whose owner netstat names
 * (./peerWindows.cjs).
 * @param {{ socket: any, pid: number, execFile?: Parameters<typeof peerHoldsWindows>[0]['execFile'], platform?: NodeJS.Platform, addon?: ReturnType<typeof core> | null }} o
 */
async function peerHolds({ socket, pid, execFile, platform = process.platform, addon = core() }) {
  if (platform === 'win32') return peerHoldsWindows({ socket, pid, execFile });
  const fd = socket._handle && socket._handle.fd;
  if (!Number.isInteger(fd) || fd < 0) return 'no socket';
  const peer = await peerPidOf(fd, addon);
  // 0 is a process the kernel can't name here (another pid namespace), never a match for a pid that claims it
  if (!Number.isInteger(peer) || peer <= 1) return 'socket not found';
  return peer === pid ? null : `process ${pid} is not the one connected`;
}

/** A registry tool as MCP lists it. */
const mcpTool = (t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: { readOnlyHint: t.policy === 'observe' },
});

/** A registry result as an MCP CallToolResult. */
function callToolResult(res) {
  const content = (res.content || []).slice();
  if (!res.ok) content.push({ type: 'text', text: res.error.message });
  // a result that ends the turn says so where Claude Code reads it (its MCP end-turn flag, as Claude Desktop's wrap-up
  // box does); other harnesses ignore it and go by the result's own text
  return { content, isError: !res.ok, ...(res.ok && res.endsTurn ? { _meta: { [CLAUDE_END_TURN]: true } } : {}) };
}

/** A JSON-RPC request id as a map key: 1 and "1" are different requests. */
const callKey = (id) => `${typeof id}:${id}`;

/** What tells a harness to read a tiered session's list again (its next turn's groups, mcp/toolTiers.cjs). */
const LIST_CHANGED = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`;

/**
 * Events: 'connected' ({key, serverName, pid}) once a sage-mcp is accepted; 'rejected' ({reason}).
 * At each turn's end (the Registry's turn tokens retire) the groups a tiered session loaded during it are listed,
 * and its sage-mcp passes list_changed on to the harness.
 */
class ToolSocket extends EventEmitter {
  /**
   * @param {{ sessions: InstanceType<typeof import('../contract/session.cjs').ToolSessions>, registry: InstanceType<typeof import('../contract/registry.cjs').Registry>,
   *           verifyPeer?: typeof verifyPeer, helloTimeoutMs?: number, platform?: NodeJS.Platform }} o
   */
  constructor(o) {
    super();
    this.sessions = o.sessions;
    this.registry = o.registry;
    this.verifyPeer = o.verifyPeer || verifyPeer;
    this.helloTimeoutMs = o.helloTimeoutMs ?? 5000;
    const createServer = () => net.createServer((socket) => this.#accept(socket));
    // Node listens on no unix socket on Windows: sage-mcp reaches main over 127.0.0.1 there, and the peer check follows
    this.listener =
      (o.platform ?? process.platform) === 'win32'
        ? new LoopbackListener({ createServer })
        : new PrivateSocketListener({ prefix: 'mpmcp-', createServer });
    this.conns = new Set();
    this.onRevoked = ({ digest }) => {
      for (const c of this.conns) if (c.digest === digest) c.socket.destroy();
    };
    this.onToolsChanged = ({ digest }) => {
      for (const c of this.conns) if (c.digest === digest && !c.socket.destroyed) c.socket.write(LIST_CHANGED);
    };
    this.sessions.on('revoked', this.onRevoked);
    this.sessions.on('tools-changed', this.onToolsChanged);
    this.offRetire = this.#retireCommits();
  }

  /** Commits tiered sessions' loaded groups whenever a turn retires; returns what stops it. */
  #retireCommits() {
    const off = this.registry.turns?.onRetire((chat, _turn, thread) => this.sessions.commitTurn(chat, thread));
    return typeof off === 'function' ? off : () => undefined;
  }

  /** Starts listening (once); resolves with the socket path (`127.0.0.1:<port>` on Windows). */
  listen() {
    this.sessions.off('revoked', this.onRevoked);
    this.sessions.on('revoked', this.onRevoked);
    this.sessions.off('tools-changed', this.onToolsChanged);
    this.sessions.on('tools-changed', this.onToolsChanged);
    this.offRetire();
    this.offRetire = this.#retireCommits();
    return this.listener.listen();
  }

  get server() {
    return this.listener.server;
  }
  get dir() {
    return this.listener.dir;
  }
  get path() {
    return this.listener.path;
  }
  get listening() {
    return this.listener.listening;
  }

  close() {
    this.sessions.off('revoked', this.onRevoked);
    this.sessions.off('tools-changed', this.onToolsChanged);
    this.offRetire();
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    this.listener.close();
  }

  #accept(socket) {
    /** @type {{ socket: import('node:net').Socket, digest: string | null, session: any, calls: Map<string, AbortController> }} */
    const c = { socket, digest: null, session: null, calls: new Map() };
    this.conns.add(c);
    const send = (m) => !socket.destroyed && socket.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    const reject = (id, reason) => {
      this.emit('rejected', { reason });
      send({ id, error: { code: -32001, message: 'Not allowed' } });
      socket.end();
      setTimeout(() => socket.destroy(), 100).unref();
    };
    const timer = setTimeout(() => reject(null, 'no hello'), this.helloTimeoutMs);
    timer.unref();
    let checking = false;
    const reader = new JsonReader({
      stream: socket,
      maxUnits: 4 * 1024 * 1024,
      onError: () => socket.destroy(),
      onInvalid: () => send({ id: null, error: { code: -32700, message: 'Parse error' } }),
      onValue: (msg) => {
        if (socket.destroyed) return;
        if (!c.session) {
          // nothing but one hello until it is accepted
          if (checking) return socket.destroy();
          checking = true;
          clearTimeout(timer);
          // a hello that fails is refused like any other: the timeout is already cleared, so nothing else answers it
          this.#hello(c, msg, send, reject).catch((error) => reject(msg?.id ?? null, messageOf(error)));
          return;
        }
        if (!isJsonRecord(msg)) {
          send({ id: null, error: { code: -32600, message: 'Invalid request' } });
          return;
        }
        // a request that fails still gets an answer: without one the agent's tool call waits forever
        this.#request(c, msg, send).catch((error) => send({ id: msg.id, error: { code: -32603, message: messageOf(error) } }));
      },
    });
    socket.on('error', () => {
      /* the close handler below deals with a lost socket */
    });
    socket.on('close', () => {
      reader.close();
      clearTimeout(timer);
      this.conns.delete(c);
      // sage-mcp went away (its harness quit or crashed): nobody waits for these calls, so they stop
      for (const ac of c.calls.values()) ac.abort();
      c.calls.clear();
    });
    socket.on('data', (chunk) => reader.push(chunk));
  }

  async #hello(c, msg, send, reject) {
    const p = (msg && msg.params) || {};
    if (msg.method !== 'hello') return reject(msg.id ?? null, 'no hello');
    const s = this.sessions.resolve(p.token);
    if (!s) return reject(msg.id, 'unknown token');
    const why = await this.verifyPeer({ socket: c.socket, pid: p.pid, harnessPid: s.harnessPid }).catch((e) => String(e.message || e));
    if (why) return reject(msg.id, why);
    // the token may have been rotated or revoked while the peer was being checked
    if (!this.sessions.live(s.digest) || c.socket.destroyed) return reject(msg.id, 'token revoked');
    c.session = s;
    c.digest = s.digest;
    send({ id: msg.id, result: { serverName: s.serverName } });
    this.emit('connected', { key: s.key, serverName: s.serverName, pid: p.pid });
  }

  async #request(c, msg, send) {
    // the harness cancelled one call (MCP notifications/cancelled, forwarded by sage-mcp): it stops like a Stop would, alone
    if (msg && msg.id == null && msg.method === 'notifications/cancelled') return cancelToolCall(c.calls, msg);
    if (!msg || msg.id == null || !msg.method) return;
    if (!this.sessions.live(c.digest)) {
      send({ id: msg.id, error: { code: -32001, message: 'Not allowed' } });
      return c.socket.destroy();
    }
    // read at each request: a Codex thread learns its id only after its MCP servers start, and what a
    // session may see can change with the thread's path (capabilities/channels/codexConfig.cjs)
    send(
      await answerToolRequest({
        registry: this.registry,
        sessions: this.sessions,
        session: this.sessions.get(c.session.key) || c.session,
        calls: c.calls,
        msg,
      }),
    );
  }
}

/** MCP notifications/cancelled: the call it names (in `calls`, by callKey) stops like a Stop would, alone. */
function cancelToolCall(calls, msg) {
  const id = msg.params?.requestId;
  if (id != null) calls.get(callKey(id))?.abort();
}

/**
 * The answer to a tools/list or tools/call request (any other method is not found) for `session`, a live
 * session as ToolSessions.get() gives it. A call in flight is kept in `calls` under callKey(id) until it ends,
 * so notifications/cancelled can stop it. Shared by sage-mcp's socket and the http channel (httpMcp.cjs).
 * A tiered session (mcp/toolTiers.cjs) lists its core tools, the groups it loaded and the more tools; `sessions`
 * records the groups a more tool loads.
 * @param {{ registry: any, session: any, calls: Map<string, AbortController>, msg: any,
 *           sessions?: InstanceType<typeof import('../contract/session.cjs').ToolSessions> | null }} o
 */
async function answerToolRequest({ registry, session: s, calls, msg, sessions = null }) {
  const p = msg.params || {};
  const hidden = (name) => typeof s.hide === 'function' && s.hide(name) === true;
  const shown = () => registry.list({ chatId: s.chatId }).filter((t) => !hidden(t.name));
  if (msg.method === 'tools/list') {
    const tools = shown();
    return { id: msg.id, result: { tools: (s.tiered ? tieredList(tools, s.loaded ?? new Set()) : tools).map(mcpTool) } };
  }
  if (msg.method === 'tools/call') {
    const more = s.tiered ? moreSurface(p.name) : null;
    if (!more && hidden(p.name)) {
      return {
        id: msg.id,
        result: {
          // the session's own rule says why (visibility.cjs): only the surfaces its harness serves
          content: [{ type: 'text', text: hiddenRefusalText(s.hide, p.name) }],
          isError: true,
        },
      };
    }
    let name = p.name;
    let args = p.arguments ?? {};
    if (more) {
      // a more tool lists, loads (listed from the next turn) or runs one of the deferred tools the session may see
      const byName = new Map(shown().map((t) => [t.name, t]));
      const r = moreCall(p.name, p.arguments, new Set(byName.keys()), (n) => byName.get(n));
      if (!('run' in r)) {
        if (r.load) sessions?.loadGroups(s.key, r.load);
        return { id: msg.id, result: { content: [{ type: 'text', text: r.answer }], isError: r.error === true } };
      }
      name = r.run;
      args = r.args;
    } else if (s.tiered) {
      const g = groupOf(p.name);
      if (g && !s.callable?.has(`${g.surface}/${g.group}`)) return { id: msg.id, result: notLoaded(p.name) };
    }
    const { chatId, segmentId } = s;
    const key = callKey(msg.id);
    const ac = new AbortController();
    calls.set(key, ac);
    try {
      // the call's _meta goes along as the harness sent it: Codex names the thread a call came from there, so a
      // sub-agent sharing its parent's session keeps its calls on its own turn (Registry turnThread)
      const res = await registry.invoke(chatId, segmentId, name, args, {
        signal: ac.signal,
        meta: isJsonRecord(p._meta) ? p._meta : null,
      });
      const result = callToolResult(res);
      // a tiered session's request_access grant loads the app tools: callable now, listed from its next turn
      // read again after the call: a grant waits on the user's card, and the turn (or the session) may have ended meanwhile
      const now = s.tiered && !result.isError ? sessions?.get(s.key) : null;
      const loads = now ? autoLoad(name, new Set(shown().map((t) => t.name)), now.callable) : null;
      if (loads && sessions?.loadGroups(s.key, loads.load)) result.content = [...result.content, { type: 'text', text: loads.note }];
      return { id: msg.id, result };
    } finally {
      if (calls.get(key) === ac) calls.delete(key);
    }
  }
  return { id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
}

/**
 * ToolSessions' preloaded groups for the app (toolTiers.cjs preloadedGroups): the Chrome core while the user's chosen
 * browser is their Chrome, read from `live.browserControl` (BrowserControl.userChrome) when a tiered session opens.
 * @param {{ browserControl?: any }} live
 */
const preloadedFor = (live) => () => preloadedGroups(!!userChromeOf(live.browserControl));

module.exports = {
  preloadedFor,
  ToolSocket,
  verifyPeer,
  peerHolds,
  ancestryOf,
  peerPidOf,
  sageMcpPath,
  mcpTool,
  callToolResult,
  cancelToolCall,
  answerToolRequest,
  startedBy,
  MAX_DEPTH,
};
