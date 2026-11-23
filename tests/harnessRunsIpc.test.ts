// electron/app/ipc/harnessRuns.cjs: the harnessRuns:* handlers over one HarnessRuns, the tools check on the login-shell
// PATH, and what main looks at again per family once a run ends (with no window needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register, afterExit, found, binSig } = require('../electron/app/ipc/harnessRuns.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core } = require('../electron/platform/core.cjs');
const { installLines, packageExecutionBlock } = await import('../shared/harnessInstall.mjs');

function setup() {
  const handlers = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const calls: any[] = [];
  const ptys: any[] = [];
  const ipcMain = {
    handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    on: (ch: string, fn: Function) => listeners.set(ch, fn),
  };
  const deps = {
    live: { acpAdmission: { refresh: async (o: any) => calls.push(['refresh', o]) } },
    server: { stop: () => calls.push(['stop']), start: () => calls.push(['start']) },
    shellEnv: {
      which: (n: string) => (n === 'npm' ? '/n/bin/npm' : null),
      childEnv: () => ({ npm_config_prefix: '/definitely/not/a/prefix' }),
    },
    broadcastAll: (ch: string, p: any) => calls.push(['broadcast', ch, p]),
  };
  const pty = {
    spawn: (id: string, opts: any, h: any) => ptys.push({ id, opts, h }),
    write: (id: string, d: string) => calls.push(['write', id, d]),
    resize: (id: string, c: number, r: number) => calls.push(['resize', id, c, r]),
    kill: (id: string) => calls.push(['kill', id]),
  };
  const runs = register(ipcMain, deps, { pty });
  const invoke = (ch: string, ...a: any[]) => handlers.get(ch)!({}, ...a);
  const send = (ch: string, ...a: any[]) => listeners.get(ch)!({}, ...a);
  return { runs, invoke, send, calls, ptys };
}

test('the handlers drive one set of runs that every window shares', async () => {
  const { invoke, send, calls, ptys } = setup();
  const kimi = installLines('acp:kimi', process.platform, null)[0];
  const r = await invoke('harnessRuns:start', 'acp:kimi', kimi.index, { cols: 80, rows: 10 });
  assert.equal(r.ok, true);
  assert.equal(ptys[0].opts.cols, 80);
  // no size from the window: the pty's own default
  const other = await invoke('harnessRuns:start', 'claude', installLines('claude', process.platform, null)[0].index);
  assert.equal(other.ok, true);
  assert.equal(ptys[1].opts.cols, undefined);
  assert.equal((await invoke('harnessRuns:list')).length, 2);
  ptys[0].h.onData('hi');
  assert.equal((await invoke('harnessRuns:attach', r.run.id)).output, 'hi');
  send('harnessRuns:write', r.run.id, 'y');
  send('harnessRuns:resize', r.run.id, 100, 20);
  const stopping = invoke('harnessRuns:stop', r.run.id);
  assert.equal((await invoke('harnessRuns:list'))[0].state, 'running');
  ptys[0].h.onExit({ exitCode: 143 });
  assert.equal(await stopping, true);
  assert.equal(await invoke('harnessRuns:dismiss', r.run.id), true);
  assert.deepEqual(
    calls.filter((c) => c[0] !== 'broadcast' && c[0] !== 'refresh'),
    [
      ['write', r.run.id, 'y'],
      ['resize', r.run.id, 100, 20],
      ['kill', r.run.id],
    ],
  );
  assert.ok(calls.some((c) => c[0] === 'broadcast' && c[1] === 'harnessRuns:state'));
});

test("tools reads npm on the login-shell PATH and the prefix from the login shell's environment", async () => {
  const { invoke } = setup();
  const t = await invoke('harnessRuns:tools');
  assert.equal(t.npm, true);
  assert.equal(t.brew, false);
  assert.equal(typeof t.npmWritable, 'boolean');
});

test('once a run ends main looks again per family: a basic harness by its check, Codex by restarting, Claude Code in windows', async () => {
  const calls: any[] = [];
  const deps = {
    live: { acpAdmission: { refresh: async (o: any) => calls.push(['refresh', o]) } },
    server: { stop: () => calls.push(['stop']), start: () => calls.push(['start']) },
  };
  const after = afterExit(deps);
  await after('acp:gemini');
  await after('codex');
  await after('claude');
  await after('nonsense');
  assert.deepEqual(calls, [['refresh', { force: true, only: 'gemini' }], ['stop'], ['start']]);
  // a Codex app-server already running (found on focus, or installed before) may be mid-turn: left alone
  calls.length = 0;
  await afterExit({ ...deps, server: { ...deps.server, status: 'running' } })('codex');
  assert.deepEqual(calls, []);
});

