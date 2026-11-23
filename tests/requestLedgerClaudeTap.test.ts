// The request ledger's Claude Code tap (electron/ledger/claudeTap.cjs): the CLI's stream becomes one line per model request with the
// account the session runs on, for success, retry, error and a stop, across parallel subagents. The Codex tap is in
// tests/requestLedgerTaps.test.ts; each line's request key and payment in tests/requestLedgerCost.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClaudeLedgerTap } = require('../electron/ledger/claudeTap.cjs');

const ACCOUNT = { id: 'acct-1', email: 'work@example.com', verified: true };
function claudeTap(account: any = ACCOUNT) {
  const out: any[] = [];
  const asked: any[] = [];
  const tap = new ClaudeLedgerTap({
    record: (r: any) => out.push(r),
    chatOf: (key: string) => `chat-of-${key}`,
    accountOf: (evt: any) => (asked.push(evt.account), account),
  });
  const send = (msg: any, key = 'claude:s1') => tap.event({ key, kind: 'message', msg, login: true, account: 'b1' });
  return { tap, out, asked, send };
}
const assistant = (id: string, o: any = {}) => ({
  type: 'assistant',
  message: {
    id,
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: 'the reply' }],
    usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 },
    ...o,
  },
});

test('Claude: one line per message id with its final usage, written at the next id or the result', () => {
  const { send, out, asked } = claudeTap();
  send({ type: 'system', subtype: 'init', session_id: 'sess', model: 'claude-sonnet-5-5' });
  send(assistant('m1'));
  send(
    assistant('m1', {
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat .env' } }],
      usage: { input_tokens: 3, output_tokens: 40 },
    }),
  );
  send({ type: 'user', message: { content: [{ type: 'tool_result', content: 'API_KEY=abc' }] } });
  send(assistant('m2', { model: 'claude-opus-5-5' }));
  send(assistant('m3', { usage: undefined, model: undefined }));
  send({ type: 'result', subtype: 'success', is_error: false, result: 'the final reply' });
  assert.deepEqual(
    out.map((r) => [r.session, r.chat, r.req, r.served, r.in, r.out, r.cacheRead, r.cacheWrite, r.outcome]),
    [
      ['sess', 'chat-of-claude:s1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 3, 40, undefined, undefined, 'ok'],
      ['sess', 'chat-of-claude:s1', 'claude-sonnet-5-5', 'claude-opus-5-5', 3, 1, 500, 20, 'ok'],
      ['sess', 'chat-of-claude:s1', 'claude-sonnet-5-5', undefined, undefined, undefined, undefined, undefined, 'ok'],
    ],
  );
  assert.deepEqual(asked, ['b1'], 'the account is read once per turn');
  assert.ok(out.every((r) => r.account === ACCOUNT && r.harness === 'claude'));
});

test('Claude: an API retry is a retry line; an assistant error one error line with its kind and wording', () => {
  const { send, out } = claudeTap();
  send({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' });
  send({ type: 'system', subtype: 'api_retry', error_status: null, error: 'unknown' });
  send(assistant('m1'));
  send({
    type: 'assistant',
    error: 'rate_limit',
    message: {
      id: 'synthetic',
      model: '<synthetic>',
      content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 18 at 11am" }],
    },
  });
  // the result repeats the error: no second line
  send({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit" });
  assert.deepEqual(
    out.map((r) => [r.outcome, r.status, r.code, r.error]),
    [
      ['retry', 529, 'overloaded', undefined],
      ['retry', undefined, 'unknown', undefined],
      ['ok', undefined, undefined, undefined],
      ['error', undefined, 'rate_limit', "You've hit your weekly limit · resets Oct 18 at 11am"],
    ],
  );
});

test("Claude: an is_error result with no error line yet is one, worded only by the CLI's own errors, never by `result`", () => {
  const { send, out } = claudeTap();
  send({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 server error' });
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['tool crashed', 'then this'] });
  send({ type: 'result', subtype: 'error_max_turns', is_error: true });
  send({ type: 'result', subtype: 'success', is_error: false, result: 'a reply, never written' });
  assert.deepEqual(
    out.map((r) => [r.outcome, r.code, r.error]),
    [
      ['error', 'success', undefined],
      ['error', 'error_during_execution', 'tool crashed; then this'],
      ['error', 'error_max_turns', undefined],
    ],
  );
});

test("Claude: a result whose only errors are the CLI's diagnostics is no error line, and diagnostics never word one", () => {
  const { send, out } = claudeTap();
  const ede = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [ede] });
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [ede, 'tool crashed'] });
  assert.deepEqual(
    out.map((r) => [r.outcome, r.error]),
    [['error', 'tool crashed']],
  );
});

test("Claude: the CLI's interrupt marker makes the cut request a stopped line; with none open the stop is one line", () => {
  const { send, out } = claudeTap();
  send(assistant('m1'));
  send({ type: 'user', message: { content: '[Request interrupted by user]' } });
  send({ type: 'result', subtype: 'error_during_execution', is_error: true });
  send({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  send({ type: 'result', subtype: 'error_during_execution', is_error: true });
  // a user message that is not the marker (or has no text) changes nothing
  send({ type: 'user', message: { content: [{ type: 'image' }] } });
  send({ type: 'user', message: {} });
  send({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(
    out.map((r) => [r.outcome, r.in]),
    [
      ['interrupted', 3],
      ['interrupted', undefined],
    ],
  );
});

test('Claude: a process that ends writes its open request; one that dies mid-turn fails it, or adds an error, with the reason', () => {
  const { tap, send, out } = claudeTap();
  send(assistant('m1'));
  tap.event({ key: 'claude:s1', kind: 'closed' });
  assert.deepEqual(
    out.map((r) => r.outcome),
    ['ok'],
  );
  assert.equal(tap.sessions.has('claude:s1'), false);
  send({ type: 'system', subtype: 'init', session_id: 's2' }, 'claude:s2');
  send({ type: 'system', subtype: 'api_retry', error_status: 500, error: 'server_error' }, 'claude:s2');
  tap.event({ key: 'claude:s2', kind: 'error', error: 'Claude Code process exited with code 1' });
  send(assistant('m9'), 'claude:s3');
  tap.event({ key: 'claude:s3', kind: 'error', error: 'exited' });
  // an idle session that ends, or one never seen, writes nothing more
  send({ type: 'system', subtype: 'init', session_id: 's4' }, 'claude:s4');
  tap.event({ key: 'claude:s4', kind: 'error', error: 'exited' });
  tap.event({ key: 'claude:never', kind: 'closed' });
  assert.deepEqual(
    out.map((r) => [r.session, r.outcome, r.error]),
    [
      ['s1', 'ok', undefined],
      ['s2', 'retry', undefined],
      ['s2', 'error', 'Claude Code process exited with code 1'],
      ['s3', 'error', 'exited'],
    ],
  );
});

test('Claude: events without a key or a message, live output and other kinds write nothing', () => {
  const { tap, send, out } = claudeTap();
  tap.event(null);
  tap.event({ kind: 'message', msg: assistant('m') });
  tap.event({ key: 'claude:s', kind: 'tasks', tasks: [] });
  tap.event({ key: 'claude:s', kind: 'message' });
  send({ type: 'system', subtype: 'sage_bash_output', output: 'secret output' });
  send({ type: 'assistant', message: { content: [] } });
  send({ type: 'stream_event', event: {} });
  assert.deepEqual(out, []);
});

test('Claude: parallel subagents interleave their messages, and each request is still one line', () => {
  const { send, out } = claudeTap();
  const sub = (id: string, parent: string, output: number) => ({
    ...assistant(id, { usage: { input_tokens: 1, output_tokens: output } }),
    parent_tool_use_id: parent,
  });
  send(assistant('main', { content: [{ type: 'tool_use', name: 'Task' }] }));
  send(sub('a', 'task-a', 1));
  send(sub('b', 'task-b', 1));
  send(sub('a', 'task-a', 9));
  send({ type: 'user', parent_tool_use_id: 'task-a', message: { content: [{ type: 'tool_result', content: 'x' }] } });
  send(sub('b', 'task-b', 7));
  send({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(
    out.map((r) => [r.out, r.outcome]),
    [
      [1, 'ok'],
      [9, 'ok'],
      [7, 'ok'],
    ],
    'main, a and b once each with their last counts, written at the result',
  );
  assert.equal(out.length, 3);
});

test("Claude: a real reply that carries an error fails its request without writing the reply's words", () => {
  const { send, out } = claudeTap();
  send({
    ...assistant('m1', { content: [{ type: 'text', text: 'SECRET-REPLY-WORDS' }], usage: { input_tokens: 5, output_tokens: 32000 } }),
    error: 'max_output_tokens',
  });
  send({ type: 'result', subtype: 'success', is_error: true, result: 'SECRET-REPLY-WORDS' });
  assert.deepEqual(
    out.map(({ key: _k, pay: _p, ...r }) => r),
    [
      {
        harness: 'claude',
        chat: 'chat-of-claude:s1',
        session: 's1',
        account: ACCOUNT,
        req: undefined,
        outcome: 'error',
        code: 'max_output_tokens',
        error: undefined,
        served: 'claude-sonnet-5-5',
        in: 5,
        out: 32000,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
    ],
  );
});

test('Claude: a stop cuts the open request on every thread', () => {
  const { send, out } = claudeTap();
  send(assistant('main'));
  send({ ...assistant('a'), parent_tool_use_id: 'task-a' });
  send({ type: 'user', message: { content: '[Request interrupted by user]' } });
  send({ type: 'result', subtype: 'error_during_execution', is_error: true });
  assert.deepEqual(
    out.map((r) => r.outcome),
    ['interrupted', 'interrupted'],
  );
});

test('Claude: a message without a body, a CLI-made reply with an id, and a crash with no reason', () => {
  const { tap, send, out } = claudeTap();
  send({ type: 'assistant' });
  send(assistant('note', { model: '<synthetic>' }));
  send({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(
    out.map((r) => [r.outcome, r.served]),
    [['ok', undefined]],
    'a CLI-made message names no model as the one that served it',
  );
  send(assistant('m2'));
  tap.event({ key: 'claude:s1', kind: 'error' });
  assert.deepEqual(
    out.slice(1).map((r) => [r.outcome, r.error]),
    [['error', '']],
  );
});

test("Claude: a message's next tool block that comes after the first tool's result is still the same request", () => {
  const { send, out } = claudeTap();
  send(assistant('x', { content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 2, output_tokens: 20 } }));
  send({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file A' }] } });
  send(assistant('x', { content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 2, output_tokens: 47 } }));
  send({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file B' }] } });
  send(assistant('y', { usage: { input_tokens: 2, output_tokens: 39 } }));
  send({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(
    out.map((r) => r.out),
    [47, 39],
  );
});

test('Claude: a stop while a tool runs leaves the finished request ok and adds one stopped line', () => {
  const { send, out } = claudeTap();
  send(assistant('x', { content: [{ type: 'tool_use', name: 'Bash' }] }));
  send({ type: 'user', message: { content: [{ type: 'tool_result', content: 'partial output' }] } });
  send({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  send({ type: 'result', subtype: 'error_during_execution', is_error: true });
  // a tool result for a thread with no open request changes nothing
  send({ type: 'user', parent_tool_use_id: 'none', message: { content: [{ type: 'tool_result', content: 'x' }] } });
  assert.deepEqual(
    out.map((r) => [r.outcome, r.in]),
    [
      ['ok', 3],
      ['interrupted', undefined],
    ],
  );
});
