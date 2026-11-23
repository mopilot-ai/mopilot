// Claude Code probes drive the real CLI through the Agent SDK, shaped like electron/harness/claude/index.cjs.
// Settings go in as SDK options (the in-memory flag layer); nothing writes ~/.claude settings.
import fs from 'node:fs';
import { readJsonLineLog } from '../../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { REPO, newestInstall, sleep } from './common.mjs';

export const sdk = await import('@anthropic-ai/claude-agent-sdk');
export const sdkVersion = JSON.parse(
  fs.readFileSync(path.join(REPO, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'),
).version;

// Same scrub as electron/harness/claude/index.cjs: the CLI uses its own login, never inherited API keys.
const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDECODE$)/;
export function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!AUTH_ENV.test(k)) env[k] = v;
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
  return env;
}

export function versionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], { timeout: 8000, env: cleanEnv() }).toString().trim().split(/\s/)[0];
  } catch {
    return null;
  }
}

export function findBinary(override) {
  const h = os.homedir();
  const list = override
    ? [override]
    : [
        process.env.CLAUDE_BIN,
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(h, '.local/bin/claude'),
        path.join(h, '.claude/local/claude'),
        path.join(h, '.npm-global/bin/claude'),
      ];
  const found = list.filter((c) => c && fs.existsSync(c)).map((p) => ({ path: p, version: versionOf(p) }));
  return newestInstall(found, 'claude');
}

class Channel {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(v) {
    if (this.closed) return;
    this.items.push(v);
    this.waiters.shift()?.();
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) yield this.items.shift();
      else if (this.closed) return;
      else await new Promise((r) => this.waiters.push(r));
    }
  }
}

// Query methods that would persist settings outside the session.
const BLOCKED = new Set(['updateSettings']);

/**
 * Opens a streaming session. Every SDK message is recorded to <ID>-<name>.jsonl.
 * opts.persist: keep a transcript (needed to read attachments); the session is deleted on cleanup.
 * opts.effort: null omits the effort option.
 * opts.keepStreamEvents: keep `stream_event` messages (includePartialMessages) in msgs; every kept message carries a hidden `__at` (ms).
 * opts.captureSpawn: start the CLI through spawnClaudeCodeProcess, so the exact argv and the child process are
 * available (`spawned`) for checking flags and for killing the CLI.
 */
