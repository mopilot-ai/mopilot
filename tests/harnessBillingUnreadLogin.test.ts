// The offer to pay for Claude Code access once a subscription runs out (src/session/harness/billing.ts) waits for the CLI's own
// login to be read: until then it reads signed out, and another subscription that was about to take over would be missed.
// The logins it weighs are ranked by what each has left, as main ranks them (shared/switch.mjs).
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';
import { claudeSignedOut } from '../src/harness/accounts.ts';

mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: {
    recheckClaude: async () => {},
    ...Object.fromEntries(
      ['addClaudeAccount', 'pinClaudeChat', 'reloginClaudeAccount', 'removeClaudeAccount', 'switchClaudeAccount'].map((n) => [n, () => {}]),
    ),
  },
});
const billing = await import('../src/session/harness/billing.ts');

const future = () => Math.floor(Date.now() / 1000) + 3600;
const fire = () => fx.listeners.forEach((l) => l(fx.state, fx.state));
beforeEach(reset);
// the watch listens for the whole file; each test sets the store it reads
reset();
fx.native.claude = { apiKey: async () => ({ mode: 'subscription', set: false }) };
billing.startLimitWatch();

/** meggie (the login in use) is out of usage; `cli` is the CLI's own login as the window last heard of it */
function outOfUsage(cli: Record<string, unknown>, resetsAt: number) {
  fx.mopilot.signedIn = true;
  fx.state.claude.status = { state: 'ready', usage: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt }] } };
  fx.state.claudeAccounts = {
    active: 'meggie',
    autoSwitch: true,
    accounts: [
      { id: 'default', email: 'cli@example.test', authMethod: 'claude.ai', loggedIn: false, ...cli },
      { id: 'meggie', email: 'meggie@example.test', authMethod: 'claude.ai', loggedIn: true },
    ],
  };
}

test("no offer while the CLI's own login has not been read; once it reads signed in, the other subscription takes over and nothing is offered", () => {
  outOfUsage({ checked: false }, future() + 10);
  fire();
  assert.equal(called('toast').length, 0);
  // the read lands: signed in, so main moves the chat there and there is nothing to pay for
  fx.state.claudeAccounts.accounts[0] = { ...fx.state.claudeAccounts.accounts[0], loggedIn: true, checked: true };
  fire();
  assert.equal(called('toast').length, 0);
});

test('the offer is still made once the CLI login has been read and is signed out; and for a login main never marks as unread', () => {
  outOfUsage({ checked: true }, future() + 20);
  fire();
  assert.equal(called('toast')[0]?.[0], 'Claude Code has reached its subscription limit');
  // a main that does not say (an older one) never defers the offer
  reset();
  outOfUsage({}, future() + 30);
  fire();
  assert.equal(called('toast').length, 1);
});

test('the logins an offer weighs are ranked by what each has left, the login in use first among equals', () => {
  const w = (usedPercent: number) => ({ windows: [{ label: 'Weekly', usedPercent, resetsAt: future() + 40 }], at: Date.now() });
  const accounts = ['a', 'b', 'c', 'd'].map((id) => ({ id, authMethod: 'claude.ai', loggedIn: true }));
  const state = {
    ...fx.state,
    claudeAccounts: { active: 'b', autoSwitch: true, accounts },
    claudeUsage: { a: w(70), b: w(70), c: w(10), d: undefined },
  };
  const { from, candidates } = billing.limitInstances('claude', state as any, null, false);
  assert.equal(from?.id, 'b');
  // d has no reading (full), c has the most left of the read ones, b is the one in use so it leads a at 30% left
  assert.deepEqual(
    candidates.map((c) => c.id),
    ['d', 'c', 'b', 'a'],
  );
});

test("the signed-out banner is not shown for a chat on the CLI's own login until that login has been read", () => {
  const row = { id: 'default', email: 'cli@example.test', loggedIn: false };
  const pool = (checked?: boolean) => ({
    active: 'a',
    accounts: [
      { ...row, ...(checked === undefined ? {} : { checked }) },
      { id: 'a', email: 'a@example.test', loggedIn: true },
    ],
  });
  const chats = { c1: { id: 'default' } };
  assert.equal(claudeSignedOut({ state: 'ready' }, pool(false), chats, 'c1'), null);
  assert.equal(claudeSignedOut({ state: 'ready' }, pool(true), chats, 'c1')?.login, 'default');
  // a main that does not say counts the login as read
  assert.equal(claudeSignedOut({ state: 'ready' }, pool(), chats, 'c1')?.login, 'default');
});
