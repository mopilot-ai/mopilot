// Codex probes talk JSON-RPC to the real `codex app-server` over stdio.
// Config overrides are per-process `-c` flags or per-thread `config`; ~/.codex/config.toml is never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { newestInstall, sleep } from './common.mjs';

export function versionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], { timeout: 8000 })
      .toString()
      .trim()
      .replace(/^codex-cli\s*/, '');
  } catch {
    return null;
  }
}

export function findBinary(override) {
  const h = os.homedir();
  const list = override
    ? [override]
    : [
        process.env.CODEX_BIN,
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(h, '.local/bin/codex'),
        path.join(h, '.codex/bin/codex'),
        path.join(h, '.npm-global/bin/codex'),
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
        '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
      ];
  const found = list.filter((c) => c && fs.existsSync(c)).map((p) => ({ path: p, version: versionOf(p) }));
  return newestInstall(found, 'codex');
}

/** Only per-process overrides are allowed on the command line. */
export function assertSafeArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--enable' || a === '--disable') {
      const v = args[++i];
      if (typeof v !== 'string' || !v) throw new Error(`conformance: ${a} needs a value`);
      continue;
    }
    throw new Error(`conformance: app-server arg ${a} is not allowed (use -c, --enable or --disable)`);
  }
}

// Methods that write the user's config, change the login, or send data out.
const BLOCKED = [
  /^config\/(value\/write|batchWrite)$/,
  /^experimentalFeature\/enablement\/set$/,
  /^account\/(login|logout|sendAddCreditsNudgeEmail|rateLimitResetCredit)/,
  /^externalAgentConfig\/import/,
  /\/(install|uninstall)$/,
  /^skills\/config\/write$/,
];
export function assertSafeRequest(method, params) {
  if (BLOCKED.some((re) => re.test(method))) throw new Error(`conformance: ${method} is blocked`);
  // feedback/upload is only probed with an invalid body, so nothing is uploaded.
  if (method === 'feedback/upload' && params && 'classification' in params) throw new Error('conformance: real feedback/upload is blocked');
}

// No notify hook, no memory writes.
const BASE_ARGS = ['-c', 'notify=[]', '-c', 'features.memories=false'];

