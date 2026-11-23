// electron/app/ipc/harnessUpdates.cjs: the installed harnesses from what detection found, the chats mid-turn per
// harness, the run after an update, an npm install's version, the registries through main, and the handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerUpdates, installedOf, busyChatsOf, health, packageVersion } = require('../electron/app/ipc/harnessUpdates.cjs');
const { HarnessRuns } = require('../electron/harness/harnessRuns.cjs');

test('the installed harnesses come from Codex’s binaries, Claude Code’s CLI and ACP admission; a failing one is left out', async () => {
  const deps = (o: any = {}) => ({
    codexBinaries: async () =>
      o.codex ?? {
        candidates: [
          { path: '/c1', version: '0.1' },
          { path: '/c2', version: '0.2' },
        ],
        current: '/c2',
      },
    claude: {
      findBinary: async (pref?: string) => (o.claudeFails ? Promise.reject(new Error('x')) : (pref ?? '/cl')),
      versionOf: async (bin: string) => (bin === '/mine' ? '2.2.0' : '2.1.302'),
    },
    live: {
      acpAdmission: {
        list: () => [
          { id: 'kimi', state: 'admitted', bin: '/k', version: '1.0' },
          { id: 'qwen', state: 'missing', bin: null },
          { id: 'goose', state: 'unsupported', bin: '/g' },
          { id: 'dsh', state: 'signin', bin: null },
        ],
      },
    },
    readState: () => ({ prefs: o.prefs }),
  });
  assert.deepEqual(await installedOf(deps())(), [
    { kind: 'codex', bin: '/c2', version: '0.2' },
    { kind: 'claude', bin: '/cl', version: '2.1.302' },
    { kind: 'acp:kimi', bin: '/k', version: '1.0' },
    { kind: 'acp:goose', bin: '/g', version: null },
  ]);
  // Claude Code's CLI chosen by hand is the one chats run
  assert.deepEqual((await installedOf(deps({ prefs: { claudeBin: '/mine' } }))())[1], { kind: 'claude', bin: '/mine', version: '2.2.0' });
  const failing = { ...deps({ claudeFails: true }), codexBinaries: async () => Promise.reject(new Error('gone')), live: {} };
  assert.deepEqual(await installedOf(failing)(), []);
  // no Codex copy named current: none
  assert.deepEqual(await installedOf({ ...deps({ codex: { candidates: [], current: 'codex' } }), live: {} })(), [
    { kind: 'claude', bin: '/cl', version: '2.1.302' },
  ]);
});

test('the chats mid-turn on a harness: by their current harness, basic ones by id, with their titles', () => {
  const sessions: Record<string, any> = {
    a: { turn: 'running' },
    b: { turn: 'awaitingUser' },
    c: { turn: 'idle' },
    d: { turn: 'running' },
    e: { turn: 'running' },
    f: { turn: 'running' },
  };
  const kinds: Record<string, string> = { a: 'codex', b: 'acp:kimi', c: 'codex', d: 'acp:qwen', f: 'acp:kimi' };
  const live = {
    sessions: { all: () => Object.keys(sessions), get: (id: string) => sessions[id] },
    controller: {
      ref: (id: string) => {
        if (!kinds[id]) throw new Error('no segment');
        return { kind: kinds[id] };
      },
    },
    chats: {
      records: new Map([
        ['a', { meta: { title: 'Fix login' } }],
        ['b', { meta: {} }],
      ]),
    },
  };
  const busy = busyChatsOf(live);
  assert.deepEqual(busy('codex'), [{ id: 'a', title: 'Fix login' }]);
  assert.deepEqual(busy('acp:kimi'), [
    { id: 'b', title: 'Untitled chat' },
    { id: 'f', title: 'Untitled chat' },
  ]);
  assert.deepEqual(busy('claude'), []);
  assert.deepEqual(busyChatsOf({})('codex'), [], 'no sessions yet');
});

