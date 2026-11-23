// A message to a chat on a machine shows in the transcript as soon as it is sent, as on this Mac (src/store/send.ts); the queue keeps only what really waits.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { native, resetStore, state } from './support/thread-kit.ts';
import { hostChats, renderer, sendMessage } from './support/handoff-renderer-send.ts';
import { deferred } from './support/async-scenarios.ts';

const PICTURE = { kind: 'image', path: '/Users/me/one.png', name: 'one.png' };
const turns = () => state.runtime.chat?.turns ?? [];
const bubble = () =>
  turns()
    .flatMap((t: any) => t.items)
    .find((i: any) => i.type === 'userMessage');

beforeEach(() => {
  resetStore({ runtime: { chat: { turns: [], activeTurnId: null } } });
  renderer.sessionOf = () => ({ turn: 'idle' });
  hostChats.hostOfChatNow = () => 'box';
});

/** A send whose receipt the test answers, and the items it carried. */
function pending() {
  const reply = deferred<any>();
  const sent: any[] = [];
  native.session.send = async (_chat: string, item: any) => (sent.push(item), reply.promise);
  return { reply, sent };
}

test('an idle machine chat shows the message with its pictures before the machine answers, and keeps it once it started', async () => {
  const { reply, sent } = pending();
  const done = sendMessage('chat', 'look', [PICTURE] as any);
  assert.equal(sent.length, 1);
  assert.equal(turns().length, 1);
  assert.equal(turns()[0].id, `pending-${sent[0].id}`);
  assert.deepEqual(
    bubble().content.map((c: any) => c.path ?? c.text),
    ['look', '/Users/me/one.png'],
  );
  assert.equal(bubble().clientId, sent[0].id);
  reply.resolve({ action: 'started', id: sent[0].id });
  assert.equal(await done, true);
  assert.equal(turns().length, 1);
});

test('a message the machine keeps (away, or refused with its words) leaves the transcript: the queue shows it', async () => {
  for (const receipt of [{ action: 'queued' }, { action: 'queued', error: 'The machine: no.' }]) {
    resetStore({ runtime: { chat: { turns: [], activeTurnId: null } } });
    const { reply, sent } = pending();
    const done = sendMessage('chat', 'later');
    assert.equal(turns().length, 1);
    reply.resolve({ ...receipt, id: sent[0].id });
    await done;
    assert.equal(turns().length, 0);
  }
});

test('a message that could not be kept at all leaves the transcript too', async () => {
  native.session.send = async () => ({ action: 'failed', id: 'x', error: 'This message could not be saved, so it was not sent.' });
  assert.equal(await sendMessage('chat', 'nope'), false);
  assert.equal(turns().length, 0);
});

test('a machine chat with a turn running, and a chat on this Mac, do not get a copy the machine or the harness did not ask for', async () => {
  renderer.sessionOf = () => ({ turn: 'running' });
  const busy = pending();
  const steered = sendMessage('chat', 'more');
  assert.equal(turns().length, 0);
  assert.equal(busy.sent[0].id, undefined);
  busy.reply.resolve({ action: 'steered', id: 'k' });
  await steered;
  renderer.sessionOf = () => ({ turn: 'idle' });
  hostChats.hostOfChatNow = () => '';
  const here = pending();
  const local = sendMessage('chat', 'here');
  assert.equal(turns().length, 0);
  assert.equal(here.sent[0].id, undefined);
  here.reply.resolve({ action: 'started', id: 'k' });
  await local;
});

test('a chat on this Mac that waits for a switch keeps its failed copy with the reason, and drops it when a Stop took the start over', async () => {
  hostChats.hostOfChatNow = () => '';
  renderer.sessionOf = () => ({ turn: 'idle', pendingSwitch: { harness: 'other' } });
  const first = pending();
  const refused = sendMessage('chat', 'switching');
  first.reply.resolve({ action: 'queued', error: 'Not now.', id: first.sent[0].id });
  await refused;
  assert.equal(turns()[0].status, 'failed');
  resetStore({ runtime: { chat: { turns: [], activeTurnId: null } } });
  const second = pending();
  const stopped = sendMessage('chat', 'again');
  second.reply.resolve({ action: 'queued', error: 'turn_changed', id: second.sent[0].id });
  await stopped;
  assert.equal(turns().length, 0);
});

test('a chat whose machine is not known yet (the chat list is still being read) shows the message at once too, and a machine that keeps it takes the copy away', async () => {
  hostChats.hostOfChatNow = () => null;
  const { reply, sent } = pending();
  const done = sendMessage('chat', 'early', [PICTURE] as any);
  assert.equal(turns().length, 1, 'shown before the reply');
  assert.equal(typeof sent[0].id, 'string');
  reply.resolve({ action: 'queued', id: sent[0].id });
  await done;
  assert.equal(turns().length, 0);
});
