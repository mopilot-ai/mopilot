// Remote kill switches on the desktop (electron/platform/flags.cjs): cache, offline fallback and expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferred } from './support/async-scenarios.ts';
import { SHIPPED_OFF_NATIVE } from './support/native-build-flags.ts';

const require = createRequire(import.meta.url);
const { Flags, DEFAULTS, MAX_AGE_MS, REFRESH_MS, parseOverride } = require('../electron/platform/flags.cjs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-flags-')), 'flags.json');
const reply =
  (body: unknown, ok = true) =>
  async () =>
    ({ ok, json: async () => body }) as any;
const offline = async () => {
  throw new Error('offline');
};

function make(file: string, o: Record<string, any> = {}) {
  let t = 1_000_000_000;
  const changes: any[] = [];
  const flags = new Flags({
    file,
    url: 'https://x/api/flags',
    channel: () => 'stable',
    version: '0.3.0',
    now: () => t,
    fetch: offline,
    onChange: (s: any) => changes.push(s),
    ...o,
  });
  return { flags, changes, tick: (ms: number) => (t += ms) };
}

test('a refresh rejects old channel, version, or generation after either await', async () => {
  for (const stage of ['fetch', 'json']) {
    for (const invalidation of ['channel', 'version', 'stop', 'newer']) {
      const file = tmpFile();
      const gate = deferred<any>();
      let channel = 'stable';
      const a = make(file, {
        channel: () => channel,
        fetch: stage === 'fetch' ? () => gate.promise : async () => ({ ok: true, json: () => gate.promise }),
      });
      const pending = a.flags.refresh();
      await new Promise((r) => setImmediate(r));
      if (invalidation === 'channel') channel = 'beta';
      if (invalidation === 'version') a.flags.o.version = '2';
      if (invalidation === 'stop') a.flags.stop();
      if (invalidation === 'newer') {
        a.flags.o.fetch = reply({ 'tier.basic.enabled': false });
        assert.equal(await a.flags.refresh(), true);
      }
      const changes = a.changes.length;
      const cached = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      gate.resolve(
        stage === 'fetch' ? { ok: true, json: async () => ({ 'harness.claude.enabled': false }) } : { 'harness.claude.enabled': false },
      );
      assert.equal(await pending, false, `${stage}/${invalidation}`);
      assert.equal(a.flags.isEnabled('harness.claude.enabled'), true);
      assert.equal(a.changes.length, changes);
      assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, cached);
    }
  }
});

test('cached and fetched switches stay scoped to their channel/version, including a failed refresh', async () => {
  for (const fromCache of [false, true]) {
    const file = tmpFile();
    const seed = make(file, { fetch: reply({ 'harness.claude.enabled': false }) });
    await seed.flags.refresh();
    let channel = 'stable';
    const a = fromCache ? make(file, { channel: () => channel }) : seed;
    a.flags.o.channel = () => channel;
    assert.equal(a.flags.isEnabled('harness.claude.enabled'), false);
    channel = 'dogfood';
    assert.equal(a.flags.isEnabled('harness.claude.enabled'), true);
    a.flags.o.fetch = offline;
    assert.equal(await a.flags.refresh(), false);
    assert.equal(a.changes.at(-1)['harness.claude.enabled'], true, 'windows see the scope change even when discovery fails');
    a.flags.o.fetch = reply({ 'harness.claude.enabled': false });
    assert.equal(await a.flags.refresh(), true);
    assert.equal(a.flags.isEnabled('harness.claude.enabled'), false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).channel, 'dogfood');
    a.flags.o.version = '2';
    assert.equal(a.flags.isEnabled('harness.claude.enabled'), true);
    assert.equal(await a.flags.refresh(), true);
    assert.equal(a.flags.isEnabled('harness.claude.enabled'), false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '2');
    a.flags.stop();
    assert.equal(await a.flags.refresh(), true, 'a later explicit refresh still works');
  }
});

