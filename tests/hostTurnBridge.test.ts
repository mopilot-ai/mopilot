// What a Claude Code chat's turns tell the Host's stream (host/src/turnBridge.mjs): a turn starts and ends with the controller's own state, the words come from the CLI's messages, and a permission request becomes a card (A: ordering of start, words and end; B: messages of every shape; I: only the chats this family runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_PERMISSION_OPTIONS, createTurnBridge } from '../host/src/turnBridge.mjs';

/** A bridge over a store of `active` turns, a controller whose chats are `kinds` and the answers the CLI took. */
function setup({ kinds = { 'claude:a': 'claude' } as Record<string, string>, answered = true } = {}) {
  const events: any[] = [];
  const active: Record<string, any> = {};
  const answers: any[] = [];
  const resolved: string[] = [];
  const bridge = createTurnBridge({
    state: { get: (chatId: string) => ({ activeTurn: active[chatId] ?? null }) },
    emit: (e: any) => events.push(e),
    controller: () =>
      ({
        ref: (chatId: string) => {
          if (!kinds[chatId]) throw new Error('no such chat');
          return { kind: kinds[chatId] };
        },
        chatOf: (key: string) => key,
        resolveApproval: (id: string) => resolved.push(id),
      }) as any,
    answer: (requestId: string, result: object) => (answers.push([requestId, result]), answered),
  });
  const start = (chatId = 'claude:a', id: any = 'pending-t1') => {
    active[chatId] = id === null ? null : { id };
    bridge.patched({ chatId, patch: { turn: 'running' } });
  };
  return { bridge, events, active, answers, resolved, start };
}
const delta = (text: string, extra = {}) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  ...extra,
});
const message = (chatId: string, msg: any) => ({ kind: 'message', key: chatId, msg });

test('A: a turn starts once when the store says running, keeps its id while it waits on the user, and ends once with how it ended', () => {
  const t = setup();
  t.start();
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'awaitingUser' } });
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'running' } });
  assert.deepEqual(
    [...t.events],
    [{ kind: 'turnStart', key: 'claude:a', turnId: 't1', user: { id: 'u-t1', clientId: 't1', content: [] } }],
  );
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.deepEqual(t.events[1], { kind: 'turnEnd', key: 'claude:a', turnId: 't1', stopReason: 'end_turn' });
  assert.equal(t.events.length, 2);
});

test('A: a turn the harness names has the id the store holds, and one with no id still gets a stream id of its own', () => {
  const t = setup();
  t.start('claude:a', 'ct-abc');
  assert.equal(t.events[0].turnId, 'ct-abc');
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  t.start('claude:a', null);
  assert.match(t.events[2].turnId, /^claude-claude:a-\d+$/);
});

test('A: a stop marks the turn cancelled, a failed start and a crash are errors, and none outlives its turn', () => {
  const t = setup();
  t.start();
  t.bridge.adapterEvent({ kind: 'interrupting', key: 'claude:a' });
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.equal(t.events.at(-1).stopReason, 'cancelled');
  t.start('claude:a', 'pending-t2');
  t.bridge.adapterEvent({ kind: 'turnFailed', chatId: 'claude:a', error: 'no binary' });
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.deepEqual(t.events.at(-1), {
    kind: 'turnEnd',
    key: 'claude:a',
    turnId: 't2',
    stopReason: 'error',
    error: { message: 'no binary' },
  });
  // the failure was said once: the next turn does not inherit it
  t.start('claude:a', 'pending-t3');
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.equal(t.events.at(-1).stopReason, 'end_turn');
  t.start('claude:a', 'pending-t4');
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'crashed', crashed: 'Claude Code quit' } });
  assert.deepEqual(t.events.at(-1).error, { message: 'Claude Code quit' });
  t.start('claude:a', 'pending-t5');
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'crashed' } });
  assert.match(t.events.at(-1).error.message, /session ended/);
});

test('I: only a chat that runs Claude Code is reported; an unknown chat and a patch that is not about the turn are not', () => {
  const t = setup({ kinds: { 'claude:a': 'claude', 'acp:x:1': 'acp' } });
  t.start('acp:x:1');
  t.start('claude:unknown');
  t.bridge.patched({ chatId: 'claude:a', patch: { plan: true } as any });
  assert.deepEqual([...t.events], []);
  // a controller that does not exist yet
  const early = createTurnBridge({
    state: { get: () => ({}) },
    emit: (e: any) => t.events.push(e),
    controller: () => undefined,
    answer: () => true,
  });
  early.patched({ chatId: 'claude:a', patch: { turn: 'running' } });
  early.harnessEvent({ kind: 'permissionCancelled', key: 'claude:a', requestId: 'x' });
  assert.deepEqual([...t.events], []);
});

