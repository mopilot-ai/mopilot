// Main's context service (electron/context/contextService.cjs): every harness's events become one snapshot per owner, Claude Code's breakdown is read when its turn ends (one read at a time, a superseded answer dropped), and failures keep the last snapshot, marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick as flush } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { ContextService, ownerKey, parseOwner } = require('../electron/context/contextService.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');

function service(readers: Record<string, (id: string, d: string) => Promise<unknown>> = {}, readMs?: { summary: number; full: number }) {
  const map = new Map<string, any>();
  const published: any[] = [];
  let now = 100;
  const svc = new ContextService({
    store: { get: (o: string) => map.get(o) ?? null, put: (s: any) => map.set(s.owner, s) },
    publish: (chatId: string, s: any) => published.push([chatId, s]),
    chatOf: (id: string) => `chat-${id}`,
    readers,
    now: () => ++now,
    readMs,
  });
  return { svc, map, published };
}
const usage = (last: number, total: number, input = last) => ({
  last: { totalTokens: last, inputTokens: input },
  total: { totalTokens: total, inputTokens: input },
  modelContextWindow: 1000,
});

test('owner keys round-trip and anything else is not one', () => {
  assert.deepEqual(parseOwner(ownerKey('c', 'codex', 't')), { chatId: 'c', harness: 'codex', nativeId: 't' });
  for (const bad of ['nope', '[]', '["a","b",""]', JSON.stringify(['a', 'b', 3]), '{}']) assert.equal(parseOwner(bad), null);
  const { svc } = service();
  assert.equal(svc.get('nope'), null);
});

test("Codex: a thread's first request sets the baseline less its first message; a resumed thread's does not", () => {
  const { svc, published } = service();
  const owner = ownerKey('chat-t1', 'codex', 't1');
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: {} });
  svc.codexMessage({
    method: 'item/started',
    params: { threadId: 't1', item: { type: 'userMessage', content: [{ type: 'text', text: 'x'.repeat(400) }, { type: 'image' }] } },
  });
  // a second message does not move the first's length
  svc.codexMessage({ method: 'item/started', params: { threadId: 't1', item: { type: 'userMessage', content: 'odd' } } });
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage(600, 600, 500) } });
  let s = svc.get(owner);
  assert.equal(s.baseline, 400);
  assert.equal(s.used, 600);
  assert.equal(s.window, 1000);
  assert.deepEqual(
    s.categories.map((c: any) => [c.id, c.tokens]),
    [
      ['instructions', 400],
      ['conversation', 200],
      ['free', 400],
    ],
  );
  assert.equal(published.at(-1)[0], 'chat-t1');
  // later requests keep the baseline
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage(700, 1300) } });
  assert.equal(svc.get(owner).baseline, 400);
  // a resumed thread's first report seen here is not its first request
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't2', tokenUsage: usage(700, 9000) } });
  s = svc.get(ownerKey('chat-t2', 'codex', 't2'));
  assert.equal(s.baseline, null);
  assert.deepEqual(
    s.categories.map((c: any) => c.id),
    ['used', 'free'],
  );
  // a report without breakdowns has no baseline either
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't3', tokenUsage: {} } });
  assert.equal(svc.get(ownerKey('chat-t3', 'codex', 't3')).baseline, null);
});

test('Codex: a finished compaction marks the snapshot until the next report; one with nothing measured is left alone', () => {
  const { svc, published } = service();
  const owner = ownerKey('chat-t1', 'codex', 't1');
  const compaction = (phase: string) => ({
    method: phase,
    params: { threadId: 't1', turnId: 'u', item: { type: 'contextCompaction', id: 'c' } },
  });
  svc.codexMessage(compaction('item/completed'));
  assert.equal(published.length, 0);
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage(600, 900) } });
  svc.codexMessage(compaction('item/started'));
  assert.equal(svc.get(owner).stale, null);
  svc.codexMessage(compaction('item/completed'));
  assert.equal(svc.get(owner).stale, 'compacted');
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage(100, 1000) } });
  assert.equal(svc.get(owner).stale, null);
});

