// The optional built-in GitHub connector (electron/platform/builtinConnectors.cjs): a pinned release downloaded only when
// turned on and checked against its pinned SHA-256, installed through the plugin store for every harness, signed in
// with the user's gh login at server start; and its IPC (electron/app/ipc/plugins.cjs).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const bc = require('../electron/platform/builtinConnectors.cjs');
const ipc = require('../electron/app/ipc/plugins.cjs');
const { createPluginService } = require('../electron/plugins/service.cjs');
const { PluginStore } = require('../electron/plugins/store.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A real store over a scratch folder, and a connector set whose download is a fake archive pinned to its hash. */
function setup(over: Record<string, unknown> = {}) {
  const home = tmp();
  const store = new PluginStore({ dir: () => path.join(home, 'plugins') });
  const calls: string[] = [];
  const archive = Buffer.from('fake archive');
  const key = `${process.platform}-${process.arch}`;
  const pinned = { ...bc.GITHUB_ASSETS };
  pinned[key] = { ...pinned[key], sha256: sha(archive) };
  const options = {
    store,
    dir: () => path.join(home, 'connectors'),
    platform: process.platform,
    arch: process.arch,
    download: async (url: string) => (calls.push(`download ${url}`), archive),
    extract: async (_archive: string, into: string) => (
      calls.push('extract'), fs.writeFileSync(path.join(into, 'github-mcp-server'), '#!/bin/sh\n'), true
    ),
    login: async () => ({ gh: '/opt/homebrew/bin/gh', signedIn: true }),
    ...over,
  };
  return { home, store, calls, archive, key, pinned, options };
}

// the asset table is the source of the pins: swap one entry for the fake archive's hash, as a build would never do
function withPin(s: ReturnType<typeof setup>) {
  const saved = bc.GITHUB_ASSETS[s.key];
  bc.GITHUB_ASSETS[s.key] = s.pinned[s.key];
  return () => {
    bc.GITHUB_ASSETS[s.key] = saved;
  };
}

test('the pinned release names every platform it covers with a SHA-256, from GitHub releases', () => {
  assert.equal(bc.VERSION, '2.0.3');
  assert.deepEqual(Object.keys(bc.GITHUB_ASSETS).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  for (const a of Object.values(bc.GITHUB_ASSETS) as { file: string; sha256: string }[]) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.match(a.file, /^github-mcp-server_(Darwin|Linux)_(arm64|x86_64)\.tar\.gz$/);
  }
  assert.match(bc.BASE_URL, /^https:\/\/github\.com\/github\/github-mcp-server\/releases\/download\/v2\.0\.3$/);
});

test('the wrapper reads the token from the environment or gh at start and stores none', () => {
  const text = bc.wrapperScript("/x/it's/github-mcp-server", '/opt/homebrew/bin/gh');
  assert.match(text, /\[ -z "\$GITHUB_PERSONAL_ACCESS_TOKEN" \]/);
  assert.match(text, /GH='\/opt\/homebrew\/bin\/gh'/);
  assert.match(text, /\[ -x "\$GH" \] \|\| GH=gh/);
  assert.match(text, /exec '\/x\/it'\\''s\/github-mcp-server' stdio/);
  assert.doesNotMatch(text, /ghp_|gho_|github_pat_/);
  assert.match(text, /no GitHub login found/);
  const files = bc.pluginFiles('/b', '/gh');
  assert.deepEqual(Object.keys(files).sort(), ['.claude-plugin/plugin.json', '.mcp.json', 'run.sh']);
  assert.deepEqual(JSON.parse(files['.mcp.json']), { mcpServers: { github: { command: '${CLAUDE_PLUGIN_ROOT}/run.sh', args: [] } } });
});

test('the wrapper runs the server with the gh token, and keeps one already in the environment', () => {
  const dir = tmp();
  const bin = path.join(dir, 'server');
  fs.writeFileSync(bin, '#!/bin/sh\necho "$@ token=$GITHUB_PERSONAL_ACCESS_TOKEN"\n', { mode: 0o755 });
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, '#!/bin/sh\necho "[$1 $2]"\n', { mode: 0o755 });
  const run = path.join(dir, 'run.sh');
  fs.writeFileSync(run, bc.wrapperScript(bin, gh), { mode: 0o755 });
  const env = { PATH: '/usr/bin:/bin' };
  assert.equal(execFileSync(run, { env }).toString().trim(), 'stdio token=[auth token]');
  assert.equal(
    execFileSync(run, { env: { ...env, GITHUB_PERSONAL_ACCESS_TOKEN: 'mine' } })
      .toString()
      .trim(),
    'stdio token=mine',
  );
  // no token anywhere: it says so and never starts the server
  fs.writeFileSync(gh, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => execFileSync(run, { env, stdio: 'pipe' }), /no GitHub login found/);
});

test('turning it on downloads the pinned release once, installs the plugin for every harness, and turning it off removes it', async () => {
  const s = setup();
  const restore = withPin(s);
  try {
    const c = bc.createBuiltinConnectors(s.options);
    assert.deepEqual(
      (await c.list()).map((x: { id: string; state: string }) => [x.id, x.state]),
      [['github', 'off']],
    );
    const on = await c.set('github', true);
    assert.equal(on[0].state, 'on');
    assert.equal(s.calls[0], `download ${bc.BASE_URL}/${bc.GITHUB_ASSETS[s.key].file}`);
    const { plugins } = await s.store.list();
    assert.deepEqual(
      plugins.map((p: { id: string }) => p.id),
      ['github@mopilot-builtin'],
    );
    assert.equal(plugins[0].origin, 'builtin');
    assert.deepEqual(Object.keys(plugins[0].spec.mcpServers), ['github']);
    for (const family of ['claude', 'codex', 'acp']) {
      assert.equal((await s.store.enabledFor(family)).deliver.length, 1, family);
    }
    // the wrapper in the installed copy runs the downloaded binary
    const installed = fs.readFileSync(path.join(plugins[0].path, 'run.sh'), 'utf8');
    assert.match(installed, /connectors\/github\/2\.0\.3\/github-mcp-server/);
    assert.equal((fs.statSync(path.join(plugins[0].path, 'run.sh')).mode & 0o111) !== 0, true);
    // on again: no second download
    await c.set('github', true);
    assert.equal(s.calls.filter((x) => x.startsWith('download')).length, 1);
    // a binary that is no longer what was unpacked is fetched again
    fs.writeFileSync(path.join(s.home, 'connectors', 'github', bc.VERSION, 'github-mcp-server'), 'truncated');
    await c.set('github', true);
    assert.equal(s.calls.filter((x) => x.startsWith('download')).length, 2);
    const off = await c.set('github', false);
    assert.equal(off[0].state, 'off');
    assert.deepEqual((await s.store.list()).plugins, []);
  } finally {
    restore();
  }
});

test('a download that does not match its pinned checksum is not installed', async () => {
  const s = setup({ download: async () => Buffer.from('tampered') });
  const c = bc.createBuiltinConnectors(s.options);
  await assert.rejects(c.set('github', true), /checksum/);
  assert.deepEqual((await s.store.list()).plugins, []);
  assert.equal(fs.existsSync(path.join(s.home, 'connectors', 'github', bc.VERSION)), false);
});

test('without a gh login it asks to sign in first and downloads nothing', async () => {
  const s = setup({ login: async () => ({ gh: 'gh', signedIn: false }) });
  const c = bc.createBuiltinConnectors(s.options);
  await assert.rejects(c.set('github', true), /gh auth login/);
  assert.deepEqual(s.calls, []);
});

test('an archive that will not unpack, or a failed download, leaves nothing installed', async () => {
  const s = setup();
  const restore = withPin(s);
  try {
    const bad = bc.createBuiltinConnectors({ ...s.options, extract: async () => false });
    await assert.rejects(bad.set('github', true), /unpack/);
    const empty = bc.createBuiltinConnectors({ ...s.options, extract: async () => true });
    await assert.rejects(empty.set('github', true), /unpack/);
    const down = bc.createBuiltinConnectors({ ...s.options, download: async () => Promise.reject(new Error('offline')) });
    await assert.rejects(down.set('github', true), /offline/);
    assert.deepEqual((await s.store.list()).plugins, []);
    assert.deepEqual(
      fs.readdirSync(path.join(s.home, 'connectors')).filter((n) => n.startsWith('.download-')),
      [],
    );
  } finally {
    restore();
  }
});

test('where the release has no build it is unavailable, and an unknown connector is refused', async () => {
  const s = setup({ platform: 'win32', arch: 'x64' });
  const c = bc.createBuiltinConnectors(s.options);
  const [g] = await c.list();
  assert.equal(g.state, 'unavailable');
  assert.ok(g.why);
  await assert.rejects(c.set('github', true), /isn’t available/);
  await assert.rejects(c.set('nope', true), /No built-in connector/);
});

test('a plugin the store refuses to preview stops the install with its reason', async () => {
  const s = setup();
  const restore = withPin(s);
  try {
    const store = { ...s.store, list: () => s.store.list(), preview: async () => ({ ok: false, error: 'bad plugin' }) };
    const c = bc.createBuiltinConnectors({ ...s.options, store });
    await assert.rejects(c.set('github', true), /bad plugin/);
  } finally {
    restore();
  }
});

test('turning it on and off in quick succession runs in order', async () => {
  const s = setup();
  const restore = withPin(s);
  try {
    const c = bc.createBuiltinConnectors(s.options);
    const results = await Promise.all([c.set('github', true), c.set('github', false), c.set('github', true)]);
    assert.deepEqual(
      results.map((r: { state: string }[]) => r[0].state),
      ['on', 'off', 'on'],
    );
    assert.equal((await s.store.list()).plugins.length, 1);
  } finally {
    restore();
  }
});

test('the default download follows GitHub, refuses an error status and a huge file', async () => {
  const s = setup();
  const { download: _d, ...rest } = s.options;
  const restore = withPin(s);
  const ok = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    arrayBuffer: async () => s.archive.buffer.slice(s.archive.byteOffset, s.archive.byteOffset + s.archive.length),
  }));
  try {
    const c = bc.createBuiltinConnectors(rest);
    assert.equal((await c.set('github', true))[0].state, 'on');
    ok.mock.restore();
    mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
    const c2 = bc.createBuiltinConnectors({ ...rest, dir: () => path.join(s.home, 'other') });
    await assert.rejects(c2.set('github', true), /404/);
    (globalThis.fetch as unknown as { mock: { restore(): void } }).mock.restore();
    mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(65 * 1024 * 1024) }));
    await assert.rejects(c2.set('github', true), /larger than expected/);
  } finally {
    mock.restoreAll();
    restore();
  }
});

