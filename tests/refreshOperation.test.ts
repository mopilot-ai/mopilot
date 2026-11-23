// Refresh successor derivation is deterministic, device/domain bound and accepts only the persisted 192-bit operation format.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { refreshSuccessor, validRefreshOperation } from '../shared/remote/refreshOperation.mjs';

test('operation format rejects missing, non-string and malformed identities', () => {
  for (const value of [undefined, null, 8, '', 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(31) + '!'])
    assert.equal(validRefreshOperation(value), false);
  assert.equal(validRefreshOperation('a'.repeat(32)), true);
  assert.equal(validRefreshOperation('-_'.repeat(16)), true);
});

test('successor binds old credential, operation and device with a domain-separated HMAC', () => {
  const token = 'mprt_' + 'old'.repeat(20),
    operation = 'a'.repeat(32);
  const expected =
    'mprt_' +
    createHmac('sha256', token)
      .update(JSON.stringify(['mopilot-refresh-operation-v1', 'phone', operation]))
      .digest('base64url');
  assert.equal(refreshSuccessor(token, 'phone', operation), expected);
  assert.notEqual(refreshSuccessor(token, 'other', operation), expected);
  assert.notEqual(refreshSuccessor(token, 'phone', 'b'.repeat(32)), expected);
  assert.notEqual(refreshSuccessor('other-token', 'phone', operation), expected);
});
