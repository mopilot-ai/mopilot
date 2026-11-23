import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { Window } from 'happy-dom';

const { useAccountMenuUsageRefresh, accountLimitText } = await import('../src/harness/accountMenuUsage.ts');
const { codexAccounts } = await import('../src/harness/accounts.ts');
const window = new Window();
for (const name of ['window', 'document', 'Node', 'HTMLElement'])
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : (window as any)[name] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

const accounts = codexAccounts({
  accounts: {
    active: 'a',
    accounts: [
      { id: 'a', email: 'a@example.com', status: 'ok', limits: { used: 24 } },
      { id: 'b', email: 'b@example.com', status: 'ok', limits: { used: 81 } },
      { id: 'unknown', email: 'u@example.com', status: 'ok', limits: null },
      { id: 'expired', email: 'e@example.com', status: 'expired', limits: { used: 0 } },
    ],
  } as any,
  account: null,
  rateLimits: null,
}).accounts;

function Menu({ enabled, count, refresh }: { enabled: boolean; count: number; refresh: () => Promise<unknown> }) {
  useAccountMenuUsageRefresh(count, enabled ? refresh : undefined);
  return createElement(
    'div',
    { 'aria-disabled': true },
    accounts.map((account) => {
      const status = accountLimitText(account);
      return createElement('span', { key: account.id, className: `acct-status ${status.tone}` }, status.text);
    }),
  );
}

for (const scenario of ['success', 'failure', 'disabled', 'single', 'empty'] as const) {
  test(`account menu keeps each usage reading visible: ${scenario}`, async () => {
    const host = document.createElement('div');
    const root = createRoot(host as any);
    const calls: number[] = [];
    const refresh = async () => {
      calls.push(0);
      if (scenario === 'failure') throw new Error('Offline');
    };
    const enabled = scenario !== 'disabled';
    const count = scenario === 'single' ? 1 : scenario === 'empty' ? 0 : accounts.length;
    const props = { enabled, count, refresh };
    try {
      await act(async () => root.render(createElement(Menu, props)));
      assert.deepEqual(
        [...host.querySelectorAll('.acct-status')].map((node) => node.textContent),
        ['76% left', '19% left', 'Usage unknown', 'Sign-in expired'],
      );
      assert.ok(host.querySelector('.acct-status.warn'));
      assert.equal(host.firstElementChild?.getAttribute('aria-disabled'), 'true');
      assert.deepEqual(calls, enabled && count > 0 ? [0] : []);
      await act(async () => root.render(createElement(Menu, props)));
      assert.equal(calls.length, enabled && count > 0 ? 1 : 0, 'rerender must not re-poll unchanged accounts');
      if (scenario === 'success') {
        await act(async () => root.render(createElement(Menu, { ...props, count: count + 1 })));
        assert.deepEqual(calls, [0, 0]);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
}

const { accountStatusText } = await import('../src/harness/accounts.ts');
const acct = (p: any) => ({
  id: 'x',
  harness: 'codex',
  email: 'x@example.com',
  plan: 'Plus',
  kind: 'subscription',
  status: 'ok',
  left: 80,
  limited: null,
  usage: { windows: [], source: 'polled', at: null },
  ...p,
});
const win = (label: string, usedPercent: number) => ({ label, usedPercent, resetsAt: null });

test('the account menus say which window "x% left" is about, and warn when little is left', () => {
  const both = { windows: [win('5h', 20), win('Weekly', 88)], source: 'polled', at: null };
  assert.deepEqual(accountLimitText(acct({ left: 12, usage: both }) as any), { text: '12% left (weekly)', tone: 'warn' });
  assert.deepEqual(accountLimitText(acct({ left: 80, usage: { ...both, windows: [win('5h', 20)] } }) as any), {
    text: '80% left (5h)',
    tone: 'ok',
  });
  // a reading with no named window, or no windows, keeps the plain text
  assert.deepEqual(accountLimitText(acct({ usage: { ...both, windows: [win('Usage', 20)] } }) as any), { text: '80% left', tone: 'ok' });
  assert.deepEqual(accountLimitText(acct({}) as any), { text: '80% left', tone: 'ok' });
  // exactly at the line is not low
  assert.equal(accountLimitText(acct({ left: 15 }) as any).tone, 'ok');
});

test('a stale reading keeps its age and stays muted, even when little is left', () => {
  const at = Date.now() - 30 * 60_000;
  const a = acct({ harness: 'claude', left: 5, usage: { windows: [win('5h', 95)], source: 'parsed', at } });
  assert.deepEqual(accountLimitText(a as any), { text: '5% left (5h) · updated 30m ago', tone: 'muted' });
});

test('every other status is the account status as it was', () => {
  for (const p of [
    { status: 'expired' },
    { status: 'signin' },
    { kind: 'apiKey', left: null },
    { limited: { resetsAt: null }, left: 0 },
    { left: null },
  ]) {
    const a = acct(p) as any;
    assert.deepEqual(accountLimitText(a), accountStatusText(a));
  }
});
