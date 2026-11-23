// A card id in this app is the chat's own (electron/host/remoteChats.cjs, remoteChatState.cardId): two Hosts that number their requests alike, or one that means harm, each have their own cards; an answer reaches the Host whose card it is, with the id that Host gave it; a cancel touches only its own chat's cards; and a Host cannot name a card of this Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeItems, createRemoteChats, ev, fakeHost, tick } from './support/host/remoteChatsKit.ts';

const A = 'acp:kimi:chat-a';
const B = 'acp:kimi:chat-b';

function twoHosts() {
  const hostA = fakeHost();
  const hostB = fakeHost();
  const answersA: any[] = [];
  const answersB: any[] = [];
  hostA.answer = async (p: any) => (answersA.push(p), { answered: true });
  hostB.answer = async (p: any) => (answersB.push(p), { answered: true });
  const emitted: any[] = [];
  const reported: any[] = [];
  const closed: string[] = [];
  const hosts: Record<string, any> = { mA: hostA, mB: hostB };
  const chats = createRemoteChats({
    items: new FakeItems(),
    hostFor: (id: string) => hosts[id] ?? null,
    ownerOf: (chatId: string) => ({ hostId: chatId === A ? 'mA' : 'mB', folder: '/srv/work' }),
    emit: (e: object) => emitted.push(e),
    questions: () => ({ openRemote: () => undefined, closeRemote: (id: string) => void closed.push(id) }),
    now: () => 1000,
    report: (e: Error) => reported.push(e),
  });
  return { chats, hostA, hostB, answersA, answersB, emitted, reported, closed };
}

async function follow(w: ReturnType<typeof twoHosts>) {
  w.chats.follow(A);
  w.chats.follow(B);
  await w.chats.settled(A);
  await w.chats.settled(B);
}

const idOf = (chat: string, raw: string) => `${chat}|${raw}`;

test('the real card, then another Host’s card with the same id, then the user’s answers: each answer reaches the Host that owns the card, with the id that Host gave it', async () => {
  const w = twoHosts();
  await follow(w);
  w.hostA.fire.patch(A, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(A);
  w.hostB.fire.patch(B, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(B);
  const cards = w.emitted.filter((e) => e.kind === 'permission');
  assert.deepEqual(
    cards.map((e) => [e.key, e.requestId]),
    [
      [A, idOf(A, 'p1')],
      [B, idOf(B, 'p1')],
    ],
    'two cards, each with its own chat’s id',
  );
  assert.equal(await w.chats.answer(idOf(A, 'p1'), 'allow'), true);
  assert.deepEqual(w.answersA, [{ chatId: A, requestId: 'p1', optionId: 'allow' }]);
  assert.deepEqual(w.answersB, [], 'the other Host did not get the user’s answer');
  assert.equal(await w.chats.answer(idOf(B, 'p1'), 'deny'), true);
  assert.deepEqual(w.answersB, [{ chatId: B, requestId: 'p1', optionId: 'deny' }]);
  assert.deepEqual(w.reported, []);
});

test('a Host’s cancel names only its own chat’s card: another Host’s card with the same raw id stays answerable and its question is not closed', async () => {
  const w = twoHosts();
  await follow(w);
  w.hostA.fire.patch(A, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(A);
  w.hostB.fire.patch(B, 1, ev({ kind: 'permissionCancelled', requestId: 'p1' }));
  await w.chats.settled(B);
  assert.deepEqual(w.closed, [idOf(B, 'p1')], 'B closes its own id, not A’s');
  assert.equal(await w.chats.answer(idOf(A, 'p1'), 'allow'), true, 'A’s card is untouched');
  assert.equal(w.answersA.length, 1);
  // and a card of B’s that is gone cannot be answered
  assert.equal(w.chats.answer(idOf(B, 'p1'), 'allow'), null);
});

test('a card id of this Mac is a different card from a Host’s with the same text: the answer to this Mac’s card is not taken by the Host', async () => {
  const w = twoHosts();
  await follow(w);
  w.hostB.fire.patch(B, 1, ev({ kind: 'permission', requestId: 'local-1', turnId: 't1' }));
  await w.chats.settled(B);
  assert.equal(w.chats.answer('local-1', 'allow'), null, 'this Mac’s id is not one of the Host’s: the local route takes it');
  assert.equal(await w.chats.answer(idOf(B, 'local-1'), 'allow'), true);
  assert.deepEqual(w.answersB, [{ chatId: B, requestId: 'local-1', optionId: 'allow' }]);
});

test('the same chat repeating its own card id is the same card, and an unfollowed chat’s cards are forgotten', async () => {
  const w = twoHosts();
  await follow(w);
  w.hostA.fire.patch(A, 1, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  w.hostA.fire.patch(A, 2, ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }));
  await w.chats.settled(A);
  assert.deepEqual(w.reported, []);
  w.chats.unfollow(A);
  assert.equal(w.chats.answer(idOf(A, 'p1'), 'allow'), null);
  void tick;
});
