// Agent-to-agent bounds with no per-turn budget (electron/session/peerInboxGuard.cjs): a relay loop is cut and kept
// visible, the user's Retry starts a new chain, and a flood or a repeat to one chat is refused with its own reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { PeerMessageService } = require('../electron/session/peerMessages.cjs');
const { LIMITS, hopsFor, loopReason, createInboxGuard } = require('../electron/session/peerInboxGuard.cjs');

function make(opts: any = {}) {
  const sent: any[] = [];
  const turns: Record<string, string | null> = {};
  const active: Record<string, string> = {};
  const controller: any = {
    send: (id: string, item: any) => sent.push({ id, item }),
    // a chat's running native turn, for messages steered into it
    state: { get: (id: string) => ({ turn: 'idle', queue: [], activeTurn: active[id] ? { id: active[id] } : null }) },
    peerCapabilities: () => ({ steer: true }),
    removeQueued: () => {},
  };
  const service = new PeerMessageService({
    file: path.join(os.tmpdir(), `peer-guard-${crypto.randomUUID()}`, 'journal.json'),
    controller,
    exists: () => true,
    // the sender's current turn input token, as PeerRuntime's authorize gives it
    authorize: (source: string) => ({ sourceTurnId: turns[source] ?? null }),
    gate: () => null,
    write: () => {},
    inbox: opts.inbox,
  });
  /** `source` sends to `target` from the turn the message `cause` started there (or a turn of its own) */
  const send = (source: string, target: string, cause: any, n: number) => {
    turns[source] = cause ? `pending-${cause.id}` : 'user-turn';
    return service.send(source, { targetChatId: target, requestId: `r${n}`, body: `round ${n}` });
  };
  return { service, sent, send, turns, active };
}

test('a message’s chain continues the peer message that started the sender’s turn, else starts with the sender', () => {
  const cause = { id: 'm1', sourceChatId: 'A', targetChatId: 'B', hops: ['A'] };
  assert.deepEqual(hopsFor([cause], 'B', 'pending-m1'), ['A', 'B']);
  // a journal entry from before chains were recorded starts from its sender
  assert.deepEqual(hopsFor([{ ...cause, hops: undefined }], 'B', 'pending-m1'), ['A', 'B']);
  // a user's turn, no turn, or a message that went elsewhere starts a new chain
  assert.deepEqual(hopsFor([cause], 'B', 'user-turn'), ['B']);
  assert.deepEqual(hopsFor([cause], 'B', null), ['B']);
  assert.deepEqual(hopsFor([cause], 'C', 'pending-m1'), ['C']);
  // a turn that took several: the longest chain counts, whichever came first
  const steered = { id: 'm2', sourceChatId: 'C', targetChatId: 'B', hops: ['C'], delivery: 'delivered', targetTurnId: 'native-1' };
  const deep = { ...steered, id: 'm3', hops: ['A', 'C', 'A', 'C'] };
  assert.deepEqual(hopsFor([cause, steered], 'B', 'pending-m1', 'native-1'), ['A', 'B']);
  assert.deepEqual(hopsFor([cause, steered, deep], 'B', 'pending-m1', 'native-1'), ['A', 'C', 'A', 'C', 'B']);
  // one not yet delivered into that turn does not count
  assert.deepEqual(hopsFor([{ ...deep, delivery: 'queued' }], 'B', 'user-turn', 'native-1'), ['B']);
  assert.equal(loopReason(['A', 'B'], 'A'), null);
  assert.equal(loopReason(Array(LIMITS.maxSelfHops).fill('A'), 'A'), 'peer_loop_cut');
  assert.equal(
    loopReason(
      Array.from({ length: LIMITS.maxChainLength + 1 }, (_, i) => `c${i}`),
      'A',
    ),
    'peer_relay_runaway',
  );
});

test('two agents messaging each other with no user turn are cut on the tenth visit, kept and visible, and Retry resumes', async () => {
  const { service, send, sent } = make({ inbox: { admit: () => null } });
  let last: any = null;
  let n = 0;
  // A and B take turns: each message starts the other's turn, which sends the next
  for (;;) {
    const [source, target] = n % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    last = await send(source, target, last, n++);
    if (last.delivery === 'blocked') break;
    assert.equal(last.delivery, 'queued');
  }
  assert.equal(last.errorCode, 'peer_loop_cut');
  assert.equal(n, 2 * LIMITS.maxSelfHops);
  assert.equal(sent.length, n - 1, 'the cut message never reaches the harness');
  assert.equal(service.data.messages.length, n, 'nor is it dropped: both chats list it');
  // the sender's user sends it on: a new chain from the sender
  const resumed = await service.resume(last.sourceChatId, last.id);
  assert.equal(resumed.delivery, 'queued');
  assert.deepEqual(resumed.hops, [last.sourceChatId]);
  // a user's own turn in between starts over too
  assert.equal((await send('A', 'B', null, n++)).hops.length, 1);
});

