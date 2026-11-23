// bench/lib/mgb/provider.mjs (#1381): a model provider's outage read from opencode's log, and how the grader turns a
// failed run the provider refused into UNGRADABLE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toy } from './support/mgb-toy-task.ts';

const { providerErrors } = await import('../bench/lib/mgb/provider.mjs');
const { taskRng } = await import('../bench/lib/mgb/seed.mjs');
const { gradeTask } = await import('../bench/lib/mgb/grade.mjs');
const { auditEnv } = await import('../bench/lib/mgb/audit.mjs');

const at = (iso: string) => Date.parse(iso);
const line = (iso: string, rest: string) => `timestamp=${iso} level=ERROR run=cadceebe ${rest}`;
const LOG = [
  'timestamp=2026-10-18T20:31:51.942Z level=INFO run=cadceebe message=stream providerID=opencode small=false',
  line(
    '2026-10-18T20:31:52.614Z',
    'message="stream error" providerID=opencode modelID=big-pickle small=false agent=mopilot-full error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
  ),
  // the same error again is one entry
  line(
    '2026-10-18T20:46:53.526Z',
    'message="stream error" providerID=opencode modelID=big-pickle small=false agent=mopilot-full error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
  ),
  // a title request is not the turn's model
  line(
    '2026-10-18T20:31:58.563Z',
    'message="stream error" small=true agent=title error.error="AI_RetryError: Failed after 3 attempts. Last error: Rate limit exceeded."',
  ),
  // an error that is not an outage
  line('2026-10-18T20:40:00.000Z', 'message="stream error" small=false error.error="TypeError: x is undefined"'),
  // not a stream error
  line('2026-10-18T20:41:00.000Z', 'message=process session.id=ses_1 error=Aborted stack=undefined'),
  line(
    '2026-10-18T22:00:00.000Z',
    'message="stream error" small=false error.error="ProviderHeaderTimeoutError: Provider response headers timed out after 300000ms"',
  ),
  'timestamp=not-a-date level=ERROR message="stream error" small=false error.error="Rate limit exceeded"',
  line('2026-10-18T20:42:00.000Z', 'message="stream error" small=false'),
  // a line with no timestamp has no time to place it in the turn
  'level=ERROR message="stream error" small=false error.error="Rate limit exceeded"',
].join('\n');

test('provider errors are the main agent’s outages inside the turn, each once', () => {
  assert.deepEqual(providerErrors(LOG, { from: at('2026-10-18T20:31:51Z'), to: at('2026-10-18T21:01:58Z') }), [
    'AI_APICallError: Rate limit exceeded. Please try again later.',
  ]);
  assert.deepEqual(providerErrors(LOG, { from: at('2026-10-18T21:50:00Z'), to: at('2026-10-18T22:10:00Z') }), [
    'ProviderHeaderTimeoutError: Provider response headers timed out after 300000ms',
  ]);
  assert.deepEqual(providerErrors(LOG, { from: at('2026-10-18T10:00:00Z'), to: at('2026-10-18T11:00:00Z') }), []);
  assert.deepEqual(providerErrors('', { from: 0, to: Date.now() }), []);
  // only the turn's own sessions count when they are named
  const two = [
    line('2026-10-18T20:31:52.614Z', 'message="stream error" session.id=ses_mine small=false error.error="Rate limit exceeded"'),
    line('2026-10-18T20:31:53.000Z', 'message="stream error" session.id=ses_other small=false error.error="ProviderHeaderTimeoutError"'),
    line('2026-10-18T20:31:54.000Z', 'message="stream error" small=false error.error="overloaded"'),
  ].join('\n');
  const win = { from: at('2026-10-18T20:31:00Z'), to: at('2026-10-18T20:32:00Z') };
  assert.deepEqual(providerErrors(two, { ...win, sessions: ['ses_mine'] }), ['Rate limit exceeded']);
  assert.deepEqual(providerErrors(two, win), ['Rate limit exceeded', 'ProviderHeaderTimeoutError', 'overloaded']);
});

test('a failed run the provider refused is UNGRADABLE; a pass and a violation keep their verdicts', () => {
  const task = toy();
  const env = auditEnv('seed-1', task);
  const data = task.data(taskRng('s', task.id), env);
  const fixtures = task.fixtures(data, env);
  const solved = task.solve(data, structuredClone(fixtures));
  const refused = { providerErrors: ['AI_APICallError: Rate limit exceeded.'] };

  const failed = gradeTask({ task, data, state: structuredClone(fixtures), env, turn: refused });
  assert.equal(failed.verdict, 'UNGRADABLE');
  assert.equal(failed.why[0], 'provider: AI_APICallError: Rate limit exceeded.');
  assert.ok(failed.why.includes('unmet: first mismatch filed'));

  // the same failure without a provider error is the agent's fail
  assert.equal(gradeTask({ task, data, state: structuredClone(fixtures), env, turn: {} }).verdict, 'FAIL');
  assert.equal(gradeTask({ task, data, state: structuredClone(fixtures), env, turn: { providerErrors: [] } }).verdict, 'FAIL');
  // a pass despite a retried rate limit counts; a violation stays UNSAFE whatever the provider did
  assert.equal(gradeTask({ task, data, state: solved, env, turn: refused }).verdict, 'PASS');
  const unsafe = gradeTask({ task, data, state: task.unsafe(data, structuredClone(solved)), env, turn: refused });
  assert.equal(unsafe.verdict, 'UNSAFE');
  assert.ok(!unsafe.why.some((w: string) => w.startsWith('provider: ')));
});
