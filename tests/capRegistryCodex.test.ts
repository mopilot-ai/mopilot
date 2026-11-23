// Edge cases of the capability registry, the Codex server-request chain and the Codex tool injection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry, OperationLog, ToolError, checkArgs, toContent } = require('../electron/capabilities/contract/registry.cjs');
const {
  rejectNativeCuaElicitation,
  codexServerRequests,
  toolCallResponse,
} = require('../electron/capabilities/contract/serverRequests.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

/* -- registry --------------------------------------------------------- */
test('checkArgs: no schema passes; null, integers, arrays and non-objects are typed precisely', () => {
  assert.equal(checkArgs(null, 'anything'), null);
  assert.equal(checkArgs({}, 'x'), 'arguments must be an object');
  assert.equal(checkArgs({}, null), 'arguments must be an object');
  assert.equal(checkArgs({ properties: { n: { type: 'number' } } }, { n: 3 }), null);
  assert.equal(checkArgs({ properties: { n: { type: 'string' } } }, { n: 3 }), 'argument n must be string');
  assert.equal(checkArgs({ properties: { n: { type: ['string', 'null'] } } }, { n: null }), null);
  assert.equal(checkArgs({ properties: { n: {} } }, { n: [1] }), null);
  assert.equal(checkArgs({ properties: { n: { type: 'object' } } }, { n: [1] }), 'argument n must be object');
  assert.equal(checkArgs({}, {}), null);
});

test('toContent: nothing, content items, nested lists and plain objects', () => {
  assert.deepEqual(toContent(null), []);
  assert.deepEqual(toContent(['a', null, { type: 'image', data: 'd' }]), [
    { type: 'text', text: 'a' },
    { type: 'image', data: 'd' },
  ]);
  assert.deepEqual(toContent({ content: [{ type: 'text', text: 't' }] }), [{ type: 'text', text: 't' }]);
  assert.deepEqual(toContent({ a: 1 }), [{ type: 'text', text: '{"a":1}' }]);
  // half of an emoji (a page or label cut short somewhere) would break the harness's JSON: it reads as U+FFFD
  assert.deepEqual(toContent('page text \uD83D'), [{ type: 'text', text: 'page text \uFFFD' }]);
  assert.deepEqual(toContent({ type: 'text', text: '\uDE42 ok 🙂' }), [{ type: 'text', text: '\uFFFD ok 🙂' }]);
  assert.deepEqual(toContent({ label: 'a\uD83D', n: 1 }), [{ type: 'text', text: '{"label":"a\uFFFD","n":1}' }]);
  assert.deepEqual(toContent({ type: 'image', data: 'd' }), [{ type: 'image', data: 'd' }]);
});

test('a failed call never carries half of an emoji in its message', async () => {
  const r = new Registry({ approve: async () => true });
  r.register({
    name: 'cut',
    policy: 'observe',
    handler: () => {
      throw new ToolError('title "ab\uD83D"', 'failed');
    },
  });
  const res = await r.invoke('c', 's', 'cut', {});
  assert.equal(res.error.message, 'title "ab\uFFFD"');
});

test('OperationLog: keeps the newest entries and swallows a failing append', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-oplog-'));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, '');
  const log = new OperationLog({ file: path.join(blocker, 'sub', 'ops.jsonl'), max: 2 });
  log.add({ n: 1 });
  log.add({ n: 2 });
  log.add({ n: 3 });
  assert.deepEqual(log.recent(), [{ n: 2 }, { n: 3 }]);
  const ok = new OperationLog({ file: path.join(dir, 'ops.jsonl') });
  ok.add({ n: 1 });
  assert.equal(fs.readFileSync(path.join(dir, 'ops.jsonl'), 'utf8'), '{"n":1}\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invoke: a handler’s answer that ends the turn is flagged on the result, and the flag is not part of the answer', async () => {
  const r = new Registry();
  r.register({ name: 'end', policy: 'observe', handler: () => ({ endsTurn: true, shown: true }) });
  r.register({ name: 'not', policy: 'observe', handler: () => ({ endsTurn: false, shown: false }) });
  r.register({ name: 'list', policy: 'observe', handler: () => ['a'] });
  const ended = await r.invoke('c', 's', 'end', {});
  assert.deepEqual([ended.endsTurn, ended.content], [true, [{ type: 'text', text: '{"shown":true}' }]]);
  const plain = await r.invoke('c', 's', 'not', {});
  assert.deepEqual(['endsTurn' in plain, plain.content], [false, [{ type: 'text', text: '{"endsTurn":false,"shown":false}' }]]);
  assert.equal('endsTurn' in (await r.invoke('c', 's', 'list', {})), false);
});

test('register: a missing tool or a nameless one is a bad name', () => {
  const r = new Registry();
  assert.throws(() => r.register(null), /bad tool name: null/);
  assert.throws(() => r.register({ policy: 'observe', handler() {} }), /bad tool name: undefined/);
});

test('invoke: a repeated call id gets the first result; the oldest remembered call is forgotten past the cap', async () => {
  let runs = 0;
  const r = new Registry();
  r.register({ name: 't', policy: 'observe', handler: () => `run ${++runs}` });
  const a = await r.invoke('c', 's', 't', {}, { callId: 1 });
  const b = await r.invoke('c', 's', 't', {}, { callId: 1 });
  assert.equal(a, b);
  assert.equal(runs, 1);
  r.maxCalls = 1;
  await r.invoke('c', 's', 't', undefined, { callId: 2 });
  assert.deepEqual([...r.calls.keys()], [JSON.stringify(['c', 's', '2'])]);
});

test("invoke: an approver that throws fails closed as unavailable (not the user's denial); thrown strings and coded errors keep their message", async () => {
  const r = new Registry({
    approve: () => {
      throw new Error('boom');
    },
  });
  r.register({ name: 'act', policy: 'act', handler: () => 'x' });
  r.register({
    name: 'str',
    policy: 'observe',
    handler: () => {
      throw 'plain';
    },
  });
  r.register({
    name: 'coded',
    policy: 'observe',
    handler: () => {
      throw new ToolError('nope', 'custom');
    },
  });
  r.register({
    name: 'uncoded',
    policy: 'observe',
    handler: () => {
      throw new ToolError('nope');
    },
  });
  r.register({ name: 'loose', policy: 'observe', schema: null, handler: (a: any) => a });
  assert.deepEqual((await r.invoke('c', 's', 'act', {})).error, {
    code: 'unavailable',
    message: "Couldn't ask the user to allow this action: boom",
  });
  assert.deepEqual((await r.invoke('c', 's', 'str', {})).error, { code: 'failed', message: 'plain' });
  assert.equal((await r.invoke('c', 's', 'coded', {})).error.code, 'custom');
  assert.equal((await r.invoke('c', 's', 'uncoded', {})).error.code, 'failed');
  assert.deepEqual((await r.invoke('c', 's', 'loose', 'text')).content, [{ type: 'text', text: 'text' }]);
  // the log keeps argument names only, and none for arguments that aren't an object
  assert.deepEqual(r.log.recent(1)[0].argKeys, []);
  assert.equal(r.running.size, 0);
});

test('invoke: two calls of a chat run together; abortChat ends both, the set is dropped when the last ends', async () => {
  const r = new Registry();
  r.register({ name: 'slow', policy: 'observe', handler: () => new Promise(() => {}) });
  r.register({ name: 'quick', policy: 'observe', handler: () => new Promise((res) => setTimeout(() => res('done'), 5)) });
  const slow = r.invoke('c', 's', 'slow', {});
  const quick = r.invoke('c', 's', 'quick', {});
  assert.equal((await quick).ok, true);
  assert.equal(r.running.get('c').size, 1);
  assert.equal(r.abortChat('c'), 1);
  assert.equal((await slow).error.code, 'aborted');
  assert.equal(r.abortChat('c'), 0);
});

/* -- server requests -------------------------------------------------- */
test('rejectNativeCuaElicitation: a request without params is not ours', () => {
  const sent: any[] = [];
  const h = rejectNativeCuaElicitation({ send: (m: any) => sent.push(m), notify() {} });
  assert.equal(h({ id: 1, method: 'mcpServer/elicitation/request' }), false);
  assert.deepEqual(sent, []);
});

test('toolCallResponse: an image without a url is a data URL, png unless it says otherwise; no content is fine', () => {
  assert.deepEqual(
    toolCallResponse({
      ok: true,
      content: [
        null,
        { type: 'image', data: 'AA' },
        { type: 'image', data: 'BB', mimeType: 'image/jpeg' },
        { type: 'image', url: 'http://i' },
        { type: 'other' },
      ],
    }).contentItems,
    [
      { type: 'inputImage', imageUrl: 'data:image/png;base64,AA' },
      { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,BB' },
      { type: 'inputImage', imageUrl: 'http://i' },
    ],
  );
  assert.deepEqual(toolCallResponse({ ok: false, error: { message: 'bad' } }), {
    contentItems: [{ type: 'inputText', text: 'bad' }],
    success: false,
  });
});

test('codexServerRequests: a request without params is answered as unsupported', () => {
  const sent: any[] = [];
  const h = codexServerRequests({ send: (m: any) => sent.push(m), registry: { has: () => false } });
  assert.equal(h({ id: 3, method: 'some/request' }), true);
  assert.deepEqual(sent, [{ id: 3, error: { code: -32601, message: 'Not supported by this client' } }]);
});

/* -- codex tool injection --------------------------------------------- */
function injection() {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({ sessions, command: 'c', socketPath: '/s', harnessPid: () => undefined });
  return { sessions, inj };
}

test('codex injection: no params, no pid, a junk user-server list', () => {
  const { sessions, inj } = injection();
  inj.setUserServers('node_repl');
  assert.deepEqual(inj.userServers, []);
  const out = inj.outgoing({ id: 1, method: 'thread/start' });
  assert.ok(Object.keys(out.params.config.mcp_servers)[0].startsWith('sage_'));
  const { key } = inj.pending.get(1);
  assert.equal(sessions.get(key).harnessPid, null);
  assert.equal(inj.observe(null), false);
});

test('codex injection: a failed resume of a known thread suspends its session rather than ending it', () => {
  const { sessions, inj } = injection();
  inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  inj.observe({ id: 1, result: { thread: { id: 't' } } });
  const key = inj.byThread.get('t');
  inj.observe({ method: 'thread/closed', params: { threadId: 't' } });
  inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 't' } });
  assert.equal(inj.byThread.get('t'), key);
  inj.observe({ id: 2, error: { message: 'no' } });
  assert.notEqual(sessions.get(key), null);
  // a resume of a thread whose session is gone opens a new one
  sessions.end(key);
  inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 't' } });
  assert.notEqual(inj.byThread.get('t'), key);
});