test('a relay across many chats is cut once its chain is too long; replies are never cut', async () => {
  const { send } = make({ inbox: { admit: () => null } });
  let last: any = null;
  for (let i = 0; i <= LIMITS.maxChainLength; i++) last = await send(`c${i}`, `c${i + 1}`, last, i);
  assert.equal(last.errorCode, 'peer_relay_runaway');
  // a reply answers its receiver's own request: deep in a chain it is still delivered
  const { service: pair, send: ask, sent } = make({ inbox: { admit: () => null } });
  let request: any = null;
  for (let i = 0; i < 2 * LIMITS.maxSelfHops - 1; i++) request = await ask(i % 2 ? 'B' : 'A', i % 2 ? 'A' : 'B', request, i);
  assert.equal(request.delivery, 'queued');
  const item = sent.at(-1).item;
  await pair.beforeDispatch({ chatId: request.targetChatId, kind: 'start', item, ref: { id: 'n', kind: 'codex' } });
  pair.result({ item, result: { started: true, turnId: 't' } });
  const answer = await pair.reply(request.targetChatId, { messageId: request.id, requestId: 'answer', body: 'Done' });
  assert.equal(answer.delivery, 'queued');
  assert.equal(answer.hops.length, request.hops.length + 1);
  assert.equal(loopReason(answer.hops, answer.targetChatId), 'peer_loop_cut', 'as a new request it would have been cut');
});

test('a flood to one chat is refused past the burst and admitted again as tokens refill; a repeat within 30 s is refused', (t) => {
  const clock = useFakeClock(t, 0);
  const guard = createInboxGuard();
  for (let i = 0; i < LIMITS.bucketCapacity; i++) assert.equal(guard.admit('A', 'B', `m${i}`), null);
  assert.equal(guard.admit('A', 'B', 'one more'), 'rate_limited');
  // another pair has its own bucket
  assert.equal(guard.admit('A', 'C', 'm0'), null);
  clock.advance(2000);
  assert.equal(guard.admit('A', 'B', 'after a pause'), null);
  assert.equal(guard.admit('A', 'B', 'after a pause'), 'duplicate_message');
  clock.advance(LIMITS.dedupWindowMs);
  assert.equal(guard.admit('A', 'B', 'after a pause'), null);
  // the oldest pair is forgotten past the tracked limit
  const small = createInboxGuard({ ...LIMITS, maxTrackedPairs: 1, bucketCapacity: 1 });
  assert.equal(small.admit('A', 'B', 'x'), null);
  assert.equal(small.admit('A', 'B', 'y'), 'rate_limited');
  assert.equal(small.admit('C', 'D', 'x'), null);
  assert.equal(small.admit('A', 'B', 'z'), null);
});

test('the service refuses a flood or a repeat with its reason and keeps nothing; a reply is not counted', async () => {
  const { service, sent } = make();
  const first = await service.send('A', { targetChatId: 'B', requestId: 'r1', body: 'Check the build' });
  await assert.rejects(service.send('A', { targetChatId: 'B', requestId: 'r2', body: 'Check the build' }), /duplicate_message/);
  assert.equal(service.data.messages.length, 1);
  // the same request id is still the same message, not a repeat
  assert.equal((await service.send('A', { targetChatId: 'B', requestId: 'r1', body: 'Check the build' })).id, first.id);
  await service.beforeDispatch({ chatId: 'B', kind: 'start', item: sent[0].item, ref: { id: 'n', kind: 'codex' } });
  service.result({ item: sent[0].item, result: { started: true, turnId: 't' } });
  const flooded = make({ inbox: { admit: () => 'rate_limited' } });
  await assert.rejects(flooded.service.send('A', { targetChatId: 'B', requestId: 'x', body: 'y' }), /rate_limited/);
  // B's answers bypass the guard: one per request
  service.inbox = { admit: () => 'rate_limited' };
  assert.equal((await service.reply('B', { messageId: first.id, requestId: 'a', body: 'Green' })).delivery, 'queued');
});

test('request → reply → request ping-pong is cut too: a reply carries its request’s chain', async () => {
  const { service, sent, send } = make({ inbox: { admit: () => null } });
  let cause: any = null;
  let n = 0;
  for (;;) {
    // A asks B from the turn B's last reply started; B's turn answers it
    const request = await send('A', 'B', cause, n++);
    if (request.delivery === 'blocked') {
      assert.equal(request.errorCode, 'peer_loop_cut');
      break;
    }
    const item = sent.at(-1).item;
    await service.beforeDispatch({ chatId: 'B', kind: 'start', item, ref: { id: 'n', kind: 'codex' } });
    service.result({ item, result: { started: true, turnId: `t${n}` } });
    cause = await service.reply('B', { messageId: request.id, requestId: `answer${n}`, body: `answer ${n}` });
    assert.equal(cause.delivery, 'queued');
  }
  assert.equal(n, LIMITS.maxSelfHops + 1);
});

test('two running chats steering each other are cut too: a steered message joins the turn it was delivered into', async () => {
  const { service, sent, turns, active } = make({ inbox: { admit: () => null } });
  // both chats sit in one long turn of their own each (a user's), waiting on each other
  Object.assign(turns, { A: 'user-turn-A', B: 'user-turn-B' });
  Object.assign(active, { A: 'native-A-1', B: 'native-B-1' });
  let n = 0;
  for (;;) {
    const [source, target] = n % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    const m = await service.send(source, { targetChatId: target, requestId: `s${n}`, body: `steer ${n++}` });
    if (m.delivery === 'blocked') {
      assert.equal(m.errorCode, 'peer_loop_cut');
      break;
    }
    // delivered into the target's running native turn
    const item = sent.at(-1).item;
    await service.beforeDispatch({ chatId: target, kind: 'steer', item, ref: { id: 'n', kind: 'codex' } });
    service.result({ item, result: { started: true, turnId: active[target] } });
  }
  assert.equal(n, 2 * LIMITS.maxSelfHops);
  // a message delivered into an earlier turn no longer counts
  active.A = 'native-A-2';
  turns.A = 'user-turn-A2';
  assert.deepEqual((await service.send('A', { targetChatId: 'B', requestId: 'fresh', body: 'fresh' })).hops, ['A']);
});
