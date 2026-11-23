// Accounts & billing, after each provider's own rows: the API-key note, Codex's credits and the reset cards.
import { test, mock } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, flush, settingsStubs, fakeStore, byText } from './support/harness-ui-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (calls.push([name, ...a]), ret);
const store = fakeStore<any>({
  prefs: { defaultHarness: 'claude' },
  rateLimits: null,
  accounts: { accounts: [], active: null },
  claudeUsage: {},
});
let ck: any = null;
mock.module('../src/components/pages/HarnessSettings.tsx', {
  namedExports: { endpointLabel: (u: string | undefined, own: string) => u ?? own },
});
mock.module('../src/session/harness/billing.ts', { namedExports: { useClaudeKey: () => ck } });
stubStore({
  useStore: store.useStore,
  refreshRateLimits: rec('refreshRateLimits'),
  toast: rec('toast'),
});
mock.module('../src/session/open.ts', { namedExports: { openLink: rec('open') } });
// the reset-card sections are their own components (tests/resetCardsUI.test.ts)
mock.module('../src/components/harness/ResetCards.tsx', {
  namedExports: {
    CodexResetCards: ({ expanded }: any) => h('aside', { 'data-reset': 'codex', 'data-expanded': String(expanded) }),
    ClaudeResetCards: ({ expanded }: any) => h('aside', { 'data-reset': 'claude', 'data-expanded': String(expanded) }),
  },
});
mock.module('../src/components/pages/Settings.tsx', {
  namedExports: { Group: settingsStubs.Group, Row: settingsStubs.Row, Segmented: settingsStubs.Segmented },
});
const { ProviderExtras, CodexCredits, creditsText } = await import('../src/components/harness/Usage.tsx');

const groups = (host: HTMLElement) => [...host.querySelectorAll('section')].map((s) => s.querySelector('h3')?.textContent);
const group = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === title) as HTMLElement;
const resets = (host: HTMLElement) => [...host.querySelectorAll('aside[data-reset]')].map((e) => (e as HTMLElement).dataset.reset);
const reset = () => {
  calls.length = 0;
  ck = null;
  store.set({ prefs: { defaultHarness: 'claude' }, rateLimits: null, accounts: { accounts: [], active: null }, claudeUsage: {} });
};

test('a credit balance reads as money: grouped thousands, at most two decimals, or Unlimited', () => {
  assert.equal(creditsText({ unlimited: false, balance: '62373.5621000000' }), '62,373.56');
  assert.equal(creditsText({ unlimited: false, balance: 5 }), '5');
  assert.equal(creditsText({ unlimited: false, balance: null }), '0');
  assert.equal(creditsText({ unlimited: true, balance: '1' }), 'Unlimited');
});

test('Codex credits: a row with the balance and the way to add more, read when it shows; none without a reading', async () => {
  reset();
  const r = await mount(h(CodexCredits));
  assert.deepEqual(calls, [['refreshRateLimits']]);
  assert.equal(r.host.querySelector('.row'), null);
  store.set({ rateLimits: { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '1234.5' } } } });
  await flush(1);
  assert.equal(r.host.querySelector('.row b')?.textContent, 'Codex credits');
  assert.equal(r.host.querySelector('.credits-balance')?.textContent, '1,234.5');
  await click(byText(r.host, 'button', 'Add more'));
  assert.deepEqual(calls.at(-1), ['open', 'https://chatgpt.com/codex/settings/usage']);
  // the general limit's reading when there are several
  store.set({ rateLimits: { rateLimitsByLimitId: { codex: { credits: { hasCredits: true, unlimited: true, balance: null } } } } });
  await flush(1);
  assert.equal(r.host.querySelector('.credits-balance')?.textContent, 'Unlimited');
  store.set({ rateLimits: { rateLimitsByLimitId: {} } });
  await flush(1);
  assert.equal(r.host.querySelector('.row'), null);
  await r.unmount();
});

test('on an API key the billing note shows with the provider dashboard unless the endpoint is custom, and no reset cards', async () => {
  reset();
  ck = { mode: 'apiKey' };
  const r = await mount(h(ProviderExtras, { h: 'claude' }));
  assert.deepEqual(groups(r.host), ['Billing']);
  assert.deepEqual(resets(r.host), []);
  assert.match(group(r.host, 'Billing').querySelector('.gdesc')!.textContent!, /your Anthropic API key/);
  await click(byText(r.host, 'button', 'Open dashboard'));
  assert.deepEqual(calls.at(-1), ['open', 'https://console.anthropic.com/settings/usage']);
  ck = { mode: 'apiKey', baseUrl: 'OpenRouter' };
  await r.render(h(ProviderExtras, { h: 'claude' }));
  assert.equal(byText(r.host, 'button', 'Open dashboard'), undefined);
  assert.equal(group(r.host, 'Billing').querySelector('.row i')?.textContent, 'Check spend with OpenRouter.');

  store.set({ accounts: { accounts: [{ id: 'k', kind: 'apiKey' }], active: 'k' } });
  await r.render(h(ProviderExtras, { h: 'codex' }));
  assert.deepEqual(groups(r.host), ['Billing']);
  calls.length = 0;
  await click(byText(r.host, 'button', 'Open dashboard'));
  assert.deepEqual(calls, [['open', 'https://platform.openai.com/usage']]);
  store.set({ accounts: { accounts: [{ id: 'k', kind: 'apiKey', baseUrl: 'Groq' }], active: 'k' } });
  await flush(1);
  assert.match(group(r.host, 'Billing').querySelector('.gdesc')!.textContent!, /your Groq API key/);
  await r.unmount();
});

test('on a subscription each provider ends with its reset cards, folded, and no billing note', async () => {
  reset();
  const r = await mount(h(ProviderExtras, { h: 'claude' }));
  assert.deepEqual(groups(r.host), []);
  assert.equal(r.host.querySelector('details summary')?.textContent, 'Usage limit resets');
  assert.equal((r.host.querySelector('details') as HTMLDetailsElement).open, false);
  assert.deepEqual(resets(r.host), ['claude']);
  await r.render(h(ProviderExtras, { h: 'codex' }));
  assert.deepEqual(resets(r.host), ['codex']);
  await r.unmount();
});

test('disclosure changes reach both providers without discarding the wallet or its pending reset', async () => {
  reset();
  for (const provider of ['codex', 'claude'] as const) {
    const r = await mount(h(ProviderExtras, { h: provider }));
    const disclosure = r.host.querySelector('details')!;
    const wallet = r.host.querySelector('aside')!;
    assert.equal(wallet.dataset.expanded, 'false');
    for (const open of [true, false, true]) {
      await act(async () => {
        disclosure.open = open;
        disclosure.dispatchEvent(new Event('toggle'));
      });
      assert.equal(r.host.querySelector('aside'), wallet);
      assert.equal(wallet.dataset.expanded, String(open));
    }
    await r.unmount();
  }
});
