// Settings → Accounts for one server account behind two logins (#1312): main lists the added login and names the CLI's
// own login folded into it (`same`). The row says it is the CLI login too, and its ⋯ menu removes the added login
// only: the CLI login stays signed in and is listed again, so it is never called a sign-out.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, ctl, resetCtl, defaultState, useStore, render, click, text, button } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { AccountsSettings } = await import('../src/components/accounts/Accounts.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

async function fromRowMenu(rowEl: Element, label: string) {
  await click(rowEl.querySelector('[aria-label^="More for"]')!);
  await click(button(rowEl, label));
}

test('the account the Codex login on this computer folded into says so, and its menu removes only the added login', async () => {
  useStore.setState({
    accounts: {
      ...useStore.getState().accounts,
      active: 'b',
      relay: false,
      same: { default: 'b' },
      accounts: [{ id: 'b', email: 'b@x.com', kind: 'chatgpt', planType: 'pro', status: 'ok', chats: 2, isDefault: false }],
    },
  });
  const { host, unmount } = await render(h(AccountsSettings, { only: 'codex' }));
  assert.equal(host.querySelector('[data-account="codex:default"]'), null);
  const r = host.querySelector('[data-account="codex:b"]')!;
  assert.match(text(r.querySelector('.acct-row-text')), /Codex login on this computer · .* · 2 chats$/);
  ctl.confirm = true;
  await fromRowMenu(r, 'Remove');
  assert.deepEqual(calls.slice(-2), [
    ['confirm', 'Remove b@x.com from Codex on this computer?'],
    ['removeAccount', 'b'],
  ]);
  await unmount();
});
