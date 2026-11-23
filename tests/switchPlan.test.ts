// The SwitchSheet's lines and defaults (src/harness/switchPlan.ts): effort mapping, permissions that
// only tighten, the goal's default, the three columns, the divider back (WP7-11, A14).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { backDivider, defaultContinueGoal, mapEffort, permissionChange, sheetPlan } = await import('../src/harness/switchPlan.ts');
type SheetInput = import('../src/harness/switchPlan.ts').SheetInput;

test('effort: the same level when the target has it, else the nearest, the lighter on a tie', () => {
  assert.equal(mapEffort('high', ['low', 'medium', 'high'], 'medium'), 'high');
  assert.equal(mapEffort('xhigh', ['low', 'medium', 'high'], 'medium'), 'high');
  assert.equal(mapEffort('minimal', ['medium', 'high'], 'medium'), 'medium');
  assert.equal(mapEffort('medium', ['low', 'high'], 'high'), 'low');
  assert.equal(mapEffort(null, ['low', 'high'], 'high'), 'high');
  assert.equal(mapEffort('high', [], null), null);
  // several agents is not a level
  assert.equal(mapEffort('ultra', ['low', 'medium', 'ultra'], 'medium'), 'medium');
});

test('permissions stay or get stricter, never looser', () => {
  assert.deepEqual(permissionChange('auto-review', false), {
    to: 'default',
    text: "Approve for me → Ask for approval (this model can't auto-approve)",
  });
  assert.deepEqual(permissionChange('auto-review', true), { to: 'auto-review', text: null });
  assert.deepEqual(permissionChange('read-only', false), { to: 'read-only', text: null });
  assert.deepEqual(permissionChange('full-access', false), { to: 'full-access', text: null });
});

test('the goal is continued by default only when the harness stays and the provider changes', () => {
  assert.equal(defaultContinueGoal('claude', 'claude'), true);
  assert.equal(defaultContinueGoal('codex', 'claude'), false);
});

const base: SheetInput = {
  from: 'codex',
  to: 'claude',
  fromLabel: 'Codex',
  toLabel: 'Claude Code',
  vendor: 'Anthropic',
  account: 'me@example.com',
  goal: { objective: 'tests pass', status: 'active' },
  effortFrom: 'xhigh',
  targetEfforts: ['low', 'medium', 'high'],
  targetDefaultEffort: 'medium',
  permission: 'auto-review',
  targetAutoMode: false,
  multiAgentOn: true,
  queued: 2,
};

test('what changes: the account, effort, multi-agent and permission rows', () => {
  const p = sheetPlan(base);
  assert.equal(p.account, 'Account: me@example.com · Your next messages and the handoff summary go to Anthropic');
  assert.equal(p.effort.text, 'Effort: Extra high → High');
  assert.equal(p.permission.text, "Approve for me → Ask for approval (this model can't auto-approve)");
  assert.match(p.multiAgent.label, /^Keep multiple agents on/);
  assert.equal(p.goal?.pauses, 'Goal "tests pass" pauses on Codex');
  assert.equal(p.goal?.continueLabel, 'Continue this goal on Claude Code');
  assert.equal(p.queued?.text, '2 queued messages');
});

test('no goal, no queue, nothing changes: those rows are quiet, the four Changes rows stay', () => {
  const p = sheetPlan({ ...base, goal: null, queued: 0, permission: 'default', targetAutoMode: true, effortFrom: null });
  assert.equal(p.goal, null);
  assert.equal(p.queued, null);
  assert.equal(p.permission.text, 'Permissions: unchanged');
  assert.equal(p.effort.text, 'Effort: Default → Medium');
  assert.ok(p.account);
});

test('going back keeps the notification concise', () => {
  assert.equal(backDivider('Codex', 6, 'Claude Code'), 'Back on Codex');
});
