// Update presentation distinguishes a requested rollback from an ordinary upgrade and its platform-specific action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackAction, updateDescription } from '../src/lib/updatePresentation.ts';

test('rollback copy names source and target with safe restart, idle and manual installer actions', () => {
  const base: any = {
    status: 'ready',
    available: { version: '1.9.0', notes: '', rollback: { fromVersion: '2.0.0', channel: 'stable', requestId: 'id' } },
  };
  assert.equal(rollbackAction(base), 'Restart to roll back');
  assert.equal(rollbackAction({ ...base, manual: true }), 'Download rollback');
  for (const extra of [{}, { manual: true }, { restartWhenIdle: true }, { error: 'try again' }]) {
    const text = updateDescription({ ...base, ...extra });
    assert.match(text, /2.0.0 was pulled back/);
    assert.match(text, /1.9.0/);
  }
  assert.equal(rollbackAction({ ...base, available: null }), null);
  assert.equal(rollbackAction({ ...base, available: { version: '2.1.0', notes: '' } }), null);
});

test('ordinary update states keep honest progress, failures and platform-specific installation instructions', () => {
  const desc = (value: any) => updateDescription({ available: null, ...value });
  assert.match(desc({ status: 'unsupported' }), /release builds/);
  assert.match(desc({ status: 'checking' }), /Checking/);
  assert.match(desc({ status: 'installing' }), /Restarting/);
  assert.equal(desc({ status: 'error', error: 'offline' }), 'offline');
  assert.equal(desc({ status: 'error' }), 'Update check failed.');
  assert.equal(desc({ status: 'idle' }), 'MoPilot');
  assert.match(desc({ status: 'idle', checkedAt: 1000 }), /checked/);
  assert.match(desc({ status: 'ready', available: { version: '2.1.0' } }), /Restart to install/);
  assert.match(desc({ status: 'downloading', preparing: true }), /Preparing an update/);
  assert.equal(desc({ status: 'downloading' }), 'Downloading an update…');
  assert.match(desc({ status: 'downloading', progress: { version: '2.1.0', received: 2, total: 10 } }), /20%/);
  assert.match(desc({ status: 'downloading', progress: { version: '2.1.0', received: 2, total: null } }), /Downloading version 2.1.0/);
});
