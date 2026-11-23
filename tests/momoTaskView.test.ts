// The tasks as the clients draw them (shared/momoTasks/view.ts): every state and failure maps to the view contract, and a fix a client sends back reads as it was named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOMO_TASK_STATES } from '../shared/momoView.ts';
import { fixId, parseFixId, taskView } from '../shared/momoTasks/view.ts';
import type { FailureCode, Item, TaskError } from '../shared/momoTasks/types.ts';

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  title: 'Quote',
  doneMeans: 'opens',
  state: 'working',
  where: { machineId: 'm1', harness: 'codex', sessionId: 's1' },
  origin: 'asked',
  stableKey: 'k',
  attempts: 1,
  attemptCap: 3,
  lastError: null,
  result: null,
  progress: 'Filling the table',
  cardId: null,
  watch: null,
  nextCheck: null,
  createdAt: 10,
  startedAt: 20,
  updatedAt: 30,
  settled: 0,
  posted: 0,
  card: null,
  notice: null,
  failedWith: null,
  ...over,
});
const error = (code: FailureCode, over: Partial<TaskError> = {}): TaskError => ({
  code,
  message: `${code} happened`,
  fixes: [],
  retry: false,
  at: 1,
  ...over,
});
const names = (id: string) => (id === 'm1' ? 'Mac mini' : null);

test('a working task: where it runs, its attempts and its live step', () => {
  const v = taskView(item(), names);
  assert.deepEqual(
    [v.state, v.where, v.startedAt, v.attempts, v.attemptCap, v.step, v.failure, v.result],
    ['working', { machine: { machineId: 'm1', name: 'Mac mini' }, agent: 'codex' }, 20, 1, 3, 'Filling the table', null, null],
  );
  assert.equal(taskView(item({ startedAt: null }), names).startedAt, 10);
  assert.equal(
    taskView(item({ where: { machineId: 'gone', harness: 'claude', sessionId: null } }), names).where.machine.name,
    'An unknown machine',
  );
  assert.equal(
    taskView(item({ where: { machineId: 'gone', harness: 'claude', sessionId: null, machineName: 'Old Mac' } }), names).where.machine.name,
    'Old Mac',
  );
});

test('every state the manager makes is one the contract knows', () => {
  for (const state of MOMO_TASK_STATES) assert.equal(taskView(item({ state }), names).state, state);
});

test('a failure keeps its real cause, its agent and machine, and the one-click fix of that cause', () => {
  const codes: [FailureCode, string | null][] = [
    ['machine_offline', 'machine-unreachable'],
    ['host_outdated', 'machine-unreachable'],
    ['agent_missing', 'agent-missing'],
    ['agent_signed_out', 'agent-signed-out'],
    ['usage_limit', 'usage-limit'],
    ['stopped_by_user', null],
    ['interrupted', 'restarted'],
    ['retry_cap', 'retry-cap'],
    ['same_failure', 'retry-cap'],
    ['too_many_active', 'session-error'],
    ['check_failed', 'not-done'],
    ['watch_failed', 'session-error'],
    ['refused', 'session-error'],
    ['session_failed', 'session-error'],
  ];
  for (const [code, view] of codes) {
    const v = taskView(
      item({
        state: 'failed',
        lastError: error(code, {
          fixes: [
            { action: 'install', label: 'Install Codex on Mac mini', machineId: 'm1', harness: 'codex' },
            { action: 'retry', label: 'Retry' },
          ],
        }),
      }),
      names,
    );
    assert.equal(v.failure?.code ?? null, view, code);
    if (view)
      assert.deepEqual(
        [v.failure?.message, v.failure?.agent, v.failure?.machine, v.failure?.fix],
        [
          `${code} happened`,
          'codex',
          { machineId: 'm1', name: 'Mac mini' },
          { id: 'install|m1|codex', label: 'Install Codex on Mac mini' },
        ],
      );
  }
  assert.equal(taskView(item({ state: 'failed', lastError: error('session_failed') }), names).failure?.fix, null);
});

test('finished but not done is a failure the user reviews; a task waiting on a gate card is not', () => {
  const result = { summary: 'Built it', files: ['a.xlsx'], evidence: 'e', checked: 'c', met: false };
  const v = taskView(item({ state: 'needs_you', result, progress: 'Finished, but not done: short' }), names);
  assert.deepEqual(
    [v.failure?.code, v.failure?.message, v.failure?.fix],
    ['not-done', 'Finished, but not done: short', { id: 'review', label: 'Review' }],
  );
  assert.deepEqual(v.result, { summary: 'Built it', files: ['a.xlsx'], evidence: 'e' });
  assert.equal(taskView(item({ state: 'needs_you', result, progress: null }), names).failure?.message, 'Built it');
  assert.equal(taskView(item({ state: 'needs_you', result, cardId: 'c1' }), names).failure, null);
  assert.equal(taskView(item({ state: 'needs_you' }), names).failure, null);
  assert.equal(taskView(item({ state: 'done', result: { ...result, met: true } }), names).failure, null);
});

test('a watching task says what it watches and when it looks next', () => {
  const v = taskView(
    item({
      state: 'watching',
      nextCheck: 99,
      watch: { watch: { kind: 'tool', tool: 'gmail.search', everyMinutes: 15 }, state: null, retryAt: null },
    }),
    names,
  );
  assert.deepEqual([v.step, v.nextCheck], ['Watching gmail.search', 99]);
  assert.equal(taskView(item({ state: 'watching', progress: 'x' }), names).step, 'x');
});

test('a fix id names the action and, for Run on, the machine and agent', () => {
  assert.equal(fixId({ action: 'retry', label: 'Retry' }), 'retry');
  assert.equal(fixId({ action: 'runElsewhere', label: 'Run on Studio', machineId: 'm2', harness: 'claude' }), 'runElsewhere|m2|claude');
  assert.deepEqual(parseFixId('runElsewhere|m2|claude'), { action: 'runElsewhere', machineId: 'm2', harness: 'claude' });
  assert.deepEqual(parseFixId('retry'), { action: 'retry', machineId: null, harness: null });
  assert.deepEqual(parseFixId(''), { action: '', machineId: null, harness: null });
});

test('a failure code a newer home made is still shown as a failure', () => {
  const v = taskView(item({ state: 'failed', lastError: { ...error('session_failed'), code: 'brand_new' as FailureCode } }), names);
  assert.deepEqual([v.failure?.code, v.failure?.message], ['session-error', 'session_failed happened']);
});
