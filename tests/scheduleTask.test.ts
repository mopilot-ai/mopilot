// Scheduled tasks (src/lib/scheduleTask.ts): which harness runs one, what a run may do, when one is due.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_WITH,
  acpHarnessOf,
  anchorDays,
  approvalOf,
  computerAllowed,
  APP_LABEL,
  appStatusRows,
  runRow,
  runSendOptions,
  runSource,
  runWithChoices,
  runWithLabel,
  runWithOf,
  runWithWhere,
  runsInLabel,
  whereItRuns,
  scheduledMark,
  wantsWorktree,
} from '../src/lib/scheduleTask.ts';

test('inherited object names are unknown harness availability states', () => {
  for (const state of Object.getOwnPropertyNames(Object.prototype)) {
    assert.deepEqual(runWithChoices([{ id: 'opencode', label: 'OpenCode', state }]), runWithChoices([]), state);
  }
});

test('Run with: Codex, Claude Code, then each admitted basic harness; anything unknown runs with Codex', () => {
  assert.deepEqual(
    RUN_WITH.map((r) => r.label),
    ['Codex', 'Claude Code'],
  );
  const basics = [
    { id: 'opencode', label: 'opencode', state: 'admitted' },
    { id: 'kimi', label: 'Kimi Code', state: 'signin' },
    { id: 'gemini', label: 'Gemini CLI', state: 'unsupported' },
    { id: 'qwen', label: 'Qwen', state: 'off' },
    { id: 'goose', label: 'Goose', state: 'checking' },
    { id: 'cursor', label: 'Cursor', state: 'missing' },
  ];
  // admitted ones run; installed ones that can't yet say why; uninstalled ones aren't offered
  assert.deepEqual(
    runWithChoices(basics).map((r) => [r.id, r.label, r.note, r.disabled]),
    [
      ['codex', 'Codex', 'Also runs in the Codex app', false],
      ['claude', 'Claude Code', 'Also runs in Claude Desktop', false],
      ['acp:opencode', 'opencode', 'MoPilot only', false],
      ['acp:kimi', 'Kimi Code', 'Sign in to use', true],
      ['acp:gemini', 'Gemini CLI', "Can't run in MoPilot", true],
      ['acp:qwen', 'Qwen', 'Turned off for now', true],
      ['acp:goose', 'Goose', 'Checking…', true],
    ],
  );
  assert.match(runWithWhere('codex', 'Codex'), /MoPilot or the Codex app/);
  assert.match(runWithWhere('claude', 'Claude Code'), /next time Claude Desktop is closed/);
  assert.match(runWithWhere('acp:opencode', 'opencode'), /only while MoPilot is open: opencode has no scheduler/);
  assert.equal(runWithOf({}), 'codex');
  assert.equal(runWithOf({ harness: 'claude' }), 'claude');
  assert.equal(runWithOf({ harness: 'acp:opencode' }), 'acp:opencode');
  assert.equal(runWithOf({ harness: 'opencode' }), 'codex');
  assert.equal(runWithOf({ harness: 'acp:Bad Id' }), 'codex');
  assert.equal(runWithOf({ harness: 7 }), 'codex');
  assert.equal(acpHarnessOf({ harness: 'acp:kimi' }), 'kimi');
  assert.equal(acpHarnessOf({ harness: 'claude' }), null);
  assert.equal(runWithLabel('claude', basics), 'Claude Code');
  assert.equal(runWithLabel('acp:kimi', basics), 'Kimi Code');
  assert.equal(runWithLabel('acp:gone', basics), 'gone');
});

test('where a task runs, in words', () => {
  assert.match(runsInLabel({ apps: ['mopilot', 'codex-app'] }), /MoPilot or the Codex app/);
  assert.match(runsInLabel({ apps: ['mopilot', 'claude-desktop'] }), /MoPilot or Claude Desktop/);
  assert.match(runsInLabel({ apps: ['claude-desktop'] }), /^Runs in Claude Desktop only/);
  assert.match(runsInLabel({ apps: ['codex-app'] }), /^Runs in the Codex app only/);
  assert.match(runsInLabel({ apps: ['codex-app', 'claude-desktop'] }), /^Runs in the Codex app and Claude Desktop only/);
  assert.match(runsInLabel({ apps: [] }), /^Runs in Claude Desktop only/);
  assert.match(runsInLabel({ apps: ['mopilot'], desktop: 'pending' }), /once Claude Desktop is closed/);
  assert.match(runsInLabel({ apps: ['mopilot'], desktop: 'unsupported-schedule' }), /can’t run this schedule/);
  assert.match(runsInLabel({ apps: ['mopilot'], desktop: 'unavailable' }), /isn’t supported/);
  assert.match(runsInLabel({ apps: ['mopilot'], desktop: 'missing' }), /removed from Claude Desktop/);
  assert.equal(runsInLabel({ apps: ['mopilot'] }), 'Runs while MoPilot is open');
  assert.equal(runsInLabel(undefined), 'Runs while MoPilot is open');
});

