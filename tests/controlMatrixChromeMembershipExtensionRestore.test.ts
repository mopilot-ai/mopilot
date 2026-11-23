// Membership replay and persistence preserve exact ownership across worker restarts and asynchronous reads/writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { membershipExtension } from './support/chrome-membership-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

function replacement(w: Awaited<ReturnType<typeof membershipExtension>>) {
  const reports: any[] = [];
  const sessions = new Sessions({
    chrome: w.chrome,
    storage: w.chrome.storage.session,
    send: (m: any) => reports.push(m),
    log: (...args: any[]) => w.errors.push(args),
  });
  return { sessions, reports };
}

test('network reconnect preserves receipts; worker restore rotates authority and revalidates manual provenance', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  w.move(a.id, b.groupId);
  const receipt = w.sessions.memberships.get(a.id)!.id;
  await w.sessions.peerGone();
  await w.sessions.open('b', { receipts: true });
  assert.equal(w.sent.findLast((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === a.id).params[1].membership, receipt);
  await w.sessions.saveTail;
  const next = replacement(w);
  await next.sessions.restore();
  await next.sessions.open('b', { receipts: true });
  const report = next.reports.find((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === a.id);
  assert.notEqual(report.params[1].membership, receipt, 'a restored receipt never revives old command authority');
  assert.deepEqual(report.params[1].ownership, { kind: 'user_group', groupId: b.groupId });
  assert.notEqual(next.sessions.memberships.get(b.id)!.id, b.membership, 'ordinary created memberships rotate too');
  const restored = next.sessions.memberships.get(a.id)!.id;
  await next.sessions.open('b', { receipts: true });
  assert.equal(next.sessions.memberships.get(a.id)!.id, restored, 'ordinary reconnect in the new worker stays stable');
});

for (const fails of [false, true]) {
  test(`replay read ${fails ? 'rejecting' : 'succeeding'} after ABA cannot publish or drop the returning membership`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    const wait = deferred<any>();
    w.chrome.tabs.get = () => wait.promise;
    const replay = w.sessions.open('a', { receipts: true });
    w.move(a.id, b.groupId);
    w.move(a.id, a.groupId);
    const returned = w.sessions.memberships.get(a.id);
    w.sent.length = 0;
    if (fails) wait.reject(new Error('old tab unavailable'));
    else wait.resolve(a);
    await replay;
    assert.equal(w.sessions.memberships.get(a.id), returned);
    assert.deepEqual(
      w.sent.map((m) => m.method),
      ['extension.initialized'],
    );
  });
}

for (const invalid of ['tab id', 'native group', 'session group', 'missing tab', 'closed session']) {
  test(`manual replay fails closed for ${invalid}`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    w.move(a.id, b.groupId);
    const original = w.chrome.tabs.get;
    w.chrome.tabs.get = async (id: number) => {
      if (id !== a.id) return original(id);
      if (invalid === 'missing tab') throw new Error('gone');
      if (invalid === 'closed session') {
        await w.sessions.close('b');
        return { ...a, groupId: b.groupId };
      }
      return { ...a, id: invalid === 'tab id' ? 9999 : a.id, groupId: invalid === 'native group' ? -1 : b.groupId };
    };
    if (invalid === 'session group') w.sessions.chats.get('b')!.groupId = 999;
    w.sent.length = 0;
    await w.sessions.open('b', { receipts: true });
    assert.equal(
      w.sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === a.id),
      false,
    );
    assert.equal(w.sessions.owner.has(a.id), false);
  });
}

