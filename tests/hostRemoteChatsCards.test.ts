// Permission cards of a chat on a machine (electron/host/remoteChats.cjs): told to the approval guard, answered through the Host once, and kept when the answer cannot be given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, FakeItems, end, ev, fakeHost, start, tick, world } from './support/host/remoteChatsKit.ts';

test('a permission card waiting for the user is answered through the Host once; the Host closing it afterwards changes nothing here', async () => {
  const host = fakeHost();
  const answers: any[] = [];
  const w = world(host);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  host.answer = async (p: any) => (answers.push(p), { answered: true });
  host.fire.patch(CHAT, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(CHAT);
  assert.equal(await w.chats.answer(`${CHAT}|p1`, 'allow'), true);
  assert.deepEqual(answers, [{ chatId: CHAT, requestId: 'p1', optionId: 'allow' }]);
  // the card is gone for a second answer, and the Host's record that closes it reaches the window
  assert.equal(w.chats.answer(`${CHAT}|p1`, 'allow'), null);
  host.fire.patch(CHAT, 2, ev({ kind: 'permissionCancelled', requestId: 'p1' }));
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.map((e) => e.kind),
    ['permission', 'permissionCancelled'],
  );
  // a card that goes away unanswered cannot be answered any more
  host.fire.patch(CHAT, 3, ev({ kind: 'permission', requestId: 'p2', turnId: 't1' }));
  host.fire.patch(CHAT, 4, ev({ kind: 'permissionCancelled', requestId: 'p2' }));
  await w.chats.settled(CHAT);
  assert.equal(w.chats.answer(`${CHAT}|p2`, null), null);
  assert.equal(w.chats.answer('unknown', null), null);
});

test('an answer the Host cannot take leaves the card to answer again; a dismissed card sends no option; a card the Host no longer has says so', async () => {
  const host = fakeHost();
  const w = world(host);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  host.fire.patch(CHAT, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(CHAT);
  const asked: any[] = [];
  let reply: any = Promise.reject(Object.assign(new Error('away'), { code: 'host_unreachable' }));
  host.answer = (p: any) => (asked.push(p), reply);
  await assert.rejects(w.chats.answer(`${CHAT}|p1`, 'allow')!, /away/);
  // still there to answer, and told nothing of a timeout
  reply = Promise.resolve({ answered: false });
  assert.equal(await w.chats.answer(`${CHAT}|p1`, null), false);
  assert.deepEqual(asked, [
    { chatId: CHAT, requestId: 'p1', optionId: 'allow' },
    { chatId: CHAT, requestId: 'p1' },
  ]);
  assert.equal(w.chats.answer(`${CHAT}|p1`, null), null);
  // a card of a chat no longer followed is not answered here
  host.fire.patch(CHAT, 2, ev({ kind: 'permission', requestId: 'p3', turnId: 't1' }));
  await w.chats.settled(CHAT);
  w.chats.unfollow(CHAT);
  assert.equal(w.chats.answer(`${CHAT}|p3`, null), null);
});

test('A3: an answer that arrives after the chat moved to another machine or was unfollowed is not applied to it', async () => {
  const w = world();
  let release!: (v: any) => void;
  w.host.subscribe = () => new Promise((r) => (release = r));
  w.chats.follow(CHAT);
  await tick();
  await tick();
  w.chats.unfollow(CHAT);
  release({ snapshot: { rev: 1, items: [start()] }, patches: null, generation: 'g1', inflight: [] });
  await tick();
  await tick();
  assert.deepEqual(w.emitted, []);
  assert.equal(w.items.records.filter((r) => r.hostRev !== undefined).length, 0);
  // and one that moved while the transcript was being read does not even ask
  const items = new FakeItems();
  const read = items.readAsync.bind(items);
  let unfollow: () => void = () => undefined;
  let reads = 0;
  // the first read lists the chat; the second finds where the transcript stands
  items.readAsync = async () => {
    const records = await read();
    if (++reads === 2) unfollow();
    return records;
  };
  const x = world(fakeHost(), items);
  unfollow = () => x.chats.unfollow(CHAT);
  x.chats.follow(CHAT);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(x.host.asked, []);
});

test('B1: events a Host sent without what a record needs are not taken for the real ones: one short row says so in the turn, and the next good record still goes in', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const bad = [
    ev({ kind: 7 }),
    ev({ kind: 'update', turnId: 't1' }),
    ev({ kind: 'update', turnId: 't1', update: 'text' }),
    ev({ kind: 'turnStart', turnId: 't1' }),
    ev({ kind: 'turnStart', user: {} }),
    ev({ kind: 'permission', turnId: 't1' }),
    ev({ kind: 'permissionCancelled' }),
  ];
  bad.forEach((item, i) => w.host.fire.patch(CHAT, i + 1, item));
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.map((e) => [e.kind, e.turnId, e.update?.content?.text]),
    [['update', 't1', 'This part of the reply can’t be shown by this version of MoPilot.']],
  );
  assert.equal(w.reported.length, 1, 'the one that names no turn is said once');
  // the next good record still goes in at its place
  w.host.fire.patch(CHAT, 8, end());
  await w.chats.settled(CHAT);
  assert.equal(w.items.records.at(-1).hostRev, 8);
});

test('a second answer while the first is on its way to the Host joins it: one answer reaches the Host, and the second fails as the first fails', async () => {
  const host = fakeHost();
  const w = world(host);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  host.fire.patch(CHAT, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(CHAT);
  const sent: any[] = [];
  let reply!: (v: any) => void;
  let fail!: (e: Error) => void;
  host.answer = (p: any) => (sent.push(p), new Promise((res, rej) => ((reply = res), (fail = rej))));
  const first = w.chats.answer(`${CHAT}|p1`, 'allow');
  const second = w.chats.answer(`${CHAT}|p1`, 'deny');
  assert.notEqual(second, null);
  fail(new Error('away'));
  await assert.rejects(first, /away/);
  await assert.rejects(second, /away/);
  assert.equal(sent.length, 1);
  // kept to answer again; the next pair: the first is taken, the second says the card was answered
  const again = w.chats.answer(`${CHAT}|p1`, 'allow');
  const late = w.chats.answer(`${CHAT}|p1`, 'deny');
  reply({ answered: true });
  assert.equal(await again, true);
  assert.equal(await late, false);
  assert.equal(sent.length, 2);
  assert.equal(w.chats.answer(`${CHAT}|p1`, 'allow'), null);
});
