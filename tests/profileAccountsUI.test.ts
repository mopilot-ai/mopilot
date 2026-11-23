import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMock, autoMockStore } from './support/thread-kit.ts';
import { createElement, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { createRoot } = await import('react-dom/client');

// The real menu component, with inert controls and store hooks. The real harness parts supply the
// refresh bindings, so the test also checks forced Codex refreshes.
const fx = () => (globalThis as any).__profileAccountsFixture;
const nul = () => null;
autoMockStore('store', {
  useStore: (f: any) => f({ prefs: { defaultHarness: 'codex' }, accounts: { accounts: [] }, claudeChats: {} }),
  refreshAccountsUsage: async (age: number) => {
    fx().calls.push(['codex', age]);
    if (fx().error) throw fx().error;
  },
  toast: (...args: any[]) => fx().toasts.push(args),
});
autoMock('src/session/harness/claude.ts', 'claude', {
  refreshClaudeUsage: async () => {
    fx().calls.push(['claude']);
  },
});
autoMock('src/session/harness/select.ts', 'select', { useHarnessAccounts: () => fx().view, useHarnessStatus: () => fx().status });
autoMock('src/components/harnessPicker/HarnessPicker.tsx', 'picker', { HarnessIcon: nul });
autoMock('src/components/ui/Popover.tsx', 'popover', {
  MenuSeparator: nul,
  MenuLabel: (p: any) => createElement('header', null, p.children),
  MenuItem: (p: any) => createElement('article', null, p.children, p.description),
  SubMenu: (p: any) =>
    createElement(
      'section',
      null,
      createElement('div', { 'data-parent': 'true' }, p.label, p.description, p.shortcut),
      createElement('aside', null, p.children),
    ),
});
for (const [rel, tag] of [
  ['src/lib/native.ts', 'native'],
  ['src/components/panels/TerminalPanel.tsx', 'term'],
  ['src/components/pages/Settings.tsx', 'settings'],
  ['src/lib/mopilot.ts', 'mopilot'],
  ['src/session/harness/billing.ts', 'billing'],
  ['src/store/session/useSession.ts', 'session'],
  ['src/components/pages/settings/BillingRow.tsx', 'billingRow'],
  ['src/components/harness/claude/Customize.tsx', 'customize'],
])
  autoMock(rel, tag);
const { HarnessAccountsMenu } = await import('../src/components/accounts/Accounts.tsx');

function render(h: string, accountStatus = 'ok', state = 'ready', signedIn = true) {
  const account = {
    id: 'default',
    harness: h,
    email: 'person@example.com',
    plan: 'Test plan',
    kind: 'subscription',
    status: accountStatus,
    left: 80,
    usage: { windows: [], source: 'none', at: null },
  };
  (globalThis as any).__profileAccountsFixture = {
    view: { active: signedIn ? account : null, accounts: signedIn ? [account] : [], multi: true },
    status: { state },
    calls: [],
    toasts: [],
  };
  const html = renderToStaticMarkup(createElement(HarnessAccountsMenu, { h: h as any }));
  return { html, parent: html.match(/<div data-parent="true">(.*?)<\/div>/)![1] };
}

test('harness rows say who they run as and what is left, and the submenu lists each account', () => {
  for (const h of ['codex', 'claude']) {
    const { html, parent } = render(h);
    assert.match(parent, /80% left/);
    // the email and the plan are two spans so the email alone can end in an ellipsis
    assert.match(parent.replace(/<[^>]+>/g, ''), /person@example.com · Test plan/);
    assert.match(parent, /acct-split-who">person@example.com<\/span><span class="acct-split-plan"> · Test plan</);
    // once on the row, once in the submenu's account list
    assert.equal(html.split('person@example.com').length - 1, 2);
  }
});

test('opening and reopening the menu refreshes each ready harness without a refresh button', async () => {
  for (const h of ['codex', 'claude']) {
    assert.doesNotMatch(render(h).html, /Refresh usage/);
    const fixture = (globalThis as any).__profileAccountsFixture;
    const host = document.createElement('div');
    const root = createRoot(host as any);
    try {
      await act(() => root.render(createElement(HarnessAccountsMenu, { h: h as any })));
      assert.deepEqual(fixture.calls, h === 'codex' ? [['codex', 'surface']] : [['claude']]);
      // Usage state updates while the menu is open must not trigger another fetch.
      await act(() => root.render(createElement(HarnessAccountsMenu, { h: h as any })));
      assert.equal(fixture.calls.length, 1);
      await act(() => root.render(null));
      await act(() => root.render(createElement(HarnessAccountsMenu, { h: h as any })));
      assert.deepEqual(
        fixture.calls,
        h === 'codex'
          ? [
              ['codex', 'surface'],
              ['codex', 'surface'],
            ]
          : [['claude'], ['claude']],
      );
      assert.doesNotMatch(host.textContent ?? '', /Refresh usage/);
    } finally {
      await act(() => root.unmount());
    }
  }
});

test('opening an unavailable or signed-out harness does not fetch usage', async () => {
  for (const h of ['codex', 'claude']) {
    for (const state of ['missing', 'detecting', 'signin']) {
      render(h, 'ok', state, false);
      const fixture = (globalThis as any).__profileAccountsFixture;
      const root = createRoot(document.createElement('div') as any);
      try {
        await act(() => root.render(createElement(HarnessAccountsMenu, { h: h as any })));
        assert.deepEqual(fixture.calls, []);
      } finally {
        await act(() => root.unmount());
      }
    }
  }
});

test('an automatic refresh failure is handled without interrupting the menu', async () => {
  render('codex');
  const fixture = (globalThis as any).__profileAccountsFixture;
  fixture.error = new Error('Usage unavailable');
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(() => root.render(createElement(HarnessAccountsMenu, { h: 'codex' })));
    assert.deepEqual(fixture.calls, [['codex', 'surface']]);
    assert.deepEqual(fixture.toasts, []);
    assert.match(host.textContent ?? '', /person@example.com/);
  } finally {
    await act(() => root.unmount());
  }
});

test('removing duplicate identity preserves sign-in warnings and unavailable states', () => {
  for (const h of ['codex', 'claude']) {
    const expired = render(h, 'expired').parent;
    assert.match(expired, /Sign-in expired/);
    assert.doesNotMatch(expired, /80% left|person@example.com/);
    for (const [state, text] of [
      ['missing', 'Not installed'],
      ['detecting', 'Checking…'],
      ['signin', 'Not signed in'],
    ]) {
      assert.ok(render(h, 'ok', state, false).parent.includes(text));
    }
  }
});
