// The renderer's follow of every machine's chats (src/lib/hostChatIndex.ts): nothing is read before Host access is on, one read serves every consumer, pushes replace the index, a malformed answer is ignored, and the follow ends with its last consumer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const { parseChatIndex, useHostChatIndex } = await import('../src/lib/hostChatIndex.ts');

const row = (n: number, o: object = {}) => ({
  chatId: `claude:c${n}`,
  title: `chat ${n}`,
  harness: 'claude',
  createdAt: n,
  updatedAt: n,
  epoch: 1,
  rev: 1,
  state: 'idle',
  ...o,
});
const entry = (machineId: string, state = 'ready', rows: unknown[] = [row(1)], truncated = false) => ({
  machineId,
  state,
  truncated,
  rows,
});

const seen: { indexes: ReadonlyMap<string, any>; answered: boolean }[] = [];
function Probe() {
  seen.push(useHostChatIndex());
  return null;
}
async function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(createElement(Probe)));
  return () => act(async () => root.unmount());
}

test('an answer is an index only when every entry names its machine and state and holds its rows; a row without its fields is left out', () => {
  assert.equal(parseChatIndex(null), null);
  assert.equal(parseChatIndex({}), null);
  assert.equal(parseChatIndex([null]), null);
  assert.equal(parseChatIndex([{ machineId: '', state: 'ready', rows: [] }]), null);
  assert.equal(parseChatIndex([{ machineId: 'a', state: 'weird', rows: [] }]), null);
  assert.equal(parseChatIndex([{ machineId: 'a', state: 'ready', rows: 'x' }]), null);
  assert.deepEqual(parseChatIndex([]), []);
  const parsed = parseChatIndex([
    entry('a', 'partial', [
      row(1),
      null,
      row(2, { chatId: '' }),
      row(3, { title: 7 }),
      row(4, { updatedAt: Number.NaN }),
      row(5, { state: 'sleeping' }),
      row(6, { state: 'running' }),
    ]),
    { ...entry('b', 'loading', []), truncated: 'yes' },
  ])!;
  assert.deepEqual(
    parsed[0].rows.map((r) => r.chatId),
    ['claude:c1', 'claude:c6'],
  );
  assert.equal(parsed[0].truncated, false);
  assert.equal(parsed[1].truncated, false, 'truncated is true only as true');
  assert.equal(parseChatIndex([entry('c', 'ready', [], true)])![0].truncated, true);
});

test('the index is read once for every consumer, pushes replace it, a malformed push does not, and losing access drops it', async () => {
  const fake = fakeNative({ host: { access: async () => true }, hostChats: { list: async () => [entry('a')] } });
  installNative(fake);
  const a = await mount();
  assert.equal(seen.at(-1)!.answered, true);
  assert.deepEqual([...seen.at(-1)!.indexes.keys()], ['a']);
  const b = await mount();
  assert.equal(fake.callsTo('hostChats.list').length, 1, 'a second consumer does not start a second read');
  await act(async () => fake.emit('hostChats.onChanged', [entry('a', 'stale'), entry('b', 'loading', [])]));
  assert.deepEqual(
    [...seen.at(-1)!.indexes].map(([id, e]) => [id, e.state]),
    [
      ['a', 'stale'],
      ['b', 'loading'],
    ],
  );
  // the same index again (main sends the whole one on every change) draws nothing again and keeps the very entries
  const before = seen.length;
  const held = seen.at(-1)!.indexes;
  await act(async () => fake.emit('hostChats.onChanged', [entry('a', 'stale'), entry('b', 'loading', [])]));
  assert.equal(seen.length, before, 'nothing rendered');
  assert.equal(seen.at(-1)!.indexes, held);
  // a change to one row of one machine is drawn, and the other machine keeps its entry
  await act(async () =>
    fake.emit('hostChats.onChanged', [entry('a', 'stale', [row(1, { rev: 2, state: 'running' })]), entry('b', 'loading', [])]),
  );
  assert.equal(seen.at(-1)!.indexes.get('a')!.rows[0].state, 'running');
  assert.equal(seen.at(-1)!.indexes.get('b'), held.get('b'));
  await act(async () => fake.emit('hostChats.onChanged', [entry('a', 'stale'), entry('b', 'loading', [])]));
  await act(async () => fake.emit('hostChats.onChanged', 'nope'));
  assert.equal(seen.at(-1)!.indexes.size, 2, 'a malformed push changes nothing');
  await act(async () => fake.emit('host.onAccess', false));
  assert.deepEqual([seen.at(-1)!.indexes.size, seen.at(-1)!.answered], [0, false], 'no access: nothing is held');
  // access returns: it follows again from a fresh read
  await act(async () => fake.emit('host.onAccess', true));
  assert.equal(fake.callsTo('hostChats.list').length, 2);
  assert.deepEqual([...seen.at(-1)!.indexes.keys()], ['a']);
  await a();
  await b();
});

test('a read that fails or returns something else leaves the index unanswered, and the last consumer leaving ends the follow', async () => {
  const fake = fakeNative({ host: { access: async () => true }, hostChats: { list: async () => 'nope' } });
  installNative(fake);
  const off = await mount();
  assert.deepEqual([seen.at(-1)!.indexes.size, seen.at(-1)!.answered], [0, false]);
  const failing = fakeNative({
    host: { access: async () => true },
    hostChats: {
      list: async () => {
        throw new Error('no connection');
      },
    },
  });
  installNative(failing);
  await off();
  const again = await mount();
  assert.deepEqual([seen.at(-1)!.indexes.size, seen.at(-1)!.answered], [0, false]);
  await again();
  await act(async () => failing.emit('hostChats.onChanged', [entry('late')]));
  assert.equal(seen.at(-1)!.indexes.size, 0, 'a follow that ended hears nothing');
});

test('each read of the list tells main which chats this window has open, as the window says them now', async () => {
  const fake = fakeNative({ host: { access: async () => true }, hostChats: { list: async () => [entry('a')] } });
  installNative(fake);
  let open = ['acp:host-claude:one'];
  function Open() {
    useHostChatIndex(() => open);
    return null;
  }
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(createElement(Open)));
  assert.deepEqual(fake.callsTo('hostChats.list').at(-1), [['acp:host-claude:one']]);
  await act(async () => root.unmount());
  open = [];
  await act(async () => fake.emit('host.onAccess', false));
  await act(async () => fake.emit('host.onAccess', true));
});
