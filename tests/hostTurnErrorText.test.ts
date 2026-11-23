// A turn that fails on a machine: the Host sends its error as `{ message }`, and everything after the boundary reads text (a non-string took down the whole chat view).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeItems, createRemoteChats, ev, fakeHost } from './support/host/remoteChatsKit.ts';
import { acpStop, isLimitError, stopErrorText } from '../shared/acpStop.mjs';
import { friendlyError } from '../src/components/thread/view/friendlyError.ts';

const CHAT = 'acp:host-claude:chat-a';
const LIMIT = "You've hit your weekly limit · resets Nov 11 at 4pm (America/Los_Angeles)";

function world() {
  const host = fakeHost();
  const items = new FakeItems();
  const emitted: any[] = [];
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: object) => emitted.push(e),
    now: () => 1000,
    report: () => undefined,
  });
  return { chats, host, items, emitted };
}

test('a failed turn from a Host is recorded and emitted with its error as text, and reads as a usage limit', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, ev({ kind: 'turnEnd', turnId: 't1', stopReason: 'error', error: { message: LIMIT } }));
  await w.chats.settled(CHAT);
  const record = w.items.records.find((r) => r.t === 'end');
  assert.equal(record.error, LIMIT);
  const end = w.emitted.find((e) => e.kind === 'turnEnd');
  assert.equal(end.error, LIMIT);
  assert.equal(isLimitError(end.error), true);
  assert.equal(acpStop(end.stopReason, end.error).note?.kind, 'limit');
  assert.equal(friendlyError(acpStop('error', 'plain').error as string), 'plain');
});

test('a turn that ended well keeps no error, and an end with no error field gets none', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, ev({ kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn', error: null }));
  w.host.fire.patch(CHAT, 2, ev({ kind: 'turnEnd', turnId: 't2', stopReason: 'end_turn' }));
  await w.chats.settled(CHAT);
  const [a, b] = w.items.records.filter((r) => r.t === 'end');
  assert.equal(a.error, null);
  assert.equal(Object.hasOwn(b, 'error'), false);
});

test('stopErrorText: text as it is; a message out of an object; nothing as null; an object with no message is still text', () => {
  assert.equal(stopErrorText('boom'), 'boom');
  assert.equal(stopErrorText({ message: 'boom' }), 'boom');
  for (const none of [null, undefined, '']) assert.equal(stopErrorText(none), null);
  assert.equal(stopErrorText({ code: 7 }), '{"code":7}');
  assert.equal(stopErrorText({ message: 7 }), '{"message":7}');
});