test('registered as main does it, foreground package commands share the owned ChildProcess runner', () => {
  const handlers: string[] = [];
  const ipcMain = { handle: (ch: string) => handlers.push(ch), on: (ch: string) => handlers.push(ch) };
  const runs = register(ipcMain, { live: {}, server: {}, shellEnv: {}, broadcastAll: () => undefined });
  assert.notEqual(runs.o.pty, require('../electron/platform/pty.cjs'));
  assert.equal(typeof runs.o.pty.spawn, 'function');
  assert.deepEqual(handlers.sort(), [
    'harnessRuns:attach',
    'harnessRuns:dismiss',
    'harnessRuns:find',
    'harnessRuns:list',
    'harnessRuns:resize',
    'harnessRuns:start',
    'harnessRuns:stop',
    'harnessRuns:tools',
    'harnessRuns:write',
    'harnessUpdates:cancelAll',
    'harnessUpdates:cancelWait',
    'harnessUpdates:check',
    'harnessUpdates:state',
    'harnessUpdates:update',
    'harnessUpdates:updateAll',
  ]);
  assert.ok(runs.updates, 'updates go through these runs');
});

test("a quiet update runs in the login shell's environment with its own on top; the updates registrar can be swapped", () => {
  const got: any[] = [];
  const ipcMain = { handle: () => undefined, on: () => undefined };
  let registered: any = null;
  const runs = register(
    ipcMain,
    { live: {}, server: {}, shellEnv: { childEnv: () => ({ PATH: '/usr/bin', HOME: '/h' }) }, broadcastAll: () => undefined },
    {
      pty: {},
      spawnQuiet: (argv: string[], q: any) => (got.push([argv, q]), { kill() {} }),
      registerUpdates: (_i: any, _d: any, r: any) => ((registered = r), 'updates'),
    },
  );
  assert.equal(registered, runs);
  assert.equal(runs.updates, 'updates');
  runs.o.spawnQuiet(['/n'], { cwd: '/h', env: { PATH: '/p:/usr/bin' }, timeoutMs: 1 }, {});
  assert.deepEqual(got, [[['/n'], { cwd: '/h', env: { PATH: '/p:/usr/bin', HOME: '/h' }, timeoutMs: 1 }]]);
});

test('a quiet update starts only with a trustworthy platform monitor (quietRun.cjs)', async () => {
  const { runs } = setup();
  if (packageExecutionBlock(process.platform) || !core()?.routes().includes('proc.identities')) {
    assert.throws(
      () => runs.o.spawnQuiet([process.execPath, '-e', ''], { cwd: process.cwd(), env: {} }, {}),
      /cannot verify package installer shutdown.*Rebuild or update|unavailable on Windows/,
    );
    return;
  }
  const code = await new Promise((resolve) =>
    runs.o.spawnQuiet(
      [process.execPath, '-e', ''],
      { cwd: process.cwd(), env: { ...process.env } },
      { onData() {}, onExit: (e: any) => resolve(e.exitCode) },
    ),
  );
  assert.equal(code, 0);
});

test('find names the binary that can run now, per family, without starting or checking anything', async () => {
  const seen: string[] = [];
  const sig = (p: string) => (seen.push(p), p.endsWith('/.codex/bin/codex') || p === '/my/kimi' ? `${p}:1:2` : null);
  const shellEnv = { which: () => null };
  // first-class: the login shell's PATH, the user-tool folders and its own install's folder
  assert.match(found('codex', { shellEnv }, sig)!, /\/\.codex\/bin\/codex:1:2$/);
  seen.length = 0;
  assert.equal(found('claude', { shellEnv }, sig), null);
  assert.ok(seen.some((p) => p.endsWith('/.claude/local/claude')));
  assert.ok(
    seen.some((p) => p.endsWith('/.local/bin/claude')),
    'the usual install folders, made or not',
  );
  // a basic harness: its own path from Settings first, else the search
  assert.equal(found('acp:kimi', { shellEnv, readState: () => ({ prefs: { acpBins: { kimi: '/my/kimi' } } }) }, sig), '/my/kimi:1:2');
  assert.equal(
    found('acp:qwen', { shellEnv, readState: () => ({ prefs: {} }) }, () => null),
    null,
  );
  assert.equal(found('nonsense', { shellEnv }, sig), null);
  // as registered: the handler answers for the kind it is given
  const handlers = new Map<string, Function>();
  register(
    { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: () => undefined },
    { live: {}, server: {}, shellEnv, broadcastAll: () => undefined },
    {
      pty: {},
      found: (kind: string, deps: any) => `${kind}:${deps.shellEnv === shellEnv}`,
    },
  );
  assert.equal(await handlers.get('harnessRuns:find')!({}, 'claude'), 'claude:true');
  // registered as main does it, the handler asks the real search
  assert.equal(await setup().invoke('harnessRuns:find', 'nonsense'), null);
});

test('a binary counts once it is a file that can run; a rewrite or chmod reads as a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-'));
  try {
    const bin = path.join(dir, 'codex');
    assert.equal(binSig(bin), null, 'missing');
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o644);
    if (process.platform !== 'win32') assert.equal(binSig(bin), null, 'not executable yet: a download under way');
    fs.chmodSync(bin, 0o755);
    const first = binSig(bin);
    assert.match(first!, new RegExp(`^${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:`));
    fs.writeFileSync(bin, '#!/bin/sh\necho hi\n');
    assert.notEqual(binSig(bin), first);
    assert.equal(binSig(dir), null, 'a folder is no binary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
