// Fakes for electron/harness/claude/index.cjs: Electron's app, the Agent SDK, child_process and a filtered fs (only paths
// under this test's temp folder exist, so a CLI installed on the machine is never found or run). Each
// load() gives a fresh copy of the module with its own userData folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tick as flush } from './async-scenarios.ts';
import { waitFor } from './waitFor.ts';
export { flush };

export const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-cov-')));
export const home = path.join(tmp, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
for (const k of Object.keys(process.env))
  if (/^(CLAUDE_CONFIG_DIR|CLAUDE_BIN|APPDATA|SAGE_CLAUDE_LIVE_OUTPUT|CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete process.env[k];

const fakeDir = path.join(tmp, 'fakes');
fs.mkdirSync(fakeDir);
const F = 'globalThis.__claudeFakes';
fs.writeFileSync(
  path.join(fakeDir, 'electron.cjs'),
  `module.exports = { app: { getPath: () => ${F}.userData }, shell: { openExternal: (u) => ${F}.openExternal(u) }, net: { isOnline: () => ${F}.online },  get safeStorage() { return ${F}.safe; } };`,
);
const sdkNames = [
  'query',
  'listSessions',
  'getSessionMessages',
  'getSubagentMessages',
  'renameSession',
  'getSessionInfo',
  'deleteSession',
  'forkSession',
  'tool',
  'createSdkMcpServer',
];
fs.writeFileSync(path.join(fakeDir, 'sdk.mjs'), sdkNames.map((n) => `export const ${n} = (...a) => ${F}.sdk.${n}(...a);`).join('\n'));
fs.writeFileSync(
  path.join(fakeDir, 'cp.cjs'),
  `module.exports = { execFile: (...a) => ${F}.execFile(...a), spawn: (...a) => ${F}.spawn(...a) };`,
);
// the harness reaches the disk and processes through the ports (electron/platform/ports): child_process runs nothing
// but the fakes, and fs finds only what the test says exists (a CLI installed on this machine is never found)
const portRequire = createRequire(import.meta.url);
const realFs = portRequire('node:fs');
const realCp = portRequire('node:child_process');
const g = globalThis as any;
portRequire('../../electron/platform/ports/fs.cjs').installFs(
  new Proxy(realFs, {
    get: (target, key) =>
      key === 'existsSync'
        ? (p: string) => g.__claudeFakes.exists(p)
        : key === 'watch'
          ? (...a: unknown[]) => (g.__claudeFakes.watch ?? realFs.watch)(...a)
          : Reflect.get(target, key),
  }),
);
// links the harness opens go to the fake shell, as main's guarded shell does behind the openExternal port
portRequire('../../electron/platform/ports/openExternal.cjs').installOpenExternal((u: string) => g.__claudeFakes.openExternal(u));
portRequire('../../electron/platform/ports/proc.cjs').installProc(
  new Proxy(realCp, {
    get: (target, key) =>
      key === 'execFile'
        ? (...a: unknown[]) => g.__claudeFakes.execFile(...a)
        : key === 'spawn'
          ? (...a: unknown[]) => g.__claudeFakes.spawn(...a)
          : Reflect.get(target, key),
  }),
);
// the one module the harness loads that still starts its process itself (L1, below the ports)
const toolVersion = '/electron/platform/toolVersion.cjs';
registerHooks({
  resolve(specifier, context, next) {
    const to = (f: string) => ({ url: pathToFileURL(path.join(fakeDir, f)).href, shortCircuit: true });
    if (specifier === 'electron') return to('electron.cjs');
    if (specifier === '@anthropic-ai/claude-agent-sdk') return to('sdk.mjs');
    if (context.parentURL?.endsWith(toolVersion) && specifier === 'node:child_process') return to('cp.cjs');
    return next(specifier, context);
  },
});

/** A CLI process the SDK started: `reply(input)` answers each streamed prompt; `push`/`end` drive it by hand. */
export interface FakeQuery {
  options: any;
  prompt: any;
  inputs: any[];
  calls: any[][];
  closed: boolean;
  endWith: unknown;
  reply: ((m: any) => any[]) | null;
  push(...m: any[]): void;
  end(err?: unknown): void;
  [k: string]: any;
}

export const fakes: any = {
  userData: '',
  /** Electron's net.isOnline */
  online: true,
  /** Electron's safeStorage: reversible, never the plain text; set encryption = false to take the OS key away */
  encryption: true,
  safe: {
    isEncryptionAvailable: () => fakes.encryption,
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
    decryptString: (b: Buffer) => {
      const t = b.toString();
      if (!t.startsWith('enc:')) throw new Error('bad ciphertext');
      return Buffer.from(t.slice(4), 'hex').toString();
    },
  },
  queries: [] as FakeQuery[],
  onQuery: (_q: FakeQuery) => {},
  versions: {} as Record<string, string>,
  runs: [] as any[],
  /** answers execFile: { stdout, stderr, err } */
  run: (_cmd: string, _args: string[], _opts: any): any => ({ stdout: '' }),
  watch: null,
  exists: (p: any) => String(p).startsWith(tmp) && fs.existsSync(p),
  /** what each binary's --help says (default: an option list with --plugin-dir) */
  helps: {} as Record<string, string | null>,
  /** --version and --help asks, answered from versions and helps (execFile) */
  probes: [] as { cmd: string; args: string[] }[],
  probe(cmd: string, args: string[] = []) {
    if (args.includes('--help')) {
      const help = cmd in fakes.helps ? fakes.helps[cmd] : '  --plugin-dir <path>  Load a plugin from a directory\n';
      if (help == null) throw new Error('not runnable');
      return Buffer.from(help);
    }
    const v = fakes.versions[cmd];
    if (v == null) throw new Error('not runnable');
    return Buffer.from(`${v} (Claude Code)\n`);
  },
  /** shell.openExternal */
  opened: [] as string[],
  openExternal: (u: string) => fakes.opened.push(u),
  /** child_process.spawn: what spawned, and the process it returns */
  spawns: [] as any[][],
  spawn: (...a: any[]): any => {
    throw new Error(`spawn ${a[0]} is not faked`);
  },
  execFile(cmd: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) {
    if (args.length === 1 && (args[0] === '--version' || args[0] === '--help')) {
      fakes.probes.push({ cmd, args });
      let out = '';
      let err = null;
      try {
        out = String(fakes.probe(cmd, args));
      } catch (e) {
        err = e;
      }
      return void setImmediate(() => cb(err, out, ''));
    }
    fakes.runs.push({ cmd, args, opts });
    const r = fakes.run(cmd, args, opts) ?? {};
    setImmediate(() => cb(r.err ?? null, r.stdout ?? '', r.stderr ?? ''));
  },
  sdk: {
    query: ({ prompt, options }: any) => makeQuery(prompt, options),
    listSessions: async () => [],
    getSessionMessages: async () => [],
    getSubagentMessages: async () => [],
    renameSession: async (...a: any[]) => ['renamed', ...a],
    getSessionInfo: async (id: string) => ({ id }),
    deleteSession: async (id: string) => ['deleted', id],
    forkSession: async (...a: any[]) => ['forked', ...a],
    tool: (name: string, description: string, schema: any, handler: any, extra: any) => ({ name, description, schema, handler, extra }),
    createSdkMcpServer: (o: any) => ({ server: o.name, tools: o.tools }),
  },
};
(globalThis as any).__claudeFakes = fakes;

function makeQuery(prompt: any, options: any): FakeQuery {
  const out: any[] = [];
  let wake = () => {};
  const rec =
    (name: string, ret?: (...a: any[]) => any) =>
    async (...a: any[]) => {
      q.calls.push([name, ...a]);
      return ret ? ret(...a) : undefined;
    };
  const q: FakeQuery = {
    options,
    prompt,
    inputs: [],
    calls: [],
    closed: false,
    endWith: undefined,
    reply: (m: any) => [
      { type: 'assistant', uuid: `a-${m.uuid}`, message: { content: [{ type: 'text', text: 're' }] } },
      { type: 'result', subtype: 'success' },
    ],
    push(...m: any[]) {
      out.push(...m);
      wake();
    },
    end(err?: unknown) {
      q.endWith = err;
      q.closed = true;
      wake();
    },
    close() {
      q.calls.push(['close']);
      q.closed = true;
      wake();
    },
    interrupt: rec('interrupt', () => 'interrupted'),
    setModel: rec('setModel'),
    setPermissionMode: rec('setPermissionMode'),
    applyFlagSettings: rec('applyFlagSettings'),
    stopTask: rec('stopTask'),
    backgroundTasks: rec('backgroundTasks', () => true),
    getContextUsage: rec('getContextUsage', () => ({ used: 1 })),
    mcpServerStatus: rec('mcpServerStatus', () => [{ name: 'm', status: 'connected', extra: 1 }]),
    toggleMcpServer: rec('toggleMcpServer'),
    reconnectMcpServer: rec('reconnectMcpServer'),
    getSettings: rec('getSettings', () => ({ applied: { ultracode: true, ultracodeAvailable: true, ultracodeRequested: true } })),
    rewindFiles: rec('rewindFiles', () => ({ canRewind: true, filesChanged: ['f'] })),
    supportedCommands: rec('supportedCommands', () => [{ name: 'help' }]),
    initializationResult: rec('initializationResult', () => ({ models: [], commands: [] })),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) {
          if (q.endWith !== undefined) throw q.endWith;
          return;
        } else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  fakes.queries.push(q);
  fakes.onQuery(q);
  if (prompt && typeof prompt !== 'string')
    (async () => {
      for await (const m of prompt) {
        q.inputs.push(m);
        if (q.reply) q.push(...q.reply(m));
      }
    })();
  return q;
}

const req = createRequire(import.meta.url);
const target = req.resolve('../../electron/harness/claude/index.cjs');

/** Runs `fn` while the core's process table lists `rows`: [pid, ppid, command]. */
export async function withCommands<T>(rows: unknown[], fn: () => Promise<T>) {
  const addon = req('../../electron/platform/core.cjs').core();
  const { dispatch } = addon;
  addon.dispatch = (route: string, payload: Buffer) =>
    route === 'proc.commands' ? Promise.resolve(Buffer.from(JSON.stringify(rows))) : dispatch(route, payload);
  try {
    return await fn();
  } finally {
    addon.dispatch = dispatch;
  }
}

/** A fresh Claude Code harness (createClaudeHarness) on a new userData folder, registered unless `register` is false. */
export function load(o: { register?: boolean; hooks?: any } = {}) {
  fakes.userData = fs.mkdtempSync(path.join(tmp, 'ud-'));
  fakes.encryption = true;
  fakes.onQuery = () => {};
  fakes.run = () => ({ stdout: '' });
  const claude = req(target).createClaudeHarness();
  const handlers = new Map<string, (...a: any[]) => any>();
  const events: any[] = [];
  const broadcasts: [string, any][] = [];
  if (o.register !== false)
    claude.register(
      { handle: (n: string, fn: (...a: any[]) => any) => handlers.set(n, fn) },
      (ch: string, evt: any) => {
        broadcasts.push([ch, evt]);
        if (ch === 'claude:event') events.push(evt);
      },
      o.hooks,
    );
  const call = (n: string, ...a: any[]) => handlers.get(n)!({}, ...a);
  return { claude, handlers, events, broadcasts, call, userData: fakes.userData as string };
}

/** An executable file under the temp folder that the fake --version probe reports `version` for (null: --version fails). */
export function fakeBin(rel: string, version: string | null = '2.0.0') {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  if (version != null) fakes.versions[p] = version;
  return p;
}

export async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
}
export const lastQuery = () => fakes.queries[fakes.queries.length - 1] as FakeQuery;

/** The Claude API key as saved (electron/platform/secretFile.cjs), decrypted the way the fake safeStorage encrypts it. */
export function savedKey(dir: string): string {
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'claude-api-key.json'), 'utf8'));
  if (env.enc !== 'safe') throw new Error(`not saved encrypted: ${env.enc}`);
  return fakes.safe.decryptString(Buffer.from(env.data, 'base64'));
}
