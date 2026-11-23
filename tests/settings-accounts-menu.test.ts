// Accounts UI: each harness's row in the profile menu, its account switcher, default harness and the way to
// Accounts & billing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, ctl, resetCtl, defaultState, useStore, render, click, text, button, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { HarnessAccountsMenu, BasicHarnessMenuRow } = await import('../src/components/accounts/Accounts.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});
const find = (root: Element, label: string) => [...root.querySelectorAll('button')].find((b) => text(b) === label);

const acct = (p: any = {}) => ({
  id: 'a1',
  harness: 'codex',
  email: 'me@x.com',
  plan: 'Pro',
  kind: 'subscription',
  status: 'ok',
  left: 70,
  usage: { windows: [], at: null },
  ...p,
});

test('profile menu row: who it runs as, usage, the account switcher, adding, default harness and managing accounts', async () => {
  const refresh: string[] = [];
  ctl.parts.codex = {
    refreshUsage: async () => {
      refresh.push('codex');
    },
  };
  const a1 = acct(),
    a2 = acct({ id: 'a2', email: 'two@x.com', plan: null, status: 'expired' }),
    a3 = acct({ id: 'a3', email: 'three@x.com', plan: null, kind: 'apiKey' });
  ctl.harnessAccounts.codex = { active: a1, accounts: [a1, a2, a3], multi: true };
  const { host, unmount } = await render(h(HarnessAccountsMenu, { h: 'codex' }));
  assert.deepEqual(refresh, ['codex']);
  assert.equal(text(host.querySelector('.submenu-label')), 'Codexme@x.com · Pro70% left');
  assert.equal(text(host.querySelector('header')), 'Codex · 3 accounts');
  // the account in use is checked in the column on the left
  assert.equal(host.querySelectorAll('.acct-choice-check svg').length, 1);
  assert.ok(host.querySelectorAll('.menu-item')[0].querySelector('.acct-choice-check svg'));
  const items = [...host.querySelectorAll('.menu-item')];
  assert.equal(text(items[0]), 'MEme@x.comPro · 70% left');
  assert.equal(text(items[1]), 'TWtwo@x.comSign-in expired');
  assert.ok(items[1].querySelector('.acct-warn'));
  assert.equal(text(items[2]), 'THthree@x.comBilled per token');
  await click(items[1]);
  // picking a lapsed login chooses it, which signs it in again (harness/select.ts chooseAccount)
  const chosen = calls.filter((c) => c[0] === 'chooseAccount').at(-1)!;
  assert.equal(chosen[1].id, 'a2');
  await click(button(host, 'Add account…'));
  assert.deepEqual(calls.at(-1), ['addHarnessAccount', 'codex']);
  await click(button(host, 'Default for new chats'));
  assert.deepEqual(calls.at(-1), ['setPrefs', { defaultHarness: 'codex' }]);
  await click(button(host, 'Manage accounts…'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'accounts', tab: 'row:codex:a1' }]);
  await unmount();
});

test('profile menu row: "Default for new chats" follows a basic harness picked as the default, and moves it back (#1293)', async () => {
  const a = acct();
  ctl.harnessAccounts.codex = { active: a, accounts: [a], multi: true };
  // opencode is the default: Codex is not checked
  useStore.setState({ prefs: { ...useStore.getState().prefs, defaultHarness: 'acp:opencode' } });
  const { host, unmount } = await render(h(HarnessAccountsMenu, { h: 'codex' }));
  const item = () => button(host, 'Default for new chats')!;
  assert.equal(item().querySelector('[aria-label=Default]'), null);
  // choosing it makes Codex the default, replacing opencode
  await click(item());
  assert.deepEqual(calls.at(-1), ['setPrefs', { defaultHarness: 'codex' }]);
  await flush();
  assert.ok(item().querySelector('[aria-label=Default]'));
  await unmount();
});

test('profile menu row: a key with no email says what it is once', async () => {
  const k = acct({ email: null, plan: 'API key', kind: 'apiKey', left: null });
  ctl.harnessAccounts.codex = { active: k, accounts: [k], multi: true };
  const { host, unmount } = await render(h(HarnessAccountsMenu, { h: 'codex' }));
  assert.equal(text(host.querySelector('.submenu-label')), 'CodexAPI key');
  await unmount();
});

test('profile menu row: the email may end in an ellipsis, the plan always shows whole', async () => {
  const a = acct({ email: 'a.very.long.address@example.test', plan: 'Pro Lite' });
  ctl.harnessAccounts.codex = { active: a, accounts: [a], multi: true };
  const { host, unmount } = await render(h(HarnessAccountsMenu, { h: 'codex' }));
  const line = host.querySelector('.submenu-label .acct-split')!;
  assert.equal(text(line.querySelector('.acct-split-who')), 'a.very.long.address@example.test');
  assert.equal(text(line.querySelector('.acct-split-plan')), '· Pro Lite');
  await unmount();
});