test("ACP: a new session's first prompt sets the baseline, a loaded one's never; usage_update carries cost; turn usage adds once", () => {
  const { svc } = service();
  const key = 'acp:gemini:k1';
  const owner = ownerKey(`chat-${key}`, 'acp:gemini', key);
  svc.acpEvent({ key: 'claude:x', kind: 'session' });
  svc.acpEvent({ kind: 'session' });
  svc.acpEvent({ key, kind: 'session', fresh: true });
  svc.acpEvent({ key, kind: 'turnStart', user: { content: [{ type: 'text', text: 'y'.repeat(80) }] } });
  // replayed history (no prompt running) is not the first prompt's context
  svc.acpEvent({ key, kind: 'update', turnId: null, update: { sessionUpdate: 'usage_update', used: 5, size: 100 } });
  assert.equal(svc.get(owner).baseline, null);
  svc.acpEvent({
    key,
    kind: 'update',
    turnId: 'p1',
    update: { sessionUpdate: 'usage_update', used: 50, size: 100, cost: { amount: 0.25, currency: 'USD' } },
  });
  let s = svc.get(owner);
  assert.equal(s.baseline, 30);
  assert.deepEqual(s.cost, { amount: 0.25, currency: 'USD' });
  // an update without a count, or not about usage, changes nothing
  svc.acpEvent({ key, kind: 'update', turnId: 'p1', update: { sessionUpdate: 'usage_update', used: 'x' } });
  svc.acpEvent({ key, kind: 'update', turnId: 'p1', update: { sessionUpdate: 'plan' } });
  svc.acpEvent({ key, kind: 'turnEnd', turnId: 'p1', usage: { inputTokens: 10, outputTokens: 5 } });
  svc.acpEvent({ key, kind: 'turnEnd', turnId: 'p1', usage: { inputTokens: 10, outputTokens: 5 } });
  svc.acpEvent({ key, kind: 'turnEnd', turnId: 'p2', usage: null });
  s = svc.get(owner);
  assert.equal(s.session.totalTokens, 15);
  assert.equal(s.lastRequest.totalTokens, 15);
  // a turn with no id is added each time; the cost stands until another comes
  svc.acpEvent({ key, kind: 'turnEnd', usage: { totalTokens: 5 } });
  svc.acpEvent({ key, kind: 'update', turnId: 'p3', update: { sessionUpdate: 'usage_update', used: 60, size: null } });
  s = svc.get(owner);
  assert.equal(s.session.totalTokens, 20);
  assert.deepEqual(s.cost, { amount: 0.25, currency: 'USD' });
  assert.equal(s.window, null);
  // the second prompt's context is not a baseline, nor a loaded session's first
  svc.acpEvent({ key: 'acp:gemini:k2', kind: 'session', fresh: false });
  svc.acpEvent({ key: 'acp:gemini:k2', kind: 'turnStart', user: {} });
  svc.acpEvent({ key: 'acp:gemini:k2', kind: 'update', turnId: 'q', update: { sessionUpdate: 'usage_update', used: 70 } });
  assert.equal(svc.get(ownerKey('chat-acp:gemini:k2', 'acp:gemini', 'acp:gemini:k2')).baseline, null);
  // the counted turns stay bounded
  for (let i = 0; i < 40; i++) svc.acpEvent({ key, kind: 'turnEnd', turnId: `t${i}`, usage: { totalTokens: 1 } });
  assert.equal(svc.state(owner).counted.length, 32);
});

test("Claude Code: the chat's own result reports its tokens and reads the breakdown; a subagent's does neither", async () => {
  const asked: any[] = [];
  const { svc } = service({
    claude: async (key, detail) => {
      asked.push([key, detail]);
      return {
        totalTokens: 900,
        rawMaxTokens: 2000,
        categories: [{ name: 'Messages', tokens: 900, kind: 'used' }],
        isAutoCompactEnabled: true,
      };
    },
  });
  const key = 'claude:s1';
  const owner = ownerKey(`chat-${key}`, 'claude', key);
  svc.claudeEvent({ key, kind: 'closed' });
  svc.claudeEvent({ kind: 'message', msg: {} });
  svc.claudeEvent({ key, kind: 'message' });
  svc.claudeEvent({ key, kind: 'message', msg: { type: 'result', parent_tool_use_id: 'sub', usage: { input_tokens: 5 } } });
  assert.equal(svc.get(owner), null);
  svc.claudeEvent({
    key,
    kind: 'message',
    msg: { type: 'result', usage: { input_tokens: 700, output_tokens: 100 }, modelUsage: { m: { contextWindow: 2000 } } },
  });
  assert.equal(svc.get(owner).used, 800);
  assert.equal(svc.get(owner).session.totalTokens, 800);
  await flush();
  assert.deepEqual(asked, [[key, 'summary']]);
  let s = svc.get(owner);
  assert.equal(s.quality, 'breakdown');
  assert.equal(s.used, 900);
  // the next result adds to the session and counts the new tokens since the breakdown
  svc.claudeEvent({
    key,
    kind: 'message',
    msg: { type: 'result', usage: { input_tokens: 950, output_tokens: 50 }, modelUsage: { m: { contextWindow: 2000 } } },
  });
  s = svc.get(owner);
  assert.equal(s.session.totalTokens, 1800);
  assert.equal(s.used, 1000);
  assert.equal(s.breakdownUsed, 900);
});

