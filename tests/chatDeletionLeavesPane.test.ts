// A deleted chat leaves the main pane the way an archived one does (src/store/deletionReceipts.ts): whichever window deleted it, whichever machine it ran on, the pane that showed it goes home and a split pane closes; a chat that is not on screen moves nothing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, flush, deleteReceipt } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const S = store;
const { acceptChatDeletion } = await import('../src/store/deletionReceipts.ts');
const { applySplitOp } = await import('../src/store/splitView.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const MACHINE = 'acp:host-claude:3f0a3b1c-0000-4000-8000-000000000001';
const LOCAL = 'acp:kimi:3f0a3b1c-0000-4000-8000-000000000002';
// a deletion is remembered for the life of the process: each test deletes chats of its own
const SPLIT = 'acp:host-codex:3f0a3b1c-0000-4000-8000-000000000003';
const AWAY = 'acp:host-claude:3f0a3b1c-0000-4000-8000-000000000004';
const ids = [MACHINE, LOCAL, SPLIT, AWAY, 'other'];

beforeEach(() => {
  resetState();
  resetAll();
  set({
    threads: Object.fromEntries(ids.map((id) => [id, { id, cwd: `/w/${id}` } as any])),
    threadOrder: ids,
    runtime: Object.fromEntries(ids.map((id) => [id, { loaded: true, turns: [], error: 'The machine closed the connection.' } as any])),
  });
});

for (const id of [MACHINE, LOCAL])
  test(`${id.split(':')[1]}: deleting the open chat takes the pane home, and its transcript and error card with it`, async () => {
    set({ route: { name: 'thread', id } });
    await S.deleteThread(id);
    await flush();
    assert.deepEqual(st().route, { name: 'home' });
    assert.equal(st().threadOrder.includes(id), false);
    assert.equal(st().threadOrder.includes('other'), true);
  });

test('a deletion another window made (its receipt) takes this window home from the chat, and closes a split pane that showed it', () => {
  set({ route: { name: 'thread', id: 'other' } });
  applySplitOp({ op: 'open', chatId: SPLIT });
  assert.deepEqual(
    st().split.panes.map((p) => p.chatId),
    [SPLIT],
  );
  acceptChatDeletion(deleteReceipt(SPLIT));
  assert.deepEqual(
    st().split.panes.map((p) => p.chatId),
    [],
  );
  assert.deepEqual(st().route, { name: 'thread', id: 'other' });
  acceptChatDeletion(deleteReceipt('other', ['other']));
  assert.deepEqual(st().route, { name: 'home' });
});

test('Back and Forward pass over a deleted chat; with nothing but deleted chats behind, Back goes Home and Forward stays', async () => {
  const GONE = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000f1';
  const GONE2 = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000f2';
  const page = (id: string) => ({ name: 'thread' as const, id });
  acceptChatDeletion(deleteReceipt(GONE));
  acceptChatDeletion(deleteReceipt(GONE2));
  set({ route: page('now'), back: [page('kept'), page(GONE), page(GONE2)], forward: [page(GONE), page('ahead'), page(GONE2)] });
  S.goBack();
  assert.deepEqual([st().route, st().back, st().forward.map((r: any) => r.id)], [page('kept'), [], ['now', GONE, 'ahead', GONE2]]);
  S.goForward();
  assert.deepEqual([st().route, st().back, st().forward.map((r: any) => r.id)], [page('now'), [page('kept')], [GONE, 'ahead', GONE2]]);
  S.goForward();
  assert.deepEqual([st().route, st().back.length, st().forward.map((r: any) => r.id)], [page('ahead'), 2, [GONE2]]);
  // all that lies ahead is deleted: it is dropped and the view stays
  S.goForward();
  assert.deepEqual([st().route, st().forward], [page('ahead'), []]);
  S.goForward();
  assert.deepEqual(st().route, page('ahead'));
  // nothing but deleted chats behind: Home, with no history left
  set({ route: page('now'), back: [page(GONE), page(GONE2)], forward: [] });
  S.goBack();
  assert.deepEqual([st().route, st().back], [{ name: 'home' }, []]);
  // no history at all: nothing moves
  S.goBack();
  assert.deepEqual(st().route, { name: 'home' });
});

test('a chat that is not on screen leaves the route alone', async () => {
  set({ route: { name: 'thread', id: 'other' } });
  await S.deleteThread(AWAY);
  await flush();
  assert.deepEqual(st().route, { name: 'thread', id: 'other' });
});