test('offline with no cache: the built-in defaults', async () => {
  const { flags } = make(tmpFile());
  assert.equal(await flags.refresh(), false);
  assert.equal(flags.isEnabled('harness.codex.enabled'), true);
  assert.equal(flags.isEnabled('shared.computerUse.unattended'), true);
  assert.deepEqual(flags.snapshot(), { ...DEFAULTS });
  assert.equal(flags.isEnabled('no.such.flag'), false);
});

test('a fetched kill turns a feature off, is cached, and survives a restart offline', async () => {
  const file = tmpFile();
  const urls: string[] = [];
  const fetch = async (url: string) => (urls.push(url), reply({ 'shared.computerUse.enabled': false, 'harness.codex.enabled': true })());
  const a = make(file, { fetch });
  assert.equal(await a.flags.refresh(), true);
  assert.equal(urls[0], 'https://x/api/flags?channel=stable&version=0.3.0&schema=2');
  assert.equal(a.flags.isEnabled('shared.computerUse.enabled'), false);
  assert.equal(a.changes.length, 1);
  assert.equal(a.changes[0]['shared.computerUse.enabled'], false);
  const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  // a flat (pre-toggle) answer keeps only its kills
  assert.deepEqual(cached.flags, { 'shared.computerUse.enabled': false });
  assert.equal(cached.schema, 2);

  const b = make(file);
  assert.equal(await b.flags.refresh(), false);
  assert.equal(b.flags.isEnabled('shared.computerUse.enabled'), false, 'the cached kill holds offline');
});

test('a switch never turns on what the build ships off; unknown keys and non-booleans are ignored', async () => {
  const { flags, changes } = make(tmpFile(), {
    fetch: reply({
      'shared.computerUse.unattended': true,
      [SHIPPED_OFF_NATIVE]: true,
      'secret.feature': true,
      'harness.claude.enabled': 'no',
    }),
  });
  await flags.refresh();
  assert.equal(flags.isEnabled(SHIPPED_OFF_NATIVE), false);
  assert.equal(flags.isEnabled('secret.feature'), false);
  assert.equal(flags.isEnabled('harness.claude.enabled'), true);
  assert.equal(changes.length, 0, 'nothing effective changed');
});

test('inherited object names are neither switches nor accepted overrides', async () => {
  const names = Object.getOwnPropertyNames(Object.prototype);
  const raw = Object.fromEntries(names.map((key) => [key, true]));
  assert.deepEqual(parseOverride(JSON.stringify(raw)), {});
  const { flags } = make(tmpFile(), { fetch: reply(raw) });
  await flags.refresh();
  for (const key of names) assert.equal(flags.isEnabled(key), false, key);
  assert.deepEqual(flags.remote, {});
});

test('a failed or bad answer keeps the last good switches', async () => {
  const file = tmpFile();
  const a = make(file, { fetch: reply({ 'tier.basic.enabled': false }) });
  await a.flags.refresh();
  a.flags.o.fetch = reply({}, false);
  assert.equal(await a.flags.refresh(), false);
  assert.equal(a.flags.isEnabled('tier.basic.enabled'), false);
  a.flags.o.fetch = offline;
  assert.equal(await a.flags.refresh(), false);
  assert.equal(a.flags.isEnabled('tier.basic.enabled'), false);
  // a broken cache file reads as no cache
  fs.writeFileSync(file, '{nope');
  assert.equal(make(file).flags.isEnabled('tier.basic.enabled'), true);
});

test('lifting a kill turns the feature back on', async () => {
  const { flags, changes } = make(tmpFile(), { fetch: reply({ 'channel.claude.sdkMcp': false }) });
  await flags.refresh();
  assert.equal(flags.isEnabled('channel.claude.sdkMcp'), false);
  flags.o.fetch = reply({ 'channel.claude.sdkMcp': true });
  await flags.refresh();
  assert.equal(flags.isEnabled('channel.claude.sdkMcp'), true);
  assert.equal(changes.length, 2);
});

