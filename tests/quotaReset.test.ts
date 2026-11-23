// electron/session/orchestration/autoHarness.cjs quotaResetOf: when a harness that ran out of usage has it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { quotaResetOf } = require('../electron/session/orchestration/autoHarness.cjs');

test('quotaResetOf: when a harness that is out has usage again, from its logins’ reset times; null when not out or unknown', () => {
  const plan = (account: string, limited: boolean, limitedUntil?: number, billing = 'subscription') => ({
    account,
    status: 'ok',
    limited,
    billing,
    active: false,
    ...(limitedUntil === undefined ? {} : { limitedUntil }),
  });
  assert.equal(quotaResetOf(null, 'codex'), null);
  assert.equal(quotaResetOf([plan('a', false)], 'codex'), null, 'not out');
  assert.equal(quotaResetOf([plan('a', true), plan('b', true, 5)], 'codex'), null, 'one login’s reset is not known');
  assert.equal(quotaResetOf([plan('a', true, 9), plan('b', true, 5)], 'codex'), 5, 'the first login back');
  assert.equal(quotaResetOf([plan('a', true, 9), plan('b', false, 1)], 'codex'), null, 'one login still has usage');
  assert.equal(quotaResetOf([null, plan('a', true, 9)] as any, 'codex'), 9, 'an empty entry is skipped');
  assert.equal(quotaResetOf([plan('h', true, 4, 'harness')], 'codex'), 4, 'a harness-billed login counts as a plan');
  assert.equal(quotaResetOf([plan('a', true, 9), plan('kimi', true, 3)], 'acp:kimi'), 3, 'a basic harness reads only its own login');
  assert.equal(
    quotaResetOf([plan('kimi', true, 3), plan('other', false, 1), plan('other', true, 1)], 'acp:kimi'),
    3,
    'another harness’s login is not its',
  );
});
