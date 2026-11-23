// The per-feature IPC registries: electron/bridge/<namespace>.cjs (what window.native exposes), src/lib/native/<namespace>.ts
// (its types) and electron/app/ipc/<feature>.cjs (main's handlers), loaded by listing their folders, and kept in step with each other.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'src/lib/native/'];

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const bridgeSpec = require('../electron/bridge/spec.cjs');
const { invoke, send, call, on, filePath, loadBridge, channelsOf, buildApi, BRIDGE_DIR, RESERVED } = bridgeSpec;
const { listIpcModules, registerIpcModules, IPC_DIR } = require('../electron/app/ipc/modules.cjs');

// the folder's entries, less its own loader (electron/bridge/spec.cjs, electron/app/ipc/modules.cjs), which lists the rest
const names = (dir: string, ext: string) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !(dir === BRIDGE_DIR && f === 'spec.cjs') && !(dir === IPC_DIR && f === 'modules.cjs'))
    .map((f) => f.slice(0, -ext.length))
    .sort();
const made: string[] = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-registry-'));
  made.push(dir);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
};

function fakeIpc() {
  const listeners = new Map<string, Set<Function>>();
  const calls: any[] = [];
  let result: any;
  const ipcRenderer = {
    on: (ch: string, h: Function) => (listeners.get(ch) ?? listeners.set(ch, new Set()).get(ch)!).add(h),
    removeListener: (ch: string, h: Function) => listeners.get(ch)?.delete(h),
    invoke: (ch: string, ...args: any[]) => (calls.push(['invoke', ch, args]), Promise.resolve(result)),
    sendSync: () => 'document-owner',
    send: (ch: string, ...args: any[]) => calls.push(['send', ch, args]),
  };
  const emit = (ch: string, ...args: any[]) => {
    for (const h of listeners.get(ch) ?? []) h({ sender: 'event' }, ...args);
  };
  return { ipcRenderer, listeners, calls, emit, set: (r: any) => (result = r) };
}

test('bridge methods forward a fixed number of arguments, mapped ones, or all; events drop the IPC event; files give their path', async () => {
  const ipc = fakeIpc();
  const api = buildApi(
    {
      none: invoke('a:none'),
      two: invoke('a:two', 2),
      mapped: invoke('a:mapped', (x: any) => [x === true]),
      fire: send('a:fire', 1),
      fireNone: send('a:fireNone'),
      fireMapped: send('a:fireMapped', (id: any) => [id, true]),
      adapter: call('a:adapter'),
      nested: { deep: { onIt: on('a:it') } },
      path: filePath(),
    },
    { ipcRenderer: ipc.ipcRenderer, webUtils: { getPathForFile: (f: any) => `/picked/${f.name}` } },
  );
  ipc.set('r');
  assert.equal(await api.none('x'), 'r');
  await api.two();
  await api.two(1, 2, 3);
  await api.mapped(1);
  api.fire('a', 'b');
  api.fireNone('a');
  api.fireMapped('g');
  assert.deepEqual(ipc.calls, [
    ['invoke', 'a:none', []],
    ['invoke', 'a:two', [undefined, undefined]],
    ['invoke', 'a:two', [1, 2]],
    ['invoke', 'a:mapped', [false]],
    ['send', 'a:fire', ['a']],
    ['send', 'a:fireNone', []],
    ['send', 'a:fireMapped', ['g', true]],
  ]);
  // an adapter call resolves the value, rethrows the error with its code, and reads nothing as undefined
  ipc.set({ value: 42 });
  assert.equal(await api.adapter(1, 2, 3), 42);
  assert.deepEqual(ipc.calls.at(-1), ['invoke', 'a:adapter', [1, 2, 3]]);
  ipc.set({ error: { message: 'locked out', code: 'locked' } });
  await assert.rejects(api.adapter(), (e: any) => e.message === 'locked out' && e.code === 'locked');
  ipc.set(null);
  assert.equal(await api.adapter(), undefined);
  const got: any[] = [];
  const off = api.nested.deep.onIt((...a: any[]) => got.push(a));
  ipc.emit('a:it', 1, 2);
  off();
  ipc.emit('a:it', 3);
  assert.deepEqual(got, [[1, 2]]);
  assert.equal(ipc.listeners.get('a:it')!.size, 0);
  assert.equal(api.path({ name: 'a.png' }), '/picked/a.png');
  assert.throws(
    () => buildApi({ x: { kind: 'bogus' } }, { ipcRenderer: ipc.ipcRenderer, webUtils: {} }),
    /unknown bridge method kind bogus/,
  );
});

