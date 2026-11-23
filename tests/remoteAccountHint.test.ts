// The QR's account hint: a stable non-secret id from the user id, a masked email, and nothing at all when no one is signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { accountId, maskEmail, accountHint } = await import('../shared/remote/accountHint.mjs');
const sha256 = (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest());

test('the id is the first eight bytes of the labelled hash, and differs per user', () => {
  const want = createHash('sha256').update('mopilot-acct-v1:user-1').digest('hex').slice(0, 16);
  assert.equal(accountId('user-1', sha256), want);
  assert.match(want, /^[0-9a-f]{16}$/);
  assert.notEqual(accountId('user-2', sha256), want);
});

test('an email keeps its first letter and its domain; anything else shows nothing', () => {
  assert.equal(maskEmail('jane@gmail.com'), 'j***@gmail.com');
  for (const bad of [undefined, 5, '', 'nope', '@x.com', 'a@']) assert.equal(maskEmail(bad), '');
});

test('the hint has both fields for a user, only the id without a usable email, and none without a user', () => {
  assert.deepEqual(accountHint(sha256, { id: 'u', email: 'a@b.co' }), { acct: accountId('u', sha256), who: 'a***@b.co' });
  assert.deepEqual(accountHint(sha256, { id: 'u' }), { acct: accountId('u', sha256) });
  for (const none of [undefined, null, {}, { id: '' }, { email: 'a@b.co' }]) assert.deepEqual(accountHint(sha256, none as any), {});
});

test('the pairing hint reads the user from a MoPilot account, and nothing from none', async () => {
  const { accountUser } = await import('../electron/remote/accountScope.cjs');
  assert.deepEqual(accountUser({ creds: { user: { id: 'u', email: 'a@b.co' } } }), { id: 'u', email: 'a@b.co' });
  for (const none of [undefined, null, {}, { creds: null }]) assert.equal(accountUser(none), undefined);
});