test("codex injection: with the node_repl switch off the user's node_repl stays on", () => {
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: 'c',
    socketPath: '/s',
    harnessPid: () => 1,
    disableUserNodeRepl: () => false,
  });
  inj.setUserServers(['node_repl']);
  const out = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  assert.equal(out.params.config.mcp_servers.node_repl, undefined);
});

test('codex injection: a deleted thread ends its session; exit ends sessions still waiting for an answer', () => {
  const { sessions, inj } = injection();
  inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  inj.observe({ id: 1, result: { thread: { id: 't' } } });
  const key = inj.byThread.get('t');
  inj.observe({ method: 'thread/deleted', params: { threadId: 't' } });
  assert.equal(sessions.get(key), null);
  assert.equal(inj.byThread.has('t'), false);
  inj.outgoing({ id: 2, method: 'thread/start', params: {} });
  const waiting = inj.pending.get(2).key;
  inj.exited();
  assert.equal(sessions.get(waiting), null);
  assert.equal(inj.pending.size, 0);
});

test('wrapped tool content follows the same normalization as a bare list', () => {
  const image = { type: 'image', data: 'AA' };
  const content = [null, 'Kept', [null, image], 42];
  assert.deepEqual(toContent({ content }), toContent(content));
  assert.deepEqual(toContent({ content: [{ content }] }), toContent(content));
});

