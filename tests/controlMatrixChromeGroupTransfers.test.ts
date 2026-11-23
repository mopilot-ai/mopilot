// Observed manual Chrome group changes retire exact source membership and admit destination ownership across the shared host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

async function setup(t) {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  return { ...w, a, b, aId: a.wc.tabId, bId: b.wc.tabId, groupB: w.chrome.tabsById.get(b.wc.tabId).groupId };
}

test('one group-change event transfers extension membership from A to B', async (t) => {
  const w = await setup(t);
  w.move(w.aId, w.groupB);
  assert.equal(w.sessions.owner.get(w.aId), 'b');
  assert.equal(w.sessions.chats.get('a')!.tabs.has(w.aId), false);
  assert.equal(w.sessions.chats.get('b')!.tabs.has(w.aId), true);
});

test('one group-change event retires the source host wrapper and source lease', async (t) => {
  const w = await setup(t);
  w.move(w.aId, w.groupB);
  assert.equal(w.relay.link('a').tabs.has(w.aId), false, 'source relay already revokes access');
  assert.equal(w.a.wc.isDestroyed(), true, 'source host must retire its old contents');
  assert.deepEqual(w.ids('a'), []);
  assert.deepEqual(w.tabs.leases('a'), []);
});

test('a second event cannot be required and still fail destination host admission', async (t) => {
  const w = await setup(t);
  w.move(w.aId, w.groupB);
  w.move(w.aId, w.groupB);
  assert.equal(w.sessions.owner.get(w.aId), 'b');
  assert.equal(w.relay.link('b').tabs.has(w.aId), true);
  assert.deepEqual(w.ids('b'), [w.aId, w.bId]);
});

test('an unrelated tab explicitly dragged into B becomes a user-owned host tab without opener lineage', async (t) => {
  const w = await setup(t);
  const tab = w.chrome.addTab();
  w.move(tab.id, w.groupB);
  assert.equal(w.sessions.owner.get(tab.id), 'b');
  assert.equal(w.relay.link('b').tabs.has(tab.id), true);
  assert.deepEqual(w.ids('b'), [w.bId, tab.id]);
  assert.equal(w.tabs.list('b').find((t) => t.wc.tabId === tab.id).openedByAgent, false);
});

for (const action of ['ungroup', 'cancel']) {
  test(`source host relinquishes its tab after ${action}, while Chrome keeps it open`, async (t) => {
    const w = await setup(t);
    if (action === 'ungroup') w.move(w.aId, -1);
    else w.sessions.onDebuggerDetach({ tabId: w.aId }, 'canceled_by_user');
    assert.equal(w.sessions.owner.has(w.aId), false);
    assert.equal(w.relay.link('a').tabs.has(w.aId), false);
    assert.equal(w.chrome.tabsById.has(w.aId), true);
    assert.deepEqual(w.ids('a'), []);
  });
}

test('control: explicit-opener popups are adopted exactly once', async (t) => {
  const w = await setup(t);
  const popup = w.chrome.addTab({ openerTabId: w.bId });
  await w.sessions.onTabCreated(popup);
  await w.sessions.onTabCreated(popup);
  assert.deepEqual(w.ids('b'), [w.bId, popup.id]);
  assert.equal(w.chrome.attached.size, 0, 'adoption must not attach or act');
});

test('control: an unrelated ungrouped tab remains outside both chats', async (t) => {
  const w = await setup(t);
  const tab = w.chrome.addTab();
  await w.sessions.onTabCreated(tab);
  assert.equal(w.sessions.owner.has(tab.id), false);
  assert.deepEqual(w.ids('a'), [w.aId]);
  assert.deepEqual(w.ids('b'), [w.bId]);
});

test('control: origin commands fail closed immediately after transfer', async (t) => {
  const w = await setup(t);
  w.move(w.aId, w.groupB);
  const native = () => w.chrome.log.filter(([name]) => name.startsWith('debugger.'));
  const before = native().length;
  await assert.rejects(w.relay.attach(w.relay.token('a'), w.aId), { code: 'bad_target' });
  assert.equal(native().length, before);
});
