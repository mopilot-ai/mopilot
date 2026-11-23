// The model picker's account row (src/components/harnessPicker/AccountRow.tsx): shown when the harness has several
// accounts or the chat is pinned, named as every surface names a chat's account, opening the account list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { render } from './support/shell-chrome-kit.ts';
import { mockSource } from './support/stubs.ts';

let views: Record<string, any> = {};
let own: Record<string, any> = {};
const labels = await import('../src/harness/chatAccountLabel.ts');
mockSource('src/session/harness/select.ts', {
  useHarnessAccounts: (h: string) => views[h] ?? { active: null, accounts: [] },
  useChatAccount: (h: string, chatId: string | null) => own[`${h}:${chatId}`] ?? null,
  chatAccountLabel: labels.chatAccountLabel,
});
// the real avatar: a stub here once hid that the account showed "API" for an unverified login (#1930)
const { AccountRow } = await import('../src/components/harnessPicker/AccountRow.tsx');

const a = (id: string, extra: any = {}) => ({ id, email: `${id}@x.dev`, plan: null, ...extra });
const accountRow = async (h: string, chatId: string | null) => {
  let opened = 0;
  const v = await render(createElement(AccountRow, { h: h as any, chatId, onOpen: () => opened++ }));
  const el = v.host.querySelector('.hp-account') as HTMLButtonElement | null;
  const out = el && {
    name: el.querySelector('.hp-account-name')!.textContent,
    note: el.querySelector('.hp-account-note')?.textContent ?? null,
    title: el.getAttribute('title'),
    label: el.getAttribute('aria-label'),
    avatar: el.querySelector('.profile-avatar')!.textContent,
    sep: el.previousElementSibling?.getAttribute('role') ?? null,
    opens: (el.click(), opened),
    // → opens it too; other keys are left to the effort panel
    keys:
      (['ArrowLeft', 'ArrowRight'].map((key) => el.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key, bubbles: true }))),
      opened),
  };
  await v.unmount();
  return out;
};

test('one account and no pin: nothing to choose, so no row', async () => {
  views = { codex: { active: a('one'), accounts: [a('one')] } };
  own = {};
  assert.equal(await accountRow('codex', null), null);
  assert.equal(await accountRow('claude', 'c1'), null, 'a harness with no accounts');
});

test('several accounts: a new chat shows the one in use, a chat its own; a click opens the account list', async () => {
  views = { codex: { active: a('one'), accounts: [a('one'), a('two', { unverified: true })] } };
  own = { 'codex:c1': { id: 'two', pinned: false, serving: 'two' } };
  assert.deepEqual(await accountRow('codex', null), {
    name: 'one@x.dev',
    note: null,
    title: 'one@x.dev',
    label: 'Account: one@x.dev',
    avatar: 'ON',
    sep: 'separator',
    opens: 1,
    keys: 2,
  });
  // an unverified login's email may be another account's: "?" as the account list shows it, never "API" (#1930)
  const unverified = await accountRow('codex', 'c1');
  assert.equal(unverified?.avatar, '?');
  assert.equal(unverified?.name, labels.chatAccountLabel({ id: 'two', pinned: false, serving: 'two' }, views.codex.accounts));
});

test("a pinned chat says so, and names the pin while it can't serve the chat", async () => {
  views = { claude: { active: a('home'), accounts: [a('home'), a('work')] } };
  own = { 'claude:c1': { id: 'work', pinned: true, serving: 'work' }, 'claude:c2': { id: 'work', pinned: true, serving: 'home' } };
  assert.deepEqual(await accountRow('claude', 'c1'), {
    name: 'work@x.dev',
    note: 'Pinned to this chat',
    title: 'work@x.dev',
    label: 'Account: work@x.dev',
    avatar: 'WO',
    sep: 'separator',
    opens: 1,
    keys: 2,
  });
  assert.deepEqual(await accountRow('claude', 'c2'), {
    name: 'home@x.dev',
    note: 'Pinned to work@x.dev',
    title: 'Pinned to work@x.dev · now on home@x.dev',
    label: 'Account: Pinned to work@x.dev · now on home@x.dev',
    avatar: 'HO',
    sep: 'separator',
    opens: 1,
    keys: 2,
  });
  // pinned with a single account still shows; an account no longer listed shows nothing
  views = { claude: { active: a('work'), accounts: [a('work')] } };
  own = { 'claude:c3': { id: 'work', pinned: true, serving: 'work' }, 'claude:c4': { id: 'gone', pinned: true, serving: 'gone' } };
  assert.equal((await accountRow('claude', 'c3'))?.note, 'Pinned to this chat');
  assert.equal(await accountRow('claude', 'c4'), null);
  // several accounts but none in use and no chat of its own
  views = { claude: { active: null, accounts: [a('x'), a('y')] } };
  assert.equal(await accountRow('claude', null), null);
});

test('accounts that start alike read as the account list tells them apart, not as the same initials (#1930)', async () => {
  const d = (n: string) => ({ id: n, email: `${n}.reg@gmail.com`, plan: 'team' });
  views = { codex: { active: d('dax3'), accounts: [d('dax0'), d('daxhill6'), d('dax3'), d('dax4')] } };
  own = {};
  assert.equal((await accountRow('codex', null))?.avatar, 'D3');
});
