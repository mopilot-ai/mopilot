// The composer ring combines the current context with the limits of the login the picked harness uses, including refresh and owner changes.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { parseUsageText } from '../shared/claudeUsageText.mjs';
import { MOPILOT_PLAN, type Account } from '../src/harness/accounts.ts';
import type { HarnessKind } from '../src/harness/adapter.ts';
import type { HarnessId, Segment, UsageWindow } from '../src/harness/types.ts';
import { contextUsageKey } from '../src/store/contextUsage.ts';
import { deferred } from './support/async-scenarios.ts';
import { mockContextModules } from './support/context-kit.ts';
import { fakeStore, one, render, settle } from './support/shell-panels-kit.ts';

const NOW = 1_000_000_000_000;
const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store, { mockAccountView: false });
let accounts: Account[] = [];
let servingId: string | null = null;
let unpooledWindows: UsageWindow[] = [];
let answer: () => Promise<unknown> = async () => undefined;
const refreshes: unknown[][] = [];
const opened: unknown[][] = [];

mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessStatus: (harness: HarnessId) => {
      const active = accounts.find((a) => a.harness === harness);
      return { plan: active?.plan, usage: active?.usage ?? { windows: harness === 'codex' ? unpooledWindows : [] } };
    },
    useHarnessAccounts: (harness: HarnessId) => {
      const matching = accounts.filter((a) => a.harness === harness);
      return { active: matching[0] ?? null, accounts: matching };
    },
    useChatAccount: (_harness: HarnessId, id: string | null) => (id && servingId ? { serving: servingId } : null),
  },
});
mock.module('../src/session/harness/planUsage.ts', {
  namedExports: { refreshPlanUsage: (harness: HarnessId, reason: string) => (refreshes.push([harness, reason]), answer()) },
});
mock.module('../src/store/outputs/pane.ts', { namedExports: { openSessionPane: (...args: unknown[]) => opened.push(args) } });

const { ContextRing } = await import('../src/components/composer/ContextRing.tsx');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');
const usageRing = (selection: HarnessKind | null, threadId: string | null = 'chat') => h(ContextRing, { selection, threadId });
const limit = (label: string, usedPercent: number, resetsAt: number | null = null): UsageWindow => ({ label, usedPercent, resetsAt });
const login = (harness: HarnessId, id: string, windows: UsageWindow[], extra: Partial<Account> = {}): Account => ({
  harness,
  id,
  email: `${id}@example.com`,
  plan: harness === 'claude' ? 'Claude Max' : 'ChatGPT Plus',
  kind: 'subscription',
  status: 'ok',
  usage: { windows, at: null, source: 'live' },
  left: null,
  limited: null,
  ...extra,
});

function session(harness: HarnessId | 'acp:kimi', { id = 'chat', nativeId = `${harness}:native`, used = 20_000 } = {}) {
  const segments: Segment[] = [{ harness, nativeId, start: 0, count: null, model: null, handoff: null }];
  store.set({
    segments: { [id]: segments },
    runtime: {
      [id]: {
        turns: [],
        tokenUsage: { last: { totalTokens: used }, modelContextWindow: 200_000 },
        tokenUsageOwner: contextUsageKey(segments, id),
      },
    },
  });
}

function reset(next: Account[]) {
  resetContextSnapshots();
  store.set({ runtime: {}, segments: {} });
  accounts = next;
  servingId = null;
  unpooledWindows = [];
  refreshes.length = opened.length = ctx.ignored.length = 0;
  answer = async () => undefined;
}

const panel = () => one(document.body, '.ctx-popover');

