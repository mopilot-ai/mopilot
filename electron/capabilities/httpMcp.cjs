// The http tool channel, for a basic (ACP) harness that takes no stdio MCP server (Copilot CLI takes only http
// and sse). Main serves MCP's Streamable HTTP transport itself on 127.0.0.1: the harness POSTs JSON-RPC to /mcp
// with `Authorization: Bearer <token>`, its session's token (./contract/session.cjs). Initialize and ping are answered here,
// as sage-mcp answers them, and tools/list and tools/call as the unix socket does (socket.cjs answerToolRequest). A
// request goes through only when its token belongs to a live session and the process holding the other end of
// its TCP connection is that session's harness or a process it started (lsof names it, netstat on Windows; the core reads its ancestry).
// Each initialize opens an MCP session (Mcp-Session-Id), so two clients of one harness session keep their calls apart.
const crypto = require('node:crypto');
const http = require('node:http');
const { proc } = require('../platform/ports/proc.cjs');
const { EventEmitter } = require('node:events');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { messageOf, noteIgnored } = require('../ignored.cjs');
const { answerToolRequest, cancelToolCall, startedBy } = require('./mcp/socket.cjs');
const { core } = require('../platform/core.cjs');
const { tcpOwnerWindows } = require('./mcp/peerWindows.cjs');

const HOST = '127.0.0.1';
const PATH = '/mcp';
const MAX_BODY = 4 * 1024 * 1024;
const VERSION = '1.0.0';
/** The MCP revisions whose Streamable HTTP this endpoint serves (JSON answers), newest first. */
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** What verifyTcpPeer says when lsof listed no process for the connection: unknown, which is not someone else. */
const PEER_NOT_FOUND = 'the connecting process was not found';

const run = (cmd, args, exec) =>
  new Promise((resolve) => {
    // lsof exits 1 when one of several pids has nothing to list; its output still counts
    exec(cmd, args, { timeout: 5000 }, (_err, stdout) => resolve(String(stdout || '')));
  });

/** lsof -F output as [{pid, fd, device, name}] for each open file. */
function parseLsof(out) {
  /** @type {{ pid: number | null, fd: string, device: string | null, name: string | null }[]} */
  const files = [];
  /** @type {number | null} */
  let pid = null;
  /** @type {(typeof files)[number] | null} */
  let cur = null;
  for (const line of out.split('\n')) {
    const tag = line[0];
    const v = line.slice(1);
    if (tag === 'p') pid = parseInt(v, 10);
    else if (tag === 'f') files.push((cur = { pid, fd: v, device: null, name: null }));
    else if (tag === 'd' && cur) cur.device = v;
    else if (tag === 'n' && cur) cur.name = v;
  }
  return files;
}

/**
 * Whether the process at the far end of `socket` (a TCP connection to 127.0.0.1) is `harnessPid` or one of its
 * descendants. lsof names the process holding the connection's other end (netstat on Windows). Returns null when it is, or why not.
 * @param {{ socket: any, harnessPid: number, execFile?: typeof proc.execFile, addon?: ReturnType<typeof core> | null, platform?: NodeJS.Platform }} o
 */
async function verifyTcpPeer({ socket, harnessPid, execFile, addon = core(), platform = process.platform }) {
  const exec = execFile ?? proc.execFile;
  if (!Number.isInteger(harnessPid)) return 'the session has no harness process';
  const peer = await tcpPeerPid(socket, exec, platform);
  if (typeof peer === 'string') return peer;
  return (await startedBy(peer, harnessPid, addon)) ? null : `process ${peer} is not the harness or one it started`;
}

/**
 * The pid of the process at the far end of `socket` (a TCP connection to 127.0.0.1), as lsof names it; a reason when
 * there is none: 'no socket', or PEER_NOT_FOUND when lsof listed nothing for it; null when it listed no process for it.
 * Windows has no lsof: netstat's TCP table names the owner there (./mcp/peerWindows.cjs).
 * @returns {Promise<number | null | string>}
 */
