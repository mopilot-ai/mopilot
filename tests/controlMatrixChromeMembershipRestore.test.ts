// Worker restore rotates authority and only an extant suspended negotiated wrapper anchors fresh host state.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';
import { waitFor } from './support/waitFor.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { ChromeLink } = require('../electron/capabilities/browser/chromeLink.cjs');

async function setup(t) {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  await w.sessions.saveTail;
  return {
    ...w,
    a,
    b,
    id: a.wc.tabId,
    groupA: w.chrome.tabsById.get(a.wc.tabId).groupId,
    groupB: w.chrome.tabsById.get(b.wc.tabId).groupId,
  };
}

function suspend(w, chat = 'a') {
  const link = w.relay.link(chat);
  link.resumable = true;
  link.close('worker stopped');
}

async function lostLatestSave(w) {
  const saved = w.chrome.store.session.sessions.a.memberships[w.id].id;
  w.chrome.fail['storage.session.set'] = new Error('last receipt snapshot did not reach storage');
  w.move(w.id, w.groupB);
  w.move(w.id, w.groupA);
  await w.sessions.saveTail;
  assert.notEqual(w.sessions.memberships.get(w.id).id, saved);
  assert.equal(w.chrome.store.session.sessions.a.memberships[w.id].id, saved);
  delete w.chrome.fail['storage.session.set'];
  return saved;
}

test('failed latest save followed by restart cannot revive an old offline close', async (t) => {
  const w = await setup(t);
  suspend(w);
  await w.tabs.close('a', w.a.id);
  const saved = await lostLatestSave(w);
  const next = await w.restart();
  await w.relay.connect('a');
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.notEqual(next.memberships.get(w.id)?.id, saved, 'every worker incarnation rotates saved receipts');
  assert.equal(w.chrome.tabsById.has(w.id), true, 'obsolete cleanup cannot delete the physical tab');
  assert.equal(w.chrome.log.filter(([name]) => name === 'tabs.remove').length, 0);
  assert.equal(w.ids('a').includes(w.id), false, 'closed cleanup metadata cannot become a new admission anchor');
});

test('failed latest save cannot authorize stale remove, detach or CDP after worker restore', async (t) => {
  const w = await setup(t);
  suspend(w);
  const saved = await lostLatestSave(w);
  const next = await w.restart();
  await next.open('a', { receipts: true });
  const fresh = next.memberships.get(w.id)!.id;
  assert.notEqual(fresh, saved);
  await next.command('a', 'chrome.debugger.attach', [{ tabId: w.id }, '1.3'], 0, fresh, true);
  const before = w.chrome.log.length;
  for (const [method, params] of [
    ['chrome.debugger.detach', [{ tabId: w.id }]],
    ['chrome.tabs.remove', [w.id]],
    ['chrome.debugger.sendCommand', [{ tabId: w.id }, 'Runtime.evaluate', { expression: '1' }]],
  ] as [string, any[]][])
    await assert.rejects(next.command('a', method, params, 0, saved, true), /membership/);
  assert.equal(w.chrome.log.length, before, 'no stale command reaches a native effect');
  assert.equal(w.chrome.attached.has(w.id), true);
  assert.equal(w.chrome.tabsById.has(w.id), true);
});

test('successful worker restore creates a fresh wrapper while network reconnect preserves it', async (t) => {
  const w = await setup(t);
  const originalReceipt = w.a.wc.membership;
  w.a.mark = 'deliverable';
  w.a.refFrame.set('ref_1', 'source-session');
  w.a.result = true;
  suspend(w);
  await w.relay.connect('a');
  assert.equal(
    w.tabs.list('a').find((tab) => tab.wc.tabId === w.id),
    w.a,
  );
  assert.equal(w.a.wc.membership, originalReceipt, 'network reconnect is not a new worker');
  await w.sessions.saveTail;
  suspend(w);
  const next = await w.restart();
  await w.relay.connect('a');
  const fresh = w.tabs.list('a').find((tab) => tab.wc.tabId === w.id);
  assert.ok(fresh, 'an extant suspended negotiated wrapper anchors conservative rehydration');
  assert.notEqual(fresh, w.a);
  assert.notEqual(fresh.wc.membership, originalReceipt);
  assert.equal(fresh.wc.membership, next.memberships.get(w.id)!.id);
  assert.equal(w.a.wc.isDestroyed(), true);
  assert.equal(fresh.created, false);
  assert.equal(fresh.owner, null);
  assert.notEqual(fresh.id, w.a.id);
  assert.notEqual(fresh.queue, w.a.queue);
  assert.equal(fresh.mark, null);
  assert.equal(fresh.refFrame.size, 0);
  assert.equal(fresh.signin, null);
  assert.equal(fresh.result, false);
  assert.equal(fresh.openedByAgent, false);
  await assert.rejects(w.tabs.resolve('a', w.a.id), { code: 'tab_closed' });
  assert.equal(w.chrome.log.filter(([name]) => name === 'tabs.remove').length, 0);
});

test('same-link receipt churn is not a worker-rehydration admission anchor', async (t) => {
  const w = await setup(t);
  const native = w.chrome.tabsById.get(w.id);
  w.ports
    .get('a')
    .emit('message', JSON.stringify({ method: 'chrome.tabs.onCreated', params: [native, { membership: 'new-without-user-group-proof' }] }));
  assert.equal(w.a.wc.isDestroyed(), true);
  assert.equal(w.ids('a').includes(w.id), false, 'only reconnecting suspended contents qualify');
});

