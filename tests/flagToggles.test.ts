// Remote toggle flags on the desktop (electron/platform/flags.cjs): a schema-2 `true` turns on a toggle flag only, scoped
// to its channel, and a corrupt cache never reads as "all on" (contract P1a-B: A2, B1, W3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { Flags, DEFAULTS, SCHEMA, defaultsFor, remoteFrom, initFlags, isEnabled } = require('../electron/platform/flags.cjs');
const { FLAG_DEFS } = require('../shared/flagDefs.mjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const T = 'test.toggle';
const W = 'test.macOnly';
const KILL_OFF = 'shared.browser.chromeRelay';
const DEFS = [
  ...FLAG_DEFS,
  { key: T, default: false, owner: 'test', remove: '2999-01-01', mode: 'toggle', description: 'x' },
  { key: W, default: false, win32: false, owner: 'test', remove: '2999-01-01', mode: 'toggle', description: 'x' },
];
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-toggles-')), 'flags.json');
const reply = (body: unknown) => async () => ({ ok: true, json: async () => body }) as any;
const v2 = (flags: unknown) => ({ schema: SCHEMA, flags });

function make(file: string, o: Record<string, any> = {}) {
  const changes: any[] = [];
  const flags = new Flags({
    file,
    url: 'https://x/api/flags',
    channel: () => 'dogfood',
    version: '0.5.0',
    now: () => 1_000_000_000,
    fetch: async () => {
      throw new Error('offline');
    },
    onChange: (s: any) => changes.push(s),
    defs: DEFS,
    platform: 'darwin',
    ...o,
  });
  return { flags, changes };
}

test('B1: a schema-2 true turns a toggle flag on; it is ignored for a kill flag, a non-boolean and an unknown key', async () => {
  const { flags, changes } = make(tmpFile(), {
    fetch: reply(v2({ [T]: true, [KILL_OFF]: true, 'harness.claude.enabled': 'yes', 'no.such.flag': true, W: 1 })),
  });
  assert.equal(flags.isEnabled(T), false, 'the build default before any answer');
  assert.equal(await flags.refresh(), true);
  assert.equal(flags.isEnabled(T), true);
  assert.equal(flags.isEnabled(KILL_OFF), false, 'a kill flag the build ships off never turns on');
  assert.equal(flags.isEnabled('harness.claude.enabled'), true);
  assert.equal(flags.isEnabled('no.such.flag'), false);
  assert.deepEqual(
    changes.map((s) => s[T]),
    [true],
  );
  // a kill always wins, and lifting it goes back to the build default
  flags.o.fetch = reply(v2({ [T]: false }));
  await flags.refresh();
  assert.equal(flags.isEnabled(T), false);
  flags.o.fetch = reply(v2({}));
  await flags.refresh();
  assert.equal(flags.isEnabled(T), false);
});

test('a server that predates toggles (a flat map, true for every key) never turns a toggle on; its kills still apply', async () => {
  const flat = Object.fromEntries(DEFS.map((d) => [d.key, true]));
  const { flags } = make(tmpFile(), { fetch: reply({ ...flat, 'harness.codex.enabled': false }) });
  assert.equal(await flags.refresh(), true);
  assert.equal(flags.isEnabled(T), false);
  assert.equal(flags.isEnabled('harness.codex.enabled'), false);
  assert.deepEqual(remoteFrom({ [T]: true, 'harness.codex.enabled': false }, defaultsFor('darwin', DEFS)), {
    'harness.codex.enabled': false,
  });
});

test('a toggle a platform ships off (win32: false) stays off there whatever the server says', async () => {
  for (const [platform, on] of [
    ['win32', false],
    ['darwin', true],
  ] as const) {
    const { flags } = make(tmpFile(), { platform, fetch: reply(v2({ [W]: true })) });
    await flags.refresh();
    assert.equal(flags.isEnabled(W), on, platform);
  }
  assert.equal(defaultsFor('win32', DEFS)['shared.computerUse.enabled'], false);
});

test('A2: a dogfood fetch that settles after the switch to stable is discarded, and its enables never apply', async () => {
  const file = tmpFile();
  let channel = 'dogfood';
  const gate = deferred<any>();
  const { flags, changes } = make(file, { channel: () => channel, fetch: () => gate.promise });
  const pending = flags.refresh();
  await new Promise((r) => setImmediate(r));
  channel = 'stable';
  gate.resolve({ ok: true, json: async () => v2({ [T]: true }) });
  assert.equal(await pending, false);
  assert.equal(flags.isEnabled(T), false);
  assert.ok(changes.every((s) => s[T] === false));
  assert.equal(fs.existsSync(file), false, 'nothing cached');
  // a dogfood cache holding an enable is not read on stable, and is again on dogfood
  channel = 'dogfood';
  flags.o.fetch = reply(v2({ [T]: true }));
  assert.equal(await flags.refresh(), true);
  assert.equal(flags.isEnabled(T), true);
  channel = 'stable';
  assert.equal(flags.isEnabled(T), false, 'in memory');
  assert.equal(make(file, { channel: () => 'stable' }).flags.isEnabled(T), false, 'from the cache');
  assert.equal(make(file).flags.isEnabled(T), true, 'the dogfood cache on dogfood');
});

test('W3: a corrupt cache is reported and treated as absent, never as all on', () => {
  const file = tmpFile();
  const base = { fetchedAt: 1_000_000_000, channel: 'dogfood', version: '0.5.0' };
  const corrupt: unknown[] = [
    { ...base, flags: 'all' },
    { ...base, flags: [true] },
    { ...base },
    { ...base, schema: SCHEMA, flags: null },
    { ...base, schema: SCHEMA },
    { flags: {} },
    [1],
    'flags',
    null,
  ];
  for (const c of corrupt) {
    clearIgnored();
    fs.writeFileSync(file, JSON.stringify(c));
    const { flags } = make(file);
    assert.deepEqual(flags.snapshot(), defaultsFor('darwin', DEFS), JSON.stringify(c));
    assert.equal(flags.isEnabled(T), false);
    assert.match(
      recentIgnored()
        .map((e: { message: string }) => e.message)
        .join('\n'),
      /not a switch map/,
      JSON.stringify(c),
    );
  }
  // a cache from before toggles (no schema) keeps only its kills
  fs.writeFileSync(file, JSON.stringify({ ...base, flags: { [T]: true, 'harness.codex.enabled': false } }));
  const legacy = make(file).flags;
  assert.equal(legacy.isEnabled(T), false);
  assert.equal(legacy.isEnabled('harness.codex.enabled'), false);
  // unparseable JSON is reported by the read itself
  clearIgnored();
  fs.writeFileSync(file, '{nope');
  assert.equal(make(file).flags.isEnabled(T), false);
  assert.match(
    recentIgnored()
      .map((e: { context: string }) => e.context)
      .join('\n'),
    /read the cached remote switches/,
  );
});

test('an answer that is not a switch map is rejected and keeps the last good switches', async () => {
  const file = tmpFile();
  const { flags } = make(file, { fetch: reply(v2({ [T]: true })) });
  await flags.refresh();
  const cached = fs.readFileSync(file, 'utf8');
  for (const bad of [[], null, 'on', v2('all'), v2([true])]) {
    clearIgnored();
    flags.o.fetch = reply(bad);
    assert.equal(await flags.refresh(), false, JSON.stringify(bad));
    assert.equal(flags.isEnabled(T), true);
    assert.equal(fs.readFileSync(file, 'utf8'), cached);
    assert.match(
      recentIgnored()
        .map((e: { message: string }) => e.message)
        .join('\n'),
      /not a switch map/,
    );
  }
});

test('the app instance uses the real definitions: no toggle flag, defaults until init', () => {
  const real = new Flags({ file: tmpFile(), url: 'https://x', channel: () => 'stable', version: '1', fetch: reply(v2({})) });
  assert.equal(real.defaults, DEFAULTS);
  assert.equal(real.toggles.size, FLAG_DEFS.filter((d: { mode: string }) => d.mode === 'toggle').length);
  const app = initFlags({
    file: tmpFile(),
    url: 'https://x',
    channel: () => 'stable',
    version: '1',
    fetch: reply(v2({ 'harness.codex.enabled': false })),
  });
  app.stop();
  assert.equal(typeof isEnabled('harness.codex.enabled'), 'boolean');
});
