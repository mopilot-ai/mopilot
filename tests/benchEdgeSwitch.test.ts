// The edge and MGB drivers verify harness identity separately from shared model names and wait for completed switches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { pickedIn, switchConfirmed } = await import('../bench/lib/edge.mjs');

test('pickedIn requires independently observed harness identity, including shared models', () => {
  assert.equal(pickedIn('Big Pickle', 'opencode', 'Big Pickle', 'OpenCode'), true);
  assert.equal(pickedIn('big pickle', 'opencode', 'Big Pickle', 'opencode'), true);
  assert.equal(pickedIn('Big Pickle', 'opencode', '', 'opencode'), true);
  assert.equal(pickedIn('Sonnet 5.5', 'opencode', 'Sonnet 5.5', 'Claude Code'), false);
  assert.equal(pickedIn('Big Pickle', 'opencode', 'Big Pickle', ''), false);
  assert.equal(pickedIn('Big Pickle', '', 'Big Pickle', ''), false);
  assert.equal(pickedIn('GPT-6 Luna', 'opencode', 'Big Pickle', 'opencode'), false);
  assert.equal(pickedIn('Big Pickle Extended', 'opencode', 'Big Pickle', 'opencode'), false);
});

test('switch confirmation requires completed identity and accepts a successful retry', () => {
  const base = {
    found: true,
    after: 'GPT-6 Luna',
    afterHarness: 'Codex',
    switchTo: 'Codex',
    switchModel: 'GPT-6 Luna',
    sheetGone: true,
    sheetUp: true,
    clicked: true,
  };
  const no = { confirmed: false, quick: false };
  assert.deepEqual(switchConfirmed(base), { confirmed: true, quick: false });
  for (const change of [
    { clicked: false },
    { found: false },
    { sheetGone: false },
    { after: 'Sonnet 5.5' },
    { afterHarness: 'opencode' },
  ]) {
    assert.deepEqual(switchConfirmed({ ...base, ...change }), no);
    assert.deepEqual(switchConfirmed(base), { confirmed: true, quick: false });
  }
  const quick = { ...base, sheetUp: false, clicked: false };
  assert.deepEqual(switchConfirmed(quick), { confirmed: true, quick: true });
  assert.deepEqual(switchConfirmed({ ...quick, afterHarness: 'opencode' }), no);
  assert.deepEqual(switchConfirmed({ ...quick, switchModel: '' }), { confirmed: true, quick: true });
});