test('the single ring tracks the plan arc and opens every window for the account actually serving the chat', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    const weekly = parseUsageText('Current week (all models): 10% used\nCurrent week (Fable): 95% used')!.windows;
    const windows = [limit('5h', 45, NOW / 1000 + 3600), ...weekly];
    reset([
      login('claude', 'default', [limit('Default account', 1)]),
      login('claude', 'serving', windows, { usage: { windows, source: 'live', at: NOW - 5 * 60_000 } }),
    ]);
    session('claude');
    servingId = 'serving';
    const r = await render(usageRing('claude'));
    const ring = one(r.host, '.context-ring');
    assert.equal(r.host.querySelectorAll('button').length, 1);
    assert.equal(ring.dataset.level, 'warn');
    assert.equal(ring.getAttribute('aria-label'), 'Context: 10% used, 20k of 200k tokens. Plan usage: Weekly · Fable, 95% used');
    const arc = one(r.host, '.context-ring-fill');
    assert.ok(Math.abs(Number(arc.getAttribute('stroke-dashoffset')) / Number(arc.getAttribute('stroke-dasharray')) - 0.05) < 0.001);
    await act(() => ring.parentElement!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    await settle(act, 500);
    assert.match(one(document.body, '.context-tip').textContent!, /10% used.*Plan usage: Weekly · Fable, 95% used/);

    await act(() => ring.click());
    await settle(act);
    assert.deepEqual(refreshes, [['claude', 'surface']]);
    assert.equal(ring.getAttribute('aria-expanded'), 'true');
    assert.equal(one(panel(), '.ctx-summary-value').textContent, '10% used');
    assert.equal(panel().querySelectorAll('.ctx-limits').length, 1);
    assert.match(panel().textContent!, /Claude Code usage limits.*serving@example.com · Claude Max/);
    assert.doesNotMatch(panel().textContent!, /Default account/);
    assert.equal(panel().querySelectorAll('.limit-row').length, 3);
    assert.equal(one(panel(), '[role="meter"][aria-label="Weekly · Fable"]').getAttribute('aria-valuenow'), '95');
    assert.equal(one(panel(), '[role="meter"][aria-label="Weekly · All models"]').getAttribute('aria-valuenow'), '10');
    assert.match(one(panel(), '.limit-row-reset').textContent!, /^Resets in 1h 0m · /);
    assert.match(panel().textContent!, /Updated 5m ago/);

    answer = async () => {
      throw new Error('offline');
    };
    await act(() => one(panel(), 'button[aria-label="Refresh usage"]').click());
    assert.deepEqual(refreshes.at(-1), ['claude', 'now']);
    assert.equal(ctx.ignored.length, 1);
    assert.equal(panel().querySelectorAll('.limit-row').length, 3);

    await act(() => one(panel(), '.ctx-limits-foot button', 'All usage').click());
    assert.deepEqual(opened, [['chat', 'usage']]);
    assert.equal(document.querySelector('.ctx-popover'), null);
    answer = async () => undefined;
    await act(() => ring.click());
    await act(() => ring.click());
    assert.deepEqual(refreshes, [
      ['claude', 'surface'],
      ['claude', 'now'],
      ['claude', 'surface'],
    ]);
    assert.equal(ring.getAttribute('aria-expanded'), 'false');
    await r.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('a draft can open plan usage before a context reading, and expired windows stop filling the ring', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    const windows = [limit('Weekly', 100, NOW / 1000 + 60)];
    reset([login('codex', 'default', windows, { email: null, usage: { windows, source: 'live', at: NOW + 30_000 } })]);
    const r = await render(usageRing('codex', null));
    const ring = one(r.host, '.context-ring');
    assert.equal(ring.dataset.level, 'full');
    assert.equal(ring.getAttribute('aria-label'), 'Plan usage: Weekly, 100% used');
    assert.equal(Number(one(r.host, '.context-ring-fill').getAttribute('stroke-dashoffset')), 0);
    await act(() => ring.click());
    assert.match(panel().textContent!, /Signed-in account · ChatGPT Plus.*Updated just now/);
    assert.equal(panel().querySelector('.ctx-summary, .ctx-limits-foot button'), null);
    assert.deepEqual(refreshes, [['codex', 'surface']]);
    mock.timers.tick(61_000);
    await r.rerender(usageRing('codex', null));
    assert.equal(ring.dataset.level, 'ok');
    assert.equal(ring.getAttribute('aria-label'), 'Plan usage');
    assert.equal(one(panel(), '.limit-row-reset').textContent, 'Reset since last read');

    accounts[0] = login('codex', 'default', windows, { email: null, plan: null, usage: { windows, source: 'live', at: null } });
    await r.rerender(usageRing('codex', null));
    assert.equal(panel().querySelector('.ctx-limits-foot'), null);
    accounts[0] = login('codex', 'default', [], { kind: 'apiKey' });
    await r.rerender(usageRing('codex', null));
    assert.equal(r.host.querySelector('.context-ring'), null);
    assert.equal(document.querySelector('.ctx-popover'), null);
    accounts[0] = login('codex', 'default', [limit('Weekly', 10)]);
    await r.rerender(usageRing('codex', null));
    assert.equal(one(r.host, '.context-ring').getAttribute('aria-expanded'), 'false');
    await r.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('a pending harness choice shows its own plan limits at once, beside the open session’s context', async () => {
  const windows = [limit('5h', 50)];
  reset([
    login('codex', 'local', windows, { usage: { windows, source: 'live', at: Date.now() - 3 * 3_600_000 } }),
    login('claude', 'next', [limit('Weekly', 60)]),
  ]);
  session('codex');
  const r = await render(usageRing('codex'));
  const pending = deferred();
  answer = () => pending.promise;
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.match(panel().textContent!, /Updated 3h ago/);
  await r.rerender(usageRing('claude'));
  assert.equal(document.querySelector('.ctx-popover'), null);
  // the picker names Claude Code before the session changes: its login's limits, the Codex session's context
  assert.match(one(r.host, '.context-ring').getAttribute('aria-label')!, /^Context: 10% used.*Weekly · All models, 60% used/);
  // a picker that has not resolved falls back to the session's harness
  await r.rerender(usageRing(null));
  assert.match(one(r.host, '.context-ring').getAttribute('aria-label')!, /5-hour limit, 50% used/);
  // an agent with no plan of its own shows the context alone
  await r.rerender(usageRing('acp:kimi'));
  assert.match(one(r.host, '.context-ring').getAttribute('aria-label')!, /^Context: 10% used[^.]*tokens$/);
  await r.rerender(usageRing('claude'));
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.match(panel().textContent!, /Claude Code usage limits.*next@example.com · Claude Max/);
  await act(() => one(r.host, '.context-ring').click());
  // a login picked with the switch is the one the next message spends; one picked for another harness is not
  accounts.push(login('claude', 'work', [limit('Weekly', 15)]));
  ctx.pendingSwitch = { harness: 'claude', account: 'work' } as typeof ctx.pendingSwitch;
  await r.rerender(usageRing('claude'));
  assert.match(one(r.host, '.context-ring').getAttribute('aria-label')!, /Weekly · All models, 15% used/);
  ctx.pendingSwitch = { harness: 'codex', account: 'work' } as typeof ctx.pendingSwitch;
  await r.rerender(usageRing('claude'));
  assert.match(one(r.host, '.context-ring').getAttribute('aria-label')!, /Weekly · All models, 60% used/);
  ctx.pendingSwitch = null;
  await r.rerender(usageRing('claude'));
  await act(async () => session('claude', { nativeId: 'next', used: 0 }));
  answer = async () => undefined;
  const ring = one(r.host, '.context-ring');
  assert.match(ring.getAttribute('aria-label')!, /^Context: 0% used.*Weekly · All models, 60% used/);
  await act(() => ring.click());
  await settle(act);
  await act(async () => pending.reject(new Error('previous account read failed')));
  assert.equal(ring.getAttribute('aria-expanded'), 'true');
  assert.match(panel().textContent!, /Claude Code usage limits/);
  assert.deepEqual(refreshes, [
    ['codex', 'surface'],
    ['claude', 'surface'],
    ['claude', 'surface'],
  ]);
  await act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(ring.getAttribute('aria-expanded'), 'false');
  await r.unmount();
});

test('changing only the serving login or native id closes the ring even when a replacement has usage', async () => {
  reset([login('claude', 'a', [limit('5h', 20)]), login('claude', 'b', [limit('Weekly', 75)])]);
  session('claude');
  const r = await render(usageRing('claude'));
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.match(panel().textContent!, /a@example.com/);
  servingId = 'b';
  await r.rerender(usageRing('claude'));
  assert.equal(document.querySelector('.ctx-popover'), null);
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.match(panel().textContent!, /b@example.com/);
  accounts[1] = login('claude', 'b', [limit('Weekly', 30)], { email: 'new@example.com' });
  await r.rerender(usageRing('claude'));
  assert.equal(document.querySelector('.ctx-popover'), null);
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.match(panel().textContent!, /new@example.com/);
  await act(async () => session('claude', { nativeId: 'replacement' }));
  assert.equal(document.querySelector('.ctx-popover'), null);
  assert.equal(one(r.host, '.context-ring').getAttribute('aria-expanded'), 'false');
  await r.unmount();
});

test('context-only chats keep the details action and read no plan until a harness with one is picked', async () => {
  reset([login('codex', 'default', [limit('Weekly', 50)])]);
  session('acp:kimi');
  const r = await render(usageRing('acp:kimi'));
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.equal(one(panel(), '.ctx-summary-value').textContent, '10% used');
  assert.equal(one(panel(), '.ctx-foot-link').textContent?.trim(), 'View context');
  assert.equal(panel().querySelector('.ctx-limits'), null);
  assert.deepEqual(refreshes, []);
  await r.rerender(usageRing('acp:opencode'));
  assert.equal(document.querySelector('.ctx-popover'), null);
  // picking a harness with a plan shows that plan before the chat's session changes
  await r.rerender(usageRing('codex'));
  assert.match(one(r.host, '.context-ring').getAttribute('aria-label')!, /^Context: 10% used.*Weekly, 50% used/);
  await r.unmount();
});

test('a reading without an account identity shows its limits while context has yet to arrive', async () => {
  reset([]);
  unpooledWindows = [limit('Weekly', 35)];
  const r = await render(usageRing('codex'));
  const ring = one(r.host, '.context-ring');
  assert.equal(ring.getAttribute('aria-label'), 'Plan usage: Weekly, 35% used');
  await act(() => ring.click());
  await settle(act);
  assert.equal(one(panel(), '.ctx-summary-value').textContent, '—');
  assert.equal(panel().querySelector('.ctx-limits .ctx-sub'), null);
  assert.equal(one(panel(), '.usage-limit-value').textContent, '35% used');

  await act(async () => session('codex'));
  assert.equal(one(r.host, '.context-ring').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.ctx-popover'), null);
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.equal(one(panel(), '.ctx-summary-value').textContent, '10% used');
  await r.unmount();
});

test('opening requests a subscription’s first reading and shows it in the same popover', async () => {
  reset([login('claude', 'subscription', [])]);
  const r = await render(usageRing('claude', null));
  assert.equal(one(r.host, '.context-ring').getAttribute('aria-label'), 'Plan usage');
  assert.equal(r.host.querySelector('.context-ring-fill'), null);
  await act(() => one(r.host, '.context-ring').click());
  await settle(act);
  assert.deepEqual(refreshes, [['claude', 'surface']]);
  assert.match(panel().textContent!, /Usage not loaded/);
  assert.equal(panel().querySelector('[role="meter"]'), null);
  accounts[0] = login('claude', 'subscription', [limit('Weekly', 30)]);
  await r.rerender(usageRing('claude', null));
  assert.equal(one(panel(), '.usage-limit-value').textContent, '30% used');
  assert.deepEqual(refreshes, [['claude', 'surface']]);
  await r.unmount();
});

test('API keys, MoPilot credits and signed-out logins without readings do not request plan usage', async () => {
  for (const account of [
    login('codex', 'key', [limit('Previous plan', 90)], { kind: 'apiKey' }),
    login('codex', 'lapsed', [], { status: 'expired' }),
    login('codex', 'credits', [limit('Previous plan', 90)], { plan: MOPILOT_PLAN }),
  ]) {
    reset([account]);
    session('codex');
    const r = await render(usageRing('codex'));
    await act(() => one(r.host, '.context-ring').click());
    await settle(act);
    assert.equal(panel().querySelector('.ctx-limits'), null);
    assert.deepEqual(refreshes, []);
    await r.unmount();
  }
});