test('legacy suspended contents cannot upgrade themselves into negotiated rehydration authority', async (t) => {
  const w = world({ memberships: false });
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  suspend(w);
  assert.equal(a.wc.membership, null);
  const ws: any = new EventEmitter();
  ws.open = true;
  ws.send = () => {};
  ws.close = () => {
    ws.open = false;
    ws.emit('close');
  };
  const link = new ChromeLink('a', ws, 1000, { memberships: true });
  w.relay.links.set('a', link);
  ws.emit(
    'message',
    JSON.stringify({ method: 'chrome.tabs.onCreated', params: [w.chrome.tabsById.get(a.wc.tabId), { membership: 'new-worker-receipt' }] }),
  );
  w.relay.emit('connected', 'a', link);
  assert.equal(a.wc.isDestroyed(), true);
  assert.deepEqual(w.ids('a'), []);
});

test('rehydration retirement callbacks cannot resurrect the same chat after it closes', async (t) => {
  const w = await setup(t);
  suspend(w);
  await w.restart();
  let closed = false;
  w.tabs.o.onChange = (chat) => {
    if (chat === 'a' && w.a.wc.isDestroyed() && !closed) {
      closed = true;
      w.tabs.forget('a');
    }
  };
  await w.relay.connect('a');
  assert.equal(closed, true);
  assert.equal(w.relay.link('a'), null);
  assert.deepEqual(w.ids('a'), []);
  await Promise.resolve();
  assert.deepEqual(w.ids('a'), [], 'deferred tracking cannot revive the retired wrapper');
});

test('legacy network reconnect keeps its extant wrapper without negotiating new authority', async (t) => {
  const w = world({ memberships: false });
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  suspend(w);
  await w.relay.connect('a');
  assert.equal(a.wc.membership, null);
  assert.equal(a.wc.isDestroyed(), false);
  assert.equal(w.tabs.list('a')[0], a);
});

test('persisted manual proof cannot resurrect a closed-offline tab across repeated replay; a fresh live move can', async (t) => {
  const w = await setup(t);
  const user = w.chrome.addTab();
  w.move(user.id, w.groupA);
  const admitted = w.tabs.list('a').find((tab) => tab.wc.tabId === user.id);
  assert.ok(admitted);
  await w.sessions.saveTail;
  suspend(w);
  await w.tabs.close('a', admitted.id);
  const next = await w.restart();
  await w.relay.connect('a');
  assert.equal(w.ids('a').includes(user.id), false, 'old persisted manual provenance predates the explicit host close');
  await next.open('a', { receipts: true });
  assert.equal(w.ids('a').includes(user.id), false, 'duplicate replay on the same link cannot bypass the close');
  suspend(w);
  await w.relay.connect('a');
  assert.equal(w.ids('a').includes(user.id), false, 'the suppression survives another network reconnect');
  w.move(user.id, -1);
  w.move(user.id, w.groupA);
  const fresh = w.tabs.list('a').find((tab) => tab.wc.tabId === user.id);
  assert.ok(fresh, 'a newly observed live manual transition can re-admit the physical tab');
  assert.notEqual(fresh.id, admitted.id);
  assert.equal(fresh.created, false);
  assert.equal(w.chrome.tabsById.has(user.id), true);
  assert.equal(w.chrome.log.filter(([name]) => name === 'tabs.remove').length, 0);
});

test('offline-close suppression survives missing restored ownership and non-manual receipt changes', async (t) => {
  const w = await setup(t);
  await w.sessions.saveTail;
  suspend(w);
  await w.tabs.close('a', w.a.id);
  w.chrome.store.session.sessions.a.tabs = [];
  const next = await w.restart();
  await w.relay.connect('a');
  assert.deepEqual(w.ids('a'), []);
  assert.equal(next.owner.has(w.id), false);
  w.ports
    .get('a')
    .emit(
      'message',
      JSON.stringify({ method: 'chrome.tabs.onCreated', params: [w.chrome.tabsById.get(w.id), { membership: 'without-manual-proof' }] }),
    );
  assert.deepEqual(w.ids('a'), [], 'ordinary receipt metadata cannot undo an explicit close');
  suspend(w);
  await w.relay.connect('a');
  assert.deepEqual(w.ids('a'), []);
  w.move(w.id, w.groupA);
  assert.equal(w.ids('a').includes(w.id), true, 'a live group gesture can admit when restore had no owner');
  assert.equal(w.chrome.log.filter(([name]) => name === 'tabs.remove').length, 0);
});

test('a close already requested when transport fails cannot become fresh restore admission', async (t) => {
  const w = await setup(t);
  const user = w.chrome.addTab();
  w.move(user.id, w.groupA);
  const admitted = w.tabs.list('a').find((tab) => tab.wc.tabId === user.id);
  await w.sessions.saveTail;
  const ws = w.ports.get('a');
  const send = ws.send;
  let closing = false;
  ws.send = (text) => {
    if (JSON.parse(text).method === 'chrome.tabs.remove') {
      closing = true;
      return;
    }
    send(text);
  };
  const pending = w.tabs.close('a', admitted.id);
  await waitFor(() => closing, 'the host close request');
  assert.equal(closing, true, 'host close was requested before the transport failed');
  suspend(w);
  await w.restart();
  await w.relay.connect('a');
  await pending;
  assert.equal(w.ids('a').includes(user.id), false, 'closing wrappers are not extant admission anchors');
  assert.equal(w.chrome.tabsById.has(user.id), true);
  assert.equal(w.chrome.log.filter(([name]) => name === 'tabs.remove').length, 0);
});
