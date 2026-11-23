// Spend across the harnesses (plan U5): Claude Code, Codex and an ACP agent each report a turn's usage into the one counter, and over a limit no turn starts on any of them, from a client, a schedule or the waiting queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { createSpend } from '../host/src/spend.mjs';
// @ts-ignore
import { hostStatus } from '../host/src/status.mjs';
// @ts-ignore
import { createCodexStream } from '../host/src/codexStream.mjs';
// @ts-ignore
import { createClaudeAcp } from '../host/src/claudeAcp.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };
const key = (n: number) => `key-${String(n).padStart(8, '0')}`;
const M = 1_000_000;
const FAMILIES = [
  { harness: 'claude', chatId: 'claude:00000000-0000-4000-8000-0000000000c1', model: 'claude-sonnet-4-5' },
  { harness: 'codex', chatId: '019e0000-0000-7000-8000-000000000001', model: 'gpt-5-codex' },
  { harness: 'acp:fake', chatId: 'acp:fake:c1', model: 'gpt-5' },
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-spend-wire-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sends: any[] = [];
  const runtime: any = {
    host,
    send: async (p: any) => (sends.push(p), { turnId: `t${sends.length}` }),
    prepare: async () => undefined,
    setMode: async () => undefined,
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const states: any[] = [];
  let ref: any = null;
  const policy = createPolicy({ dataDir: dir, onChange: () => spend.reevaluate() });
  const spend = createSpend({
    dataDir: dir,
    limits: () => policy.effective().doc.spend ?? {},
    report: () => undefined,
    state: (chatId: string, patch: any) => (states.push([chatId, patch]), ref?.chatState(chatId, patch)),
  });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    policy,
    spend,
    dataDir: dir,
    status: () => hostStatus({ running: true, policy: policy.status(), spend: spend.status() }),
  });
  ref = protocol;
  const conn = protocol.connection(() => undefined);
  /** A turn on the chat that ends with the usage its harness reported. */
  const endTurn = (chatId: string, n: number, usage?: object) => {
    host.emit('event', { kind: 'turnStart', turnId: `x${n}`, key: chatId, user: { id: `u${n}` } });
    host.emit('event', { kind: 'turnEnd', turnId: `x${n}`, key: chatId, stopReason: 'end_turn', ...(usage ? { usage } : {}) });
  };
  return { conn, sends, endTurn, policy, spend, states, protocol };
}
const hello = (conn: any) => conn.call('host.hello', helloParams());
const doc = (spend: object) => ({ version: 1, spend });

for (const { harness, chatId, model } of FAMILIES) {
  test(`${harness}: usage reaches the one counter, and over the limit chat.start and chat.send are refused before they run`, async () => {
    const { conn, sends, endTurn, spend } = setup();
    await hello(conn);
    await conn.call('host.policy', { doc: doc({ chatUsd: 10 }) });
    await conn.call('chat.start', { chatId, epoch: 1, harness, key: key(1), text: 'one', model });
    endTurn(chatId, 1, { model, inputTokens: M, outputTokens: M });
    const lane = spend.lane(chatId);
    assert.ok(lane.usd > 0 && lane.usd >= 10, `${harness} priced ${lane.usd}`);
    assert.equal((await conn.call('host.status', {})).spend.unpriced, 0);
    const before = sends.length;
    for (const [i, method] of ['chat.send', 'chat.start'].entries()) {
      await assert.rejects(
        conn.call(method, { chatId, epoch: 1, harness, key: key(10 + i), text: 'again' }),
        (e: any) => e.code === 'spend_limit' && e.details.key === 'chatUsd' && e.details.limitUsd === 10 && e.details.spentUsd >= 10,
      );
    }
    assert.equal(sends.length, before, 'nothing reached the harness');
    // raising the limit lets the same message go (the refusal was not remembered as the key's answer)
    await conn.call('host.policy', { doc: doc({ chatUsd: 1000 }) });
    await conn.call('chat.send', { chatId, epoch: 1, key: key(10), text: 'again' });
    assert.equal(sends.length, before + 1);
  });
}

test('removing a chat drops its total from the counter', async () => {
  const { conn, endTurn, spend } = setup();
  await hello(conn);
  await conn.call('chat.send', { chatId: 'claude:a', epoch: 1, key: key(1), text: 'go', model: 'claude-sonnet-4-5' });
  endTurn('claude:a', 1, { model: 'claude-sonnet-4-5', inputTokens: M, outputTokens: M });
  assert.ok(spend.lane('claude:a').usd > 0);
  await conn.call('chat.remove', { chatId: 'claude:a', epoch: 1, key: key(2) });
  assert.equal(spend.lane('claude:a').usd, 0);
});

