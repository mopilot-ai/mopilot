// electron/platform/core.cjs: where the Rust core's addon is looked for, loading it (or not: no file, a load error, a
// library that is not the core), and a route's JSON reply, which throws without a core or when the call fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  corePath,
  loadCore,
  core,
  coreLoaded,
  coreCall,
  coreSyncCall,
  coreProblem,
  requiredCore,
} = require('../electron/platform/core.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');

/** What a library needs to be the core, each doing nothing. */
const CORE_EXPORTS = {
  dispatch: async () => Buffer.alloc(0),
  dispatchCancellable: () => ({ id: 0, reply: Promise.resolve(Buffer.alloc(0)) }),
  cancel: () => false,
  dispatchSync: () => Buffer.alloc(0),
  subscribe: () => undefined,
  routes: (): string[] => [],
};
const EXPORTS = Object.keys(CORE_EXPORTS);

test('the addon is MOPILOT_CORE when set, else the release build for this platform', () => {
  assert.equal(corePath({ env: { MOPILOT_CORE: '/x/core.node' } }), '/x/core.node');
  // no value turns it off: `off` is a file that is not there
  assert.equal(corePath({ env: { MOPILOT_CORE: 'off' } }), 'off');
  assert.equal(
    corePath({ env: {}, platform: 'darwin', root: '/r' }),
    path.join('/r', 'core', 'target', 'release', 'libmopilot_core.dylib'),
  );
  assert.equal(corePath({ env: {}, platform: 'linux', root: '/r' }), path.join('/r', 'core', 'target', 'release', 'libmopilot_core.so'));
  assert.equal(corePath({ env: {}, platform: 'win32', root: '/r' }), path.join('/r', 'core', 'target', 'release', 'mopilot_core.dll'));
  assert.equal(corePath({ env: {}, platform: 'aix', root: '/r' }), null);
  // a packaged app's own copy comes first; an unpackaged Electron (no copy in its resources) takes the release build
  const shipped = path.join('/App/Resources', 'core', 'mopilot_core.node');
  assert.equal(
    corePath({ env: {}, root: '/r', platform: 'darwin', resources: '/App/Resources', exists: (f: string) => f === shipped }),
    shipped,
  );
  assert.equal(
    corePath({ env: {}, root: '/r', platform: 'darwin', resources: '/App/Resources', exists: () => false }),
    path.join('/r', 'core', 'target', 'release', 'libmopilot_core.dylib'),
  );
  // unit tests run on the checkout's own core (tests/support/register.ts)
  assert.equal(corePath(), process.env.MOPILOT_CORE);
  assert.equal(coreLoaded(), true);
  assert.equal(core(), core(), 'looked for once');
});

test('loading: no file is no core, a load error is noted, and only a library with every export is the core', () => {
  clearIgnored();
  const addon = { ...CORE_EXPORTS, dispatch: async () => Buffer.from('1') };
  assert.equal(loadCore(null), null);
  assert.equal(loadCore('/none', { exists: () => false }), null);
  assert.equal(loadCore('/x', { exists: () => true, dlopen: (m: any) => (m.exports = addon) }), addon);
  assert.equal(loadCore('/x', { exists: () => true, dlopen: (m: any) => (m.exports = { other: 1 }) }), null);
  // a stale build, from before its stream
  const { subscribe: _none, ...stale } = addon;
  assert.equal(loadCore('/x', { exists: () => true, dlopen: (m: any) => (m.exports = stale) }), null);
  assert.equal(recentIgnored().at(-1)?.message, 'it has no subscribe');
  assert.equal(
    loadCore('/x', {
      exists: () => true,
      dlopen: () => {
        throw new Error('wrong architecture');
      },
    }),
    null,
  );
  assert.ok(recentIgnored().some((e: any) => e.context === 'load the Rust core'));
  // Node's own loader, given a file that is not an addon
  const notAddon = path.join(mkdtempSync(path.join(os.tmpdir(), 'core-loader-')), 'core.node');
  writeFileSync(notAddon, 'not a library');
  assert.equal(loadCore(notAddon), null);
});

