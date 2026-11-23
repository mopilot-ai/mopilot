// What a machine chat waits for and how a closed card reads, in main (electron/host/attentionLane.cjs, cardClosed.cjs, remoteChatState.cjs, remoteChats.cjs): the lane keeps and pushes each chat's attention, the Host's reason and `answeredBy` become one line, and an older Host leaves both alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, FakeItems, createRemoteChats, ev, fakeHost, start } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { createAttentionLane, readAttention } = require('../electron/host/attentionLane.cjs');
const { closedLine, closedPatch } = require('../electron/host/cardClosed.cjs');

test('readAttention keeps what it knows and drops the rest', () => {
  assert.deepEqual(readAttention({ kind: 'approval', since: 5, cards: ['a'] }), { kind: 'approval', since: 5 });
  assert.deepEqual(readAttention({ kind: 'paused', reason: 'approval_timeout', since: Number.NaN }), {
    kind: 'paused',
    reason: 'approval_timeout',
  });
  // a pause keeps the minutes the owner gave it, and only a pause does
  assert.deepEqual(readAttention({ kind: 'paused', pauseMinutes: 5 }), { kind: 'paused', pauseMinutes: 5 });
  assert.deepEqual(readAttention({ kind: 'paused', pauseMinutes: 0 }), { kind: 'paused' });
  assert.deepEqual(readAttention({ kind: 'paused', pauseMinutes: 'x' }), { kind: 'paused' });
  assert.deepEqual(readAttention({ kind: 'limit', pauseMinutes: 5 }), { kind: 'limit' });
  for (const v of [null, undefined, 'x', [], {}, { kind: 'soon' }, { kind: 7 }]) assert.equal(readAttention(v), null);
});

test('the lane pushes a change once, forgets a chat whose attention ends, and lists what waits', () => {
  const said: any[] = [];
  const lane = createAttentionLane({ broadcast: (e: any) => said.push(e) });
  lane.set('a', { kind: 'approval', since: 1 });
  lane.set('a', { kind: 'approval', since: 1 });
  lane.set('b', { kind: 'paused', reason: 'approval_timeout' });
  assert.deepEqual(lane.all(), { a: { kind: 'approval', since: 1 }, b: { kind: 'paused', reason: 'approval_timeout' } });
  lane.set('a', null);
  lane.set('a', 'nonsense');
  lane.set('c', null);
  assert.deepEqual(
    said.map((e) => [e.chatId, e.attention?.kind ?? null]),
    [
      ['a', 'approval'],
      ['b', 'paused'],
      ['a', null],
    ],
  );
  assert.deepEqual(Object.keys(lane.all()), ['b']);
});

test('closedLine: another device is named, this Mac and an older Host say nothing, the rest read as the table says', () => {
  const by = (fingerprint: string) => ({ fingerprint, name: 'Pocket iPhone', kind: 'phone' });
  assert.equal(closedLine({ reason: 'answered', answeredBy: by('p'), optionKind: 'allow' }, { selfKey: 'me' }), 'Allowed on Pocket iPhone');
  assert.equal(closedLine({ reason: 'answered', answeredBy: by('p'), optionKind: 'deny' }), 'Denied on Pocket iPhone');
  assert.equal(closedLine({ reason: 'answered', answeredBy: by('p'), optionKind: 'wat' }), 'Answered on Pocket iPhone');
  assert.equal(closedLine({ reason: 'answered', answeredBy: by('me'), optionKind: 'allow' }, { selfKey: 'me' }), null);
  assert.equal(closedLine({ reason: 'answered' }), null);
  assert.equal(closedLine({ reason: 'answered', answeredBy: { name: '' } }), null);
  assert.equal(
    closedLine({ reason: 'answered', answeredBy: by('p'), optionKind: 'allow', at: 5 }),
    'Allowed on Pocket iPhone',
    'the time is only the hover',
  );
  assert.equal(closedLine({ reason: 'expired' }), 'Not answered');
  assert.equal(closedLine({ reason: 'stopped' }), 'Cancelled');
  // only a cancelled card takes a line: a request's own `reason` is not why a card closed
  assert.deepEqual(closedPatch({ kind: 'permissionCancelled', reason: 'stopped' }), { line: 'Cancelled' });
  assert.deepEqual(closedPatch({ kind: 'permissionCancelled' }), {});
  assert.deepEqual(closedPatch({ kind: 'permission', reason: 'stopped' }), {});
  assert.equal(closedLine({ reason: 'turn_ended' }), 'Cancelled');
  assert.equal(closedLine({ reason: 'host_restarted' }), 'The machine restarted');
  assert.equal(closedLine({ reason: 'moved' }), null);
  assert.equal(closedLine({}), null);
  assert.equal(closedLine(null), null);
});