test('bridge declarations load by file name in order; the preload-owned names are refused', () => {
  const dir = scratch({
    'b.cjs': "module.exports = { x: { kind: 'on', channel: 'b:x' } };",
    'a.cjs': "module.exports = { y: { kind: 'invoke', channel: 'a:y', params: 0 } };",
    'notes.txt': 'not a declaration',
  });
  assert.deepEqual(Object.keys(loadBridge(dir)), ['a', 'b']);
  assert.deepEqual(channelsOf(loadBridge(dir)), [
    { path: 'a.y', kind: 'invoke', channel: 'a:y' },
    { path: 'b.x', kind: 'on', channel: 'b:x' },
  ]);
  for (const name of RESERVED) {
    const bad = scratch({ [`${name}.cjs`]: 'module.exports = {};' });
    assert.throws(() => loadBridge(bad), new RegExp(`window.native.${name} is written by the preload`));
  }
});

test('window.native is the preload-owned keys and one namespace per electron/bridge file, which every channel it names comes from', () => {
  const spec = loadBridge();
  assert.equal(BRIDGE_DIR, path.join(ROOT, 'electron', 'bridge'));
  assert.deepEqual(Object.keys(spec), names(BRIDGE_DIR, '.cjs'));
  const list = channelsOf(spec);
  assert.ok(list.length > 300, `${list.length} channels`);
  // one method per kind and channel, so a channel's callers are one declaration
  const seen = new Map<string, string>();
  for (const c of list) {
    const key = `${c.kind} ${c.channel}`;
    assert.ok(!seen.has(key), `${key}: ${seen.get(key)} and ${c.path}`);
    seen.set(key, c.path);
  }
  // the preload exposes nothing else: no raw ipcRenderer calls outside electron/bridge/spec.cjs
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /ipcRenderer\.(invoke|send)\(/);
  assert.match(preload, /\.\.\.buildApi\(loadBridge\(\), electron\)/);
  // it requires its own files, which a sandboxed preload cannot: every window that loads it runs it unsandboxed
  const windows = fs.readFileSync(path.join(ROOT, 'electron', 'app', 'windows.cjs'), 'utf8');
  const preloaded = windows.match(/preload: PRELOAD[^}]*\}/g) ?? [];
  assert.equal(preloaded.length, 2);
  for (const prefs of preloaded) assert.match(prefs, /contextIsolation: true[^}]*sandbox: false/, prefs);
});

test('every declared call, its argument mapping included, reaches the channel and kind it declares', async () => {
  const ipc = fakeIpc();
  const api = buildApi(loadBridge(), { ipcRenderer: ipc.ipcRenderer, webUtils: { getPathForFile: () => '/f' } });
  const at = (p: string) => p.split('.').reduce((o: any, k) => o[k], api);
  for (const c of channelsOf(loadBridge())) {
    ipc.calls.length = 0;
    const r = await at(c.path)(c.kind === 'on' ? () => {} : 'a1', 'a2', null, undefined, 'a5');
    if (c.kind === 'on') {
      assert.equal(ipc.listeners.get(c.channel)?.size, 1, c.path);
      r();
      assert.equal(ipc.listeners.get(c.channel)?.size, 0, c.path);
    } else
      assert.deepEqual(
        ipc.calls.map(([kind, ch]) => [kind, ch]),
        [[c.kind === 'send' ? 'send' : 'invoke', c.channel]],
        c.path,
      );
  }
});

/** Main's sources outside the declarations, where every channel a declaration names must be handled or sent. */
function mainSources() {
  return treeFiles(path.join(ROOT, 'electron'), /\.c?js$/, {
    skip: (p) => p === BRIDGE_DIR || p === path.join(ROOT, 'electron', 'preload.cjs'),
  })
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
}
/** Channels main builds at run time: an exit-gate question's answer comes back on `${channel}:reply` (electron/platform/exitGate.cjs). */
const REPLY = /:reply$/;

test('every channel a bridge declaration names is one main handles or sends, by its literal name', () => {
  const src = mainSources();
  const quoted = (ch: string) => [`'${ch}'`, `"${ch}"`, `\`${ch}\``].some((q) => src.includes(q));
  const missing = channelsOf(loadBridge())
    .filter((c: any) => !quoted(c.channel) && !(REPLY.test(c.channel) && quoted(c.channel.replace(REPLY, ''))))
    .map((c: any) => `${c.path} (${c.kind} ${c.channel})`);
  assert.deepEqual(missing, []);
});

/**
 * The calls a src/lib/native/<namespace>.ts declares, by name: the members of its `<namespace>: {` block, as the
 * formatter lays them out (one per line at the block's indentation; a one-line block lists one).
 */
