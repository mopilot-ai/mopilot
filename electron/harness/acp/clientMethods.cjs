// ACP client filesystem and terminal operations, plus recognition of the session's own authorized tools.
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { RpcError } = require('./rpc.cjs');
const { writeTextAtomic } = require('../../platform/writeTextAtomic.cjs');

/** Output kept per terminal when the agent sets no limit. */
const TERMINAL_OUTPUT_LIMIT = 1_000_000;

const NOT_SAGE_KINDS = new Set(['execute', 'edit', 'delete', 'move']);
/**
 * A permission request for one of this session's own sage_<nonce> tools. Only the random server
 * name counts, matched where harnesses put an MCP tool's name (its title or _meta), never in the
 * arguments, so a command or path that mentions it doesn't pass.
 */
function isSageToolCall(toolCall, serverName) {
  if (!/^sage_[0-9a-f]{12}$/.test(serverName || '')) return false;
  return sageServersCalled(toolCall).has(serverName);
}

const SERVER_AT_START = /^(?:mcp__)?(sage_[0-9a-f]{12})(?:__|[/.:])/;
const SERVER_AT_END = /\((sage_[0-9a-f]{12}) MCP Server\)$/;

/**
 * Every MoPilot tool server a tool call names, where harnesses put an MCP tool's name (title or _meta).
 * The one parser behind both the own-call check and the foreign-call check (#2311, #2302).
 * @param {any} toolCall
 * @returns {Set<string>}
 */
function sageServersCalled(toolCall) {
  const found = new Set();
  if (!toolCall || NOT_SAGE_KINDS.has(toolCall.kind)) return found;
  const names = [toolCall.title];
  const meta = toolCall._meta;
  if (meta && typeof meta === 'object')
    for (const v of Object.values(meta)) {
      if (typeof v === 'string') names.push(v);
      else if (v && typeof v === 'object') for (const w of Object.values(v)) if (typeof w === 'string') names.push(w);
    }
  for (const t of names) {
    if (typeof t !== 'string') continue;
    const m = SERVER_AT_START.exec(t) ?? SERVER_AT_END.exec(t);
    if (m) found.add(m[1]);
  }
  return found;
}

/**
 * Whether a tool call names a MoPilot tool server that is not this chat's own: another chat's (an agent may
 * share MCP servers across sessions, #2311, #2302), a closed chat's, or one this chat never had. Fails closed: a chat
 * without a server of its own has none to call.
 */
function isForeignSageCall(toolCall, ownServerName) {
  for (const n of sageServersCalled(toolCall)) if (n !== ownServerName) return true;
  return false;
}

/** The option to answer an automatic allow with: allow_once, else any allow. */
const allowOnce = (options) =>
  (options ?? []).find((o) => o.kind === 'allow_once') ?? (options ?? []).find((o) => String(o.kind).startsWith('allow'));

function absolute(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new RpcError(-32602, 'path must be absolute');
  return p;
}

function readTextFile({ path: p, line, limit }) {
  let text;
  try {
    text = fs.readFileSync(absolute(p), 'utf8');
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(-32002, `Couldn't read ${p}: ${e.code ?? e.message}`);
  }
  if (line == null && limit == null) return { content: text };
  const lines = text.split('\n');
  const from = Math.max(0, (Number(line) || 1) - 1);
  const to = limit == null ? lines.length : from + Math.max(0, Number(limit) || 0);
  return { content: lines.slice(from, to).join('\n') };
}

function writeTextFile({ path: p, content }) {
  const file = absolute(p);
  writeTextAtomic(file, String(content ?? ''));
  return null;
}

