// The tab that opens Accounts & billing on one account's row (/logout, Log Out).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { accountRowTab, accountRowOf, resolveSection } = await import('../src/lib/settingsNav.ts');

test('the tab that opens an account row round-trips, and other tabs name no row', () => {
  const tab = accountRowTab('codex', 'acct:1');
  assert.equal(accountRowOf(tab), 'codex:acct:1');
  assert.equal(accountRowOf('advanced'), null);
  assert.equal(accountRowOf(undefined), null);
  assert.deepEqual(resolveSection('accounts', tab), { section: 'accounts', tab });
});