test('B: text arrives as deltas of its message, whole when the CLI did not stream it, never twice, and a sub-agent’s with their call', () => {
  const t = setup();
  t.bridge.harnessEvent(message('claude:a', delta('before the turn')));
  t.start();
  const m = (msg: any) => t.bridge.harnessEvent(message('claude:a', msg));
  m({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  m(delta('Hel'));
  m(delta('lo'));
  m(delta('ignored', { parent_tool_use_id: 'agent-1' }));
  m({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  m({ type: 'stream_event', event: { type: 'content_block_start' } });
  m({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta' } } });
  m({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } });
  m({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } });
  m({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use' }, { type: 'text', text: 'whole' }, { type: 'text' }] } });
  m({ type: 'assistant', message: { content: [{ type: 'text', text: 'no id' }] } });
  m({ type: 'assistant', message: { content: 'plain' } });
  m({ type: 'assistant', parent_tool_use_id: 'agent-1', message: { id: 'm9', content: [{ type: 'text', text: 'sub' }] } });
  m({ type: 'result' });
  m(null);
  t.bridge.harnessEvent(null);
  t.bridge.harnessEvent({ kind: 'closed' });
  const words = t.events.filter((e) => e.update).map((e) => [e.update.messageId ?? null, e.update.content.text]);
  assert.deepEqual(words, [
    ['m1', 'Hel'],
    ['m1', 'lo'],
    [null, 'ignored'],
    ['m2', 'whole'],
    [null, 'no id'],
    ['m9', 'sub'],
  ]);
  // a sub-agent's words name the call they belong to
  assert.deepEqual(
    t.events.filter((e) => e.update?._meta).map((e) => [e.update.content.text, e.update._meta.claudeCode.parentToolUseId]),
    [
      ['ignored', 'agent-1'],
      ['sub', 'agent-1'],
    ],
  );
  // the next turn starts with a clean slate: a message id seen in the last one is told again
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  t.start('claude:a', 'pending-t2');
  m({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Again' }] } });
  assert.equal(t.events.at(-1).update.content.text, 'Again');
});

test('A: a permission request is a card of the turn, the app’s answer goes to the CLI, and a card that went away has no answer', () => {
  const t = setup();
  const ask = (requestId: string, extra = {}) =>
    t.bridge.harnessEvent({ kind: 'permission', key: 'claude:a', requestId, toolName: 'Bash', input: { command: 'ls' }, ...extra });
  ask('before');
  assert.deepEqual([...t.events], [], 'no turn, no card');
  assert.deepEqual(
    t.answers,
    [['before', { behavior: 'deny', message: 'There is no turn to ask the person in.' }]],
    'and the call is refused',
  );
  t.answers.length = 0;
  t.start();
  ask('c1', { toolUseID: 'tu1', title: 'Run ls' });
  ask('c2', { displayName: 'Shell' });
  ask('c3');
  assert.deepEqual(
    t.events.slice(1).map((e) => [e.requestId, e.toolCall.toolCallId, e.toolCall.title]),
    [
      ['c1', 'tu1', 'Run ls'],
      ['c2', 'c2', 'Shell'],
      ['c3', 'c3', 'Bash'],
    ],
  );
  assert.deepEqual(t.events[1].options, CLAUDE_PERMISSION_OPTIONS);
  // the card says what kind of tool it is, from the tool's name
  assert.equal(t.events[1].toolCall.kind, 'execute');
  ask('mcp', { toolName: 'mcp__x__y' });
  assert.equal(t.events.at(-1).toolCall.kind, 'other');
  ask('plan', { toolName: 'ExitPlanMode' });
  assert.equal(t.events.at(-1).toolCall.kind, 'switch_mode');
  t.bridge.permit({ requestId: 'mcp' });
  t.bridge.permit({ requestId: 'plan' });
  t.answers.length = 0;
  t.resolved.length = 0;
  assert.equal(t.bridge.permit({ requestId: 'c1', optionId: 'allow' }), true);
  assert.equal(t.bridge.permit({ requestId: 'c2', optionId: 'deny' }), true);
  assert.equal(t.bridge.permit({ requestId: 'c3' }), true);
  assert.deepEqual(t.answers, [
    ['c1', { behavior: 'allow', updatedInput: { command: 'ls' } }],
    ['c2', { behavior: 'deny', message: 'The user declined.' }],
    ['c3', { behavior: 'deny', message: 'The user declined.' }],
  ]);
  assert.deepEqual(t.resolved, ['c1', 'c2', 'c3']);
  assert.equal(t.bridge.permit({ requestId: 'c1', optionId: 'allow' }), false, 'answered once');
  ask('c4', { input: undefined });
  assert.equal(t.events.at(-1).toolCall.rawInput, null);
  t.bridge.harnessEvent({ kind: 'permissionCancelled', key: 'claude:a', requestId: 'c4' });
  t.bridge.harnessEvent({ kind: 'permissionCancelled', key: 'claude:a', requestId: 'c4' });
  assert.deepEqual(
    t.events.filter((e) => e.kind === 'permissionCancelled'),
    [{ kind: 'permissionCancelled', key: 'claude:a', requestId: 'c4' }],
  );
  assert.equal(t.bridge.permit({ requestId: 'c4', optionId: 'allow' }), false);
});

test('B: a CLI that no longer holds the request is no answer: permit says false', () => {
  const t = setup({ answered: false });
  t.start();
  t.bridge.harnessEvent({ kind: 'permission', key: 'claude:a', requestId: 'gone', toolName: 'Bash', input: {} });
  assert.equal(t.bridge.permit({ requestId: 'gone', optionId: 'allow' }), false);
});

test('the adapter’s events about other things are left alone', () => {
  const t = setup();
  assert.equal(t.bridge.adapterEvent({ kind: 'turnStarting' }), false);
  assert.equal(t.bridge.adapterEvent(null), false);
  assert.equal(t.bridge.adapterEvent({ kind: 'interrupting', key: 'claude:a' }), false, 'no turn is open');
  t.bridge.adapterEvent({ kind: 'turnFailed', error: 'x' });
  t.start();
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.equal(t.events.at(-1).stopReason, 'end_turn');
  t.bridge.adapterEvent({ kind: 'turnFailed', chatId: 'claude:a' });
  t.start('claude:a', 'pending-t2');
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.match(t.events.at(-1).error.message, /did not start/);
});

test('A: a turn starts with what the person wrote, once, and ends with the result’s failure, usage and context unless it was stopped', () => {
  const t = setup();
  t.bridge.noteUser('t1', 'hello');
  t.start('claude:a', 'pending-t1');
  assert.deepEqual(t.events[0].user.content, [{ type: 'text', text: 'hello' }]);
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  t.start('claude:a', 'pending-t1');
  assert.deepEqual(t.events.at(-1).user.content, [], 'the text was told once');
  t.bridge.harnessEvent({
    kind: 'message',
    key: 'claude:a',
    msg: { type: 'assistant', message: { id: 'a', content: [], usage: { input_tokens: 4 } } },
  });
  t.bridge.harnessEvent({
    kind: 'message',
    key: 'claude:a',
    msg: {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Credit balance is too low',
      usage: { input_tokens: 4, output_tokens: 1 },
      modelUsage: { m: { contextWindow: 100 } },
    },
  });
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  const [usage, end] = t.events.slice(-2);
  assert.deepEqual(usage.update, { sessionUpdate: 'usage_update', used: 4, size: 100 });
  assert.deepEqual(
    [end.kind, end.stopReason, end.error.message, end.usage.inputTokens],
    ['turnEnd', 'error', 'Credit balance is too low', 4],
  );
  // the same result of a turn the person stopped: a stop
  t.start('claude:a', 'pending-t2');
  t.bridge.adapterEvent({ kind: 'interrupting', key: 'claude:a' });
  t.bridge.harnessEvent({ kind: 'message', key: 'claude:a', msg: { type: 'result', subtype: 'error_during_execution', is_error: true } });
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  assert.deepEqual([t.events.at(-1).stopReason, t.events.at(-1).error], ['cancelled', undefined]);
  // a message that arrives with no turn open is dropped
  const before = t.events.length;
  t.bridge.harnessEvent({
    kind: 'message',
    key: 'claude:a',
    msg: { type: 'assistant', message: { id: 'z', content: [{ type: 'text', text: 'late' }] } },
  });
  assert.equal(t.events.length, before);
});

test('what was written for turns that never started is kept only for the newest hundred', () => {
  const t = setup();
  for (let i = 0; i < 105; i++) t.bridge.noteUser(`n${i}`, `text ${i}`);
  t.start('claude:a', 'pending-n0');
  assert.deepEqual(t.events.at(-1).user.content, [], 'the oldest was let go');
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
  t.start('claude:a', 'pending-n104');
  assert.deepEqual(t.events.at(-1).user.content, [{ type: 'text', text: 'text 104' }]);
});

test('#4278: a failed Claude Code turn carries its code: the CLI’s own word for it, else its words; a crash has only what its words say', () => {
  const t = setup();
  const fail = (id: string, error: string | undefined, result: string) => {
    t.start('claude:a', id);
    t.bridge.harnessEvent(message('claude:a', { type: 'assistant', ...(error ? { error } : {}), message: { id, content: [] } }));
    t.bridge.harnessEvent(message('claude:a', { type: 'result', subtype: 'error_during_execution', is_error: true, result }));
    t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'idle' } });
    return t.events.at(-1).error;
  };
  assert.deepEqual(fail('pending-1', 'authentication_failed', 'It did not work.'), { message: 'It did not work.', code: 'auth' });
  assert.deepEqual(fail('pending-2', 'rate_limit', 'Try later.'), { message: 'Try later.', code: 'rate_limit' });
  assert.deepEqual(fail('pending-3', undefined, 'Prompt is too long'), { message: 'Prompt is too long', code: 'context' });
  assert.deepEqual(fail('pending-4', undefined, 'It fell over.'), { message: 'It fell over.' });
  // a crash is not the result's failure: the word of the last message does not name it
  t.start('claude:a', 'pending-5');
  t.bridge.harnessEvent(message('claude:a', { type: 'assistant', error: 'rate_limit', message: { id: 'x', content: [] } }));
  t.bridge.harnessEvent(message('claude:a', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Try later.' }));
  t.bridge.patched({ chatId: 'claude:a', patch: { turn: 'crashed', crashed: 'Claude Code quit' } });
  assert.deepEqual(t.events.at(-1).error, { message: 'Claude Code quit' });
});
