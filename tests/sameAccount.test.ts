// Logins that are one server account (electron/identity/contract/sameAccount.cjs, #1312): which login stands for the account,
// how a limit seen on either holds it, and what a ChatGPT login's server identity is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { foldSameAccounts, foldMarks, codexServerId } = createRequire(import.meta.url)('../electron/identity/contract/sameAccount.cjs');

const ids: Record<string, string | null> = { default: 'u-1', a: 'u-1', b: 'u-1', c: 'u-2', d: null };
const logins = ['default', 'a', 'b', 'c', 'd'].map((id) => ({ id }));
const serverId = (l: { id: string }) => ids[l.id];

test('an added login stands for the account: the one in use among them, else the first listed', () => {
  assert.deepEqual(foldSameAccounts(logins, serverId), { default: 'a', b: 'a' });
  assert.deepEqual(foldSameAccounts(logins, serverId, 'b'), { default: 'b', a: 'b' });
  // the CLI's own login in use still folds into an added one: that one is the login the user chose
  assert.deepEqual(foldSameAccounts(logins, serverId, 'default'), { default: 'a', b: 'a' });
});

test('a login alone with its account, or with no known identity, is never folded', () => {
  assert.deepEqual(foldSameAccounts([{ id: 'default' }, { id: 'c' }, { id: 'd' }], serverId), {});
  assert.deepEqual(
    foldSameAccounts([{ id: 'x' }, { id: 'y' }], () => null),
    {},
  );
});

test("a limit or the least left of a folded login holds the login shown; a lapse stays the folded login's own", () => {
  const marks = new Map<string, any>([
    ['default', { limitedUntil: 500, left: 10, expired: true }],
    ['a', { left: 40 }],
    ['b', { limitedUntil: 100 }],
  ]);
  const held = foldMarks(marks, { default: 'a', b: 'c', e: 'a' });
  assert.deepEqual(held.get('a'), { left: 10, limitedUntil: 500 });
  assert.deepEqual(held.get('c'), { limitedUntil: 100 });
  // the folded marks themselves are kept as they were, and the caller's copy is untouched
  assert.deepEqual(held.get('default'), { limitedUntil: 500, left: 10, expired: true });
  assert.deepEqual(marks.get('a'), { left: 40 });
  // a folded login seen with nothing that holds a quota adds nothing
  assert.deepEqual(foldMarks(new Map([['x', { expired: true }]]), { x: 'y' }).get('y'), {});
});

test("a ChatGPT login is its workspace and member: an email alone is no identity, and the case of it doesn't count", () => {
  assert.equal(codexServerId({ chatgptAccountId: 'acct-1', email: 'Me@Example.com' }), 'acct-1\nme@example.com');
  assert.equal(codexServerId({ chatgptAccountId: 'acct-1', email: null }), 'acct-1\n');
  assert.notEqual(
    codexServerId({ chatgptAccountId: 'acct-1', email: 'a@x.com' }),
    codexServerId({ chatgptAccountId: 'acct-1', email: 'b@x.com' }),
  );
  assert.equal(codexServerId({ chatgptAccountId: '', email: 'me@example.com' }), null);
  assert.equal(codexServerId({ email: 'me@example.com' }), null);
  assert.equal(codexServerId(null), null);
});