test('Claude Code: a compaction or reset drops the read under way; a reset empties the snapshot but keeps the model', async () => {
  const reads: ReturnType<typeof deferred>[] = [];
  const { svc } = service({
    claude: () => {
      const d = deferred();
      reads.push(d);
      return d.promise;
    },
  });
  const key = 'claude:s1';
  const owner = ownerKey(`chat-${key}`, 'claude', key);
  const msg = (m: any) => svc.claudeEvent({ key, kind: 'message', msg: { session_id: 'sid', ...m } });
  const pending = svc.refresh(owner);
  msg({ type: 'system', subtype: 'compact_boundary' });
  reads[0].resolve({ totalTokens: 9, rawMaxTokens: 10 });
  assert.equal(await pending, null);
  assert.equal(svc.get(owner), null);
  // with a breakdown standing, a compaction marks it and a reset clears it
  const second = svc.refresh(owner);
  reads[1].resolve({ totalTokens: 5, rawMaxTokens: 10, model: 'opus' });
  await second;
  msg({ type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(svc.get(owner).stale, null);
  msg({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(svc.get(owner).stale, 'compacted');
  msg({ type: 'conversation_reset', new_conversation_id: 'n' });
  const s = svc.get(owner);
  assert.equal(s.used, null);
  assert.equal(s.model, 'opus');
  assert.equal(s.stale, null);
});

test('reads are one at a time per owner: an ask meanwhile is answered by the read after, the fuller detail winning', async () => {
  const reads: [string, ReturnType<typeof deferred>][] = [];
  const { svc } = service({
    claude: (_key, detail) => {
      const d = deferred();
      reads.push([detail, d]);
      return d.promise;
    },
  });
  const owner = ownerKey('c', 'claude', 'claude:s');
  const first = svc.refresh(owner);
  const second = svc.refresh(owner, 'full');
  const third = svc.refresh(owner);
  assert.equal(reads.length, 1);
  reads[0][1].resolve({ totalTokens: 1, rawMaxTokens: 10 });
  assert.equal((await first).used, 1);
  await flush();
  assert.equal(reads.length, 2);
  assert.equal(reads[1][0], 'full');
  reads[1][1].resolve({ totalTokens: 2, rawMaxTokens: 10 });
  assert.equal((await second).used, 2);
  assert.equal((await third).used, 2);
  await flush();
  assert.equal(reads.length, 2);
});

test('a failed read keeps a standing breakdown marked; with none it changes nothing; a later read clears the mark', async () => {
  clearIgnored();
  let answer: () => Promise<unknown> = async () => {
    throw new Error('closed');
  };
  const { svc } = service({ claude: () => answer() });
  const owner = ownerKey('c', 'claude', 'claude:s');
  assert.equal(await svc.refresh(owner), null);
  assert.equal(svc.get(owner), null);
  assert.ok(recentIgnored().some((e: any) => /context breakdown/.test(JSON.stringify(e))));
  answer = async () => ({ totalTokens: 3, rawMaxTokens: 10 });
  await svc.refresh(owner);
  answer = async () => {
    throw new Error('closed');
  };
  assert.equal((await svc.refresh(owner)).stale, 'refresh-failed');
  // a session that is not running answers nothing: the snapshot stands as it was
  answer = async () => null;
  assert.equal((await svc.refresh(owner)).stale, 'refresh-failed');
  answer = async () => ({ totalTokens: 4, rawMaxTokens: 10 });
  assert.equal((await svc.refresh(owner)).stale, null);
});

test('a failed read a newer one replaced is dropped too', async () => {
  const reads: ReturnType<typeof deferred>[] = [];
  const { svc } = service({
    claude: () => {
      const d = deferred();
      reads.push(d);
      return d.promise;
    },
  });
  const key = 'claude:s';
  const owner = ownerKey(`chat-${key}`, 'claude', key);
  const first = svc.refresh(owner);
  reads[0].resolve({ totalTokens: 3, rawMaxTokens: 10 });
  await first;
  const second = svc.refresh(owner);
  svc.claudeEvent({ key, kind: 'message', msg: { session_id: 'x', type: 'system', subtype: 'compact_boundary' } });
  reads[1].reject(new Error('late'));
  assert.equal((await second).stale, 'compacted');
});

test('a harness with no reader answers with the snapshot as it stands; a bad owner with nothing', async () => {
  const { svc } = service({ claude: async () => ({}) });
  assert.equal(await svc.refresh('nope'), null);
  const owner = ownerKey('chat-t', 'codex', 't');
  assert.equal(await svc.refresh(owner, 'full'), null);
  svc.codexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't', tokenUsage: usage(1, 1) } });
  assert.equal((await svc.refresh(owner)).used, 1);
  // a harness named like an Object property is not a reader
  assert.equal(await svc.refresh(ownerKey('c', 'toString', 'x')), null);
});

test('an again-read that fails is noted, not thrown', async () => {
  clearIgnored();
  const reads: ReturnType<typeof deferred>[] = [];
  const { svc } = service({
    claude: () => {
      const d = deferred();
      reads.push(d);
      return d.promise;
    },
  });
  const owner = ownerKey('c', 'claude', 'claude:s');
  const first = svc.refresh(owner);
  svc.refresh(owner);
  // the read after the first throws before it starts
  svc.read = () => Promise.reject(new Error('boom'));
  reads[0].resolve({ totalTokens: 1, rawMaxTokens: 10 });
  await first;
  await flush();
  assert.ok(recentIgnored().some((e: any) => /again/.test(JSON.stringify(e))));
});

test('ACP: a fresh session empties what the one before it measured; a session reopened keeps it', () => {
  const { svc } = service();
  const key = 'acp:kimi:k';
  const owner = ownerKey(`chat-${key}`, 'acp:kimi', key);
  svc.acpEvent({ key, kind: 'session', fresh: true });
  assert.equal(svc.get(owner), null);
  svc.acpEvent({ key, kind: 'turnStart', user: {} });
  svc.acpEvent({ key, kind: 'update', turnId: 't', update: { sessionUpdate: 'usage_update', used: 40, size: 100 } });
  svc.acpEvent({ key, kind: 'turnEnd', turnId: 't', usage: { totalTokens: 9 } });
  assert.equal(svc.get(owner).baseline, 40);
  svc.acpEvent({ key, kind: 'session', fresh: false });
  assert.equal(svc.get(owner).session.totalTokens, 9);
  svc.acpEvent({ key, kind: 'session', fresh: true });
  const s = svc.get(owner);
  assert.equal(s.used, null);
  assert.equal(s.session, null);
  assert.equal(s.baseline, null);
  // the same turn id in the new session counts again
  svc.acpEvent({ key, kind: 'turnEnd', turnId: 't', usage: { totalTokens: 2 } });
  assert.equal(svc.get(owner).session.totalTokens, 2);
});

test('Claude Code: a result never moves the window its breakdown named', async () => {
  const { svc } = service({ claude: async () => ({ totalTokens: 100, rawMaxTokens: 1_000_000 }) });
  const key = 'claude:w';
  const owner = ownerKey(`chat-${key}`, 'claude', key);
  const result = { type: 'result', usage: { input_tokens: 200 }, modelUsage: { haiku: { contextWindow: 200_000 } } };
  svc.claudeEvent({ key, kind: 'message', msg: result });
  assert.equal(svc.get(owner).window, 200_000);
  await flush();
  assert.equal(svc.get(owner).window, 1_000_000);
  svc.claudeEvent({ key, kind: 'message', msg: result });
  assert.equal(svc.get(owner).window, 1_000_000);
});

test('a read that does not answer in time fails, and the next read runs', async () => {
  clearIgnored();
  let hang = true;
  const { svc } = service(
    { claude: () => (hang ? new Promise(() => {}) : Promise.resolve({ totalTokens: 2, rawMaxTokens: 10 })) },
    { summary: 5, full: 5 },
  );
  const owner = ownerKey('c', 'claude', 'claude:s');
  assert.equal(await svc.refresh(owner), null);
  assert.ok(recentIgnored().some((e: any) => /no answer in/.test(JSON.stringify(e))));
  hang = false;
  assert.equal((await svc.refresh(owner, 'full')).used, 2);
});

test('read state is kept for the most recent owners only, never one with a read under way', async () => {
  const pending = deferred();
  const { svc } = service({ claude: () => pending.promise });
  const busy = ownerKey('c', 'claude', 'claude:busy');
  const reading = svc.refresh(busy);
  for (let i = 0; i < 1001; i++) svc.state(`o${i}`);
  assert.equal(svc.owners.has(busy), true);
  assert.equal(svc.owners.has('o0'), false);
  assert.equal(svc.owners.size, 1000);
  pending.resolve(null);
  await reading;
});