export function open(ctx, name, opts = {}) {
  const { persist = false, canUseTool, effort, captureSpawn = false, keepStreamEvents = false, ...rest } = opts;
  const rec = ctx.recorder(name);
  const input = new Channel();
  const msgs = [];
  const listeners = new Set();
  const options = {
    pathToClaudeCodeExecutable: ctx.bin,
    cwd: rest.cwd ?? ctx.cwd(name),
    model: ctx.model,
    ...(effort === null ? {} : { effort: effort ?? ctx.effort }),
    persistSession: persist,
    thinking: { type: 'adaptive', display: 'summarized' },
    settingSources: ['user', 'project', 'local'],
    env: cleanEnv(),
    stderr: (d) => rec.write({ stderr: String(d) }),
    canUseTool: canUseTool ?? (async (_n, input) => ({ behavior: 'allow', updatedInput: input })),
    ...rest,
  };
  /** Every CLI process the session started: { command, args, child, exit }. */
  const spawned = [];
  if (captureSpawn) {
    options.spawnClaudeCodeProcess = (o) => {
      const child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: o.signal,
        windowsHide: true,
      });
      const entry = { command: o.command, args: o.args, child, exit: null };
      spawned.push(entry);
      rec.write({ harness: 'spawn', command: o.command, args: o.args, pid: child.pid });
      child.stderr.on('data', (d) => rec.write({ stderr: String(d) }));
      child.on('exit', (code, signal) => ((entry.exit = { code, signal }), rec.write({ harness: 'exit', code, signal })));
      return child;
    };
  }
  rec.write({
    harness: 'options',
    options: {
      ...options,
      env: '<cleanEnv>',
      stderr: undefined,
      canUseTool: canUseTool ? '<custom>' : '<allow-all>',
      mcpServers: options.mcpServers ? Object.keys(options.mcpServers) : undefined,
    },
  });
  const raw = sdk.query({ prompt: input, options });
  const q = new Proxy(raw, {
    get(t, k) {
      if (BLOCKED.has(k)) throw new Error(`conformance: ${String(k)} is blocked (it writes settings)`);
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let streamError = null;
  const done = (async () => {
    try {
      for await (const m of raw) {
        if (m.type === 'stream_event' && !keepStreamEvents) continue;
        Object.defineProperty(m, '__at', { value: Date.now(), enumerable: false });
        msgs.push(m);
        rec.write({ dir: '<', msg: m });
        for (const l of [...listeners]) l(m);
      }
      rec.write({ harness: 'stream-ended' });
    } catch (e) {
      streamError = String(e?.message || e);
      rec.write({ harness: 'stream-error', error: String(e?.stack || e) });
    }
  })();
  const waitFor = (pred, ms = 120000, label = 'condition', from = 0) =>
    new Promise((resolve, reject) => {
      const hit = msgs.slice(from).find(pred);
      if (hit) return resolve(hit);
      const l = (m) => {
        if (pred(m)) {
          clearTimeout(t);
          listeners.delete(l);
          resolve(m);
        }
      };
      const t = setTimeout(() => {
        listeners.delete(l);
        reject(new Error(`timeout waiting for ${label}`));
      }, ms);
      listeners.add(l);
    });
  /** Resolves with the next result message after the current one. */
  const nextResult = (ms = 180000) => waitFor((m) => m.type === 'result', ms, 'result', msgs.length);
  const send = (content, extra = {}) => {
    const m = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', ...extra };
    rec.write({ dir: '>', msg: m });
    input.push(m);
  };
  /** Sends and waits for that turn's result. */
  const turn = async (content, extra, ms) => {
    const r = nextResult(ms);
    send(content, extra);
    return r;
  };
  const sessionId = () => msgs.find((m) => m.session_id)?.session_id ?? null;
  let closed = false;
  /** keep: leave a persisted transcript in place (the caller deletes it). */
  const close = async ({ keep = false } = {}) => {
    if (closed) return;
    closed = true;
    input.close();
    try {
      raw.close();
    } catch {
      /* the query may already be closed */
    }
    await Promise.race([done, sleep(5000)]);
    const sid = sessionId();
    if (persist && sid && !keep) {
      try {
        await sdk.deleteSession(sid);
        rec.write({ harness: 'deleted-session', sid });
      } catch (e) {
        rec.write({ harness: 'delete-session-failed', error: String(e) });
      }
    }
  };
  ctx.defer(close);
  return {
    q,
    msgs,
    send,
    turn,
    waitFor,
    nextResult,
    close,
    sessionId,
    rec,
    since: (i) => msgs.slice(i),
    spawned,
    ended: () => done,
    streamError: () => streamError,
  };
}

/** Records of this session's transcript jsonl (persisted sessions only). */
export function transcript(sid) {
  if (!sid) return [];
  const root = path.join(os.homedir(), '.claude/projects');
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return readJsonLineLog(f);
  }
  return [];
}
export const attachmentTypes = (sid) =>
  transcript(sid)
    .filter((r) => r.type === 'attachment')
    .map((r) => r.attachment?.type);

export const toolUses = (msgs) =>
  msgs.flatMap((m) => (m.type === 'assistant' ? (m.message?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name) : []));
export const assistantText = (msgs) =>
  msgs
    .flatMap((m) => (m.type === 'assistant' ? (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text) : []))
    .join('\n');
export const systemOf = (msgs, re) => msgs.filter((m) => m.type === 'system' && re.test(m.subtype ?? ''));
export { sleep };
export const brief = (r) =>
  r
    ? {
        subtype: r.subtype,
        result: String(r.result ?? '').slice(0, 300),
        num_turns: r.num_turns,
        cost: r.total_cost_usd,
        is_error: r.is_error,
      }
    : null;
