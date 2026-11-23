// A turn its person stopped (src/store/stoppedByYou.ts): Stop or Esc in the composer, or main's computer:changed after Esc
// on the desktop, marks the running turn, so it reads "You stopped after Ns".
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, listeners, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { noteOwner } = await import('../src/harness/ownership.ts');
noteOwner('cl', 'claude');

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});

test('a turn its person stopped reads "You stopped": Stop or Esc here, or Esc on the desktop (computer:changed), on any harness', async () => {
  const turn = (id: string) => ({ id, status: 'inProgress', items: [], itemTimes: {} }) as any;
  set({
    runtime: {
      cx: { activeTurnId: 't1', turns: [turn('t1')] } as any,
      'acp:k:1': { activeTurnId: 't2', turns: [turn('t2')] } as any,
      cl: { activeTurnId: 'pending-9', turns: [] } as any,
    },
  });
  const by = (chat: string) => st().runtime[chat].turns.map((t: any) => t.stoppedByYou ?? false);
  await S.interrupt('cx');
  assert.deepEqual(by('cx'), [true]);
  // main says a person's Esc on the desktop stopped it
  listeners['computer.onChanged']({ chatId: 'acp:k:1', stoppedByYou: true });
  assert.deepEqual(by('acp:k:1'), [true]);
  // other changes, no chat, or a turn not named yet: nothing is marked
  listeners['computer.onChanged']({ chatId: null, stoppedByYou: true });
  listeners['computer.onChanged']({ chatId: 'cl' });
  listeners['computer.onChanged']({ chatId: 'cl', stoppedByYou: true });
  listeners['computer.onChanged']({ chatId: 'gone', stoppedByYou: true });
  assert.deepEqual(by('cl'), []);
});

test('the mark outlives a read from history: the same turn under another source prefix keeps it, another turn does not', async () => {
  const { stoppedByYou } = await import('../src/store/stoppedByYou.ts');
  set({
    runtime: {
      cl: {
        activeTurnId: 'ct-e26b202e-7027-4f5f-bfab-8938a21f391a',
        turns: [{ id: 'ct-e26b202e-7027-4f5f-bfab-8938a21f391a', status: 'inProgress', items: [], itemTimes: {} }],
      } as any,
    },
  });
  await S.interrupt('cl');
  assert.equal(stoppedByYou('cl', { id: 'h-e26b202e-7027-4f5f-bfab-8938a21f391a' }), true);
  assert.equal(stoppedByYou('cl', { id: 'h-00000000-7027-4f5f-bfab-8938a21f391a' }), false);
  assert.equal(stoppedByYou('other', { id: 'h-e26b202e-7027-4f5f-bfab-8938a21f391a' }), false);
});
