import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import { profileIdentity } from '../src/lib/profileIdentity.ts';
const { systemUsername } = createRequire(import.meta.url)('../electron/platform/userIdentity.cjs');

test('MoPilot identity takes precedence over the local system account', () => {
  const mp = { signedIn: true, user: { id: 'u', name: '  Jane Smith ', email: 'other@example.com' } };
  assert.deepEqual(profileIdentity(mp, 'system-user'), { label: 'Jane Smith', initials: 'JS', colorKey: 'Jane Smith' });
  assert.equal(profileIdentity({ ...mp, user: { id: 'u', name: ' ', email: ' jane@example.com ' } }, 'system').label, 'jane@example.com');
  assert.equal(profileIdentity({ signedIn: true, user: null }, 'system').label, 'MoPilot');
  assert.equal(profileIdentity({ signedIn: true, user: { id: 'u', email: '', name: null } }, 'system').label, 'MoPilot');
});

test('signed-out identity uses the system user, then N/A without stale MoPilot details', () => {
  const mp = { signedIn: false, user: { id: 'old', name: 'Old login', email: 'old@example.com' } };
  assert.deepEqual(profileIdentity(mp, ' binwang '), { label: 'binwang', initials: 'BI', colorKey: 'binwang' });
  for (const value of [null, undefined, ' ', ''])
    assert.deepEqual(profileIdentity(mp, value), { label: 'N/A', initials: 'N/A', colorKey: null });
  assert.equal(profileIdentity(mp, '王明').initials, '王明');
});

test('OS username reads are trimmed and unavailable metadata cannot prevent startup', () => {
  assert.equal(systemUsername(), os.userInfo().username.trim());
  assert.equal(
    systemUsername(() => ({ username: ' local-user ' })),
    'local-user',
  );
  for (const result of [{}, { username: '' }, { username: ' ' }])
    assert.equal(
      systemUsername(() => result),
      null,
    );
  assert.equal(
    systemUsername(() => {
      throw new Error('unavailable');
    }),
    null,
  );
});
