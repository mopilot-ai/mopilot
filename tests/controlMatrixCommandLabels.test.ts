// Command-step E2E names follow the app's real labels: completed ones keep command/exit identity with canonical elapsed
// times, running ones name the program as the transcript row does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render } from './support/thread-kit.ts';
import { formatDuration } from '../src/lib/format.ts';
import { commandStepName, runningCommandName } from './e2e/fixtures/commandStep.ts';
import { activityText, claudeActivityParts } from '../src/session/activityUx.ts';

export const GUARDS = ['src/'];

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff') });
autoMock('src/components/ui/Presence.tsx', 'presence', { Collapse: stubComponent('Collapse') });
autoMock('src/session/open.ts', 'open');
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { ClaudeActivity } = await import('../src/components/thread/ClaudeActivity.tsx');

test('completed command labels accept only the formatter duration after the exact command and exit outcome (#1572)', () => {
  for (const label of ['Ran npm test', 'Ran npm test · exit 3', 'Ran npm test · exit code unknown']) {
    const name = commandStepName(label);
    assert.equal(name.test(label), true, 'absent or zero duration is omitted by StepRow');
    for (const [ms, expected] of [
      [1, '0s'],
      [499, '0s'],
      [500, '1s'],
      [59_499, '59s'],
      [59_500, '1m'],
      [61_000, '1m 1s'],
      [3_599_000, '59m 59s'],
      [3_599_500, '1h 0m'],
      [7_260_000, '2h 1m'],
      [360_000_000, '100h 0m'],
    ] as const) {
      const duration = formatDuration(ms);
      assert.equal(duration, expected);
      assert.equal(name.test(`${label} · ${duration}`), true, `${label}: ${duration}`);
    }
  }
});

test('completed command labels reject wrong commands, states and exit outcomes', () => {
  const success = commandStepName('Ran npm test');
  const failed = commandStepName('Ran npm test · exit 3');
  const unknown = commandStepName('Ran npm test · exit code unknown');
  for (const suffix of ['', ' · 0s', ' · 1m 2s']) {
    assert.equal(success.test(`Ran npm test · exit 3${suffix}`), false);
    assert.equal(failed.test(`Ran npm test${suffix}`), false);
    assert.equal(failed.test(`Ran npm test · exit 30${suffix}`), false);
    assert.equal(failed.test(`Ran npm test · exit code unknown${suffix}`), false);
    assert.equal(unknown.test(`Ran npm test · exit 1${suffix}`), false);
    for (const other of ['Ran npm testing', 'Ran npm test extra', 'Running npm test', 'Declined npm test', 'Also Ran npm test'])
      assert.equal(success.test(other + suffix), false, other);
  }
});

test('completed command labels reject noncanonical durations and extra text', () => {
  const name = commandStepName('Ran npm test');
  for (const duration of [
    '00s',
    '01s',
    '60s',
    '-1s',
    '1.5s',
    'NaNs',
    'Infinitys',
    '0m',
    '01m',
    '60m',
    '1m 0s',
    '1m 60s',
    '0h 0m',
    '01h 0m',
    '1h 60m',
    '1h 1m 1s',
    '1s extra',
    '1s · 2s',
  ])
    assert.equal(name.test(`Ran npm test · ${duration}`), false, duration);
  for (const label of [
    'Ran npm test ',
    'Ran npm test\n',
    'Ran npm test\r\n',
    'Ran npm test · 1s\n',
    'Ran npm test · ',
    'Ran npm test ·  1s',
  ])
    assert.equal(name.test(label), false, JSON.stringify(label));
});

test('completed command labels treat regexp metacharacters in the command as literal text', () => {
  const label = 'Ran node -e "a+b?.[0] (x|y) $HOME\\bin"';
  const name = commandStepName(label);
  assert.equal(name.test(label), true);
  assert.equal(name.test(`${label} · 2s`), true);
  assert.equal(name.test('Ran node -e "abZ0 x HOMEbin" · 2s'), false);
  assert.equal(name.test(`${label} · exit 1 · 2s`), false);
});

test('the shared E2E matcher follows the real StepRow accessible command label', async () => {
  for (const [exitCode, status, label] of [
    [0, 'completed', 'Ran npm test'],
    [3, 'failed', 'Ran npm test · exit 3'],
    [null, 'failed', 'Ran npm test · exit code unknown'],
  ] as const) {
    for (const durationMs of [null, 0, 1, 1_000, 61_000, 3_600_000]) {
      const view = await render(
        h(StepRow, {
          cwd: '/repo',
          step: {
            kind: 'command',
            network: false,
            item: {
              id: 'cmd',
              type: 'commandExecution',
              pluginId: null,
              scriptPath: null,
              processId: null,
              source: 'agent',
              command: 'npm test',
              cwd: '/repo',
              status,
              exitCode,
              durationMs,
              aggregatedOutput: 'output',
              commandActions: [],
            },
          },
        }),
      );
      const button = view.$('button.step-row-hit');
      assert.ok(button);
      const labelledBy = button.getAttribute('aria-labelledby');
      assert.ok(labelledBy);
      const name = document.getElementById(labelledBy)?.textContent;
      assert.equal(name, label + (durationMs ? ` · ${formatDuration(durationMs)}` : ''));
      assert.equal(commandStepName(label).test(name!), true);
      await view.unmount();
    }
  }
});

test('the running-command E2E matcher follows the real running row, which names the program', async () => {
  for (const [command, program] of [
    ['npm test', 'npm test'],
    [`/bin/zsh -lc 'npm test -- --watch'`, 'npm test'],
    ['git status', 'git status'],
  ] as const) {
    const label = activityText(claudeActivityParts({ kind: 'command', item: { command } }));
    const view = await render(h(ClaudeActivity, { label, activity: 'code', elapsedMs: 9_000, onToggle: () => {} }, h('pre', null, 'out')));
    // the running group's row: its words are the label's, the clock after them
    const name = view.$('button.claude-activity.expandable .claude-activity-label')?.textContent;
    assert.equal(runningCommandName(program).test(name!), true, `${command}: ${name}`);
    await view.unmount();
  }
  const name = runningCommandName('npm test');
  for (const other of ['Running a command', 'Running npm testing', 'Running npm test extra', 'Ran npm test', 'Running npm test\n'])
    assert.equal(name.test(other), false, other);
  assert.equal(name.test('Running npm test…'), true, 'a cut program keeps its ellipsis');
  assert.equal(runningCommandName('a+b').test('Running aab'), false, 'metacharacters are literal');
});
