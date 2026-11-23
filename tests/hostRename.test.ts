// Renaming a machine (Settings › My machines › Rename): the registry keeps the new name, trimmed and persisted, and refuses an empty, too long or control-character name or an unknown machine (B1); a status answer out while it changes is not counted and the next beat is (A3); the machines service refuses it while Host is not allowed; the IPC passes the id and name on as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const ready = { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
const fileOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { dir: d, file: path.join(d, 'host-registry.json') };
};
const box = { id: 'h1', name: 'box', address: 'me@box' };

test('the registry keeps a new name, trimmed and on disk; the same name writes nothing; a bad name or an unknown machine is refused', (t) => {
  installFakeClock(t, 1_000_000);
  const { file } = fileOf(t);
  const registry = createRegistry({ file, status: async () => ready });
  t.after(() => registry.dispose());
  registry.add(box);
  let changes = 0;
  registry.onChange(() => changes++);
  registry.rename('h1', '  Studio iMac ');
  assert.equal(registry.list()[0].name, 'Studio iMac');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0].name, 'Studio iMac');
  assert.equal(changes, 1);
  registry.rename('h1', 'Studio iMac');
  assert.equal(changes, 1, 'nothing changed: no write, no change event');
  for (const bad of ['', '   ', 'x'.repeat(65), 'a\nb', 'tab\there', 3])
    assert.throws(() => registry.rename('h1', bad as any), { code: 'invalid', message: 'Give the machine a name of up to 64 characters.' });
  assert.equal(registry.rename('h1', 'x'.repeat(64)), undefined, '64 is allowed');
  assert.throws(() => registry.rename('nope', 'x'), { message: 'That machine is not in the registry.' });
  const again = createRegistry({ file, status: async () => ready });
  t.after(() => again.dispose());
  assert.equal(again.list()[0].name, 'x'.repeat(64), 'the name outlives the process');
});

test('a status answer out while the machine is renamed is not counted; the next beat is, and the name stays (A3)', async (t) => {
  installFakeClock(t, 1_000_000);
  const { file } = fileOf(t);
  let answer: (v: unknown) => void = () => undefined;
  let held = true;
  const registry = createRegistry({ file, status: () => (held ? new Promise((r) => (answer = r)) : Promise.resolve(ready)) });
  t.after(() => registry.dispose());
  registry.add(box);
  const first = registry.check();
  registry.rename('h1', 'Studio');
  answer(ready);
  await first;
  assert.equal(registry.list()[0].status, 'offline', 'the answer was about the record before the rename');
  held = false;
  await registry.check();
  assert.deepEqual([registry.list()[0].status, registry.list()[0].name], ['online', 'Studio']);
});

test('the machines service renames through the registry and is refused while Host is not allowed', (t) => {
  installFakeClock(t, 1_000_000);
  const { dir } = fileOf(t);
  let allowed = false;
  const changes: any[] = [];
  const m = createMachines({
    dir,
    allowed: () => allowed,
    watch: () => undefined,
    call: async () => ready,
    onChange: (s: any) => changes.push(s),
    onStep: () => undefined,
    installer: { install: async () => ({}) },
  });
  t.after(() => m.dispose());
  assert.throws(() => m.rename('h1', 'x'), { code: 'not_allowed' });
  allowed = true;
  assert.throws(() => m.rename('h1', 'x'), { message: 'That machine is not in the registry.' });
});

test('IPC: host:rename passes the id and the name on as text, and a refusal comes back with its code', async () => {
  const handlers = new Map<string, any>();
  const renamed: unknown[][] = [];
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    rename: (id: unknown, name: unknown) => {
      renamed.push([id, name]);
      if (name === '') throw Object.assign(new Error('Give the machine a name of up to 64 characters.'), { code: 'invalid' });
    },
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => svc, allowed: () => true },
  );
  const call = (...a: any[]) => handlers.get('host:rename')({}, ...a);
  assert.deepEqual(await call('h1', 'Studio'), { value: undefined });
  assert.deepEqual(await call(), { error: { message: 'Give the machine a name of up to 64 characters.', code: 'invalid' } });
  assert.deepEqual(renamed, [
    ['h1', 'Studio'],
    ['', ''],
  ]);
});
