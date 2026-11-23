// Exact extension ownership receipts: native admission evidence, retirement and legacy protocol boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { membershipExtension } from './support/chrome-membership-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

test('every create, replay and popup report carries its own opaque receipt without manual proof', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  assert.equal(typeof a.membership, 'string');
  assert.ok(a.membership.length > 0);
  await w.sessions.open('a', { receipts: true });
  const replay = w.sent.find((m) => m.method === 'chrome.tabs.onCreated');
  assert.deepEqual(replay.params[1], { membership: a.membership });
  const tab = w.chrome.addTab({ openerTabId: a.id });
  await w.sessions.onTabCreated(tab);
  const popup = w.sent.at(-1);
  assert.equal(popup.params[0].id, tab.id);
  assert.equal(typeof popup.params[1].membership, 'string');
  assert.notEqual(popup.params[1].membership, a.membership);
  assert.equal(popup.params[1].ownership, undefined);
});

test('one native move retires A before adopting B and ABA rotates receipts without touching Chrome', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  const before = w.chrome.log.length;
  w.sent.length = 0;
  w.move(a.id, b.groupId);
  assert.deepEqual(
    w.sent.map((m) => [m.chat, m.method]),
    [
      ['a', 'chrome.debugger.onDetach'],
      ['b', 'chrome.tabs.onCreated'],
    ],
  );
  assert.deepEqual(w.sent[0].params[2], { membership: a.membership });
  const owned = w.sent[1].params[1];
  assert.deepEqual(owned.ownership, { kind: 'user_group', groupId: b.groupId });
  assert.notEqual(owned.membership, a.membership);
  w.move(a.id, a.groupId);
  const returned = w.sent.at(-1).params[1].membership;
  assert.notEqual(returned, a.membership);
  assert.notEqual(returned, owned.membership);
  assert.equal(w.sessions.owner.get(a.id), 'a');
  assert.deepEqual(w.chrome.log.slice(before), [], 'no native regrouping, focus, navigation or debugger attach');
  w.move(a.id, a.groupId);
  assert.equal(w.sent.at(-1).params[1].membership, returned, 'same-group duplicate retains exact identity');
});

for (const [method, target] of [
  ['chrome.debugger.attach', (id: number) => [{ tabId: id }, '1.3']],
  ['chrome.debugger.detach', (id: number) => [{ tabId: id }]],
  ['chrome.debugger.sendCommand', (id: number) => [{ tabId: id }, 'Page.navigate', { url: 'https://example.test' }]],
  ['chrome.tabs.remove', (id: number) => [id]],
] as const) {
  test(`${method} requires an exact receipt, including stale-turn releases`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    w.sessions.advance('a', 8);
    for (const receipt of [undefined, null, false, 1, {}, [], '', 'x'.repeat(129), b.membership]) {
      const r = await w.request('a', method, target(a.id), receipt, 8);
      assert.match(r.error.message, /membership/);
    }
    const before = w.chrome.log.length;
    w.move(a.id, b.groupId);
    w.move(a.id, a.groupId);
    assert.match((await w.request('a', method, target(a.id), a.membership, 8)).error.message, /membership/);
    assert.deepEqual(
      w.chrome.log.slice(before).filter((call) => !call[0].startsWith('storage.')),
      [],
    );
    const receipt = w.sessions.memberships.get(a.id)!.id;
    const turn = method === 'chrome.tabs.remove' || method === 'chrome.debugger.detach' ? 0 : 8;
    assert.equal((await w.request('a', method, target(a.id), receipt, turn)).error, undefined);
  });
}

test('detach and removal reports retain the retired receipt; target_closed keeps ownership until removal', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  w.sessions.onDebuggerDetach({ tabId: a.id }, 'target_closed');
  assert.deepEqual(w.sent.at(-1).params, [{ tabId: a.id }, 'target_closed', { membership: a.membership }]);
  assert.equal(w.sessions.owner.get(a.id), 'a');
  w.sessions.onTabRemoved(a.id);
  assert.deepEqual(w.sent.at(-1).params, [a.id, { membership: a.membership }]);
  const b = await w.create();
  w.sessions.onDebuggerDetach({ tabId: b.id }, 'canceled_by_user');
  assert.deepEqual(w.sent.at(-1).params[2], { membership: b.membership });
  assert.equal(w.sessions.memberships.has(b.id), false);
});

test('legacy peer keeps old payloads and command behavior without manufacturing manual proof metadata', async () => {
  const w = await membershipExtension({ receipts: false });
  const a = await w.create();
  const b = await w.create('b');
  assert.equal(a.membership, undefined);
  w.move(a.id, b.groupId);
  assert.equal(w.sent.at(-2).params.length, 2);
  assert.equal(w.sent.at(-1).params.length, 1);
  assert.equal((await w.request('b', 'chrome.debugger.attach', [{ tabId: a.id }])).error, undefined);
  assert.equal((await w.request('b', 'chrome.debugger.detach', [{ tabId: a.id }])).error, undefined);
  w.sessions.onTabRemoved(a.id);
  assert.equal(w.sent.at(-1).params.length, 1);
});