async function followed(extra: object = {}) {
  const host = fakeHost();
  const emitted: any[] = [];
  const told: any[] = [];
  const items = new FakeItems();
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: object) => emitted.push(e),
    now: () => 1000,
    report: () => undefined,
    attention: (chatId: string, v: unknown) => told.push([chatId, v]),
    selfKey: () => 'me',
    ...extra,
  });
  chats.follow(CHAT);
  await chats.settled(CHAT);
  return { host, chats, emitted, told, items };
}

test('a card another device answered leaves its line; this Mac’s own answer and an older Host leave none', async () => {
  const w = await followed();
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 2, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  w.host.fire.patch(
    CHAT,
    3,
    ev({
      kind: 'permissionCancelled',
      requestId: 'p1',
      reason: 'answered',
      optionKind: 'allow',
      answeredBy: { fingerprint: 'p', name: 'Pocket iPhone', kind: 'phone' },
    }),
  );
  w.host.fire.patch(CHAT, 4, ev({ kind: 'permission', requestId: 'p2', turnId: 't1' }));
  w.host.fire.patch(
    CHAT,
    5,
    ev({
      kind: 'permissionCancelled',
      requestId: 'p2',
      reason: 'answered',
      optionKind: 'allow',
      answeredBy: { fingerprint: 'me', name: 'Work MacBook Pro', kind: 'desktop' },
    }),
  );
  w.host.fire.patch(CHAT, 6, ev({ kind: 'permission', requestId: 'p3', turnId: 't1' }));
  w.host.fire.patch(CHAT, 7, ev({ kind: 'permissionCancelled', requestId: 'p3' }));
  await w.chats.settled(CHAT);
  const closed = w.emitted.filter((e) => e.kind === 'permissionCancelled');
  assert.deepEqual(
    closed.map((e) => e.line ?? null),
    ['Allowed on Pocket iPhone', null, null],
  );
});

test('a card the Host closed leaves a record in the chat, in its turn, once; a close that has no line or no turn leaves none', async () => {
  const w = await followed();
  const by = { fingerprint: 'p', name: 'Pocket iPhone', kind: 'phone' };
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 2, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  w.host.fire.patch(CHAT, 3, ev({ kind: 'permissionCancelled', requestId: 'p1', turnId: 't1', reason: 'expired' }));
  w.host.fire.patch(CHAT, 4, ev({ kind: 'permission', requestId: 'p2', turnId: 't1' }));
  w.host.fire.patch(
    CHAT,
    5,
    ev({ kind: 'permissionCancelled', requestId: 'p2', turnId: 't1', reason: 'answered', optionKind: 'allow', answeredBy: by }),
  );
  // an older Host: no turn on the close, or no reason
  w.host.fire.patch(CHAT, 6, ev({ kind: 'permissionCancelled', requestId: 'p3', reason: 'expired' }));
  w.host.fire.patch(CHAT, 7, ev({ kind: 'permissionCancelled', requestId: 'p4', turnId: 't1' }));
  // the Host repeating a revision changes nothing
  w.host.fire.patch(
    CHAT,
    5,
    ev({ kind: 'permissionCancelled', requestId: 'p2', turnId: 't1', reason: 'answered', optionKind: 'allow', answeredBy: by }),
  );
  await w.chats.settled(CHAT);
  const cards = w.items.records.filter((r: any) => r.t === 'card');
  assert.deepEqual(
    cards.map((r: any) => [r.turnId, r.requestId, r.line, r.reason, r.hostRev, r.hostGen]),
    [
      ['t1', `${CHAT}|p1`, 'Not answered', 'expired', 3, 'g1'],
      ['t1', `${CHAT}|p2`, 'Allowed on Pocket iPhone', 'answered', 5, 'g1'],
    ],
  );
});

test('a Host chat followed with no attention sink ignores the lane’s attention', async () => {
  const w = await followed({ attention: undefined });
  w.host.fire.frame(CHAT, { t: 'state', patch: { attention: { kind: 'limit' } } });
  await w.chats.settled(CHAT);
  assert.deepEqual(w.told, []);
});

test('the state lane’s attention reaches the sink, and a frame without one does not', async () => {
  const w = await followed();
  w.host.fire.frame(CHAT, { t: 'state', patch: { attention: { kind: 'paused', reason: 'approval_timeout' } } });
  w.host.fire.frame(CHAT, { t: 'state', patch: { goal: null } });
  w.host.fire.frame(CHAT, { t: 'state', patch: { attention: null } });
  await w.chats.settled(CHAT);
  assert.deepEqual(w.told, [
    [CHAT, { kind: 'paused', reason: 'approval_timeout' }],
    [CHAT, null],
  ]);
});