function typeMembers(file: string, namespace: string) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const one = lines.map((l) => new RegExp(`^ {4}${namespace}: \\{ (\\w+)\\??\\(.*\\};$`).exec(l)).find(Boolean);
  if (one) return [one[1]];
  const start = lines.indexOf(`    ${namespace}: {`);
  assert.ok(start > 0, `${file} declares window.native.${namespace}`);
  const end = lines.indexOf('    };', start);
  return lines
    .slice(start + 1, end)
    .map((l) => /^ {6}(\w+)\??[(:<]/.exec(l)?.[1])
    .filter((n): n is string => !!n)
    .sort();
}

test('NativeApi has one src/lib/native file per bridge namespace, and its types name exactly the calls each declares', async () => {
  const NATIVE_DIR = path.join(ROOT, 'src', 'lib', 'native');
  const spec = loadBridge();
  assert.deepEqual(names(NATIVE_DIR, '.ts'), Object.keys(spec));
  for (const n of names(NATIVE_DIR, '.ts')) {
    const file = path.join(NATIVE_DIR, `${n}.ts`);
    assert.deepEqual(typeMembers(file, n), Object.keys(spec[n]).sort(), n);
    assert.match(fs.readFileSync(file, 'utf8'), /^declare module '\.\.\/native' \{\n {2}interface NativeApi \{$/m, n);
    // a type-only module: loading it runs nothing (and measures it)
    const mod = await import(file);
    assert.deepEqual(
      Object.keys(mod).filter((k) => k !== 'default' && k !== 'module.exports'),
      [],
      n,
    );
  }
  assert.throws(() => typeMembers(path.join(NATIVE_DIR, 'cloud.ts'), 'nowhere'), /declares window\.native\.nowhere/);
});

test('a bridge call that forwards no arguments is typed with none, so an argument the renderer passes is never dropped', () => {
  const NATIVE_DIR = path.join(ROOT, 'src', 'lib', 'native');
  const spec: any = loadBridge();
  const dropped: string[] = [];
  let read = 0;
  for (const [ns, methods] of Object.entries(spec) as [string, any][]) {
    const text = fs.readFileSync(path.join(NATIVE_DIR, `${ns}.ts`), 'utf8');
    for (const [name, m] of Object.entries(methods) as [string, any][]) {
      if ((m.kind !== 'invoke' && m.kind !== 'send') || m.params !== 0) continue;
      // `name(): …`, `name?(): …` or `name: () => …`: the first thing after the parenthesis closes it
      const sig = new RegExp(`^\\s+${name}\\??(?:\\(|: \\()(.)`, 'm').exec(text);
      if (sig) read++;
      if (sig && sig[1] !== ')') dropped.push(`${ns}.${name}`);
    }
  }
  assert.deepEqual(dropped, []);
  assert.ok(read > 50, `the signatures were read (${read})`);
});

test('main registers every electron/app/ipc module in name order, except those another module registers', () => {
  const mods = listIpcModules();
  const owned = names(IPC_DIR, '.cjs').filter((n) => !require(path.join(IPC_DIR, `${n}.cjs`)).registeredBy);
  assert.deepEqual(
    mods.map((m: any) => m.name),
    owned,
  );
  assert.ok(owned.includes('sessions') && owned.length < names(IPC_DIR, '.cjs').length);
  // a module left out is registered by the module it names
  for (const n of names(IPC_DIR, '.cjs')) {
    const by = require(path.join(IPC_DIR, `${n}.cjs`)).registeredBy;
    if (by)
      assert.match(fs.readFileSync(path.join(IPC_DIR, `${by}.cjs`), 'utf8'), new RegExp(`require\\('\\./${n}\\.cjs'\\)`), `${n} by ${by}`);
  }
  // main lists none by hand: it requires only the registry
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /require\('\.\/app\/ipc\/modules\.cjs'\)/);
  assert.doesNotMatch(main, /require\('\.\/app\/ipc\/(?!modules\.cjs')/);
});

test('registering IPC modules passes each the same deps in name order; a module with no register is refused', () => {
  const dir = scratch({
    'b.cjs': 'module.exports = { register: (ipc, deps) => ipc.push(["b", deps]) };',
    'a.cjs': 'module.exports = { register: (ipc, deps) => ipc.push(["a", deps]) };',
    'c.cjs': "module.exports = { register: () => { throw new Error('registered by a') }, registeredBy: 'a' };",
  });
  const ipc: any[] = [];
  const deps = { d: 1 };
  assert.deepEqual(registerIpcModules(ipc, deps, dir), ['a', 'b']);
  assert.deepEqual(ipc, [
    ['a', deps],
    ['b', deps],
  ]);
  const bad = scratch({ 'x.cjs': 'module.exports = {};' });
  assert.throws(() => listIpcModules(bad), /ipc\/x\.cjs exports no register\(ipcMain, deps\) and no registeredBy/);
});