test('corrupt and legacy saved records never fabricate manual proof or preserve invalid receipt IDs', async () => {
  for (const saved of [
    undefined,
    null,
    [],
    { id: '', manual: true, groupId: 1 },
    { id: false, manual: true, groupId: 1 },
    { id: 'x'.repeat(129), manual: true, groupId: 1 },
    { id: 'valid', manual: true, groupId: -1 },
    { id: 'valid', manual: true, groupId: -2 },
    { id: 'valid', manual: true, groupId: 1.5 },
    { id: 'valid', manual: true, groupId: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'valid', manual: true, groupId: 999 },
    { id: 'valid', manual: 'true', groupId: 1 },
  ]) {
    const w = await membershipExtension();
    const a = await w.create();
    await w.sessions.saveTail;
    w.chrome.store.session.sessions.a.memberships = { [a.id]: saved };
    if (saved && typeof saved === 'object' && 'groupId' in saved && Number.isSafeInteger(saved.groupId) && Number(saved.groupId) >= -1)
      w.chrome.tabsById.get(a.id).groupId = saved.groupId;
    const next = replacement(w);
    await next.sessions.restore();
    await next.sessions.open('a', { receipts: true });
    const report = next.reports.find((m) => m.method === 'chrome.tabs.onCreated');
    assert.ok(report);
    assert.equal(report.params[1].ownership, undefined);
    assert.equal(typeof report.params[1].membership, 'string');
    assert.ok(report.params[1].membership.length > 0 && report.params[1].membership.length <= 128);
  }
});

for (const fails of [false, true]) {
  test(`serialized saves cannot complete ABA in reverse order${fails ? ', even when the first save rejects' : ''}`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    await w.sessions.saveTail;
    const first = deferred<void>();
    const entered = deferred<void>();
    const snapshots: any[] = [];
    const save = w.chrome.storage.session.set;
    w.chrome.storage.session.set = async (value: any) => {
      snapshots.push(value);
      if (snapshots.length === 1) {
        entered.resolve();
        await first.promise;
      }
      await save(value);
    };
    w.move(a.id, b.groupId);
    w.move(a.id, a.groupId);
    const finalReceipt = w.sessions.memberships.get(a.id)!.id;
    await entered.promise;
    assert.equal(snapshots.length, 1, 'successors cannot start while an older whole-key write is pending');
    if (fails) first.reject(new Error('storage temporarily unavailable'));
    else first.resolve();
    await w.sessions.saveTail;
    assert.equal(snapshots.length, 4, 'both retirements and admissions are durable in observation order');
    assert.equal(w.chrome.store.session.sessions.a.memberships[a.id].id, finalReceipt);
    assert.equal(w.chrome.store.session.sessions.b.memberships[a.id], undefined);
    assert.equal(
      w.errors.some(([what]) => what === 'save the sessions'),
      fails,
    );
    const next = replacement(w);
    await next.sessions.restore();
    assert.notEqual(next.sessions.memberships.get(a.id)!.id, finalReceipt);
    assert.notEqual(finalReceipt, a.membership);
  });
}

test('independent moves combine in the final storage snapshot, and unreadable storage is reported', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const a2 = await w.create();
  const b = await w.create('b');
  w.move(a.id, b.groupId);
  w.move(a2.id, b.groupId);
  await w.sessions.saveTail;
  assert.equal(w.chrome.store.session.sessions.b.tabs.length, 3);
  w.chrome.fail['storage.session.get'] = new Error('unreadable');
  const next = replacement(w);
  await next.sessions.restore();
  assert.equal(next.sessions.chats.size, 0);
  assert.equal(w.errors.at(-1)[0], 'read the saved sessions');
});

test('corrupt duplicate saved native IDs have one owner and invalid saved IDs never enter inventory', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  await w.sessions.saveTail;
  const source = w.chrome.store.session.sessions.a;
  w.chrome.store.session.sessions = {
    a: { ...source, tabs: [a.id, -1, 1.5, '500', Number.MAX_SAFE_INTEGER + 1] },
    b: { ...source, title: 'B', tabs: [a.id], memberships: { [a.id]: { id: 'wrong-owner', manual: true, groupId: a.groupId } } },
  };
  const next = replacement(w);
  await next.sessions.restore();
  assert.deepEqual([...next.sessions.owner], [[a.id, 'a']]);
  assert.deepEqual([...next.sessions.chats.get('b')!.tabs], []);
  assert.notEqual(next.sessions.memberships.get(a.id)!.id, a.membership);
});