async function tcpPeerPid(socket, exec = proc.execFile, platform = process.platform) {
  const { remotePort, localPort } = socket;
  if (!remotePort || !localPort) return 'no socket';
  if (platform === 'win32') return (await tcpOwnerWindows(socket, exec)) ?? PEER_NOT_FOUND;
  const end = `${HOST}:${remotePort}->${HOST}:${localPort}`;
  const list = async () =>
    parseLsof(await run('/usr/sbin/lsof', ['-nP', `-iTCP@${HOST}:${remotePort}`, '-sTCP:ESTABLISHED', '-F', 'pn'], exec));
  // lsof can run past its time limit on a loaded machine and then prints nothing: that says nothing about the peer, so ask once more
  let files = await list();
  if (!files.length) files = await list();
  const peer = files.find((f) => f.name === end);
  // a connection lsof lists without its process line has no pid to follow (null)
  return peer ? peer.pid : PEER_NOT_FOUND;
}

/** Reads a request body up to MAX_BODY; null when it is longer. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.removeAllListeners('data');
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const refuse = (res, status, message, code = -32001) => json(res, status, { jsonrpc: '2.0', id: null, error: { code, message } });

/**
 * Events: 'connected' ({key, serverName, pid: null}) on each initialize a session's harness sends; 'rejected' ({reason}).
 */
class ToolHttp extends EventEmitter {
  /**
   * @param {{ sessions: InstanceType<typeof import('./contract/session.cjs').ToolSessions>, registry: InstanceType<typeof import('./contract/registry.cjs').Registry>,
   *           verifyPeer?: typeof verifyTcpPeer }} o
   */
  constructor(o) {
    super();
    this.sessions = o.sessions;
    this.registry = o.registry;
    this.verifyPeer = o.verifyPeer || verifyTcpPeer;
    /** @type {import('node:http').Server | null} */
    this.server = null;
    /** @type {Promise<string> | null} */
    this.listening = null;
    /** @type {() => void} */
    this.cancelOpening = () => {
      /* nothing is opening */
    };
    /** session token digest -> MCP session id ('' for a client that sends none) -> its calls in flight, by callKey */
    this.calls = new Map();
    /** TCP connection -> the peer check made for the session (by digest) that used it */
    this.peers = new WeakMap();
    this.onRevoked = ({ digest }) => {
      // the token stopped working: nobody may wait for its calls (the unix socket closes, which does the same)
      for (const calls of this.calls.get(digest)?.values() ?? []) for (const ac of calls.values()) ac.abort();
      this.calls.delete(digest);
    };
  }