test("a route's reply is its JSON; no core, or a call that fails, rejects with why", async () => {
  const calls: [string, Buffer][] = [];
  const addon = {
    ...CORE_EXPORTS,
    dispatch: async (route: string, payload: Buffer) => (calls.push([route, payload]), Buffer.from('[[1,0,1]]')),
  };
  assert.deepEqual(await coreCall('proc.table', addon), [[1, 0, 1]]);
  assert.equal(calls[0][0], 'proc.table');
  assert.equal(calls[0][1].length, 0);
  assert.ok(Array.isArray(await coreCall('proc.table')), 'the process core');
  // the loaded core is there, so a caller that has none is told only that
  await assert.rejects(coreCall('proc.table', null), { message: 'The Rust core is missing.' });
  const failing = {
    ...CORE_EXPORTS,
    dispatch: async () => {
      throw new Error('no core route proc.x');
    },
  };
  await assert.rejects(coreCall('proc.x', failing), /no core route proc\.x/);
  const garbled = { ...CORE_EXPORTS, dispatch: async () => Buffer.from('not json') };
  await assert.rejects(coreCall('proc.table', garbled), SyntaxError);
});

test("a synchronous route's reply is its JSON, or null when empty; no core, or a call that fails, throws", () => {
  const replies: Record<string, string> = { 'session.open': '', 'caps.ready': 'true' };
  const addon = { ...CORE_EXPORTS, dispatchSync: (route: string) => Buffer.from(replies[route] ?? 'not json') };
  assert.equal(coreSyncCall(addon, 'caps.ready', null), true);
  assert.equal(coreSyncCall(addon, 'session.open', { id: 1 }), null);
  assert.throws(() => coreSyncCall(addon, 'session.x', {}), SyntaxError);
  assert.throws(() => coreSyncCall(null, 'caps.ready', null), { message: 'The Rust core is missing.' });
  assert.throws(() => coreSyncCall(undefined, 'caps.ready', null), { message: 'The Rust core is missing.' });
  assert.equal(coreSyncCall(core(), 'caps.ready', null), true, 'the process core');
  assert.equal(requiredCore(core()), core());
  assert.equal(requiredCore(addon), addon);
  assert.throws(() => requiredCore(undefined), { message: 'The Rust core is missing.' });
});

test('a process without the core can say why', () => {
  const addon = { ...CORE_EXPORTS };
  assert.equal(coreProblem({ addon, file: '/x', failure: null }), null);
  assert.equal(
    coreProblem({ addon: null, file: '/app/core.node', failure: null }),
    'The Rust core is missing: there is no file at /app/core.node.',
  );
  assert.equal(coreProblem({ addon: null, file: null, failure: null }), 'The Rust core is missing.');
  assert.equal(coreProblem({ addon: null, file: '/x.node', failure: 'bad hash' }), 'The Rust core at /x.node did not load: bad hash');
  assert.equal(coreProblem(), null, 'this process has it');
});

test('a failed load is what the process then reports, naming every export a stale build lacks', () => {
  assert.equal(loadCore('/x', { exists: () => true, dlopen: (m: any) => (m.exports = { other: 1 }) }), null);
  const why = `The Rust core at /x did not load: it has no ${EXPORTS.join(', ')}`;
  assert.equal(coreProblem({ addon: null, file: '/x' }), why);
});

test('a unit test cannot end a real process through the core', async () => {
  assert.deepEqual(await coreCall('proc.kill', undefined, String(process.pid)), []);
  assert.equal(await coreCall('proc.contain', undefined, `${process.pid} 1`), false);
  assert.deepEqual(await coreCall('proc.endContained', undefined, String(process.pid)), []);
  assert.ok(process.kill(process.pid, 0), 'this process is still here');
});
