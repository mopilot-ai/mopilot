// When a followed chat listens on its machine's connection (electron/host/remoteChats.cjs `subscribed`, #3525): what the outbox waits for before it sends a kept message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, fakeHost, world, tick } from './support/host/remoteChatsKit.ts';

/** A followed chat whose next subscribe is held until `answer()`. */
function holding(w: any) {
  const answers: (() => void)[] = [];
  const reply = w.host.subscribe;
  w.host.subscribe = (...a: any[]) => new Promise((r) => answers.push(() => r(reply(...a))));
  return () => answers.shift()?.();
}

test('a chat on this Mac, or whose machine is away, does not hold a send; one not followed yet is followed and subscribed first', async () => {
  const w = world();
  w.setOwner({ hostId: 'local', folder: null });
  await w.chats.subscribed('acp:kimi:here');
  w.setOwner({ hostId: 'm1', folder: null });
  w.host.st = 'offline';
  await w.chats.subscribed(CHAT);
  assert.deepEqual(w.host.asked, []);
  w.host.st = 'online';
  await w.chats.subscribed('acp:kimi:c3');
  assert.deepEqual(w.host.asked, [['acp:kimi:c3', undefined, undefined]], 'followed by the send, subscribed once');
});

test('a machine that comes back: the send waits for the one subscribe on the new connection, whichever "online" listener runs first', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  await w.chats.subscribed(CHAT);
  assert.equal(w.host.asked.length, 1, 'subscribed once, and nothing more to wait for');
  w.host.fire.state('offline');
  const answer = holding(w);
  w.host.st = 'online';
  // the outbox asks first, then the mirror hears "online"
  let done = false;
  const waiting = w.chats.subscribed(CHAT).then(() => (done = true));
  w.host.fire.state('online');
  await tick();
  assert.equal(done, false, 'not until the new connection answers the subscribe');
  answer();
  await waiting;
  assert.equal(w.host.asked.length, 2, 'one subscribe for the new connection');
  await w.chats.subscribed(CHAT);
  assert.equal(w.host.asked.length, 2);
});

test('a subscribe that fails lets the send go on, and the next send asks again; a chat that moved meanwhile is not counted as subscribed', async () => {
  const w = world();
  const ok = w.host.subscribe;
  let calls = 0;
  w.host.subscribe = async () => {
    calls++;
    throw Object.assign(new Error('broken'), { code: 'host_error' });
  };
  w.chats.follow(CHAT);
  await w.chats.subscribed(CHAT);
  assert.equal(w.reported.length, 1);
  await w.chats.subscribed(CHAT);
  assert.equal(calls, 2, 'not counted as subscribed: asked again');
  w.host.subscribe = ok;
  const answer = holding(w);
  const waiting = w.chats.subscribed(CHAT);
  await tick();
  w.chats.unfollow(CHAT);
  answer();
  await waiting;
  assert.equal(w.emitted.length, 0, 'the answer is not applied to a chat no longer followed');
});

test("one machine's drop leaves the chats on another machine subscribed", async () => {
  const w = world();
  w.hosts.m2 = fakeHost();
  w.chats.follow(CHAT);
  w.setOwner({ hostId: 'm2', folder: null });
  w.chats.follow('acp:kimi:c2');
  await w.chats.subscribed(CHAT);
  await w.chats.subscribed('acp:kimi:c2');
  w.host.fire.state('offline');
  w.host.st = 'online';
  w.host.fire.state('online');
  await w.chats.subscribed(CHAT);
  await w.chats.subscribed('acp:kimi:c2');
  assert.equal(w.host.asked.length, 2, 'the chat on the machine that dropped subscribed again');
  assert.equal(w.hosts.m2.asked.length, 1, 'the other machine was not asked again');
});