test('the run after an update: its version, or why it is broken; a timeout, a spawn failure or 127 says nothing', async () => {
  const run = (out: string, error: any) =>
    health(
      '/b',
      { PATH: '/x' },
      {
        childEnv: () => ({ PATH: '/usr/bin', HOME: '/h' }),
        execFile: (file: string, args: string[], options: any, cb: any) => {
          assert.deepEqual(args.slice(-1), ['--version']);
          assert.equal(options.env.PATH, '/x');
          assert.equal(options.env.NO_COLOR, '1');
          setImmediate(() => cb(error, out, ''));
          return { stdin: { end() {} } };
        },
      },
    );
  assert.deepEqual(await run('kimi 2.2.0\n', null), { version: '2.2.0', broken: null });
  assert.deepEqual(await run('Error: Cannot find module\nclaude native binary not installed\n', { code: 1 }), {
    version: null,
    broken: 'Error: Cannot find module · claude native binary not installed',
  });
  assert.deepEqual(await run('', { code: 2 }), { version: null, broken: 'exit status 2' });
  assert.deepEqual(await run('', { code: 127 }), { version: null, broken: null });
  assert.deepEqual(await run('', { code: 'ENOENT' }), { version: null, broken: null });
  assert.deepEqual(await run('', { code: 1, killed: true }), { version: null, broken: null });
  // a non-zero exit that still says a version is not broken
  assert.deepEqual(await run('2.2.0', { code: 1 }), { version: '2.2.0', broken: null });
  // and no extra environment
  const plain = await health('/b', null, {
    childEnv: () => ({ PATH: '/usr/bin' }),
    execFile: (_f: string, _a: string[], o: any, cb: any) => (assert.equal(o.env.PATH, '/usr/bin'), cb(null, '1.0.0', ''), {}),
  });
  assert.equal(plain.version, '1.0.0');
});