test('computer control is off by default and approval waits by default', () => {
  assert.equal(computerAllowed({}), false);
  assert.equal(computerAllowed({ computer_control: true }), true);
  assert.equal(computerAllowed({ computer_control: 'yes' }), false);
  assert.equal(approvalOf({}), 'wait');
  assert.equal(approvalOf({ on_approval: 'skip' }), 'skip');
  assert.deepEqual(scheduledMark({ computer_control: true, on_approval: 'skip' }, true), {
    unattended: true,
    computer: true,
    onApproval: 'skip',
  });
  assert.deepEqual(scheduledMark({}, false), { unattended: false, computer: false, onApproval: 'wait' });
});

test("a run is sent with the task's model and effort, and a fresh checkout when the task wants one", () => {
  assert.deepEqual(runSendOptions({ model: 'm', reasoning_effort: 'high' }), { model: 'm', effort: 'high' });
  assert.deepEqual(runSendOptions({}), {});
  assert.equal(wantsWorktree({ execution_environment: 'worktree' }), true);
  assert.equal(wantsWorktree({ execution_environment: 'local' }), false);
});

test('sub-daily rules are anchored close, so finding the next run does not walk hundreds of thousands of occurrences', () => {
  assert.equal(anchorDays(0, 1), 400);
  assert.equal(anchorDays(60_000, 1), 2);
  assert.equal(anchorDays(3_600_000, 1), 8);
  // an interval wider than the window still fits at least two periods
  assert.ok(anchorDays(60_000, 3000) * 86400000 >= 60_000 * 3000 * 2);
  assert.equal(anchorDays(3_600_000, 24 * 400), 400);
});

const apps = (o: any = {}) => ({
  scheduler: true,
  codexApp: { installed: true, running: false },
  claudeDesktop: { installed: true, running: false },
  ...o,
});

test('where it runs: each app that runs a task, and what it is doing now', () => {
  const codexTask = { apps: ['mopilot', 'codex-app'] };
  assert.deepEqual(whereItRuns(codexTask, apps({ codexApp: { installed: true, running: true } })), [
    { app: 'mopilot', name: 'MoPilot', line: 'Waiting: the Codex app is open and runs this task' },
    { app: 'codex-app', name: 'Codex app', line: 'Open now: runs this task itself' },
  ]);
  assert.deepEqual(
    whereItRuns(codexTask, apps()).map((w) => w.line),
    ['Runs this task while the Codex app is closed, and records each run there', 'Closed: won’t run a time MoPilot already ran'],
  );
  assert.deepEqual(
    whereItRuns(
      { apps: ['mopilot', 'claude-desktop'] },
      apps({ scheduler: false, claudeDesktop: { installed: false, running: false } }),
    ).map((w) => w.line),
    ['Off in Settings: doesn’t run tasks', 'Not installed'],
  );
  // before main answers
  assert.deepEqual(
    whereItRuns(codexTask, null).map((w) => w.line),
    ['Runs this task while the Codex app is closed, and records each run there', 'Runs this task while it is open'],
  );
  assert.deepEqual(whereItRuns(undefined, apps()), [{ app: 'mopilot', name: 'MoPilot', line: 'Runs this task while MoPilot is open' }]);
  assert.match(whereItRuns({ apps: ['mopilot'], desktop: 'pending' }, apps())[0].line, /joins Claude Desktop/);
  assert.deepEqual(
    whereItRuns({ apps: ['claude-desktop'] }, apps({ claudeDesktop: { installed: true, running: true } })).map((w) => w.app),
    ['claude-desktop'],
  );
  assert.equal(APP_LABEL['claude-desktop'], 'Claude Desktop');
});

