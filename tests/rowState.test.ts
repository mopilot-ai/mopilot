// src/harness/rowState.ts: what a harness's row in All harnesses says, the same states for every harness family.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { firstClassRowState, basicRowState } = await import('../src/harness/rowState.ts');

const row = (p: any = {}) => ({ active: false, name: 'a@example.com', state: 'signed-in', account: { id: p.id ?? 'a' }, ...p });
const view = (p: any = {}) => ({ label: 'Codex', phase: 'ready', active: null, accounts: [], error: null, ...p }) as any;

test('a first-class harness by phase: missing, checking, starts on first use, signed out, cannot run', () => {
  assert.equal(firstClassRowState(view({ phase: 'missing' }), false).kind, 'missing');
  assert.deepEqual(firstClassRowState(view({ phase: 'checking' }), false), { kind: 'checking', line: 'Checking…', action: null });
  // idle Codex: no "Not started", and how many accounts wait for it
  assert.deepEqual(firstClassRowState(view({ phase: 'not-started' }), false), {
    kind: 'first-use',
    line: 'Starts with your first Codex chat',
    action: null,
  });
  assert.equal(
    firstClassRowState(view({ phase: 'not-started', accounts: [row(), row({ id: 'b' })] }), false).line,
    'Starts with your first Codex chat · 2 accounts',
  );
  assert.deepEqual(firstClassRowState(view({ phase: 'signed-out' }), false), {
    kind: 'signin',
    line: 'Sign in once, then MoPilot can use it.',
    action: { do: 'signin', label: 'Sign in to Codex' },
  });
  // cannot run: the cause, and the one fix (a set CLI location is changed, else it is looked for again)
  const err = view({ label: 'Claude Code', phase: 'error', error: "MoPilot can't find the claude command" });
  assert.deepEqual(firstClassRowState(err, true), {
    kind: 'cant-run',
    line: "MoPilot can't find the claude command",
    action: { do: 'location', label: 'Choose location…' },
  });
  // a refused key or credits with a CLI location set: the CLI runs, so its location is not the fix
  assert.deepEqual(firstClassRowState({ ...err, rejected: true }, true).action, { do: 'recheck', label: 'Re-check' });
  assert.deepEqual(firstClassRowState(view({ phase: 'error' }), false), {
    kind: 'cant-run',
    line: "Codex can't start",
    action: { do: 'recheck', label: 'Re-check' },
  });
});

test('a ready first-class harness by its login: quiet, signed out again, or at its limit with the next account', () => {
  assert.deepEqual(firstClassRowState(view({ active: row({ active: true }) }), false), { kind: 'ready', line: null, action: null });
  const lapsed = row({ active: true, state: 'lapsed' });
  assert.deepEqual(firstClassRowState(view({ active: lapsed }), false), {
    kind: 'signin',
    line: null,
    action: { do: 'relogin', label: 'Sign in to Codex', account: lapsed.account },
  });
  const limited = row({ active: true, state: 'limited', name: 'meggie@example.com' });
  // no other account with room: it says when it resets, with nothing to do
  assert.deepEqual(firstClassRowState(view({ active: limited, accounts: [limited, row({ id: 'x', state: 'limited' })] }), false), {
    kind: 'limit',
    line: null,
    action: null,
  });
  const next = row({ id: 'b', name: 'daxhill6@example.test' });
  assert.deepEqual(firstClassRowState(view({ active: limited, accounts: [limited, next] }), false).action, {
    do: 'use',
    label: 'Use daxhill6@',
    account: next.account,
  });
  // an account named without an email keeps its name
  const key = row({ id: 'k', name: 'Work key' });
  assert.equal(firstClassRowState(view({ active: limited, accounts: [limited, key] }), false).action?.label, 'Use Work key');
});

test('a basic harness by its admission: the same states, with its own sign-in or setup', () => {
  const b = (p: any) => basicRowState({ label: 'Kimi Code', reason: null, signsIn: true, state: 'admitted', ...p });
  assert.deepEqual(b({}), { kind: 'ready', line: 'Signed in and billed by Kimi Code', action: null });
  assert.equal(b({ state: 'checking' }).kind, 'checking');
  assert.equal(b({ state: 'missing' }).kind, 'missing');
  assert.deepEqual(b({ state: 'signin' }).action, { do: 'signin', label: 'Sign in to Kimi Code' });
  // no sign-in of its own (dsh's key): it needs setting up, says how, and is checked again
  assert.deepEqual(b({ state: 'signin', signsIn: false, reason: 'Put DEEPSEEK_API_KEY in ~/.env' }), {
    kind: 'cant-run',
    line: 'Put DEEPSEEK_API_KEY in ~/.env',
    action: { do: 'recheck', label: 'Re-check' },
  });
  assert.equal(b({ state: 'signin', signsIn: false }).line, 'Kimi Code needs setting up');
  assert.deepEqual(b({ state: 'unsupported', reason: 'its tool bridge is missing' }), {
    kind: 'cant-run',
    line: 'its tool bridge is missing',
    action: { do: 'recheck', label: 'Re-check' },
  });
  // No reason establishes a version problem; keep the failed state and retry without inventing a cause.
  for (const reason of [null, '']) {
    assert.deepEqual(b({ state: 'unsupported', reason }), {
      kind: 'cant-run',
      line: "Kimi Code can't run in MoPilot",
      action: { do: 'recheck', label: 'Re-check' },
    });
  }
  // turned off by MoPilot itself: nothing for the user to do
  assert.deepEqual(b({ state: 'off' }), { kind: 'cant-run', line: 'Turned off for now', action: null });
  assert.equal(b({ state: 'off', reason: 'Off while its bridge is fixed' }).line, 'Off while its bridge is fixed');
});
