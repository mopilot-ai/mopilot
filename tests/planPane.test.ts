// Plan tab routing keeps chat ownership across harness switches, side chats and stale card clicks.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const { openPlanPane } = await import('../src/store/plans/pane.ts');
const st = () => store.useStore.getState();
beforeEach(() => {
  resetState();
  resetAll();
  store.useStore.setState({ route: { name: 'thread', id: 'a' }, paneTabs: [], paneActive: '', diffPanel: { open: false }, paneFull: true });
});

test('a chat reuses its tab for historical and current plans, keeping the conversation visible', () => {
  openPlanPane('a', { turnId: 't1', itemId: 'p1' });
  const id = st().paneActive;
  assert.deepEqual(
    [st().paneTabs[0].ownerChat, st().paneTabs[0].plan?.itemId, st().diffPanel.open, st().paneFull],
    ['a', 'p1', true, false],
  );
  openPlanPane('a', { turnId: 't2', itemId: 'p2', source: 'reply' });
  openPlanPane('a');
  assert.deepEqual([st().paneTabs.length, st().paneActive, st().paneTabs[0].plan?.itemId], [1, id, undefined]);
});

test('an offscreen chat retains its tab without opening or selecting it in another chat', () => {
  openPlanPane('a', { turnId: 't', itemId: 'p' });
  const active = st().paneActive;
  store.useStore.setState({ diffPanel: { open: false } });
  openPlanPane('b', { turnId: 't', itemId: 'other' });
  openPlanPane('b', { turnId: 't2', itemId: 'updated' });
  assert.equal(st().paneTabs.length, 2);
  assert.equal(st().paneTabs.at(-1)?.plan?.itemId, 'updated');
  assert.equal(st().paneActive, active);
  assert.equal(st().diffPanel.open, false);
});

test('a side chat can open its plan while retaining that side chat', () => {
  store.useStore.setState({ paneTabs: [{ id: 'side', kind: 'chat', threadId: 'b' }] });
  openPlanPane('b', { turnId: 't', itemId: 'p' });
  assert.equal(st().paneTabs[0].id, 'side');
  assert.equal(st().paneTabs.at(-1)?.threadId, 'b');
  assert.equal(st().paneActive, st().paneTabs.at(-1)?.id);
});
