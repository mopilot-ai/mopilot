// electron/platform/flags.cjs: the app-wide instance (initFlags/isEnabled), its IPC, the Windows build
// defaults, and failures that must not escape (an onKill that throws, an unwritable cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SHIPPED_OFF_NATIVE } from './support/native-build-flags.ts';

const require = createRequire(import.meta.url);
const flagsPath = require.resolve('../electron/platform/flags.cjs');
const { Flags, initFlags, isEnabled, refreshFlags, registerFlags, DEFAULTS, sanitize } = require(flagsPath);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'));
const answer = (body: any) => async () => ({ ok: true, json: async () => body });

test('channel changes before flags initialization have no service to refresh', async () => {
  assert.equal(await refreshFlags(), false);
});

test('replacing the global service invalidates its pending response and only refreshes its replacement', async () => {
  const dir = tmp();
  const file = path.join(dir, 'flags.json');
  let resolve!: (value: any) => void;
  const pending = new Promise((r) => (resolve = r));
  const changes: any[] = [];
  const base = { file, url: 'https://x/api/flags', channel: () => 'stable', version: '1' };
  const first = initFlags({ ...base, fetch: () => pending, onChange: (s: any) => changes.push(s) });
  const second = initFlags({ ...base, fetch: answer({}) });
  assert.equal(await refreshFlags(), true);
  const cached = fs.readFileSync(file, 'utf8');
  resolve({ ok: true, json: async () => ({ 'harness.claude.enabled': false }) });
  await new Promise((r) => setImmediate(r));
  assert.equal(first.timer, null);
  assert.equal(changes.length, 0);
  assert.equal(isEnabled('harness.claude.enabled'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), cached);
  second.stop();
});

test('sanitize drops non-objects and arrays', () => {
  assert.deepEqual(sanitize(null), {});
  assert.deepEqual(sanitize('x'), {});
  assert.deepEqual(sanitize([true]), {});
  assert.deepEqual(sanitize({ 'harness.claude.enabled': false, nope: false, 'tier.basic.enabled': 'no' }), {
    'harness.claude.enabled': false,
  });
});

test('the Windows build ships computer use off and basic harnesses on', () => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    delete require.cache[flagsPath];
    const win = require(flagsPath);
    assert.equal(win.DEFAULTS['shared.computerUse.enabled'], false);
    assert.equal(win.DEFAULTS['shared.computerUse.unattended'], false);
    // the Rust sage-mcp carries their tools there; only computer use needs the Swift helper
    assert.equal(win.DEFAULTS['tier.basic.enabled'], true);
    assert.equal(win.DEFAULTS['harness.codex.enabled'], true);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
    delete require.cache[flagsPath];
    require(flagsPath);
  }
});

test('isEnabled uses build defaults until initFlags; a new init replaces and stops the old instance', async () => {
  assert.equal(isEnabled('harness.claude.enabled'), DEFAULTS['harness.claude.enabled']);
  assert.equal(isEnabled(SHIPPED_OFF_NATIVE), false);
  assert.equal(isEnabled('nope'), false);
  const dir = tmp();
  const base = { file: path.join(dir, 'flags.json'), url: 'https://x/api/flags', channel: () => 'stable', version: '1' };
  const first = initFlags({ ...base, fetch: answer({ 'harness.claude.enabled': false }) });
  assert.ok(first.timer);
  await new Promise((r) => setImmediate(r));
  assert.equal(isEnabled('harness.claude.enabled'), false);
  const second = initFlags({ ...base, fetch: answer({}) });
  assert.equal(first.timer, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(isEnabled('harness.claude.enabled'), true);
  second.stop();
});

test('registerFlags answers the synchronous flags:getSync with the snapshot', () => {
  const handlers: Record<string, Function> = {};
  const ipcMain = { on: (ch: string, fn: Function) => (handlers[ch] = fn) };
  const flags = { snapshot: () => ({ a: true }) };
  registerFlags(ipcMain, flags);
  const e: any = {};
  handlers['flags:getSync'](e);
  assert.deepEqual(e.returnValue, { a: true });
});

test('a kill reported to a throwing onKill and an unwritable cache do not break refresh; default onChange is a no-op', async () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, '');
  const killed: string[] = [];
  const f = new Flags({
    file: path.join(blocker, 'sub', 'flags.json'), // its parent is a file: the cache write fails
    url: 'u',
    channel: () => 'stable',
    version: '1',
    fetch: answer({ 'harness.codex.enabled': false }),
    onKill: (k: string) => {
      killed.push(k);
      throw new Error('telemetry down');
    },
  });
  assert.equal(await f.refresh(), true);
  assert.deepEqual(killed, ['harness.codex.enabled']);
  assert.equal(f.isEnabled('harness.codex.enabled'), false);
  assert.equal(fs.existsSync(path.join(blocker, 'sub')), false);
});

test('what the switches work around is recorded: an unreadable cache, a failed fetch, a throwing onKill, an unwritable cache', async () => {
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  const seen = (context: string) => recentIgnored().filter((e: any) => e.context === context);
  const dir = tmp();
  const file = path.join(dir, 'flags.json');
  const base = { file, url: 'u', channel: () => 'stable', version: '1' };
  new Flags({ ...base, fetch: answer({}) }); // no cache yet (ENOENT): not recorded
  assert.equal(seen('read the cached remote switches').length, 0);
  fs.writeFileSync(file, '{torn');
  const f = new Flags({
    ...base,
    fetch: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(seen('read the cached remote switches').length, 1);
  assert.equal(await f.refresh(), false);
  assert.equal(seen('fetch the remote switches')[0].message, 'offline');

  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, '');
  const g = new Flags({
    ...base,
    file: path.join(blocker, 'flags.json'),
    fetch: answer({ 'harness.codex.enabled': false }),
    onKill: () => {
      throw new Error('telemetry down');
    },
  });
  assert.equal(await g.refresh(), true);
  assert.equal(seen('report the remote switch harness.codex.enabled')[0].message, 'telemetry down');
  assert.match(seen('cache the remote switches')[0].message, /ENOTDIR|EEXIST/);
  // a good write leaves the cache in place for the next launch, with no temporary file beside it
  const h = new Flags({ ...base, fetch: answer({ 'harness.claude.enabled': false }) });
  assert.equal(await h.refresh(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).flags['harness.claude.enabled'], false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
  clearIgnored();
});

test('refresh: a channel that cannot be read is a failed refresh, not a rejection, and the switches stay', async () => {
  const dir = tmp();
  const f = new Flags({
    file: path.join(dir, 'flags.json'),
    url: 'https://x/api/flags',
    channel: () => {
      throw new Error('prefs unreadable');
    },
    version: '1',
    fetch: answer({ 'harness.claude.enabled': false }),
  });
  assert.equal(await f.refresh(), false);
  assert.equal(f.isEnabled('harness.claude.enabled'), DEFAULTS['harness.claude.enabled']);
});
