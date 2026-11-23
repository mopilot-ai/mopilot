// The authoritative preferences and registry IPC agree on which device a new chat remembers across windows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { register: registerChatRoutes } = require('../electron/app/ipc/chats.cjs');
const { registerChats, readUiState, flushPendingWrites } = require('../electron/platform/chats.cjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { LOCAL_ID } = require('../electron/host/localHost.cjs');

test('CLI selection and independent window edits merge and only accepted writes are broadcast', () => {
  const { registerPrefs } = require('../electron/platform/prefsIpc.cjs');
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const events: unknown[] = [];
  let prefs: Record<string, unknown> = { theme: 'light' };
  let reject = false;
  registerPrefs(
    { handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) },
    {
      read: () => ({ prefs }),
      write: (set: object, unset: string[]) => {
        if (reject) return null;
        prefs = { ...prefs, ...set };
        for (const key of unset) delete prefs[key];
        return prefs;
      },
      broadcast: (...event: unknown[]) => events.push(event),
      onPrefs: () => {},
    },
  );
  const patch = (sender: string, set: object, unset: string[] = []) => handlers.get('prefs:patch')!({ sender }, set, unset);
  assert.equal(patch('first', { preferHighestCli: true }), true);
  assert.equal(patch('second', { theme: 'dark' }), true);
  reject = true;
  assert.equal(patch('second', { preferHighestCli: false }), false);
  assert.deepEqual(prefs, { theme: 'dark', preferHighestCli: true });
  assert.deepEqual(events, [
    ['prefs:changed', null, { set: { preferHighestCli: true }, unset: [] }],
    ['prefs:changed', 'second', { set: { theme: 'dark' }, unset: [] }],
  ]);
  reject = false;
  assert.equal(patch('second', {}, ['preferHighestCli']), true);
  assert.deepEqual(events.at(-1), ['prefs:changed', null, { set: {}, unset: ['preferHighestCli'] }]);
  assert.deepEqual(prefs, { theme: 'dark' });
});

test('Run on broadcasts main’s accepted order and rejects a window’s queued choice after removal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-on-'));
  t.after(() => {
    flushPendingWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const uiState = path.join(dir, 'ui-state.json');
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipcMain = { handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) };
  const old = { id: 'ssh:me@old', name: 'Old machine' };
  const current = { id: 'ssh:me@current', name: 'Current machine' };
  const background = { id: LOCAL_ID, name: 'Background Host' };
  const rows = new Map([
    [old.id, old],
    [current.id, current],
    [background.id, background],
  ]);
  const events: [unknown, any][] = [];
  const removals: string[] = [];
  const live = { chats: { records: new Map() } };
  let allowed = true;
  const patch = (sender: string, values: object, unset: string[] = []) => handlers.get('prefs:patch')!({ sender }, values, unset);
  const saved = () => readUiState(uiState).prefs;
  const pick = (lastNewChatHost: object | null) => ({ lastNewChatHost });
  registerChatRoutes(ipcMain, {
    live,
    registerChats,
    STATE_FILE: () => uiState,
    readState: () => readUiState(uiState),
    broadcastExcept: (_event: string, excluding: unknown, delta: object) => events.push([excluding, delta]),
    buildMenu: () => {},
    zoom: { set: () => {} },
  });
  assert.throws(() => patch('A', pick(old)), /no longer available/, 'a missing Host authority cannot admit a saved device');
  register(
    ipcMain,
    {
      app: { getPath: () => dir },
      broadcastAll: (event: string, id: string) => {
        if (event === 'host:machineRemoved') removals.push(id);
      },
      shellEnv: { childEnv: () => ({}) },
      readState: () => readUiState(uiState),
      live,
    },
    {
      allowed: () => allowed,
      localOn: () => true,
      create: ({ onRemoved }: { onRemoved: (id: string) => void }) => ({
        row: (id: string) => rows.get(id),
        list: () => ({ machines: [...rows.values()], resolved: false }),
        onRowChange: () => () => {},
        uninstallHost: async () => ({ left: '' }),
        remove: (id: string) => {
          if (!rows.delete(id)) throw new Error('No such machine');
          onRemoved(id);
        },
      }),
      makeRemoteChats: () => ({ dropMachine: () => {} }),
    },
  );
  assert.equal(handlers.get('prefs:patch')!({ sender: 'A' }, [], 'invalid unset'), true);
  assert.equal(handlers.get('prefs:patch')!({ sender: 'A' }, {}, [3]), false);
  assert.equal(patch('A', { momo: true }), false);
  events.length = 0;

  patch('A', pick({ id: old.id, name: 'Old label' }));
  patch('B', pick(current));
  assert.deepEqual(
    events.splice(0),
    [
      [null, { set: pick(old), unset: [] }],
      [null, { set: pick(current), unset: [] }],
    ],
    'main echoes each accepted choice to every window, including its source',
  );
  assert.deepEqual(saved(), pick(current));

  await handlers.get('host:remove')!({}, old.id);
  assert.deepEqual(saved(), pick(current), 'removing a prior choice keeps a newer choice');
  assert.throws(() => patch('A', { ...pick(old), theme: 'dark' }), /no longer available/);
  assert.deepEqual(saved(), { ...pick(current), theme: 'dark' });
  assert.deepEqual(events.at(-1), [null, { set: pick(current), unset: [] }]);
  await handlers.get('host:remove')!({}, current.id);
  assert.deepEqual(saved(), { ...pick(null), theme: 'dark' }, 'the removal works before any heartbeat');
  assert.equal(patch('A', pick(background)), true);
  await handlers.get('host:removeLocal')!({});
  assert.equal(saved().lastNewChatHost, null);
  assert.deepEqual(
    removals,
    [old.id, current.id, background.id],
    'all committed removals retire open drafts, regardless of the preference',
  );
  await handlers.get('host:remove')!({}, 'missing');
  assert.equal(removals.length, 3, 'a failed removal cannot retire a draft');

  for (const invalid of [old, current, [], {}, { id: 8 }]) {
    assert.throws(() => patch('A', pick(invalid)), /no longer available/);
    assert.equal(saved().lastNewChatHost, null);
  }
  rows.set(old.id, old);
  allowed = false;
  assert.throws(() => patch('B', pick(old)), /no longer available/);
  assert.equal(patch('B', pick(null), ['lastNewChatHost']), true, 'clearing to This Mac needs no Host access');
  assert.equal(saved().lastNewChatHost, null);
});

