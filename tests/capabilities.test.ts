// The capability registry and main's single handler for app-server requests.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { Registry, OperationLog } = require('../electron/capabilities/contract/registry.cjs');
const { InterceptChain, codexServerRequests, RENDERER_METHODS } = require('../electron/capabilities/contract/serverRequests.cjs');
const debugTools = require('../electron/capabilities/tools/debug.cjs');

test('register checks the name, policy and handler', () => {
  const r = new Registry();
  assert.throws(() => r.register({ name: 'bad name', policy: 'observe', handler: () => {} }), /bad tool name/);
  assert.throws(() => r.register({ name: 't', policy: 'maybe', handler: () => {} }), /policy/);
  assert.throws(() => r.register({ name: 't', policy: 'act' }), /no handler/);
  const off = r.register({ name: 't', policy: 'act', handler: () => 'x' });
  assert.throws(() => r.register({ name: 't', policy: 'act', handler: () => 'x' }), /already registered/);
  assert.deepEqual(
    r.list().map((t: any) => [t.name, t.policy]),
    [['t', 'act']],
  );
  off();
  assert.equal(r.has('t'), false);
});

test('invoke runs the tool and records the chat and segment on the result', async () => {
  const r = new Registry();
  r.register(debugTools.echo);
  const res = await r.invoke('chat-1', 'seg-2', 'sage_debug_echo', { text: 'hello' });
  assert.deepEqual(res, {
    chatId: 'chat-1',
    segmentId: 'seg-2',
    tool: 'sage_debug_echo',
    callId: null,
    ok: true,
    content: [{ type: 'text', text: 'echo: hello' }],
  });
});

test('invoke checks arguments, unknown tools and the owner without throwing', async () => {
  const r = new Registry();
  r.register(debugTools.echo);
  assert.equal((await r.invoke('c', 's', 'sage_debug_echo', {})).error.code, 'bad_args');
  assert.equal((await r.invoke('c', 's', 'sage_debug_echo', { text: 3 })).error.code, 'bad_args');
  assert.equal((await r.invoke('c', 's', 'nope', {})).error.code, 'unknown_tool');
  assert.equal((await r.invoke('', 's', 'sage_debug_echo', { text: 'x' })).error.code, 'no_owner');
  r.register({
    name: 'boom',
    policy: 'observe',
    handler: () => {
      throw new Error('broke');
    },
  });
  assert.deepEqual((await r.invoke('c', 's', 'boom', {})).error, { code: 'failed', message: 'broke' });
});

test('a call id runs once, however many times it is invoked', async () => {
  const r = new Registry();
  let runs = 0;
  r.register({ name: 'count', policy: 'observe', handler: async () => `run ${++runs}` });
  const [a, b] = await Promise.all([
    r.invoke('c', 's', 'count', {}, { callId: 'call-1' }),
    r.invoke('c', 's', 'count', {}, { callId: 'call-1' }),
  ]);
  const c = await r.invoke('c', 's', 'count', {}, { callId: 'call-1' });
  assert.equal(runs, 1);
  assert.deepEqual([a.content, b.content, c.content], Array(3).fill([{ type: 'text', text: 'run 1' }]));
  await r.invoke('c', 's', 'count', {}, { callId: 'call-2' });
  assert.equal(runs, 2);
});

test('act and irreversible tools ask the approval hook; observe tools do not', async () => {
  const asked: any[] = [];
  const r = new Registry();
  r.register({ name: 'look', policy: 'observe', handler: () => 'seen' });
  r.register({ name: 'click', policy: 'act', handler: () => 'clicked' });
  r.register({ name: 'send', policy: 'irreversible', handler: () => 'sent' });
  // no hook: anything that acts is refused
  assert.equal((await r.invoke('c', 's', 'click', {})).error.code, 'denied');
  r.setApprover((req: any) => {
    asked.push([req.tool, req.policy, req.chatId]);
    return req.tool === 'click';
  });
  assert.equal((await r.invoke('c', 's', 'look', {})).ok, true);
  assert.equal((await r.invoke('c', 's', 'click', {})).ok, true);
  assert.equal((await r.invoke('c', 's', 'send', {})).error.code, 'denied');
  assert.deepEqual(asked, [
    ['click', 'act', 'c'],
    ['send', 'irreversible', 'c'],
  ]);
});

