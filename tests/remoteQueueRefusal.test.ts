// A message a machine's Host refused reaches a phone that goes through the Mac as what it is (#4787, the phone side of #4786): the queue view carries why a message waits (the Host's reason when it refused it, a chat that moved, a machine that is away, a sign-in), `chat.queue.retry` sends it again through the Mac's own Retry, and Cancel takes it out of the Mac's outbox as well as its queue (A); a message that waits behind a running turn is left as it was (B); an older Mac answers the new call as unknown (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { viewOf } = require('../electron/remote/sessionView.cjs');
const { createPhoneChatOps } = require('../electron/app/phoneChatOps.cjs');

const row = (over: Record<string, unknown>) => ({ id: 'q1', text: 'hello', attachments: [], ...over });

test('A: the queue view says why a message waits: the Host refused it (with its reason), the chat moved, the machine is away, a sign-in is needed', () => {
  const view = viewOf({
    queue: [
      row({ id: 'r', waitingFor: 'hostRefused', error: 'The model is not available to this account.' }),
      row({ id: 'm', waitingFor: 'hostMoved' }),
      row({ id: 'h', waitingFor: 'host' }),
      row({ id: 'w', waitingFor: 'hostMoving' }),
      row({ id: 's', waitingFor: 'orgSignin' }),
    ],
  });
  assert.deepEqual(
    view.queue.map((q: any) => [q.id, q.refused, q.moved, q.waiting]),
    [
      ['r', 'The model is not available to this account.', undefined, undefined],
      ['m', undefined, true, undefined],
      ['h', undefined, undefined, 'host'],
      ['w', undefined, undefined, 'host'],
      ['s', undefined, undefined, 'orgSignin'],
    ],
  );
  // a refusal without a reason still says it was refused; a long reason is cut, not sent whole
  const bare = viewOf({
    queue: [row({ waitingFor: 'hostRefused' }), row({ id: 'long', waitingFor: 'hostRefused', error: 'x'.repeat(900) })],
  });
  assert.equal(bare.queue[0].refused, '');
  assert.equal(bare.queue[1].refused.length, 300);
});

test('B: a message behind a running turn, and every state the Mac\u2019s own queue keeps for a chat of this Mac, is told as it always was', () => {
  const view = viewOf({
    queue: [
      row({ id: 'a' }),
      row({ id: 'b', waitingFor: 'compaction' }),
      row({ id: 'c', waitingFor: 'voiceConversation' }),
      row({ id: 'd', waitingFor: 'audioRecovery' }),
    ],
  });
  for (const q of view.queue) assert.deepEqual(Object.keys(q).sort(), ['attached', 'id', 'mine', 'text']);
});

test('A: chat.queue.retry names a chat and one queued message, and a Mac sends it again as its own Retry does', async () => {
  assert.deepEqual(parseParams('chat.queue.retry', { chatId: 'c1', id: 'queued-12' }), { chatId: 'c1', id: 'queued-12' });
  assert.throws(() => parseParams('chat.queue.retry', { chatId: 'c1' }), /not valid/);
  assert.throws(() => parseParams('chat.queue.retry', { chatId: 'c1', id: '../x' }), /not valid/);
  const asked: any[] = [];
  const r = rig({
    ops: {
      requeue: async (chatId: string, id: string) => (
        asked.push([chatId, id]),
        id === 'queued-sent'
          ? { status: 'sent' }
          : id === 'queued-again'
            ? { status: 'queued', error: 'The model is not available to this account.' }
            : null
      ),
    },
  });
  const p = r.phone('p1');
  assert.deepEqual((await p.ask('chat.queue.retry', { chatId: 'c1', id: 'queued-sent' })).result, { retried: true, status: 'sent' });
  assert.deepEqual((await p.ask('chat.queue.retry', { chatId: 'c1', id: 'queued-again' })).result, {
    retried: true,
    status: 'queued',
    error: 'The model is not available to this account.',
  });
  assert.deepEqual((await p.ask('chat.queue.retry', { chatId: 'c1', id: 'queued-nope' })).result, { retried: false });
  assert.equal((await p.ask('chat.queue.retry', { chatId: 'nope', id: 'queued-sent' })).error.code, 'gone');
  assert.deepEqual(asked, [
    ['c1', 'queued-sent'],
    ['c1', 'queued-again'],
    ['c1', 'queued-nope'],
  ]);
});

/** The Mac's ops over a controller whose queue holds `queue`, and a remote send service that owns the chats in `remote`. */
function ops(
  queue: any[],
  remote: { remove?: (c: string, q: string) => boolean | null; sendNow?: (c: string, q: string) => Promise<unknown> } | null,
) {
  const removed: string[] = [];
  const live: any = {
    controller: {
      state: { has: () => true, get: () => ({ queue }) },
      removeQueued: (_c: string, q: string) => (removed.push(q), true),
    },
    remoteSend: () => remote,
  };
  return { ops: createPhoneChatOps({ live }), removed };
}

test('A: Cancel and Retry of a message a machine owns go through the Mac’s remote send (its outbox), not only the queue row', async () => {
  const calls: string[] = [];
  const remote = {
    remove: (c: string, q: string) => (calls.push(`remove ${c} ${q}`), q === 'mine' ? true : q === 'late' ? false : null),
    sendNow: async (c: string, q: string) => (calls.push(`sendNow ${c} ${q}`), q === 'mine' ? { status: 'sent' } : null),
  };
  const { ops: o, removed } = ops([row({ id: 'mine' }), row({ id: 'late' }), row({ id: 'local' })], remote);
  assert.equal(o.unqueue('c', 'mine'), true, 'taken out of the outbox');
  assert.equal(o.unqueue('c', 'late'), false, 'the Host already has it');
  assert.equal(o.unqueue('c', 'local'), true, 'not an outbox message: the controller queue');
  assert.deepEqual(removed, ['local']);
  assert.deepEqual(await o.requeue('c', 'mine'), { status: 'sent' });
  assert.equal(await o.requeue('c', 'local'), null, 'a message of this Mac has nothing to retry');
  assert.equal(await o.requeue('c', 'unknown-id'), null, 'a message that is not in the queue is not one to send');
  assert.deepEqual(calls, ['remove c mine', 'remove c late', 'remove c local', 'sendNow c mine', 'sendNow c local']);
});

test('I: a Mac without a remote send service (Host off) leaves Cancel to the queue and has nothing to retry', async () => {
  const { ops: o, removed } = ops([row({ id: 'a' })], null);
  assert.equal(o.unqueue('c', 'a'), true);
  assert.deepEqual(removed, ['a']);
  assert.equal(await o.requeue('c', 'a'), null);
  // another session's message is never a phone's to take, outbox or not
  const foreign = ops([row({ id: 'f', sideSession: { id: 's' } })], { remove: () => true });
  assert.equal(foreign.ops.unqueue('c', 'f'), false);
  assert.equal(await foreign.ops.requeue('c', 'f'), null, 'nor to send again');
});