/** terminal/* on the platform pty (electron/platform/pty.cjs). */
class Terminals {
  constructor(pty) {
    this.pty = pty;
    this.byId = new Map();
  }
  create(owner, { command, args = [], env = [], cwd, outputByteLimit }) {
    if (typeof command !== 'string' || !command) throw new RpcError(-32602, 'command is required');
    const terminalId = `term-${crypto.randomUUID()}`;
    const t = {
      owner,
      output: '',
      truncated: false,
      limit: Number(outputByteLimit) > 0 ? Number(outputByteLimit) : TERMINAL_OUTPUT_LIMIT,
      exit: /** @type {{ exitCode: number | null, signal: string | null } | null} */ (null),
      /** @type {((exit: { exitCode: number | null, signal: string | null }) => void)[]} */
      waiters: [],
    };
    const extra = {};
    for (const e of Array.isArray(env) ? env : []) if (e && typeof e.name === 'string') extra[e.name] = String(e.value ?? '');
    this.byId.set(terminalId, t);
    try {
      this.pty.spawn(
        `acp:${terminalId}`,
        { command: [command, ...args.map(String)], cwd, env: extra, cols: 120, rows: 30, selfAnswer: true },
        {
          onData: (d) => {
            t.output += d;
            // keep the tail, cut at a character boundary
            while (Buffer.byteLength(t.output, 'utf8') > t.limit) {
              t.output = t.output.slice(Math.max(1, t.output.length - Math.floor(t.limit / 2)));
              t.truncated = true;
            }
          },
          onExit: ({ exitCode, signal }) => {
            t.exit = { exitCode: exitCode ?? null, signal: signal ? String(signal) : null };
            for (const w of t.waiters.splice(0)) w(t.exit);
          },
        },
      );
    } catch (error) {
      this.byId.delete(terminalId);
      throw error;
    }
    return { terminalId };
  }
  get(terminalId, owner) {
    const t = this.byId.get(terminalId);
    if (!t || t.owner !== owner) throw new RpcError(-32602, `Unknown terminal: ${terminalId}`);
    return t;
  }
  output({ terminalId }, owner) {
    const t = this.get(terminalId, owner);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }
  waitForExit({ terminalId }, owner) {
    const t = this.get(terminalId, owner);
    return t.exit ?? new Promise((r) => t.waiters.push(r));
  }
  kill({ terminalId }, owner) {
    this.get(terminalId, owner);
    this.pty.kill(`acp:${terminalId}`);
    return null;
  }
  release({ terminalId }, owner) {
    if (!this.byId.has(terminalId)) return null;
    const t = this.get(terminalId, owner);
    this.byId.delete(terminalId);
    this.pty.kill(`acp:${terminalId}`);
    for (const w of t.waiters.splice(0)) w(t.exit ?? { exitCode: null, signal: 'SIGTERM' });
    return null;
  }
  releaseSession(owner) {
    for (const [id, t] of this.byId) if (t.owner === owner) this.release({ terminalId: id }, owner);
  }
}

/** What a session asks the client to do with files and commands. */
const FILES_AND_COMMANDS = new Set([
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
]);

/** Whether the session `key` belongs to a chat kept apart from the coding side (MoMo's, #2139): the host's `isolated` rule, when main set one. */
const isIsolated = (/** @type {any} */ host, /** @type {string} */ key) => host.isolated?.(key) === true;

/**
 * The chat a request is for, refused when it asks for files or commands in a chat kept apart from the coding side
 * (MoMo's, #2139: decided when its session opened, `chat.isolated`, or `host.isolated(chatId)`, set by main): MoMo reads
 * files only through its own Files source.
 * @template {{ key: string, isolated?: boolean }} C
 * @param {any} host the AcpHost: its `isolated` rule, when main set one
 * @param {string} method
 * @param {C | null | undefined} chat
 * @returns {C | null | undefined}
 */
function guardIsolated(host, method, chat) {
  if (chat && FILES_AND_COMMANDS.has(method) && (chat.isolated === true || isIsolated(host, chat.key)))
    throw new RpcError(-32000, "MoMo's chats don't read or write files or run commands here");
  return chat;
}

module.exports = {
  Terminals,
  readTextFile,
  writeTextFile,
  isSageToolCall,
  isForeignSageCall,
  sageServersCalled,
  allowOnce,
  guardIsolated,
  isIsolated,
};
