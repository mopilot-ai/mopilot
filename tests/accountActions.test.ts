// Under a provider's accounts in Accounts & billing (src/components/pages/settings/AccountActions.tsx): Add account and
// Use an API key, the key form in place, and the one automatic-switching toggle, the same for every harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { settingsExports, render, click, byText, maybeText, flush } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
stubStore({ toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`]) });

const billing: Record<string, any> = {};
const auto: Record<string, boolean> = { codex: true, claude: false };
let setResult: () => Promise<unknown> = async () => {};
let accounts: Record<string, any[]> = { codex: [], claude: [] };
const part = (id: string) => ({
  useBilling: () => billing[id],
  useAutoSwitch: () => [auto[id], (on: boolean) => (calls.push(['auto', id, on]), setResult())],
});
mock.module('../src/components/harness/parts.tsx', { namedExports: { PARTS: { codex: part('codex'), claude: part('claude') } } });
mock.module('../src/session/harness/useAccountView.ts', {
  namedExports: { useAccountView: (id: string) => ({ accounts: accounts[id].map((kind) => ({ account: { kind } })) }) },
});
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
// the form's own behavior is tests/page-billing-row.test.ts': here, where it opens and what saving it does
let saveKey: ((k: string, u: string) => Promise<void>) | null = null;
let cancelKey: (() => void) | null = null;
mock.module('../src/components/pages/settings/BillingRow.tsx', {
  namedExports: {
    KeyField: (p: any) => (
      (saveKey = p.onSave), (cancelKey = p.onCancel), h('form', { 'data-key-form': p.official, 'data-url': p.urlPlaceholder })
    ),
  },
});

const { AccountActions, AUTO_SWITCH_TITLE } = await import('../src/components/pages/settings/AccountActions.tsx');

const keys = (official: string) => ({ placeholder: 'sk-…', urlPlaceholder: `https://${official}`, official });
for (const id of ['codex', 'claude'] as const)
  billing[id] = {
    keys: keys(id === 'codex' ? 'OpenAI' : 'Anthropic'),
    hasKey: false,
    onAddKey: async (k: string, u: string) => void calls.push(['addKey', id, k, u]),
  };

const add = (id: string) => h('button', { 'data-add': id }, 'Add account');

test('every harness: Add account first, then Use an API key, which opens the key form in place', async () => {
  for (const id of ['codex', 'claude'] as const) {
    calls.length = 0;
    const v = await render(h(AccountActions, { h: id, add: add(id) }));
    const row = v.host.querySelector('.acct-add-row')!;
    assert.deepEqual(
      [...row.children].map((e) => e.textContent),
      ['Add account', 'Use an API key'],
    );
    assert.equal(v.host.querySelector('[data-key-form]'), null);
    await click(byText(v.host, 'Use an API key'));
    // the form names this harness's own provider, and the action steps aside while it is open
    assert.equal(v.host.querySelector('[data-key-form]')!.getAttribute('data-key-form'), billing[id].keys.official);
    assert.equal(maybeText(v.host, 'Use an API key'), null);
    await act(async () => cancelKey!());
    assert.equal(v.host.querySelector('[data-key-form]'), null);
    await click(byText(v.host, 'Use an API key'));
    await act(async () => saveKey!('sk-1', ''));
    assert.deepEqual(calls, [['addKey', id, 'sk-1', '']]);
    assert.equal(v.host.querySelector('[data-key-form]'), null, 'saved: the form closes');
    await v.unmount();
  }
});

test('a failed save keeps the form open (the form says why)', async () => {
  const before = billing.codex.onAddKey;
  billing.codex.onAddKey = async () => {
    throw new Error('bad key');
  };
  const v = await render(h(AccountActions, { h: 'codex', add: add('codex') }));
  await click(byText(v.host, 'Use an API key'));
  let said: unknown = null;
  await act(async () => {
    await saveKey!('sk-x', '').catch((e) => (said = e));
  });
  assert.match(String(said), /bad key/);
  assert.ok(v.host.querySelector('[data-key-form]'));
  billing.codex.onAddKey = before;
  await v.unmount();
});

test('a saved key not in use: the action switches to it; a key in use and no Add account leave the row empty', async () => {
  billing.claude.hasKey = true;
  billing.claude.mode = 'subscription';
  billing.claude.onSwitch = async (m: string) => void calls.push(['switch', m]);
  calls.length = 0;
  const v = await render(h(AccountActions, { h: 'claude', add: null }));
  await click(byText(v.host, 'Use an API key'));
  assert.deepEqual(calls, [['switch', 'apiKey']]);
  assert.equal(v.host.querySelector('[data-key-form]'), null, 'no form for a key already saved');
  // a failed switch says why
  billing.claude.onSwitch = async () => {
    throw new Error('locked');
  };
  calls.length = 0;
  await click(byText(v.host, 'Use an API key'));
  await flush();
  assert.deepEqual(calls, [['toast', "Couldn't use the API key: locked"]]);
  await v.unmount();
  billing.claude.mode = 'apiKey';
  const inUse = await render(h(AccountActions, { h: 'claude', add: null }));
  assert.equal(inUse.host.querySelector('.acct-add-row')!.children.length, 0);
  await inUse.unmount();
  billing.claude.hasKey = false;
  billing.claude.mode = 'subscription';
});

test('automatic switching: one toggle once there are two subscriptions, keys not counted; a failed write says so', async () => {
  accounts = { codex: ['subscription', 'apiKey'], claude: ['subscription'] };
  let v = await render(h(AccountActions, { h: 'codex', add: add('codex') }));
  assert.equal(v.host.querySelector('[role=switch]'), null, 'one subscription and a key: nothing to move between');
  await v.unmount();

  accounts = { codex: ['subscription', 'subscription'], claude: ['subscription', 'subscription'] };
  for (const id of ['codex', 'claude'] as const) {
    calls.length = 0;
    v = await render(h(AccountActions, { h: id, add: add(id) }));
    const row = v.host.querySelector(`[data-row="${AUTO_SWITCH_TITLE}"]`)!;
    assert.equal(AUTO_SWITCH_TITLE, 'Switch automatically when one runs out');
    const sw = row.querySelector('[role=switch]')!;
    assert.equal(sw.getAttribute('aria-checked'), String(auto[id]));
    await click(sw);
    assert.deepEqual(calls, [['auto', id, !auto[id]]]);
    await v.unmount();
  }

  calls.length = 0;
  setResult = async () => {
    throw new Error('offline');
  };
  v = await render(h(AccountActions, { h: 'codex', add: add('codex') }));
  await click(v.host.querySelector('[role=switch]')!);
  await flush();
  assert.deepEqual(calls, [
    ['auto', 'codex', false],
    ['toast', "Couldn't change automatic switching: offline"],
  ]);
  setResult = async () => {};
  await v.unmount();
});
