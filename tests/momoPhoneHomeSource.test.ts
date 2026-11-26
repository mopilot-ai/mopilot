// When the phone reads its own home: only when no Mac answers, for an account a Mac once allowed, and with a Host of its own to look at.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const sourcePath = '../mobile/src/momoPhone/phoneHome/source';
const { phoneHomeNow } = await import(sourcePath);

test('the phone reads its own home only when no Mac answers, the account was allowed and a Host is there', () => {
  const base = { macAllowed: null, macSilent: true, invited: true, hosts: 1 };
  assert.equal(phoneHomeNow(base), true);
  // a Mac that answers is always the one read, yes or no
  assert.equal(phoneHomeNow({ ...base, macAllowed: true }), false);
  assert.equal(phoneHomeNow({ ...base, macAllowed: false }), false);
  // not silent yet: the Mac is still being asked
  assert.equal(phoneHomeNow({ ...base, macSilent: false }), false);
  // an account no Mac ever allowed, or a phone with no Host of its own, has no home to read
  assert.equal(phoneHomeNow({ ...base, invited: false }), false);
  assert.equal(phoneHomeNow({ ...base, hosts: 0 }), false);
});