  /** Starts listening (once); resolves with the endpoint's url. */
  listen() {
    this.sessions.off('revoked', this.onRevoked);
    this.sessions.on('revoked', this.onRevoked);
    if (this.listening) return this.listening;
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        noteIgnored('answer a harness over http', error);
        res.destroy();
      });
    });
    this.server = server;
    const listening = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (/** @type {Error | null} */ error, url = '') => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(url);
      };
      // a server closed before it binds never calls back: close() ends the wait
      this.cancelOpening = () => finish(new Error('The http tool channel was closed while opening.'));
      server.on('error', (error) => {
        if (settled) noteIgnored('keep the http tool channel listening', error);
        else finish(error);
      });
      server.listen(0, HOST, () =>
        finish(null, `http://${HOST}:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}${PATH}`),
      );
    });
    this.listening = listening;
    listening.catch(() => {
      server.close();
      if (this.listening === listening) {
        this.listening = null;
        this.server = null;
      }
    });
    return listening;
  }

  close() {
    this.cancelOpening();
    this.sessions.off('revoked', this.onRevoked);
    for (const clients of this.calls.values()) for (const calls of clients.values()) for (const ac of calls.values()) ac.abort();
    this.calls.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.listening = null;
  }

  /** The calls in flight for one MCP client of a session (its token's digest, the MCP session id it sends). */
  #callsOf(digest, client) {
    let clients = this.calls.get(digest);
    if (!clients) this.calls.set(digest, (clients = new Map()));
    let calls = clients.get(client);
    if (!calls) clients.set(client, (calls = new Map()));
    return calls;
  }

  async #handle(req, res) {
    const port = req.socket.localPort;
    if (new URL(String(req.url), 'http://x').pathname !== PATH) return refuse(res, 404, 'Not found');
    // only the harness, never a web page: a browser sends Origin, and a rebound DNS name a Host that isn't ours
    if (req.headers.origin || ![`${HOST}:${port}`, `localhost:${port}`].includes(String(req.headers.host)))
      return refuse(res, 403, 'Not allowed');
    if (req.method !== 'POST') {
      // no server-to-client stream (GET) and no MCP session to delete (DELETE): the transport allows both answers
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    const token = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const s = this.sessions.resolve(token);
    if (!s) {
      this.emit('rejected', { reason: 'unknown token' });
      return refuse(res, 401, 'Not allowed');
    }
    const body = await readBody(req);
    if (body === null) return refuse(res, 413, 'Request too large', -32600);
    let peer = this.peers.get(req.socket);
    if (peer?.digest !== s.digest) {
      peer = {
        digest: s.digest,
        check: this.verifyPeer({ socket: req.socket, harnessPid: s.harnessPid }).catch((e) => messageOf(e)),
      };
      this.peers.set(req.socket, peer);
    }
    const why = await peer.check;
    if (why) {
      this.emit('rejected', { reason: why });
      return refuse(res, 403, 'Not allowed');
    }
    // the token may have been rotated or revoked while the peer was being checked or the body read
    if (!this.sessions.live(s.digest)) {
      this.emit('rejected', { reason: 'token revoked' });
      return refuse(res, 401, 'Not allowed');
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return refuse(res, 400, 'Parse error', -32700);
    }
    const batch = Array.isArray(parsed);
    const msgs = batch ? parsed : [parsed];
    const hello = msgs.some((m) => isJsonRecord(m) && m.method === 'initialize' && m.id != null);
    // an initialize starts a new MCP session; every later request names its own
    const client = hello ? crypto.randomUUID() : String(req.headers['mcp-session-id'] ?? '');
    const calls = this.#callsOf(s.digest, client);
    /** the calls this request started: only these stop when the harness hangs up on it */
    const mine = [];
    const tracked = {
      get: (k) => calls.get(k),
      set: (k, ac) => (mine.push(ac), calls.set(k, ac)),
      delete: (k) => calls.delete(k),
    };
    res.on('close', () => {
      // the harness hung up (it stopped, or gave up on the call): nobody waits for this request's calls
      if (!res.writableFinished) for (const ac of mine) ac.abort();
    });
    const answers = await Promise.all(msgs.map((m) => this.#answer(s, calls, tracked, m)));
    const out = answers.filter((a) => a !== null).map((a) => ({ jsonrpc: '2.0', ...a }));
    if (!out.length) {
      // notifications and responses only
      res.writeHead(202);
      return res.end();
    }
    // its tools have said hello once the harness has the initialize answer
    if (hello) res.once('finish', () => this.emit('connected', { key: s.key, serverName: s.serverName, pid: null }));
    res.writeHead(200, { 'Content-Type': 'application/json', ...(hello ? { 'Mcp-Session-Id': client } : {}) });
    res.end(JSON.stringify(batch ? out : out[0]));
  }

  /** One JSON-RPC message's answer, or null for one that needs none. */
  async #answer(s, calls, tracked, msg) {
    if (!isJsonRecord(msg)) return { id: null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id == null) {
      // the harness cancelled one call: it stops like a Stop would, alone; other notifications need nothing
      if (msg.method === 'notifications/cancelled') cancelToolCall(calls, msg);
      return null;
    }
    // a response to a request: main never asks the harness anything
    if (typeof msg.method !== 'string') return null;
    if (msg.method === 'initialize') {
      const p = isJsonRecord(msg.params) ? msg.params : {};
      return {
        id: msg.id,
        result: {
          // the one asked for when it is served here, else the newest (the client then decides whether to go on)
          protocolVersion: PROTOCOLS.includes(/** @type {string} */ (p.protocolVersion)) ? p.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: s.serverName, version: VERSION },
        },
      };
    }
    if (msg.method === 'ping') return { id: msg.id, result: {} };
    // read at each request, as the socket does: what a session may see can change
    const session = this.sessions.get(s.key) || s;
    // a request that fails still gets an answer: without one the agent's tool call waits forever
    return answerToolRequest({ registry: this.registry, sessions: this.sessions, session, calls: tracked, msg }).catch((error) => ({
      id: msg.id,
      error: { code: -32603, message: messageOf(error) },
    }));
  }
}

module.exports = { ToolHttp, verifyTcpPeer, tcpPeerPid, parseLsof, run, PEER_NOT_FOUND, PATH };
