// A wait reads as a wait on every harness: a leading `sleep N`, a wait loop, an ACP sleep tool (src/lib/waitStep.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandWait, isWaitLoop, sleepPrefix, toolWait, toolWaitMs, watchCall } from '../src/lib/waitStep.ts';

test('a leading sleep is a wait, in the shell’s units, then whatever runs after it', () => {
  assert.deepEqual(sleepPrefix('sleep 50 && gh api repos/x/runs'), { ms: 50_000, rest: 'gh api repos/x/runs' });
  assert.deepEqual(sleepPrefix('  sleep 2m; npm test'), { ms: 120_000, rest: 'npm test' });
  assert.deepEqual(sleepPrefix('sleep 1.5s'), { ms: 1500, rest: '' });
  assert.deepEqual(sleepPrefix('sleep 1h'), { ms: 3_600_000, rest: '' });
  assert.deepEqual(sleepPrefix('sleep 1d && x'), { ms: 86_400_000, rest: 'x' });
  // not a wait first: a sleep joined by || or a pipe, a sleep with no number, another command
  assert.equal(sleepPrefix('sleep 5 || echo late'), null);
  assert.equal(sleepPrefix('sleep 5 | cat'), null);
  assert.equal(sleepPrefix('sleep forever'), null);
  assert.equal(sleepPrefix('sleepy 5'), null);
  assert.equal(sleepPrefix('gh run watch'), null);
});

test('a while or until loop that sleeps is a wait loop', () => {
  assert.equal(isWaitLoop('until gh run view 1 --json status | grep -q completed; do sleep 30; done'), true);
  assert.equal(isWaitLoop('while true; do curl -s x; sleep 10; done'), true);
  assert.equal(isWaitLoop('for f in *; do echo $f; done'), false);
  assert.equal(isWaitLoop('while read l; do echo $l; done'), false);
});

test('a command’s wait: its leading sleep, or a wait loop timed by how long it ran', () => {
  // a Codex command comes wrapped in its shell
  assert.deepEqual(commandWait({ command: "/bin/zsh -lc 'sleep 50 && gh api x'" }), { ms: 50_000, rest: 'gh api x', loop: false });
  assert.deepEqual(commandWait({ command: 'sleep 5' }), { ms: 5000, rest: '', loop: false });
  const loop = 'until gh run view; do sleep 30; done';
  assert.deepEqual(commandWait({ command: loop, durationMs: 360_000 }), { ms: 360_000, rest: loop, loop: true });
  // still running: how long it waits is not known yet
  assert.deepEqual(commandWait({ command: loop }), { ms: null, rest: loop, loop: true });
  // a sleep before a wait loop is part of the loop's wait
  assert.deepEqual(commandWait({ command: `sleep 5 && ${loop}`, durationMs: 9000 }), { ms: 9000, rest: `sleep 5 && ${loop}`, loop: true });
  assert.equal(commandWait({ command: 'npm test' }), null);
});

test('a tool with no server named sleep or wait is a wait, for as long as its arguments ask', () => {
  assert.equal(toolWaitMs({ tool: 'sleep', server: '', arguments: { seconds: 50 } }), 50_000);
  assert.equal(toolWaitMs({ tool: 'Wait', arguments: { ms: 250 } }), 250);
  assert.equal(toolWaitMs({ tool: 'sleep', arguments: { duration_ms: '1500' } }), 1500);
  // an argument that is no duration is skipped for the next one
  assert.equal(toolWaitMs({ tool: 'sleep', arguments: { ms: 'soon', seconds: 2 } }), 2000);
  assert.equal(toolWaitMs({ tool: 'sleep', arguments: { ms: '', duration: -1, time: 3 } }), 3000);
  // no duration it can read
  assert.equal(toolWaitMs({ tool: 'sleep', arguments: { reason: 'ci' } }), null);
  assert.equal(toolWaitMs({ tool: 'sleep', arguments: null }), null);
  assert.equal(toolWaitMs({ tool: 'sleep' }), null);
  // not a wait: another tool, another server's tool of that name, no tool name
  assert.equal(toolWaitMs({ tool: 'sleep_well', arguments: { seconds: 1 } }), undefined);
  assert.equal(toolWaitMs({ tool: 'wait', server: 'github', arguments: { seconds: 1 } }), undefined);
  assert.equal(toolWaitMs({ arguments: { seconds: 1 } }), undefined);
});

test('a tool waits when it sleeps, or when it blocks on a background task (TaskOutput), for as long as the call took', () => {
  assert.deepEqual(toolWait({ tool: 'sleep', arguments: { seconds: 2 } }), { ms: 2000 });
  assert.deepEqual(toolWait({ tool: 'TaskOutput', server: '', arguments: { task_id: 'b1' }, durationMs: 90_000 }), {
    ms: 90_000,
    on: 'a background task',
  });
  // still running: how long is not known yet
  assert.deepEqual(toolWait({ tool: 'TaskOutput', arguments: { block: true } }), { ms: null, on: 'a background task' });
  // a read that does not block, another server's tool of that name, or another tool: no wait
  assert.equal(toolWait({ tool: 'TaskOutput', arguments: { block: false } }), null);
  assert.equal(toolWait({ tool: 'TaskOutput', server: 'x', arguments: {} }), null);
  assert.deepEqual(toolWait({ tool: 'TaskOutput', arguments: null }), toolWait({ tool: 'TaskOutput' }));
  assert.equal(toolWait({ tool: 'Read', arguments: {} }), null);
});

test('a monitor and a scheduled check-in arm a watch: what it watches, how long, or when it checks in', () => {
  assert.deepEqual(
    watchCall({ tool: 'Monitor', server: '', arguments: { description: ' CI run 401 ', timeout_ms: 1_800_000, command: 'x' } }),
    {
      what: 'monitor',
      label: 'CI run 401',
      ms: 1_800_000,
      stop: false,
    },
  );
  assert.deepEqual(watchCall({ tool: 'Monitor', arguments: { description: '  ', timeout_ms: -1 } }), {
    what: 'monitor',
    label: null,
    ms: null,
    stop: false,
  });
  assert.deepEqual(watchCall({ tool: 'ScheduleWakeup', arguments: { delaySeconds: 960, prompt: 'x' } }), {
    what: 'checkin',
    label: null,
    ms: 960_000,
    stop: false,
  });
  assert.deepEqual(watchCall({ tool: 'ScheduleWakeup', arguments: { stop: true } }), {
    what: 'checkin',
    label: null,
    ms: null,
    stop: true,
  });
  assert.deepEqual(watchCall({ tool: 'Monitor' }), { what: 'monitor', label: null, ms: null, stop: false });
  // another server's tool of that name, or another tool
  assert.equal(watchCall({ tool: 'Monitor', server: 'grafana', arguments: {} }), null);
  assert.equal(watchCall({ tool: 'TaskStop', arguments: {} }), null);
});
