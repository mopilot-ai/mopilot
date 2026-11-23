// Native permission projection preserves temporary restrictions, unknown boundaries and destination ownership across harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePermission, reportedPermission } from '../shared/effectivePermission.mjs';

test('native restrictions win over saved settings and unknown reports retain the saved fallback', () => {
  for (const [native, expected] of [
    ['plan', 'plan'],
    ['dontAsk', 'read-only'],
    ['readOnly', 'read-only'],
    ['read-only', 'read-only'],
    ['bypassPermissions', 'full-access'],
    ['full-access', 'full-access'],
    ['auto', 'auto-review'],
    ['acceptEdits', 'default'],
    ['default', 'default'],
    [null, null],
    ['future', 'default'],
    ['constructor', 'default'],
    [[], 'default'],
    [['dontAsk'], 'default'],
    [['bypassPermissions'], 'default'],
    [{}, 'default'],
    [undefined, null],
  ]) {
    assert.equal(reportedPermission({ permission: native } as any), expected);
    assert.equal(effectivePermission({ permission: 'full-access' }, 'default', { permission: native } as any), expected ?? 'full-access');
  }
  assert.equal(reportedPermission(), null);
  assert.equal(effectivePermission(), 'default');
  assert.equal(effectivePermission({ permission: 'unknown' }, 'auto-review'), 'auto-review');
  assert.equal(effectivePermission({ permission: 'plan' }, 'full-access'), 'plan');
  assert.equal(effectivePermission(null, 'full-access', { plan: true, permission: 'bypassPermissions' }), 'full-access');
  assert.equal(effectivePermission(null, 'full-access', { pendingSwitch: { harness: 'claude' }, permission: 'plan' }), 'full-access');
});

test('ACP session modes and config-option modes resolve only their own declared anchor', () => {
  for (const [anchor, expected] of [
    ['readOnly', 'read-only'],
    ['ask', 'default'],
    ['auto', 'auto-review'],
    ['full', 'full-access'],
    ['future', 'default'],
    ['constructor', 'default'],
    [null, 'default'],
  ]) {
    for (const acp of [
      { modes: { currentModeId: 'own' }, anchors: { own: anchor } },
      {
        configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'own', options: [{ value: 'own' }] }],
        anchors: { own: anchor },
      },
    ])
      assert.equal(reportedPermission({ acp, permission: 'bypassPermissions' } as any, true), expected);
  }
  assert.equal(reportedPermission({ acp: {} }, true), null);
  assert.equal(reportedPermission({ acp: { modes: { currentModeId: 'unknown' } } }, true), 'default');
  assert.equal(reportedPermission({ acp: { modes: { currentModeId: 'own' }, anchors: { own: ['full'] } } } as any, true), 'default');
  assert.equal(reportedPermission(null, true), null);
  assert.equal(
    reportedPermission({ permission: 'dontAsk', acp: { modes: { currentModeId: 'own' }, anchors: { own: 'full' } } }),
    'read-only',
  );
});
