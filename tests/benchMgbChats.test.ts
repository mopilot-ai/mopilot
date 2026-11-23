// bench/lib/mgb chats.mjs and limiter.mjs, and the peer cell in run.mjs (#1381, F8): MoPilot's cross-session journal
// as the `chats` source, the provider proxy's one usage-limit refusal, and which harness a task's peer chats run on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chatsState, deliveredRequests, initChats, repliesTo } = await import('../bench/lib/mgb/chats.mjs');
const { createLimiter, isModelRequest, limitResponse } = await import('../bench/lib/mgb/limiter.mjs');
const { MGB_COLUMNS, peerCell } = await import('../bench/lib/mgb/run.mjs');

const journal = {
  schemaVersion: 1,
  messages: [
    { id: 'old', sourceChatId: 'a', targetChatId: 'b', body: 'earlier run', delivery: 'delivered', reply: 'received', createdAt: 5 },
    { id: 'r1', sourceChatId: 'a', targetChatId: 'b', body: 'Ship SO-1, SO-2', delivery: 'delivered', reply: 'received', createdAt: 100 },
    { id: 'r2', sourceChatId: 'a', targetChatId: 'c', body: 'Ship SO-1', delivery: 'blocked', createdAt: 110 },
    { id: 'p1', sourceChatId: 'b', targetChatId: 'a', body: 'SO-1: 1Z1', delivery: 'delivered', replyTo: 'r1', createdAt: 120 },
    { id: 'p2', sourceChatId: 'c', targetChatId: 'a', body: 'not mine', delivery: 'delivered', replyTo: 'r1', createdAt: 130 },
    { id: 'self', sourceChatId: 'a', targetChatId: 'a', body: 'SO-1 SO-2', delivery: 'delivered', createdAt: 140 },
    { id: 'bad', sourceChatId: 'a', targetChatId: 'b', createdAt: 'x' },
  ],
};

test('the chats source keeps the run window, and finds delivered requests and their real replies', () => {
  const s = chatsState(journal, { from: 50, to: 200 });
  assert.deepEqual(
    s.messages.map((m: any) => m.id),
    ['r1', 'r2', 'p1', 'p2', 'self'],
  );
  assert.deepEqual(s.messages[1], {
    id: 'r2',
    from: 'a',
    to: 'c',
    body: 'Ship SO-1',
    delivery: 'blocked',
    reply: 'notRequested',
    replyTo: null,
    at: 110,
  });
  assert.equal(s.messages[2].replyTo, 'r1');
  assert.deepEqual(
    deliveredRequests(s, ['so-1', 'so-2']).map((m: any) => m.id),
    ['r1'],
    'blocked requests, replies and messages to the chat itself do not count',
  );
  assert.equal(deliveredRequests(s).length, 1);
  assert.deepEqual(
    repliesTo(s, s.messages[0]).map((m: any) => m.id),
    ['p1'],
    'a reply from a chat the request did not go to is not its reply',
  );
  assert.deepEqual(deliveredRequests(undefined), []);
  assert.deepEqual(repliesTo(null, { id: 'r1' }), []);
  assert.deepEqual(
    chatsState({ messages: [{ id: 'q', sourceChatId: 'a', targetChatId: 'b', delivery: 'queued', createdAt: 1 }] }, { from: 0, to: 9 })
      .messages[0].body,
    '',
  );
  assert.throws(() => chatsState({}, { from: 0, to: 1 }), /no messages list/);
  assert.throws(() => chatsState(null, { from: 0, to: 1 }), /no messages list/);
  assert.deepEqual(initChats(undefined), { messages: [] });
});

test('the limiter refuses one model request after N, once, and records when', () => {
  let now = 1000;
  const l = createLimiter(() => now);
  assert.equal(l.decide('POST', '/v1/messages'), 'pass', 'disarmed: everything passes');
  assert.equal(l.state(), null);
  assert.throws(() => l.arm('', 2), /needs a run tag/);
  assert.throws(() => l.arm('t', 0), /afterRequests of 1 or more/);
  l.arm('t1', 2);
  assert.equal(l.decide('GET', '/v1/models'), 'pass', 'only model requests count');
  assert.equal(l.decide('POST', '/v1/messages?beta=true'), 'pass');
  assert.equal(l.decide('POST', '/v1/messages'), 'pass');
  now = 2000;
  assert.equal(l.decide('POST', '/v1/messages'), 'limit');
  assert.equal(l.decide('POST', '/v1/messages'), 'pass', 'the limit lifts after one refusal');
  assert.deepEqual(l.state(), { tag: 't1', seen: 3, limitedAt: 2000 });
  l.disarm();
  assert.equal(l.state(), null);
  assert.equal(createLimiter().decide('POST', '/v1/messages'), 'pass');
  // the real clock stamps the refusal
  const real = createLimiter();
  real.arm('t2', 1);
  real.decide('POST', '/v1/messages');
  assert.equal(real.decide('POST', '/v1/messages'), 'limit');
  assert.ok(Math.abs((real.state()?.limitedAt ?? 0) - Date.now()) < 5000);
  assert.ok(isModelRequest('POST', '/v1/messages'));
  assert.ok(!isModelRequest('POST', '/v1/messages/count_tokens'));
  assert.ok(!isModelRequest('GET', '/v1/messages'));
  const r = limitResponse(1_800_000_000);
  assert.equal(r.status, 429);
  assert.equal(r.headers['anthropic-ratelimit-unified-status'], 'rejected');
  assert.deepEqual(JSON.parse(r.body).error, { type: 'rate_limit_error', message: 'Claude AI usage limit reached|1800000000' });
});

test('peer chats run on the other harness of the cell', () => {
  assert.equal(peerCell('claude', MGB_COLUMNS), MGB_COLUMNS.codex);
  for (const c of ['codex', 'switch', 'acp']) assert.equal(peerCell(c, MGB_COLUMNS), MGB_COLUMNS.claude, c);
});
