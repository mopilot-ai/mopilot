// The Outputs section's IPC (electron/momo/outputsIpc.cjs) over a real store: the list with each file's state, Open and Show in Finder only on a plain file in MoMo's folder (a gone file, a symlink or an unknown id is refused), Save a copy through main's dialog (cancel copies nothing, the renderer never gives a path), Delete, the broadcast when the folder changes, nothing while MoMo is not allowed, and removing the handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { OutputsStore } = require('../electron/momo/outputs.cjs');
const { registerOutputsIpc, CHANNELS } = require('../electron/momo/outputsIpc.cjs');

async function world(o: { allowed?: boolean } = {}) {
  const dir = scratch();
  const store = new OutputsStore({ dir, safeStorage: fakeSafe() });
  const handlers = new Map<string, (...a: any[]) => any>();
  const removed: string[] = [];
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn), removeHandler: (c: string) => removed.push(c) };
  const state = {
    allowed: o.allowed ?? true,
    on: true,
    opened: [] as string[],
    revealed: [] as string[],
    broadcast: [] as string[],
    pick: null as string | null,
    openError: '',
  };
  const off = registerOutputsIpc(ipcMain, {
    store,
    allowed: () => state.allowed,
    enabled: () => state.on,
    openPath: async (p: string) => (state.opened.push(p), state.openError),
    reveal: (p: string) => void state.revealed.push(p),
    pickCopy: async () => state.pick,
    broadcast: (c: string) => void state.broadcast.push(c),
  });
  const call = (c: string, ...a: any[]) => handlers.get(c)!({ sender: {} }, ...a);
  return { dir, store, handlers, removed, state, off, call };
}

test('list: each file with its state; open and reveal use the store-checked path', async () => {
  const w = await world();
  const a = await w.store.save({ name: 'a.md', content: 'x', chatId: 'c' });
  await w.store.save({ name: 'b.md', content: 'x', chatId: 'c', fromPrivate: true });
  const listed = await w.call('momoOutputs:list');
  assert.deepEqual(
    listed.files.map((f: any) => [f.name, f.gone, f.fromPrivate]),
    [
      ['b.md', false, true],
      ['a.md', false, false],
    ],
  );
  assert.deepEqual(Object.keys(listed.files[0]).sort(), ['at', 'fromPrivate', 'gone', 'id', 'name', 'note', 'size', 'type']);
  assert.deepEqual(await w.call('momoOutputs:open', a.id), { ok: true });
  assert.deepEqual(await w.call('momoOutputs:reveal', a.id), { ok: true });
  const real = fs.realpathSync(path.join(w.dir, 'outputs', 'a.md'));
  assert.deepEqual([w.state.opened, w.state.revealed], [[real], [real]]);
  w.state.openError = 'no app';
  assert.deepEqual(await w.call('momoOutputs:open', a.id), { ok: false, error: 'Couldn’t open the file: no app' });
});

test('a gone file, a symlink, an unknown id or a non-string id is never opened, revealed or copied', async () => {
  const w = await world();
  const a = await w.store.save({ name: 'a.md', content: 'x', chatId: 'c' });
  const file = path.join(w.dir, 'outputs', 'a.md');
  const outside = path.join(scratch(), 'secret.md');
  fs.writeFileSync(outside, 's');
  fs.rmSync(file);
  fs.symlinkSync(outside, file);
  for (const id of [a.id, 'nope', 5, undefined])
    for (const c of ['open', 'reveal', 'saveCopy'])
      assert.deepEqual(await w.call(`momoOutputs:${c}`, id), { ok: false, error: 'The file is no longer there' }, `${c} ${String(id)}`);
  assert.deepEqual([w.state.opened, w.state.revealed], [[], []]);
});

test('save a copy: the dialog picks the path in main; cancelling copies nothing; an unknown id is not copied', async () => {
  const w = await world();
  const a = await w.store.save({ name: 'a.md', content: 'hello', chatId: 'c' });
  assert.deepEqual(await w.call('momoOutputs:saveCopy', a.id), { ok: true, cancelled: true });
  const to = path.join(scratch(), 'copy.md');
  w.state.pick = to;
  assert.deepEqual(await w.call('momoOutputs:saveCopy', a.id), { ok: true, cancelled: false });
  assert.equal(fs.readFileSync(to, 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(w.dir, 'outputs', 'a.md'), 'utf8'), 'hello', 'the original stays');
});

test('delete removes the file; a change tells the windows; a save from the tool does too', async () => {
  const w = await world();
  const a = await w.store.save({ name: 'a.md', content: 'x', chatId: 'c' });
  assert.deepEqual(w.state.broadcast, ['momoOutputs:changed']);
  assert.deepEqual(await w.call('momoOutputs:remove', a.id), { ok: true, removed: true });
  assert.deepEqual(await w.call('momoOutputs:remove', a.id), { ok: true, removed: false });
  assert.deepEqual(await w.call('momoOutputs:remove', 5), { ok: true, removed: false });
  assert.equal(fs.existsSync(path.join(w.dir, 'outputs', 'a.md')), false);
  assert.deepEqual(w.state.broadcast, ['momoOutputs:changed', 'momoOutputs:changed']);
});

test('while MoMo is not allowed nothing is answered or broadcast; an unreadable index is an error; removing unregisters everything', async () => {
  const w = await world({ allowed: false });
  for (const c of CHANNELS) assert.deepEqual(await w.call(c, 'x'), { ok: false, error: 'MoMo is not available' });
  await w.store.save({ name: 'a.md', content: 'x', chatId: 'c' });
  assert.deepEqual(w.state.broadcast, []);
  w.state.allowed = true;
  fs.writeFileSync(path.join(w.dir, 'outputs.json'), 'garbage');
  const r = await world();
  r.state.allowed = true;
  (r.store as any).list = () => {
    throw new Error('sealed with another key');
  };
  assert.deepEqual(await r.call('momoOutputs:list'), { ok: false, error: 'sealed with another key' });
  w.off();
  assert.deepEqual(w.removed.sort(), [...CHANNELS].sort());
  const before = w.state.broadcast.length;
  await w.store.save({ name: 'b.md', content: 'x', chatId: 'c' }).catch(() => {});
  assert.equal(w.state.broadcast.length, before, 'unsubscribed from the store');
});

test('a channel is declared in the bridge for each handler', () => {
  const bridge = require('../electron/bridge/momoOutputs.cjs');
  assert.deepEqual(Object.keys(bridge).sort(), ['list', 'onChanged', 'open', 'remove', 'reveal', 'saveCopy']);
});

test('with the momo.outputs flag off every call is answered off and nothing is broadcast; the files stay for Reset', async () => {
  const w = await world();
  const a = await w.store.save({ name: 'a.md', content: 'x', chatId: 'c' });
  w.state.broadcast.length = 0;
  w.state.on = false;
  for (const c of CHANNELS) assert.deepEqual(await w.call(c, a.id), { ok: false, error: 'Saving files is turned off' });
  await w.store.save({ name: 'b.md', content: 'x', chatId: 'c' });
  assert.deepEqual(w.state.broadcast, []);
  assert.deepEqual([w.state.opened, w.state.revealed], [[], []]);
  assert.ok(fs.existsSync(path.join(w.dir, 'outputs', 'a.md')), 'nothing was deleted');
});