test('the default unpacker and login helper run the system tools', async () => {
  const s = setup();
  const restore = withPin(s);
  const cp = require('node:child_process');
  const seen: string[] = [];
  const m = mock.method(cp, 'execFile', (file: string, args: string[], _o: object, cb: (e: Error | null, out: string) => void) => {
    seen.push(`${file} ${args.join(' ')}`);
    if (file === '/usr/bin/tar') {
      fs.writeFileSync(path.join(args[3], 'github-mcp-server'), '#!/bin/sh\n');
      return cb(null, '');
    }
    if (file === '/usr/bin/which') return cb(null, '/usr/local/bin/gh\n');
    return cb(null, 'tok\n');
  });
  const { extract: _e, login: _l, ...rest } = s.options;
  const saved = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  try {
    const c = bc.createBuiltinConnectors(rest);
    assert.equal((await c.set('github', true))[0].state, 'on');
    assert.ok(seen.some((x) => x.startsWith('/usr/bin/tar -xzf ') && x.endsWith(' github-mcp-server')));
    assert.ok(seen.includes('/usr/local/bin/gh auth token'));
    // a token already in the environment is enough and gh is not asked
    seen.length = 0;
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'from-env';
    await c.set('github', true);
    assert.equal(
      seen.some((x) => x.endsWith('auth token')),
      false,
    );
    // no gh at all, and no token: not signed in
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = '';
    m.mock.restore();
    mock.method(cp, 'execFile', (_f: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) =>
      cb(new Error('not found'), ''),
    );
    await assert.rejects(c.set('github', true), /gh auth login/);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = saved;
    mock.restoreAll();
    restore();
  }
});