test('a real registry result with a null block still answers the Codex request', async () => {
  const registry = new Registry();
  registry.register({ name: 'partial', policy: 'observe', handler: () => ({ content: [null, { type: 'text', text: 'Kept' }] }) });
  let timer: ReturnType<typeof setTimeout>;
  const reply = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('tool request was left unanswered')), 100);
    const handle = codexServerRequests({ registry, send: resolve });
    assert.equal(handle({ id: 'request', method: 'item/tool/call', params: { threadId: 'thread', tool: 'partial' } }), true);
  });
  try {
    assert.deepEqual(await reply, { id: 'request', result: { success: true, contentItems: [{ type: 'inputText', text: 'Kept' }] } });
  } finally {
    clearTimeout(timer!);
  }
});

test('typed tool blocks cannot carry invalid text while plain numeric results still work', () => {
  const content = [
    { type: 'text', text: 42 },
    { type: 'text', text: null },
    { type: 'text', text: 'Kept' },
  ];
  assert.deepEqual(toContent({ content }), [
    { type: 'text', text: '' },
    { type: 'text', text: 'Kept' },
  ]);
  assert.deepEqual(toContent(42), [{ type: 'text', text: '42' }]);
});

test('invoke keeps opaque chat, segment and call identities separate', async () => {
  let runs = 0;
  const r = new Registry();
  r.register({ name: 'tuple', policy: 'observe', handler: () => ++runs });
  const first = await r.invoke('a', 'b\0c', 'tuple', {}, { callId: 'd' });
  const second = await r.invoke('a\0b', 'c', 'tuple', {}, { callId: 'd' });
  const third = await r.invoke('a', 'b', 'tuple', {}, { callId: 'c\0d' });
  assert.equal(runs, 3);
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  assert.equal(await r.invoke('a', 'b\0c', 'tuple', {}, { callId: 'd' }), first);
});