test("an npm install's version from its package.json; anything unreadable is no version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-version-'));
  try {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, '{"version":"2.2.0"}');
    assert.equal(packageVersion(file), '2.2.0');
    assert.equal(
      packageVersion(file, () => '{"version":3}'),
      null,
    );
    assert.equal(
      packageVersion(file, () => 'not json'),
      null,
    );
    assert.equal(packageVersion(path.join(dir, 'missing.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function wire(o: any = {}) {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: () => undefined };
  const sent: any[] = [];
  const execs: any[] = [];
  const restarts: string[] = [];
  const runs = new HarnessRuns({
    pty: { spawn() {}, write() {}, resize() {}, kill() {} },
    spawnQuiet: () => ({ kill() {} }),
    home: () => '/h',
    broadcast: () => undefined,
    afterExit: async () => undefined,
  });
  const deps = {
    live: { acpAdmission: { list: () => [{ id: 'kimi', state: 'admitted', bin: '/k', version: '1.0.0' }] }, sessions: { all: () => [] } },
    shellEnv: { which: () => null, childEnv: () => ({ PATH: '/usr/bin' }) },
    broadcastAll: (ch: string, p: any) => sent.push([ch, p]),
    net: { fetch: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }) },
    server: { stop: () => restarts.push('stop'), start: () => restarts.push('start') },
    codexBinaries: async () => ({ candidates: [], current: 'codex' }),
    claude: { findBinary: async () => null, version: () => null },
    readState: () => ({}),
  };
  const updates = registerUpdates(ipcMain, deps, runs, {
    fetch: o.fetch,
    execFile: o.realExec
      ? undefined
      : (file: string, args: string[], options: any, cb: any) => (
          execs.push([file, args, options]), cb(o.brewError ?? null, o.brewOut ?? '{"formulae":[{"versions":{"stable":"0.25.2"}}]}')
        ),
  });
  const invoke = (ch: string, ...a: any[]) => handlers.get(ch)!({}, ...a);
  return { updates, invoke, sent, execs, restarts, handlers, deps };
}

test('the handlers drive one service; the registry is read through main, Homebrew without updating itself', async () => {
  const fetched: any[] = [];
  const w = wire({
    fetch: async (url: string, o: any) => (fetched.push([url, o.headers]), { ok: true, json: async () => ({ version: '2.2.0' }) }),
  });
  assert.deepEqual([...w.handlers.keys()].sort(), [
    'harnessUpdates:cancelAll',
    'harnessUpdates:cancelWait',
    'harnessUpdates:check',
    'harnessUpdates:state',
    'harnessUpdates:update',
    'harnessUpdates:updateAll',
  ]);
  const st = await w.invoke('harnessUpdates:check', 1);
  // Kimi at /k: MoPilot can't tell how it was installed, so nothing to read the newest from
  assert.deepEqual(
    st.harnesses.map((h: any) => [h.harness, h.via, h.blockedReason]),
    [['acp:kimi', 'unknown', 'unknown-install']],
  );
  assert.deepEqual(await w.invoke('harnessUpdates:state'), w.updates.state());
  assert.deepEqual(await w.invoke('harnessUpdates:update', 'acp:kimi', 'later'), { ok: false, error: 'not-updatable' });
  assert.equal(await w.invoke('harnessUpdates:cancelWait', 'acp:kimi'), false);
  assert.deepEqual(await w.invoke('harnessUpdates:updateAll'), { ok: false, error: 'nothing' });
  assert.equal(await w.invoke('harnessUpdates:cancelAll'), false);
  // the latest readers main builds
  assert.equal(await w.updates.o.latest.npm('@moonshot-ai/kimi-code'), '2.2.0');
  assert.equal(fetched[0][0], 'https://registry.npmjs.org/@moonshot-ai/kimi-code/latest');
  assert.equal(fetched[0][1]['user-agent'], 'MoPilot');
  assert.equal(await w.updates.o.latest.brew('/opt/homebrew/bin/brew', 'qwen-code', false), '0.25.2');
  assert.deepEqual(w.execs[0].slice(0, 2), ['/opt/homebrew/bin/brew', ['info', '--json=v2', 'qwen-code']]);
  assert.equal(w.execs[0][2].env.HOMEBREW_NO_AUTO_UPDATE, '1');
  await w.updates.o.latest.brew('/b', 'claude-code', true);
  assert.deepEqual(w.execs[1][1], ['info', '--json=v2', '--cask', 'claude-code']);
  // when and which: the update handler passes only 'now' or 'idle'
  w.updates.update = async (kind: string, o: any) => ({ kind, o });
  assert.deepEqual(await w.invoke('harnessUpdates:update', 'codex', 'now'), { kind: 'codex', o: { when: 'now' } });
  assert.deepEqual(await w.invoke('harnessUpdates:update', 'codex', 'idle'), { kind: 'codex', o: { when: 'idle' } });
  // main's own readers: the real method, readVersion and health wiring
  assert.equal((w.updates.o.method('acp:kimi', '/nowhere/kimi') as any).blocked, 'unknown-install');
  // an npm install whose prefix has no npm asks PATH for one (none here)
  assert.equal(
    (w.updates.o.method('acp:kimi', '/nowhere/lib/node_modules/@moonshot-ai/kimi-code/bin/kimi') as any).blocked,
    'unknown-install',
  );
  assert.equal(await w.updates.o.readVersion({ packageJson: null, pathVersion: null }), null);
  assert.equal(await w.updates.o.readVersion({ packageJson: null, pathVersion: '2.1.302' }), '2.1.302');
  assert.equal(await w.updates.o.readVersion({ packageJson: '/nowhere/package.json' }), null);
});

test('a registry that answers badly, or Homebrew that fails or prints no JSON, is no newest version', async () => {
  assert.equal(await wire({ fetch: async () => ({ ok: false, status: 503 }) }).updates.o.latest.npm('x'), null);
  assert.equal(await wire({ brewError: new Error('no brew') }).updates.o.latest.brew('/b', 'x', false), null);
  assert.equal(await wire({ brewOut: 'not json' }).updates.o.latest.brew('/b', 'y', false), null);
  // by default through Electron's net
  assert.equal(await wire().updates.o.latest.npm('z'), '9.9.9');
});

test("after an update, Codex's app-server moves to the new binary; Claude Code and basic harnesses need no restart", () => {
  const w = wire();
  w.updates.o.restart('codex');
  w.updates.o.restart('claude');
  w.updates.o.restart('acp:kimi');
  w.updates.o.restart('nonsense');
  assert.deepEqual(w.restarts, ['stop', 'start']);
});

test('the health check main wires runs the real child process API', async () => {
  const w = wire({ realExec: true });
  const r = await w.updates.o.health(process.execPath, null);
  assert.equal(r.broken, null);
  assert.ok(r.version, 'node --version says its version');
});
