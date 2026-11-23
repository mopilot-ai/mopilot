// D-84: a Claude chat moving to another account restarts its CLI, so the old process's settings are
// neither applied to it nor kept for the new one (src/harness/claudeTranslate.ts liveControls).
// Before this, claudeStartTurn skipped the controls on an account change but left the old entry in
// `live` until the send returned, while the new process's first events (init, rate limits) were
// read against it. The entry now goes before the send.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { liveControls } = await import('../src/harness/claudeTranslate.ts');

const base = { model: 'opus', effort: 'high', permission: 'default', fast: false, account: 'a' };

test('another account: no controls to the old process, and its live entry goes', () => {
  assert.equal(liveControls({ ...base }, { ...base, account: 'b', model: 'sonnet', effort: 'low' }), null);
});

test('no live process: nothing to change in place', () => {
  assert.equal(liveControls(undefined, base), null);
});

test('same account: only what changed, effort and fast together', () => {
  assert.deepEqual(liveControls(base, base), []);
  assert.deepEqual(liveControls(base, { ...base, model: 'sonnet', fast: true, permission: 'plan' }), [
    ['setModel', 'sonnet'],
    ['applyFlagSettings', { effortLevel: 'high', fastMode: true }],
    ['setPermissionMode', 'plan'],
  ]);
});