export class Client {
  /**
   * @param ctx the conformance run (bin, recorder)
   * @param {string} name
   * @param {{ args?: string[], onRequest?: (msg: any, client: Client) => any, env?: Record<string, string> }} [opts]
   */
  constructor(ctx, name, { args = [], onRequest, env } = {}) {
    assertSafeArgs(args);
    this.ctx = ctx;
    /** what initialize answered (set by open()) */
    this.initResult = null;
    this.rec = ctx.recorder(name);
    this.args = ['app-server', ...BASE_ARGS, ...args];
    this.proc = spawn(ctx.bin, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: os.tmpdir(),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    this.id = 0;
    this.pending = new Map();
    this.notes = [];
    this.waiters = [];
    this.threads = new Set(); // durable threads this client created, archived on close
    this.onRequest = onRequest ?? (() => undefined);
    this.stderr = '';
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          this.rec.write({ dir: '<', raw: line });
          continue;
        }
        this.rec.write({ dir: '<', msg: m });
        this._handle(m);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      this.stderr = (this.stderr + c).slice(-20000);
    });
    this.exited = /** @type {Promise<void>} */ (
      new Promise((r) => this.proc.on('exit', (code, sig) => (this.rec.write({ exit: code, sig }), r())))
    );
    this.rec.write({ args: this.args });
    ctx.defer(() => this.close());
  }
  async _handle(m) {
    if (m.id !== undefined && !m.method) {
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
      return;
    }
    if (m.method && m.id !== undefined) {
      let result;
      try {
        result = await this.onRequest(m, this);
      } catch (e) {
        result = { __error: String(e) };
      }
      if (result === undefined) {
        if (/requestApproval$|^execCommandApproval$|^applyPatchApproval$/.test(m.method)) result = { decision: 'accept' };
        else if (m.method === 'mcpServer/elicitation/request') result = { action: 'decline', content: null };
        else result = { __error: 'unhandled' };
      }
      this._send(
        result?.__error
          ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: result.__error } }
          : { jsonrpc: '2.0', id: m.id, result },
      );
      return;
    }
    if (m.method) {
      this.notes.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) this.waiters.splice(this.waiters.indexOf(w), 1), w.res(m);
    }
  }
  _send(obj) {
    this.rec.write({ dir: '>', msg: obj });
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  async request(method, params, timeoutMs = 60000) {
    assertSafeRequest(method, params);
    const id = ++this.id;
    const r = await new Promise((res) => {
      const t = setTimeout(
        () => (this.pending.delete(id), res({ error: { code: 'TIMEOUT', message: `timeout ${timeoutMs}ms` } })),
        timeoutMs,
      );
      this.pending.set(id, (m) => (clearTimeout(t), res(m)));
      this._send({ jsonrpc: '2.0', id, method, params });
    });
    const th = r.result?.thread;
    if ((method === 'thread/start' || method === 'thread/fork') && th?.id && !th.ephemeral) this.threads.add(th.id);
    return r;
  }
  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }
  waitFor(pred, timeoutMs = 120000, fromIndex = 0) {
    const hit = this.notes.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1), res(null);
      }, timeoutMs);
    });
  }
  async init() {
    const r = await this.request('initialize', {
      clientInfo: { name: 'sage_conformance', title: 'Sage conformance', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    return r;
  }
  /** thread/start with the cheap defaults; `extra.config` is merged. */
  startThread(extra = {}) {
    const { config, ...rest } = extra;
    return this.request('thread/start', {
      model: this.ctx.model,
      cwd: this.ctx.cwd('thread'),
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      serviceTier: 'default',
      ...rest,
      config: { model_reasoning_effort: this.ctx.effort, ...(config ?? {}) },
    });
  }
  /** Starts a turn and waits for its turn/completed. */
  async turn(threadId, text, extra = {}, timeoutMs = 180000) {
    const from = this.notes.length;
    const start = await this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...extra });
    if (start.error) return { start, completed: null, from };
    const turnId = start.result?.turn?.id;
    const completed = await this.waitFor(
      (n) => n.method === 'turn/completed' && n.params?.threadId === threadId && (!turnId || n.params?.turn?.id === turnId),
      timeoutMs,
      from,
    );
    return { start, turnId, completed, from, status: completed?.params?.turn?.status ?? null };
  }
  items(from, threadId) {
    return this.notes
      .slice(from)
      .filter((n) => n.method === 'item/completed' && (!threadId || n.params?.threadId === threadId))
      .map((n) => n.params.item);
  }
  methods(from = 0, threadId) {
    return [
      ...new Set(
        this.notes
          .slice(from)
          .filter((n) => !threadId || !n.params?.threadId || n.params.threadId === threadId)
          .map((n) => n.method),
      ),
    ];
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.proc.exitCode === null ? this.threads : []) {
      const r = await this.request('thread/archive', { threadId: id }, 10000);
      this.rec.write({ harness: 'archive', threadId: id, ok: !r.error });
    }
    try {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
    } catch {
      /* the process may already have exited */
    }
    const t = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* the process may already have exited */
      }
    }, 3000);
    await this.exited;
    clearTimeout(t);
  }
}

/**
 * A throwaway CODEX_HOME: the developer's config.toml, plugins and login are cloned (APFS clones, so
 * it is quick and writes never reach the original); sessions and state start empty. Auth is only
 * copied, never read or printed. Returns the env to pass to open().
 */
export function tempHome(ctx, name = 'codex-home') {
  const src = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const dst = path.join(ctx.tmpRoot, name);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['config.toml', 'auth.json', 'installation_id', 'models_cache.json', 'plugins', 'node_repl', 'computer-use']) {
    const from = path.join(src, f);
    if (!fs.existsSync(from)) continue;
    try {
      execFileSync('cp', ['-cR', from, path.join(dst, f)]);
    } catch {
      fs.cpSync(from, path.join(dst, f), { recursive: true });
    }
  }
  return { CODEX_HOME: dst };
}

export async function open(ctx, name, opts) {
  const c = new Client(ctx, name, opts);
  const r = await c.init();
  if (r.error) throw new Error(`initialize failed: ${JSON.stringify(r.error)}`);
  c.initResult = r.result;
  return c;
}

export const agentText = (items) =>
  items
    .filter((i) => i.type === 'agentMessage')
    .map((i) => i.text)
    .join(' | ');
export const errMsg = (r) => r?.error?.message ?? null;
export { sleep };