test('profile menu row: an active account without usage shows no shortcut', async () => {
  const a = acct({ plan: null, left: null });
  ctl.harnessAccounts.codex = { active: a, accounts: [a], multi: true };
  const { host, unmount } = await render(h(HarnessAccountsMenu, { h: 'codex' }));
  assert.equal(text(host.querySelector('.submenu-label')), 'Codexme@x.com');
  assert.equal(text(host.querySelector('.menu-item')), 'MEme@x.comUsage unknown');
  await unmount();
});

test('profile menu row: warnings, signed-out states and the sign-in action', async () => {
  ctl.parts.claude = {
    refreshUsage: async () => {
      throw new Error('offline');
    },
  };
  const expired = acct({ id: 'c1', harness: 'claude', status: 'expired', plan: null });
  ctl.harnessAccounts.claude = { active: expired, accounts: [expired], multi: false };
  let r = await render(h(HarnessAccountsMenu, { h: 'claude' }));
  await flush();
  assert.equal(text(r.host.querySelector('.submenu-label')), 'Claude CodeSign-in expired');
  assert.equal(text(r.host.querySelector('header')), 'Claude Code account');
  assert.ok(find(r.host, 'Sign in with another account…'));
  await r.unmount();
  useStore.setState({ prefs: { ...useStore.getState().prefs, defaultHarness: 'claude' } });
  for (const [state, label] of [
    ['missing', 'Not installed'],
    ['detecting', 'Checking…'],
    ['signin', 'Not signed in'],
  ]) {
    ctl.status.claude = { state };
    ctl.harnessAccounts.claude = { active: null, accounts: [], multi: false };
    calls.length = 0;
    r = await render(h(HarnessAccountsMenu, { h: 'claude' }));
    assert.equal(text(r.host.querySelector('.submenu-label')), `Claude Code${label}`);
    if (state === 'missing') {
      assert.equal(find(r.host, 'Sign in…'), undefined);
      assert.ok(button(r.host, 'Default for new chats').disabled);
    } else {
      await click(button(r.host, 'Sign in…'));
      assert.deepEqual(calls.at(-1), ['signInHarness', 'claude']);
    }
    assert.ok(button(r.host, 'Default for new chats').querySelectorAll('svg').length >= 2);
    // with no account the link opens Accounts & billing itself
    await click(button(r.host, 'Manage accounts…'));
    assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'accounts' }]);
    await r.unmount();
  }
  ctl.parts.claude = { addsAccountDirectly: true };
  ctl.status.claude = { state: 'signin' };
  r = await render(h(HarnessAccountsMenu, { h: 'claude' }));
  await click(button(r.host, 'Sign in…'));
  assert.deepEqual(calls.at(-1), ['addHarnessAccount', 'claude']);
  await r.unmount();
});

test('profile menu row: a harness left for first use says when it starts, not "Checking…"', async () => {
  ctl.status.codex = { state: 'detecting', idle: true };
  ctl.harnessAccounts.codex = { active: null, accounts: [], multi: true };
  const { host, unmount } = await render(h(HarnessAccountsMenu, { h: 'codex' }));
  assert.equal(text(host.querySelector('.submenu-label')), 'CodexStarts on first use · Nothing runs until your first chat with it');
  await unmount();
});

test('an installed basic harness in the profile menu: managed by itself, signed in or not, opening Other harnesses', async () => {
  const b = (state: string) => ({
    id: 'oc',
    label: 'opencode',
    state,
    reason: null,
    bin: null,
    version: null,
    authMethods: [],
    login: null,
  });
  const { host, unmount } = await render(h(BasicHarnessMenuRow, { b: b('admitted') as any }));
  const item = host.querySelector('.menu-item')!;
  assert.equal(text(item), 'opencodeManaged by opencode · Ready');
  assert.equal(!!item.querySelector('.acct-warn'), false);
  assert.equal(!!item.querySelector('.acct-status.warn'), false);
  await click(item);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'other-harnesses' }]);
  await unmount();
  for (const [state, line] of [
    // never signed in, or lapsed: both read true (#2034)
    ['signin', 'Not signed in'],
    ['unsupported', 'Not supported'],
    ['checking', 'Checking…'],
    ['off', 'Turned off'],
    ['missing', 'Not installed'],
  ]) {
    const r = await render(h(BasicHarnessMenuRow, { b: b(state) as any }));
    const it = r.host.querySelector('.menu-item')!;
    assert.equal(text(it), `opencodeManaged by opencode · ${line}`);
    assert.ok(it.querySelector('.acct-status.warn'));
    // only a sign-in it is waiting for gets the warning mark
    assert.equal(!!it.querySelector('.acct-warn'), state === 'signin');
    await r.unmount();
  }
});
