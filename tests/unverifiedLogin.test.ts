// A Claude Code login whose account is not confirmed (electron/harness/claude/loginIdentity.cjs) across the renderer: it is
// named as the CLI login, says so before its usage, and its avatar shows no one's initials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountName, accountStatusText, claudeAccounts } from '../src/harness/accounts.ts';
import { accountAvatars } from '../src/components/accounts/presentation.tsx';
import { harnessAccountView } from '../src/harness/accountView.ts';

const st = { state: 'ready', bin: '/x', version: null, plan: 'Claude Max', usage: null } as any;
const pool = (identity: 'verified' | 'unverified' | null) => ({
  active: 'default',
  autoSwitch: true,
  login: null,
  accounts: [
    {
      id: 'default',
      email: 'dz@example.com',
      subscriptionType: 'max',
      organizationType: null,
      rateLimitTier: null,
      loggedIn: true,
      isDefault: true,
      identity,
    },
    {
      id: 'b1',
      email: 'dz@example.com',
      subscriptionType: 'max',
      organizationType: null,
      rateLimitTier: null,
      loggedIn: true,
      isDefault: false,
      identity: null,
    },
  ],
});
const usage = { default: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: null }], at: Date.now() } } as any;

test('only an unverified CLI login is marked, and it is named as the CLI login rather than the account its config names', () => {
  const doubted = claudeAccounts(st, pool('unverified'), usage);
  const [cli, added] = doubted.accounts;
  assert.equal(cli.unverified, true);
  assert.equal('unverified' in added, false);
  assert.equal(accountName(cli), 'Claude Code login');
  assert.equal(accountName(added), 'dz@example.com');
  for (const identity of ['verified', null] as const) {
    const sure = claudeAccounts(st, pool(identity), usage).accounts[0];
    assert.equal('unverified' in sure, false);
    assert.equal(accountName(sure), 'dz@example.com');
  }
});

test("its status says it is unverified, then this login's own usage, as a warning", () => {
  const [cli] = claudeAccounts(st, pool('unverified'), usage).accounts;
  assert.deepEqual(accountStatusText(cli), { text: 'Account unverified · Limit reached', tone: 'warn' });
});

test("its avatar is a question mark in the list's own color order; the others keep their initials", () => {
  const [cli, added] = claudeAccounts(st, pool('unverified'), usage).accounts;
  const [a, b] = accountAvatars([cli, added]);
  assert.equal(a.initials, '?');
  assert.equal(b.initials, 'DZ');
  assert.notEqual(a.color, b.color);
});

test('a login whose email is not known yet is "?" too; "API" stays for a key and MoPilot credits keep theirs', () => {
  const [login, key, credits, mail] = accountAvatars([
    { email: null, kind: 'subscription', plan: null },
    { email: null, kind: 'apiKey', plan: 'API key' },
    { email: null, kind: 'subscription', plan: 'MoPilot credits' },
    { email: 'dz@example.test', kind: 'subscription', plan: null },
  ]);
  assert.equal(login.initials, '?');
  assert.equal(key.initials, 'API');
  assert.equal(credits.initials, 'API');
  assert.equal(mail.initials, 'DZ');
  // a caller that gives no kind keeps the old reading
  assert.equal(accountAvatars([{ email: null }])[0].initials, 'API');
});

// #1582: an added login whose token the server named another account than the one it was added as.
test('an added login signed in as another account is named by that account, says so, and offers to sign in again', () => {
  const p = pool(null);
  p.accounts[1] = { ...p.accounts[1], identity: 'mismatch', addedAs: 'meg@example.com' } as any;
  const [, added] = claudeAccounts(st, p, { b1: usage.default } as any).accounts;
  assert.equal(added.addedAs, 'meg@example.com');
  assert.equal(accountName(added), 'dz@example.com');
  assert.deepEqual(accountStatusText(added), { text: 'Signed in as another account · Limit reached', tone: 'warn' });
  const row = harnessAccountView(st, claudeAccounts(st, p, { b1: usage.default } as any)).accounts[1];
  assert.deepEqual(
    [row.state, row.action, row.note],
    ['unverified', 'verify', 'Added as meg@example.com. Sign in again as meg@example.com to use that account here.'],
  );
  // a mismatch with no added account named, or a verified login, is not marked
  p.accounts[1] = { ...p.accounts[1], addedAs: null } as any;
  assert.equal('addedAs' in claudeAccounts(st, p, usage).accounts[1], false);
});