test('the machines service reports registry read failures and only reports committed removals', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-on-remove-'));
  const file = path.join(dir, 'host-registry.json');
  fs.writeFileSync(file, '{');
  const bad = createRegistry({ file });
  const unreadable = createMachines({ dir, registry: bad, allowed: () => false, watch: () => {} });
  assert.equal(unreadable.list().registryUnreadable, true);
  unreadable.dispose();
  const registry = createRegistry({ file: path.join(dir, 'clean-registry.json') });
  registry.add({ id: 'box', address: 'me@box' });
  const removed: string[] = [];
  const machines = createMachines({
    dir,
    registry,
    allowed: () => true,
    watch: () => {},
    onRemoved: (id: string) => {
      assert.equal(
        registry.list().some((row: { id: string }) => row.id === id),
        false,
      );
      removed.push(id);
    },
  });
  t.after(() => {
    machines.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(() => machines.remove('missing'));
  assert.deepEqual(removed, []);
  machines.remove('box');
  assert.deepEqual(removed, ['box']);
});

test('a malformed registry row cannot prove device removal, even after another device is saved', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-on-malformed-row-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'host-registry.json');
  const damaged = { id: 'box', name: 'Box', address: null };
  fs.writeFileSync(file, JSON.stringify({ hosts: [damaged, null] }));
  const registry = createRegistry({ file });
  const machines = createMachines({ dir, registry, allowed: () => true, watch: () => {} });
  t.after(() => machines.dispose());
  assert.deepEqual(machines.list(), { machines: [], resolved: true, registryUnreadable: true });

  registry.add({ id: 'other', address: 'me@other' });
  registry.reload();
  assert.equal(machines.list().registryUnreadable, true, 'an unrelated write preserves uncertainty on reload');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hosts.slice(1), [damaged, null]);

  registry.add({ id: 'box', address: 'me@box' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hosts.at(-1), null, 'pairing again replaces only that device’s damaged row');
  fs.writeFileSync(file, JSON.stringify({ hosts: registry.list() }));
  registry.reload();
  assert.equal(machines.list().registryUnreadable, undefined, 'a clean read restores certainty');
});