test('native manual admission rejects invalid/mismatched evidence before source retirement', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  const cases = [
    [a.id, null, { id: a.id, groupId: b.groupId }],
    ...[{}, [], 1, 'groupId'].map((change) => [a.id, change, { id: a.id, groupId: b.groupId }]),
    ...[null, '2', 1.5, -2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((groupId) => [a.id, { groupId }, { id: a.id, groupId }]),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => [id, { groupId: b.groupId }, { id, groupId: b.groupId }]),
    [a.id, { groupId: b.groupId }, { id: a.id }],
    [a.id, { groupId: b.groupId }, { id: a.id, groupId: a.groupId }],
    [a.id, { groupId: b.groupId }, { id: a.id + 1, groupId: b.groupId }],
  ];
  const before = w.sent.length;
  for (const [id, change, tab] of cases) w.sessions.onTabUpdated(id, change, tab);
  assert.equal(w.sent.length, before);
  assert.equal(w.sessions.memberships.get(a.id)!.id, a.membership);
  const tab = w.chrome.addTab();
  w.sessions.onTabUpdated(tab.id, { groupId: 999 }, { id: tab.id, groupId: 999 });
  assert.equal(w.sessions.owner.has(tab.id), false);
  w.sessions.onTabUpdated(tab.id, { groupId: b.groupId }, { id: tab.id, groupId: b.groupId });
  assert.equal(w.sent.at(-1).params[1].ownership.kind, 'user_group', 'optional title, URL and opener are unnecessary');
  w.move(a.id, -1);
  assert.equal(w.sessions.owner.has(a.id), false);
});

for (const fails of [false, true]) {
  test(`native remove completion ${fails ? 'rejects' : 'succeeds'} after ABA without erasing returned membership`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    const wait = deferred<void>();
    w.chrome.tabs.remove = () => wait.promise;
    const removing = w.request('a', 'chrome.tabs.remove', [a.id], a.membership);
    w.move(a.id, b.groupId);
    w.move(a.id, a.groupId);
    const returned = w.sessions.memberships.get(a.id);
    if (fails) wait.reject(new Error('remove failed'));
    else wait.resolve();
    const result = await removing;
    assert.equal(Boolean(result.error), fails);
    assert.equal(w.sessions.memberships.get(a.id), returned);
    assert.equal(w.sessions.owner.get(a.id), 'a');
  });
}

test('late native create result cannot replace a same-Session membership already observed in Chrome', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  const tab = w.chrome.addTab();
  const wait = deferred<any>();
  const entered = deferred<void>();
  w.chrome.tabs.create = () => {
    entered.resolve();
    return wait.promise;
  };
  const creating = w.request('a', 'chrome.tabs.create', [{}]);
  await entered.promise;
  w.move(tab.id, a.groupId);
  w.move(tab.id, b.groupId);
  w.move(tab.id, a.groupId);
  const returned = w.sessions.memberships.get(tab.id);
  wait.resolve(tab);
  assert.match((await creating).error.message, /no longer belongs/);
  assert.equal(w.sessions.memberships.get(tab.id), returned);
});

test('reentrant source retirement cannot overwrite a newer native observation', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  const send = w.sessions.send;
  let nested = false;
  w.sessions.send = (m: any) => {
    send(m);
    if (!nested && m.method === 'chrome.debugger.onDetach') {
      nested = true;
      w.move(a.id, a.groupId);
    }
  };
  w.move(a.id, b.groupId);
  assert.equal(w.sessions.owner.get(a.id), 'a');
  assert.equal(w.sent.at(-1).chat, 'a');
});

test('creation result retired before the handle continuation is an error, never an old receipt reply', async () => {
  const w = await membershipExtension();
  const b = await w.create('b');
  const command = w.sessions.command.bind(w.sessions);
  w.sessions.command = (...args: Parameters<typeof command>) => {
    const pending = command(...args);
    void pending.then((tab: any) => w.move(tab.id, b.groupId));
    return pending;
  };
  const reply = await w.request('a', 'chrome.tabs.create', [{}]);
  assert.match(reply.error.message, /retired before its creation could be reported/);
  assert.equal(reply.result, undefined);
  assert.equal(
    [...w.sessions.owner.values()].every((owner) => owner === 'b'),
    true,
  );
});

for (const fails of [false, true]) {
  test(`create grouping metadata ${fails ? 'failure' : 'success'} after ABA cannot replace the returning receipt`, async () => {
    const w = await membershipExtension();
    const b = await w.create('b');
    const wait = deferred<void>();
    const entered = deferred<void>();
    w.chrome.tabGroups.update = async () => {
      entered.resolve();
      await wait.promise;
    };
    const creating = w.request('a', 'chrome.tabs.create', [{}]);
    await entered.promise;
    const id = [...w.sessions.chats.get('a')!.tabs][0];
    const group = w.sessions.chats.get('a')!.groupId!;
    w.move(id, b.groupId);
    w.move(id, group);
    const returned = w.sessions.memberships.get(id);
    if (fails) wait.reject(new Error('metadata unavailable'));
    else wait.resolve();
    assert.match((await creating).error.message, /no longer belongs/);
    assert.equal(w.sessions.memberships.get(id), returned);
    assert.equal(w.sessions.owner.get(id), 'a');
  });

  test(`pending native attachment ${fails ? 'failure' : 'success'} after ABA cannot become the new membership attachment`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    const wait = deferred<void>();
    const entered = deferred<void>();
    const attach = w.chrome.debugger.attach;
    let calls = 0;
    w.chrome.debugger.attach = async (target: any, version: string) => {
      if (++calls === 1) {
        entered.resolve();
        await wait.promise;
      }
      await attach(target, version);
    };
    const stale = w.request('a', 'chrome.debugger.attach', [{ tabId: a.id }], a.membership);
    await entered.promise;
    w.move(a.id, b.groupId);
    w.move(a.id, a.groupId);
    const returned = w.sessions.memberships.get(a.id)!.id;
    const current = w.request('a', 'chrome.debugger.attach', [{ tabId: a.id }], returned);
    if (fails) wait.reject(new Error('old attachment failed'));
    else wait.resolve();
    assert.ok((await stale).error);
    assert.equal((await current).error, undefined);
    assert.ok(w.chrome.attached.has(a.id));
    assert.equal(w.sessions.memberships.get(a.id)!.id, returned);
  });
}