test('the cache expires after a week, and is dropped for another version or channel', async () => {
  const file = tmpFile();
  const a = make(file, { fetch: reply({ 'data.legacyMirror': false }) });
  await a.flags.refresh();

  // still fresh just before the limit, both in memory and on the next start
  a.tick(MAX_AGE_MS - 1);
  assert.equal(a.flags.isEnabled('data.legacyMirror'), false);
  // expired: back to the defaults while running offline
  a.tick(1);
  assert.equal(a.flags.isEnabled('data.legacyMirror'), true);

  let t = 1_000_000_000 + MAX_AGE_MS;
  assert.equal(make(file, { now: () => t }).flags.isEnabled('data.legacyMirror'), true, 'expired on disk');
  t = 1_000_000_000 + 1000;
  assert.equal(make(file, { now: () => t }).flags.isEnabled('data.legacyMirror'), false, 'fresh on disk');
  assert.equal(make(file, { now: () => t, version: '0.3.1' }).flags.isEnabled('data.legacyMirror'), true, 'another version');
  assert.equal(make(file, { now: () => t, channel: () => 'beta' }).flags.isEnabled('data.legacyMirror'), true, 'another channel');
});

test('refreshes every 30 minutes', () => {
  assert.equal(REFRESH_MS, 30 * 60_000);
});

test('a local override wins in both directions, for known keys only', async () => {
  const override = parseOverride(`harness.claude.enabled=0, ${SHIPPED_OFF_NATIVE}=1, bogus.key=1, tier.basic.enabled=maybe`);
  assert.deepEqual(override, { 'harness.claude.enabled': false, [SHIPPED_OFF_NATIVE]: true });
  assert.deepEqual(parseOverride('{"channel.acp.sessionMcp": false, "x": true, "harness.codex.enabled": "no"}'), {
    'channel.acp.sessionMcp': false,
  });
  assert.deepEqual(parseOverride(undefined), {});
  const { flags, changes } = make(tmpFile(), {
    override,
    fetch: reply({ 'harness.claude.enabled': true, [SHIPPED_OFF_NATIVE]: false }),
  });
  assert.equal(flags.isEnabled('harness.claude.enabled'), false, 'overridden off even though the server says on');
  assert.equal(flags.isEnabled(SHIPPED_OFF_NATIVE), true, 'overridden on though the build ships it off');
  assert.equal(flags.isEnabled('harness.codex.enabled'), true);
  assert.equal(flags.snapshot()[SHIPPED_OFF_NATIVE], true);
  await flags.refresh();
  assert.equal(changes.length, 0);
});

test('a kill that takes effect is reported once, from the server or the cache', async () => {
  const file = tmpFile();
  const killed: string[] = [];
  const a = make(file, {
    fetch: reply({ 'channel.acp.sessionMcp': false, [SHIPPED_OFF_NATIVE]: false }),
    onKill: (k: string) => killed.push(k),
  });
  await a.flags.refresh();
  // the native fixture is already off in the build: nothing was killed
  assert.deepEqual(killed, ['channel.acp.sessionMcp']);
  await a.flags.refresh();
  assert.deepEqual(killed, ['channel.acp.sessionMcp'], 'not again while it stays off');
  a.flags.o.fetch = reply({});
  await a.flags.refresh();
  a.flags.o.fetch = reply({ 'channel.acp.sessionMcp': false });
  await a.flags.refresh();
  assert.deepEqual(killed, ['channel.acp.sessionMcp', 'channel.acp.sessionMcp'], 'again after it was lifted');
  // a start that still holds the kill from the cache reports it
  const again: string[] = [];
  const b = make(file, { onKill: (k: string) => again.push(k) });
  b.flags.start();
  b.flags.stop();
  assert.deepEqual(again, ['channel.acp.sessionMcp']);
  // an overridden key is the developer's choice, not a kill
  const c: string[] = [];
  const d = make(file, { override: { 'channel.acp.sessionMcp': false }, onKill: (k: string) => c.push(k) });
  d.flags.start();
  d.flags.stop();
  assert.deepEqual(c, []);
});
