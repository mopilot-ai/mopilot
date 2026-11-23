// How the request ledger names a Claude Code session's payment from the harness (electron/harness/claude/auth.cjs ledgerMarks): a
// Console login is paid per use, a subscription login is a plan, and a session's process is read for the billing it started with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuth } = require('../electron/harness/claude/auth.cjs');

test('the ledger marks read a login’s billing and a session’s own start, never the key', () => {
  const sessions = new Map([
    ['claude:sub', { billing: 'subscription' }],
    ['claude:key', { billing: '["apiKey","https://api.anthropic.com","sk-ant-secret"]' }],
  ]);
  const auth = createAuth({ sessions, gatewayKey: () => null }, { restartIdle: () => {} });
  const m = auth.ledgerMarks;
  assert.equal(m.loginPay('console_api_key'), 'key');
  assert.equal(m.loginPay('claude.ai'), 'plan');
  assert.equal(m.loginPay(null), 'plan');
  assert.equal(m.billingOf('claude:sub'), 'subscription');
  assert.equal(m.billingOf('claude:key'), 'apiKey');
  assert.equal(m.billingOf('claude:gone'), 'unknown', 'a session no longer open');
  assert.equal(m.authMode, auth.authMode);
  assert.equal(m.cloud, auth.cloudRoute);
});
