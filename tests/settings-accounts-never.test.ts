// Settings → Accounts & billing for a Claude Code login nobody signed in to (#1867): the empty state Codex shows,
// "Not signed in" with Sign in, never a placeholder account "In use" with "Sign in again".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, ctl, resetCtl, defaultState, useStore, render, click, text, button, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { ClaudeAccount } = await import('../src/components/accounts/Accounts.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('a Claude Code login nobody signed in to: Not signed in with Sign in, as Codex shows it (#1867)', async () => {
  ctl.harnessAccounts.claude = { active: null, accounts: [] };
  ctl.status.claude = { state: 'signin', bin: '/bin/claude' };
  ctl.loginTerm = null;
  useStore.setState({ claudeAccounts: { login: null } });
  const { host, unmount } = await render(h(ClaudeAccount));
  await flush();
  assert.match(text(host), /Claude Code: Not signed in/);
  assert.equal(host.querySelector('.acct-chip.on'), null, 'no "In use"');
  await click(button(host, 'Sign in'));
  assert.deepEqual(calls.at(-1), ['signInHarness', 'claude']);
  await unmount();
});