test('Settings: the installed native apps, open or closed, with their task counts and waiting registrations', () => {
  const tasks = [
    { native_app: 'codex-app', status: 'ACTIVE' },
    { native_app: 'codex-app', status: 'PAUSED' },
    { native_app: 'claude-desktop', status: 'ACTIVE' },
    { native_app: null, status: 'ACTIVE', claude_desktop: 'pending' },
    { native_app: null, status: 'ACTIVE', claude_desktop: 'pending' },
  ];
  assert.deepEqual(appStatusRows(null, tasks, true), []);
  assert.deepEqual(appStatusRows(apps({ codexApp: { installed: true, running: true } }), tasks, true), [
    { app: 'codex-app', name: 'Codex app', open: true, detail: 'Runs its 1 active task itself' },
    {
      app: 'claude-desktop',
      name: 'Claude Desktop',
      open: false,
      detail: 'MoPilot runs its 1 active task and records each run there. 2 new tasks join it once it closes',
    },
  ]);
  assert.deepEqual(
    appStatusRows(apps({ codexApp: { installed: false, running: false } }), tasks.slice(2, 4), false).map((r) => r.detail),
    ['Its tasks wait until it opens. 1 new task joins it once it closes'],
  );
  assert.equal(appStatusRows(apps(), [], true)[0].detail, 'MoPilot runs its 0 active tasks and records each run there');
});

test('a recorded run as its row: status, tone and what happened; which app ran it', () => {
  assert.deepEqual(runRow({ status: 'started' }, 'Review'), { status: 'Ran', tone: 'ran', detail: 'Review' });
  assert.deepEqual(runRow({ status: 'needs-approval' }, 'Review'), { status: 'Needs approval', tone: 'skipped', detail: 'Review' });
  assert.deepEqual(runRow({ status: 'needs-approval' }, null), {
    status: 'Needs approval',
    tone: 'skipped',
    detail: 'It stopped at a step that needs you',
  });
  assert.deepEqual(runRow({ status: 'started' }, null), { status: 'Ran', tone: 'ran', detail: '' });
  assert.deepEqual(runRow({ status: 'started', catchUp: true }, null), {
    status: 'Catch-up',
    tone: 'catchup',
    detail: 'A missed time, run when MoPilot opened',
  });
  assert.equal(runRow({ status: 'started', catchUp: true }, 'Review').detail, 'Review');
  assert.deepEqual(runRow({ status: 'starting' }, null), { status: 'Starting', tone: 'ran', detail: '' });
  assert.equal(runRow({ status: 'starting' }, 'R').detail, 'R');
  assert.deepEqual(runRow({ status: 'failed', reason: 'no window' }, null), {
    status: 'Didn’t start',
    tone: 'failed',
    detail: 'no window',
  });
  assert.equal(runRow({ status: 'failed' }, null).detail, 'Unknown error');
  assert.equal(runRow({ status: 'skipped', reason: 'missed' }, null).status, 'Missed');
  assert.equal(runRow({ status: 'skipped', reason: 'previous-running' }, null).detail, 'The previous run was still going');
  assert.deepEqual(runRow({ status: 'skipped' }, null), { status: 'Skipped', tone: 'skipped', detail: '' });
  assert.equal(runSource({ by: 'codex-app' }), 'Codex app');
  assert.equal(runSource({ by: { pid: 1 } }), 'MoPilot');
  assert.equal(runSource({ reason: 'missed' }), '');
  // a run a machine fired itself names the machine
  assert.equal(
    runSource({ by: { machine: 'ssh:me@box' } }, (id) => (id === 'ssh:me@box' ? 'box' : id)),
    'box',
  );
  assert.equal(runSource({ by: { machine: 'ssh:me@box' } }), 'ssh:me@box');
  assert.equal(runSource({ by: { machine: '' } }), 'MoPilot');
});

test('pending harness switches explain that the previous app must retire first', () => {
  const pending = { apps: ['mopilot'], transfer: 'pending' };
  assert.match(runsInLabel(pending), /Waiting to finish switching/);
  assert.deepEqual(whereItRuns(pending, null), [{ app: 'mopilot', name: 'MoPilot', line: runsInLabel(pending) }]);
});