test('the day limit holds every chat, a running turn is never cut, and an unpriced turn never blocks', async () => {
  const { conn, sends, endTurn, states } = setup();
  await hello(conn);
  await conn.call('host.policy', { doc: doc({ dayUsd: 20 }) });
  // a turn that crosses the limit finishes: its end only records
  await conn.call('chat.send', { chatId: 'claude:a', epoch: 1, key: key(1), text: 'go', model: 'claude-sonnet-4-5' });
  endTurn('claude:a', 1, { model: 'claude-sonnet-4-5', inputTokens: M, outputTokens: 2 * M });
  assert.deepEqual(states.at(-1)[1].attention, { kind: 'limit' });
  const status = (await conn.call('host.status', {})).spend;
  assert.equal(status.dayLimitUsd, 20);
  assert.ok(status.dayUsd >= 20);
  await assert.rejects(
    conn.call('chat.send', { chatId: 'claude:other', epoch: 1, key: key(2), text: 'go' }),
    (e: any) => e.details.key === 'dayUsd',
  );
  assert.equal(sends.length, 1);
  await conn.call('host.policy', { doc: doc({}) });
  await conn.call('chat.send', { chatId: 'claude:other', epoch: 1, key: key(2), text: 'go' });
  assert.equal(states.at(-1)[1].attention, null, 'the limit that held the first chat is gone');
  // a model not in the table and a turn that reports nothing are counted apart and never block
  endTurn('claude:other', 2, { model: 'a-model-nobody-priced', inputTokens: M });
  endTurn('claude:other', 3);
  assert.equal((await conn.call('host.status', {})).spend.unpriced, 2);
});

test('a scheduled run is refused over a limit', async () => {
  const { conn, protocol, endTurn, spend } = setup();
  await hello(conn);
  await conn.call('host.policy', { doc: doc({ dayUsd: 5 }) });
  endTurn('claude:s1', 1, { model: 'claude-sonnet-4-5', inputTokens: M, outputTokens: M });
  await assert.rejects(
    async () => protocol.startScheduled({ chatId: 'claude:sched', task: {} as any }),
    (e: any) => e.code === 'spend_limit',
  );
  assert.ok(spend.lane('claude:s1').usd > 0);
});

test('a policy without spend means no limit, and the status has no limit to show', async () => {
  const { conn, endTurn } = setup();
  await hello(conn);
  endTurn('claude:n1', 1, { model: 'claude-sonnet-4-5', inputTokens: 100 * M });
  await conn.call('chat.send', { chatId: 'claude:n1', epoch: 1, key: key(1), text: 'still fine' });
  assert.equal((await conn.call('host.status', {})).spend.dayLimitUsd, null);
});

test('Codex: each request’s usage adds up to the turn, cached tokens are priced apart, and a turn that reported none says none', () => {
  const events: any[] = [];
  const stream = createCodexStream({ chatOf: (t: string) => (t === 'th' ? 'chat' : null), emit: (e: any) => events.push(e) });
  stream.started('chat', 't1');
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  const report = (last: any, turnId?: string) =>
    stream.notification({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'th', ...(turnId ? { turnId } : {}), tokenUsage: { last, total: last } },
    });
  report({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50, totalTokens: 1050 }, 't1');
  report({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 20, totalTokens: 520 }); // names no turn: the one open
  report({ totalTokens: 'x' }, 't1');
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  // a report after the end opens nothing and adds nothing
  report({ inputTokens: 9, outputTokens: 9 }, 't1');
  const end = events.find((e) => e.kind === 'turnEnd');
  assert.deepEqual(end.usage, { inputTokens: 1100, cachedReadTokens: 400, outputTokens: 70, totalTokens: 1570 });
  stream.started('chat', 't2');
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't2' } } });
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't2', status: 'completed' } } });
  assert.equal(events.filter((e) => e.kind === 'turnEnd')[1].usage, undefined);
});

test('Claude Code: the turn’s usage names the model that did the most work', () => {
  const t = createClaudeAcp();
  t.message({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 1, outputTokens: 1 },
      'claude-sonnet-4-5': { inputTokens: 9, outputTokens: 4 },
      odd: null,
    },
  });
  assert.equal(t.summary().usage?.model, 'claude-sonnet-4-5');
  const plain = createClaudeAcp();
  plain.message({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(plain.summary().usage?.model, undefined);
});