test('failed newest retirement saves cannot revive old A commands after worker restart', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  w.move(a.id, b.groupId);
  w.move(a.id, a.groupId);
  await w.sessions.saveTail;
  const savedReceipt = w.sessions.memberships.get(a.id)!.id;
  assert.equal(w.chrome.store.session.sessions.a.memberships[a.id].id, savedReceipt);
  w.chrome.fail['storage.session.set'] = new Error('the newest snapshots never became durable');
  w.move(a.id, b.groupId);
  w.move(a.id, a.groupId);
  const liveReceipt = w.sessions.memberships.get(a.id)!.id;
  await w.sessions.saveTail;
  assert.notEqual(liveReceipt, savedReceipt);
  assert.equal(w.chrome.store.session.sessions.a.memberships[a.id].id, savedReceipt, 'storage still contains the retired A membership');
  const next = replacement(w);
  await next.sessions.restore();
  await next.sessions.open('a', { receipts: true });
  const fresh = next.sessions.memberships.get(a.id)!.id;
  assert.notEqual(fresh, savedReceipt);
  assert.notEqual(fresh, liveReceipt);
  const report = next.reports.find((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === a.id);
  assert.deepEqual(report.params[1], { membership: fresh, ownership: { kind: 'user_group', groupId: a.groupId } });
  const before = w.chrome.log.length;
  for (const membership of [savedReceipt, liveReceipt]) {
    for (const [method, params] of [
      ['chrome.debugger.attach', [{ tabId: a.id }]],
      ['chrome.debugger.detach', [{ tabId: a.id }]],
      ['chrome.debugger.sendCommand', [{ tabId: a.id }, 'Page.navigate', {}]],
      ['chrome.tabs.remove', [a.id]],
    ] as const) {
      let reply: any;
      await next.sessions.handle(
        { chat: 'a', id: 1, method, params: [...params], membership },
        (m: any) => {
          reply = m;
        },
        true,
      );
      assert.match(reply.error.message, /membership/);
    }
  }
  assert.deepEqual(
    w.chrome.log.slice(before).filter((call) => !call[0].startsWith('storage.')),
    [],
  );
  assert.ok(w.chrome.tabsById.has(a.id));
  assert.equal(next.sessions.owner.get(a.id), 'a');
});

test('legacy and corrupt saved membership groups fall back to the canonical group before replay', async () => {
  for (const saved of [
    undefined,
    { id: '', groupId: null },
    { id: 'old', groupId: '1' },
    { id: 'old', groupId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    await w.sessions.saveTail;
    w.chrome.store.session.sessions.a.memberships = { [a.id]: saved };
    w.chrome.tabsById.get(a.id).groupId = b.groupId;
    const next = replacement(w);
    await next.sessions.restore();
    await next.sessions.open('a', { receipts: true });
    assert.equal(next.sessions.owner.has(a.id), false);
    assert.equal(
      next.reports.some((m) => m.method === 'chrome.tabs.onCreated'),
      false,
    );
  }
});

test('restored legacy records without any known group replay only if the native tab remains ungrouped', async () => {
  for (const groupId of [-1, 999]) {
    const w = await membershipExtension();
    const a = await w.create();
    await w.sessions.saveTail;
    w.chrome.store.session.sessions.a.groupId = null;
    delete w.chrome.store.session.sessions.a.memberships;
    w.chrome.tabsById.get(a.id).groupId = groupId;
    const next = replacement(w);
    await next.sessions.restore();
    await next.sessions.open('a', { receipts: true });
    assert.equal(next.sessions.owner.has(a.id), groupId === -1);
    assert.equal(
      next.reports.some((m) => m.method === 'chrome.tabs.onCreated'),
      groupId === -1,
    );
  }
});
