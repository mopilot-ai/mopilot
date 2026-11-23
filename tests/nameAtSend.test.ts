// A new chat is named after its first words the moment its first message is sent, on any harness (src/store/nameAtSend.ts,
// #3413): the title its harness writes replaces it later, and a message main didn't take takes it back.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll } from './support/store-harness.ts';
import { waitFor } from './support/waitFor.ts';

const { store: S, resetState } = await loadStore();
const { nameAtSend } = await import('../src/store/nameAtSend.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const nameOf = (id: string) => st().threads[id]?.name ?? null;

beforeEach(() => {
  resetState();
  resetAll();
  set({ newChatTemporary: false, newChatCwd: '/w', newChatProjectId: null, conn: 'ready' });
  impl['codex.startThread'] = async () => ({ thread: { id: 'n1', cwd: '/w' } });
});

test("a new chat's first message names it before main answers", async () => {
  let answer!: (r: unknown) => void;
  impl['proxy.send'] = () => new Promise((r) => (answer = r));
  const sending = S.sendMessage(null, 'fix the login bug\nin auth.ts');
  await waitFor(() => answer, 'the send call');
  assert.equal(nameOf('n1'), 'fix the login bug in auth.ts');
  answer({ id: 'm1', action: 'started' });
  assert.equal(await sending, true);
  assert.equal(nameOf('n1'), 'fix the login bug in auth.ts');
});

test('a first message main did not take takes the name back, unless the chat was renamed meanwhile', async () => {
  impl['proxy.send'] = () => Promise.reject(new Error('offline'));
  assert.equal(await S.sendMessage(null, 'fix the login bug'), false);
  assert.equal(nameOf('n1'), null);
  // a receipt that refuses the message, likewise
  impl['proxy.send'] = async () => ({ action: 'refused', error: 'Not signed in' });
  assert.equal(await S.sendMessage(null, 'fix the login bug'), false);
  assert.equal(nameOf('n1'), null);

  let refuse!: (e: Error) => void;
  impl['proxy.send'] = () => new Promise((_r, reject) => (refuse = reject));
  const sending = S.sendMessage(null, 'fix the login bug');
  await waitFor(() => refuse, 'the send call');
  set((s: any) => ({ threads: { ...s.threads, n1: { ...s.threads.n1, name: 'Mine' } } }));
  refuse(new Error('offline'));
  assert.equal(await sending, false);
  assert.equal(nameOf('n1'), 'Mine');
});

test('a chat that has a name, a temporary chat, an unknown chat and an empty message are left alone', () => {
  set({
    threads: {
      named: { id: 'named', name: 'Kept' } as any,
      temp: { id: 'temp', name: null, ephemeral: true } as any,
      blank: { id: 'blank', name: null } as any,
    },
  });
  for (const [id, text] of [
    ['named', 'hello'],
    ['temp', 'hello'],
    ['missing', 'hello'],
    ['blank', '   '],
  ]) {
    const undo = nameAtSend(id, text);
    undo();
  }
  assert.equal(nameOf('named'), 'Kept');
  assert.equal(nameOf('temp'), null);
  assert.equal(nameOf('blank'), null);
  assert.equal(st().threads.missing, undefined);
  // taking the name back after the chat is gone changes nothing
  set({ threads: { fresh: { id: 'fresh', name: null } as any } });
  const undo = nameAtSend('fresh', 'hi');
  assert.equal(nameOf('fresh'), 'hi');
  set({ threads: {} });
  undo();
  assert.deepEqual(st().threads, {});
});