test("an approval prompt that can't be shown fails closed as unavailable, not as the user's refusal", async () => {
  const r = new Registry();
  let ran = 0;
  r.register({ name: 'click', policy: 'act', handler: () => ran++ });
  r.setApprover(async () => {
    throw new Error('no window to ask in');
  });
  const out = await r.invoke('c', 's', 'click', {});
  assert.deepEqual(out.error, { code: 'unavailable', message: "Couldn't ask the user to allow this action: no window to ask in" });
  assert.equal(ran, 0);
});

test('an operation log that cannot be written keeps the entry in memory and records why', async () => {
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-log-'));
  try {
    clearIgnored();
    // the log file's path is a directory: appending fails
    const r = new Registry({ log: new OperationLog({ file: dir }) });
    r.register({ name: 'look', policy: 'observe', handler: () => 'ok' });
    assert.equal((await r.invoke('c', 's', 'look', {})).ok, true);
    assert.equal(r.log.recent().length, 1);
    // the failure comes back on the core's stream
    await waitFor(() => recentIgnored().length > 0, 'the write failure');
    assert.deepEqual(
      recentIgnored().map((e: any) => e.context),
      ['append to the tool operation log'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the operation log is local and keeps argument names, not values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-log-'));
  try {
    const file = path.join(dir, 'ops', 'operations.jsonl');
    const r = new Registry({ log: new OperationLog({ file }), now: () => 1000 });
    r.register({ name: 'type', policy: 'observe', handler: () => ({ type: 'image', data: 'AAAA', mimeType: 'image/png' }) });
    await r.invoke('c', 's', 'type', { text: 'my secret words' });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('secret') && !text.includes('AAAA'));
    assert.deepEqual(JSON.parse(text), {
      at: 1000,
      chatId: 'c',
      segmentId: 's',
      tool: 'type',
      policy: 'observe',
      argKeys: ['text'],
      outcome: 'ok',
      ms: 0,
      phases: { screen: [0, 1] },
    });
    assert.equal(r.log.recent().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the intercept chain lets several handlers coexist; the first to take a message wins', () => {
  const chain = new InterceptChain();
  const seen: string[] = [];
  chain.add((m: any) => (seen.push('accounts'), m.method === 'account/chatgptAuthTokens/refresh'));
  const off = chain.add((m: any) => (seen.push('sage'), m.method === 'item/tool/call'));
  assert.equal(chain.handle({ id: 1, method: 'account/chatgptAuthTokens/refresh' }), true);
  assert.deepEqual(seen, ['accounts']);
  assert.equal(chain.handle({ id: 2, method: 'item/tool/call' }), true);
  assert.deepEqual(seen, ['accounts', 'accounts', 'sage']);
  off();
  assert.equal(chain.handle({ id: 3, method: 'item/tool/call' }), false);
  // a handler that throws doesn't stop the chain
  chain.add(() => {
    throw new Error('x');
  });
  chain.add(() => true);
  assert.equal(chain.handle({ method: 'anything' }), true);
  // a message without a method breaks a handler that expects one; the next still takes it
  assert.equal(chain.handle(null), true);
});

/**
 * A stand-in for main's AppServer: the intercept chain first, then the message goes to every window,
 * as main.cjs does. Each window does what the renderer does now: it keeps approval cards and answers
 * nothing by itself.
 */
function harness(windows: number) {
  const sent: any[] = [];
  const registry = new Registry();
  registry.register(debugTools.echo);
  const chain = new InterceptChain();
  // accounts.cjs's link, then the Sage one, in main's order
  chain.add((m: any) => {
    if (m.method !== 'account/chatgptAuthTokens/refresh') return false;
    sent.push({ id: m.id, result: { accessToken: 't' } });
    return true;
  });
  chain.add(codexServerRequests({ send: (m: any) => sent.push(m), registry }));
  const cards: any[][] = Array.from({ length: windows }, () => []);
  const deliver = (msg: any) => {
    if (chain.handle(msg)) return;
    cards.forEach((w) => msg.method && msg.id != null && RENDERER_METHODS.has(msg.method) && w.push(msg.id));
  };
  return { sent, cards, deliver };
}

test('with 3 windows open, an item/tool/call is answered once, by main', async () => {
  const h = harness(3);
  h.deliver({
    id: 7,
    method: 'item/tool/call',
    params: { threadId: 'th', turnId: 'tu', callId: 'k', namespace: null, tool: 'sage_debug_echo', arguments: { text: 'pineapple' } },
  });
  await tick();
  assert.deepEqual(h.sent, [{ id: 7, result: { contentItems: [{ type: 'inputText', text: 'echo: pineapple' }], success: true } }]);
  assert.deepEqual(h.cards, [[], [], []]);
});

test('with 3 windows open, unknown requests and unknown tools get one -32601', async () => {
  const h = harness(3);
  h.deliver({ id: 1, method: 'attestation/generate', params: {} });
  h.deliver({ id: 2, method: 'item/tool/call', params: { threadId: 'th', callId: 'k', tool: 'not_ours', arguments: {} } });
  h.deliver({ id: 3, method: 'account/chatgptAuthTokens/refresh', params: {} });
  await tick();
  assert.deepEqual(
    h.sent.map((m) => [m.id, m.error?.code ?? 'ok']),
    [
      [1, -32601],
      [2, -32601],
      [3, 'ok'],
    ],
  );
  assert.deepEqual(h.cards, [[], [], []]);
});

test('approval requests still reach every window, and main does not answer them', async () => {
  const h = harness(3);
  h.deliver({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'th' } });
  // notifications and responses pass through untouched
  h.deliver({ method: 'turn/started', params: {} });
  h.deliver({ id: 4, result: {} });
  await tick();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.cards, [[9], [9], [9]]);
});

test('a failed tool call comes back as success: false with the reason', async () => {
  const h = harness(1);
  h.deliver({ id: 5, method: 'item/tool/call', params: { threadId: 'th', callId: 'k', tool: 'sage_debug_echo', arguments: {} } });
  await tick();
  assert.deepEqual(h.sent, [{ id: 5, result: { contentItems: [{ type: 'inputText', text: 'missing argument: text' }], success: false } }]);
});

const { ToolSessions, isSageTool } = require('../electron/capabilities/contract/session.cjs');

test('each session gets its own random sage_<nonce> server name and token', () => {
  const s = new ToolSessions();
  const a = s.open('a', { harnessPid: 10 });
  const b = s.open('b', { harnessPid: 11, chatId: 'chat-b', segmentId: 'seg-b' });
  assert.match(a.serverName, /^sage_[0-9a-f]{12}$/);
  assert.notEqual(a.serverName, b.serverName);
  assert.notEqual(a.token, b.token);
  const rb = s.resolve(b.token);
  assert.deepEqual([rb.key, rb.serverName, rb.chatId, rb.segmentId, rb.harnessPid], ['b', b.serverName, 'chat-b', 'seg-b', 11]);
  assert.equal(s.resolve('nope'), null);
  assert.equal(s.resolve(undefined), null);
  // opening the same key again is a new session: a new name, and the old token is dead
  const a2 = s.open('a', { harnessPid: 10 });
  assert.notEqual(a2.serverName, a.serverName);
  assert.equal(s.resolve(a.token), null);
});

test('resume rotates the token under the same name; the end of a session revokes it', () => {
  const s = new ToolSessions();
  const revoked: string[] = [];
  s.on('revoked', (e: any) => revoked.push(e.key));
  const first = s.open('t', { harnessPid: 1 });
  const second = s.rotate('t', { harnessPid: 2 });
  assert.equal(second.serverName, first.serverName);
  assert.notEqual(second.token, first.token);
  assert.equal(s.resolve(first.token), null);
  assert.equal(s.resolve(second.token).harnessPid, 2);
  assert.equal(s.rotate('unknown'), null);
  s.end('t');
  assert.equal(s.resolve(second.token), null);
  assert.equal(s.get('t'), null);
  assert.deepEqual(revoked, ['t', 't']);
});

test("allow rules match only the session's random server name", () => {
  const s = new ToolSessions();
  const { serverName } = s.open('k');
  assert.equal(isSageTool(`mcp__${serverName}__sage_debug_echo`, serverName), true);
  // a repo's own MCP server called "sage" is not MoPilot's
  assert.equal(isSageTool('mcp__sage__sage_debug_echo', serverName), false);
  assert.equal(isSageTool('mcp__sage__sage_debug_echo', 'sage'), false);
  assert.equal(isSageTool(`mcp__${serverName}x__t`, serverName), false);
  assert.equal(isSageTool(`mcp__${serverName}__`, serverName), false);
  assert.equal(isSageTool('mcp__sage_000000000000__t', serverName), false);
  assert.equal(isSageTool('Bash', serverName), false);
});

test('abortChat: a harness that quit stops the calls still running for its chat, and only those', async () => {
  const r = new Registry();
  const seen = new Map<string, AbortSignal>();
  r.register({
    name: 'slow',
    policy: 'observe',
    handler: (_a: any, ctx: any) => {
      seen.set(ctx.chatId, ctx.signal);
      return new Promise((res) => setTimeout(() => res('done'), 50));
    },
  });
  const mine = r.invoke('chat1', 'seg1', 'slow', {}, { callId: 'a' });
  const other = r.invoke('chat2', 'seg2', 'slow', {}, { callId: 'b' });
  await new Promise((res) => setImmediate(res));
  assert.equal(r.abortChat('chat1'), 1);
  const res = await mine;
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'aborted');
  assert.equal(seen.get('chat1')?.aborted, true);
  assert.equal(seen.get('chat2')?.aborted, false);
  assert.equal((await other).ok, true);
  assert.equal(r.abortChat('chat1'), 0);
  assert.match(res.error.message, /harness quit/);
});

/** A Registry with one tool that runs until its signal aborts (a browser_batch, a computer-use action). */
function untilAborted() {
  const r = new Registry();
  const signals: AbortSignal[] = [];
  r.register({
    name: 'wait',
    policy: 'observe',
    handler: (_a: any, ctx: any) => {
      signals.push(ctx.signal);
      return new Promise(() => {});
    },
  });
  return { r, signals };
}

test("abortChat 'stopped': a Stop ends the chat's running calls and says the turn was stopped", async () => {
  const { r, signals } = untilAborted();
  const call = r.invoke('c', 's', 'wait', {});
  await new Promise((res) => setImmediate(res));
  assert.equal(r.abortChat('c', 'stopped'), 1);
  const res = await call;
  assert.equal(res.error.code, 'aborted');
  assert.equal(res.error.message, 'The turn was stopped before this finished');
  assert.equal(signals[0].aborted, true);
});

test("invoke: the harness's cancel signal for one call aborts that call only", async () => {
  const { r, signals } = untilAborted();
  const cancel = new AbortController();
  const call = r.invoke('c', 's', 'wait', {}, { callId: 'x', signal: cancel.signal });
  const other = r.invoke('c', 's', 'wait', {}, { callId: 'y' });
  await new Promise((res) => setImmediate(res));
  cancel.abort();
  const res = await call;
  assert.equal(res.error.code, 'aborted');
  assert.equal(res.error.message, 'The harness cancelled this call before it finished');
  assert.deepEqual(
    signals.map((s) => s.aborted),
    [true, false],
  );
  assert.equal(r.running.get('c')?.size, 1, 'the other call still runs');
  // a signal already aborted when the call arrives never lets it run on
  const late = await r.invoke('c', 's', 'wait', {}, { signal: AbortSignal.abort() });
  assert.equal(late.error.code, 'aborted');
  assert.equal(r.abortChat('c'), 1);
  assert.equal((await other).error.code, 'aborted');
});

test('invoke: a finished call stops listening to its cancel signal', async () => {
  const r = new Registry();
  r.register({ name: 'quick', policy: 'observe', handler: () => 'ok' });
  const cancel = new AbortController();
  const removed = mock.method(cancel.signal, 'removeEventListener');
  assert.equal((await r.invoke('c', 's', 'quick', {}, { signal: cancel.signal })).ok, true);
  assert.equal(removed.mock.callCount(), 1);
  cancel.abort();
  assert.equal(r.running.has('c'), false);
});

test('a refusal that pauses a turn keeps its reason, while the other calls still abort', async () => {
  const { recordRefusal, guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
  const r = new Registry();
  let begin!: () => void;
  const ready = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const signals: AbortSignal[] = [];
  r.register({
    name: 'other',
    policy: 'observe',
    handler: (_args: any, ctx: any) => {
      signals.push(ctx.signal);
      return new Promise(() => {});
    },
  });
  r.register({
    name: 'refusal',
    policy: 'observe',
    handler: async (_args: any, ctx: any) => {
      signals.push(ctx.signal);
      await ready;
      return guarded({ epoch: () => 0 }, () => {
        recordRefusal('unattended', 'Nobody is here to allow Notes');
        r.abortChat('c', 'stopped');
        return new Promise(() => {});
      });
    },
  });
  const other = r.invoke('c', 's', 'other', {});
  const refused = r.invoke('c', 's', 'refusal', {}, { callId: 'once' });
  begin();
  assert.deepEqual((await refused).error, { code: 'unattended', message: 'Nobody is here to allow Notes' });
  assert.equal((await other).error.code, 'aborted');
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(r.running.size, 0);
  assert.equal(await r.invoke('c', 's', 'refusal', {}, { callId: 'once' }), await refused);
  recordRefusal('unattended', 'outside a call');
  guarded({}, () => recordRefusal('unattended', 'no observer'));
  let reports = 0;
  guarded({ signal: AbortSignal.abort(), onRefusal: () => reports++ }, () => recordRefusal('unattended', 'too late'));
  assert.equal(reports, 0);
});
