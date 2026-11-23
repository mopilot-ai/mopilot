// shared/claudeResult.mjs: a result's readable errors, and when a result is a failure the chat reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeResultErrors, claudeResultFailed } from '../shared/claudeResult.mjs';
import { ClaudeTranslator } from './support/claude-translate.ts';

function mk() {
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('t1', '/repo', (m: string, p: any) => events.push([m, p]));
  return { tr, events };
}

const EDE = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';

test("the CLI's diagnostic lines are not errors a person reads", () => {
  // anything that is not the diagnostic line stays: a crash's line, and an entry of an unexpected type
  assert.deepEqual(claudeResultErrors({ errors: [EDE, 'tool crashed', '[session_crash] x', 3] }), [
    'tool crashed',
    '[session_crash] x',
    '3',
  ]);
  assert.deepEqual(claudeResultErrors({ errors: 'tool crashed' }), []);
  assert.deepEqual(claudeResultErrors(null), []);
});

test('a result fails unless it succeeded or every error it lists is a diagnostic', () => {
  // the steered prompt's leftover (#2085's repro): only the diagnostic
  assert.equal(claudeResultFailed({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [EDE] }), false);
  assert.equal(claudeResultFailed({ subtype: 'error_during_execution', errors: [EDE, 'tool crashed'] }), true);
  assert.equal(claudeResultFailed({ subtype: 'error_during_execution', errors: [EDE, null] }), true);
  assert.equal(claudeResultFailed({ subtype: 'error_during_execution', errors: ['[session_crash] boom'] }), true);
  // a failure with no errors listed (a stop, max turns) is still one
  assert.equal(claudeResultFailed({ subtype: 'error_during_execution' }), true);
  assert.equal(claudeResultFailed({ subtype: 'error_max_turns', errors: [] }), true);
  assert.equal(claudeResultFailed({ subtype: 'success' }), false);
  assert.equal(claudeResultFailed({ subtype: 'success', is_error: true }), true);
  assert.equal(claudeResultFailed(undefined), true);
});

test("main's controller: a steered prompt's diagnostic-only result keeps the turn running until the steer's own result", async () => {
  const { setup } = await import('./support/controller/fixture.ts');
  const { c, s } = setup();
  const chat = 'claude:s1';
  const result = (msg: object) => c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', ...msg } });
  c.send(chat, { text: 'hi', opts: { human: true } }, 1);
  await c.claudeSend(chat, chat, {}, { role: 'user', content: 'hi' }, undefined, { human: true, uuid: 'u1' });
  await c.claudeSend(chat, chat, {}, { role: 'user', content: 'more' }, 'now', { uuid: 'u2' });
  result({ subtype: 'error_during_execution', is_error: true, errors: [EDE] });
  assert.equal(s(chat).turn, 'running');
  result({ subtype: 'success', result: 'done' });
  assert.equal(s(chat).turn, 'idle');
  // a real error beside the diagnostic still ends a steered turn
  c.send(chat, { text: 'again', opts: { human: true } }, 1);
  await c.claudeSend(chat, chat, {}, { role: 'user', content: 'again' }, undefined, { human: true, uuid: 'u3' });
  await c.claudeSend(chat, chat, {}, { role: 'user', content: 'more' }, 'now', { uuid: 'u4' });
  result({ subtype: 'error_during_execution', is_error: true, errors: [EDE, 'tool crashed'] });
  assert.equal(s(chat).turn, 'idle');
});

test("the translator: a steered prompt's diagnostic-only result neither ends the turn nor fails it", () => {
  const { tr, events } = mk();
  const done = () => events.filter(([m]) => m === 'turn/completed').map(([, p]) => [p.turn.status, p.turn.error]);
  const ede = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'] };
  tr.beginTurn('a');
  tr.addSteer();
  tr.onMessage(ede);
  assert.deepEqual(done(), []);
  tr.onMessage({ type: 'result', subtype: 'success' });
  // a last result with only diagnostics completes; one with a real error beside them fails with that error alone
  tr.beginTurn('b');
  tr.onMessage(ede);
  tr.beginTurn('c');
  tr.addSteer();
  tr.onMessage({ ...ede, errors: [...ede.errors, 'tool crashed'] });
  assert.deepEqual(done(), [
    ['completed', null],
    ['completed', null],
    ['failed', { message: 'tool crashed' }],
  ]);
});