test('the plugins IPC lists the connectors and switches one', async () => {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const calls: unknown[][] = [];
  const connectors = { list: async () => [{ id: 'github' }], set: async (...a: unknown[]) => (calls.push(a), [{ id: 'github' }]) };
  const service = { subscribe: () => () => {}, store: {}, marketplaces: {}, builtinConnectors: () => connectors };
  ipc.register(
    {},
    { handle: (c: string, fn: (...a: unknown[]) => unknown) => (handlers[c] = fn), broadcastAll: () => {} },
    { service, delivery: {}, native: () => [], codexStates: () => ({}) },
  );
  assert.deepEqual(await handlers['plugins:builtinList'](), [{ id: 'github' }]);
  await handlers['plugins:builtinSet']('github', true);
  await handlers['plugins:builtinSet']('github', 'yes');
  assert.deepEqual(calls, [
    ['github', true],
    ['github', false],
  ]);
});

test('the plugin service makes the connectors once, over its own store', () => {
  const service = createPluginService({ dir: () => tmp(), home: tmp() });
  assert.equal(service.builtinConnectors(), service.builtinConnectors());
});

test('with no folder given the connectors live under ~/.mopilot/connectors', async () => {
  const s = setup();
  const { dir: _d, ...rest } = s.options;
  const restore = withPin(s);
  const home = process.env.HOME;
  process.env.HOME = s.home;
  try {
    const c = bc.createBuiltinConnectors(rest);
    assert.equal((await c.set('github', true))[0].state, 'on');
    assert.ok(fs.existsSync(path.join(s.home, '.mopilot', 'connectors', 'github', bc.VERSION, 'github-mcp-server')));
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    restore();
  }
});
