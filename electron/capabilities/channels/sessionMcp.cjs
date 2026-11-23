// The tool channel for basic-tier (ACP) harnesses: sage-mcp goes into session/new's mcpServers as a @host-portable: loads in the Host process without Electron (host/boundary.json).
// stdio server (ACP passes env as [{name, value}]); a harness that takes no stdio server but takes http
// gets main's own http endpoint instead (../httpMcp.cjs), with its token in an Authorization header. A
// basic-tier harness is admitted only if its tools say hello to main within 10 seconds (sage-mcp's hello,
// or the harness's MCP initialize over http); otherwise an 'admission-failed' event goes out.
const { EventEmitter } = require('node:events');
const { shownTools } = require('../contract/surfaceNote.cjs');
const { getEnv } = require('../../platform/winbin.cjs');

const ADMISSION_MS = 10_000;

/**
 * What sage-mcp is started with: its socket and token, and on Windows SystemRoot too. A harness that starts an MCP
 * server with only the env it is given leaves it out, and Winsock can't open the loopback socket without it.
 * @param {{ socketPath: string, token: string, platform?: NodeJS.Platform, env?: Record<string, string | undefined> }} o
 * @returns {Record<string, string>}
 */
function sageMcpEnv({ socketPath, token, platform = process.platform, env = process.env }) {
  const root = platform === 'win32' ? getEnv(env, 'SystemRoot') : undefined;
  return { SAGE_MCP_SOCKET: socketPath, SAGE_MCP_TOKEN: token, ...(root ? { SystemRoot: root } : {}) };
}

/**
 * The stdio McpServer entry for session/new (or session/load).
 * @param {{ serverName: string, command: string, args?: string[], socketPath: string, token: string }} o
 */
function sessionMcpServer({ serverName, command, args = [], socketPath, token }) {
  return {
    name: serverName,
    command,
    args,
    env: Object.entries(sageMcpEnv({ socketPath, token })).map(([name, value]) => ({ name, value })),
  };
}

/** The http McpServer entry for session/new (or session/load): main's endpoint, the token as a bearer header. */
function sessionMcpHttpServer({ serverName, url, token }) {
  return { type: 'http', name: serverName, url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] };
}

/**
 * Events: 'admitted' ({key, serverName}) when the session's sage-mcp connects in time;
 * 'admission-failed' ({key, serverName, reason}) when it doesn't.
 */
class SessionMcp extends EventEmitter {
  /**
   * @param {{ sessions: InstanceType<typeof import('../contract/session.cjs').ToolSessions>, socket: InstanceType<typeof import('../mcp/socket.cjs').ToolSocket>,
   *           command: string, args?: string[], admissionMs?: number, enabled?: () => boolean,
   *           http?: InstanceType<typeof import('../httpMcp.cjs').ToolHttp> | null }} o
   */
  constructor(o) {
    super();
    this.sessions = o.sessions;
    this.socket = o.socket;
    this.command = o.command;
    /** @type {string[]} what follows `command` (the Host runs its portable sage-mcp as `node <script>`) */
    this.args = o.args ?? [];
    this.admissionMs = o.admissionMs ?? ADMISSION_MS;
    /** the channel's remote switch (channel.acp.sessionMcp): off, no session gets tools */
    this.enabled = o.enabled ?? (() => true);
    /** session key -> { done(ok, reason) } while waiting for its hello */
    this.waiting = new Map();
    /** sessions whose sage-mcp said hello since prepare(), in case that beats admission() */
    this.helloed = new Set();
    /** the http endpoint, for a harness that takes no stdio MCP server */
    this.http = o.http ?? null;
    const connected = ({ key }) => {
      this.helloed.add(key);
      this.waiting.get(key)?.done(true);
    };
    this.socket.on('connected', connected);
    this.http?.on('connected', connected);
  }

  /**
   * Opens the session's tools (on a resume, rotates its token) before the ACP session exists: the socket is
   * listening and the entry for mcpServers is ready. Call admission() once session/new is sent. With `http`, the
   * entry is main's http endpoint (when there is one) rather than sage-mcp.
   * @returns {Promise<{ serverName: string, mcpServers: object[] }>}
   */
  async prepare(key, { harnessPid, chatId = key, segmentId = key, resume = false, http = false }) {
    if (!this.enabled()) throw new Error('MoPilot has turned off computer and browser control for this harness for now');
    const overHttp = http && !!this.http;
    const where = overHttp ? await /** @type {NonNullable<typeof this.http>} */ (this.http).listen() : await this.socket.listen();
    this.helloed.delete(key);
    // rotate() is null when there is no session to resume; an ACP harness has no tool search: its tools are tiered
    const issued =
      (resume && this.sessions.rotate(key, { harnessPid, chatId, segmentId, tiered: true })) ||
      this.sessions.open(key, { harnessPid, chatId, segmentId, tiered: true });
    return {
      serverName: issued.serverName,
      mcpServers: [
        overHttp
          ? sessionMcpHttpServer({ serverName: issued.serverName, url: where, token: issued.token })
          : sessionMcpServer({
              serverName: issued.serverName,
              command: this.command,
              args: this.args,
              socketPath: where,
              token: issued.token,
            }),
      ],
    };
  }

  /** Starts the admission clock. Resolves true once sage-mcp has said hello, false (and emits) otherwise. */
  admission(key) {
    const s = this.sessions.get(key);
    if (!s || !this.enabled()) return Promise.resolve(false);
    this.waiting.get(key)?.done(false, 'superseded');
    if (this.helloed.has(key)) {
      this.emit('admitted', { key, serverName: s.serverName });
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => entry.done(false, `no handshake from sage-mcp within ${Math.round(this.admissionMs / 1000)}s`),
        this.admissionMs,
      );
      const entry = {
        done: (ok, reason) => {
          if (this.waiting.get(key) !== entry) return;
          this.waiting.delete(key);
          clearTimeout(timer);
          if (ok) this.emit('admitted', { key, serverName: s.serverName });
          else if (reason !== 'superseded') this.emit('admission-failed', { key, serverName: s.serverName, reason });
          resolve(ok);
        },
      };
      this.waiting.set(key, entry);
    });
  }

  end(key) {
    this.waiting.get(key)?.done(false, 'superseded');
    this.helloed.delete(key);
    this.sessions.end(key);
  }

  /** The connected segment's callable inventory, or null before it has a tool session. */
  toolsOf(key, names) {
    const session = this.sessions.get(key);
    if (!session) return null;
    return this.helloed.has(key) ? shownTools(() => names, session.hide) : [];
  }
}

module.exports = { sessionMcpServer, sessionMcpHttpServer, sageMcpEnv, SessionMcp, ADMISSION_MS };
