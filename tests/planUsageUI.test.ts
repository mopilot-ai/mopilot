// The side pane's plan limits: each harness's logins with their windows and resets, the chat's own login and the new chats' one marked, a line only where the meters can't say it (a lapsed login, a key, an old reading), what shows with no login, and reading every harness again when shown and on Refresh.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, one, settle } from './support/shell-panels-kit.ts';
import { createElement as h, act } from 'react';

const views: Record<string, any> = {};
const refreshes: unknown[][] = [];
let answer: (harness: string) => Promise<unknown> = async () => undefined;
mock.module('../src/session/harness/useAccountView.ts', { namedExports: { useAccountView: (harness: string) => views[harness] } });
mock.module('../src/session/harness/planUsage.ts', {
  namedExports: { refreshPlanUsage: (harness: string, reason: string) => (refreshes.push([harness, reason]), answer(harness)) },
});
const chat: { family: string; account: { id: string } | null; asked: unknown[] } = { family: 'claude', account: null, asked: [] };
mock.module('../src/store/chats.ts', { namedExports: { chatFamily: () => chat.family } });
mock.module('../src/session/harness/chatAccountView.ts', {
  namedExports: { useChatAccountView: (harness: string, id: string) => ((chat.asked = [harness, id]), { account: chat.account }) },
});
const { PlanUsage } = await import('../src/components/panels/PlanUsage.tsx');

const view = (harness: string, label: string, accounts: any[]) => ({ harness, label, accounts });
const row = (key: string, p: Record<string, unknown> = {}) => ({
  key,
  account: { id: key.split(':')[1] },
  name: `${key}@example.com`,
  plan: null,
  status: { text: '62% left', tone: 'ok' },
  windows: [],
  active: false,
  ...p,
});
const w = (label: string, usedPercent: number, resetsAt: number | null = null) => ({ label, usedPercent, resetsAt });

test('every login of each harness, with its plan, which one is in use, and each window with its reset', async () => {
  const soon = Date.now() / 1000 + 2 * 3600;
  views.claude = view('claude', 'Claude Code', [
    row('claude:default', { plan: 'Claude Max', active: true, windows: [w('5h', 38, soon), w('Weekly', 20), w('Weekly Opus', 5)] }),
    // a key bills per use: no meters, so its line says so
    row('claude:key', { name: 'API key', status: { text: 'Billed per token', tone: 'muted' } }),
  ]);
  views.codex = view('codex', 'Codex', [
    // an old reading keeps its meters and says how old it is
    row('codex:a', { plan: 'ChatGPT Pro', windows: [w('5h', 90)], status: { text: '10% left · updated 30m ago', tone: 'muted' } }),
    row('codex:b', { status: { text: 'Sign-in expired', tone: 'warn' } }),
  ]);
  refreshes.length = 0;
  const r = await render(h(PlanUsage, { threadId: 't' }));
  await settle(act);
  assert.deepEqual(refreshes, [
    ['codex', 'surface'],
    ['claude', 'surface'],
  ]);
  const groups = [...r.host.querySelectorAll<HTMLElement>('.plan-usage-harness')];
  assert.deepEqual(
    groups.map((g) => [g.getAttribute('aria-label'), one(g, 'h4').textContent]),
    [
      ['Claude Code plan limits', 'Claude Code'],
      ['Codex plan limits', 'Codex'],
    ],
  );
  const main = one(r.host, '[data-account="claude:default"]');
  assert.equal(one(main, '.plan-usage-who').textContent, 'claude:default@example.comClaude MaxNew chats');
  assert.equal(main.querySelector('.plan-usage-status'), null);
  assert.deepEqual(
    [...main.querySelectorAll('.limit-meta')].map((m) => m.textContent),
    ['5h62% left', 'Weekly80% left', 'Weekly Opus95% left'],
  );
  assert.match(one(main, '.limit-reset').textContent!, /^Resets in (1h 59m|2h 0m) · /);
  const key = one(r.host, '[data-account="claude:key"]');
  assert.equal(one(key, '.plan-usage-status').textContent, 'Billed per token');
  assert.equal(key.querySelector('.acct-limits'), null);
  assert.equal(one(r.host, '[data-account="codex:a"] .plan-usage-status').textContent, '10% left · updated 30m ago');
  const expired = one(r.host, '[data-account="codex:b"] .plan-usage-status');
  assert.equal([expired.textContent, expired.dataset.tone].join('|'), 'Sign-in expired|warn');
  await r.unmount();
});

test('Refresh reads every harness again for a new reading, and one that fails leaves what is shown', async () => {
  views.claude = view('claude', 'Claude Code', [row('claude:default', { windows: [w('5h', 10)] })]);
  views.codex = view('codex', 'Codex', []);
  const r = await render(h(PlanUsage, { threadId: 't' }));
  await settle(act);
  refreshes.length = 0;
  answer = async (harness) => (harness === 'codex' ? Promise.reject(new Error('offline')) : undefined);
  await act(async () => one(r.host, 'button[aria-label="Refresh usage"]').click());
  await settle(act);
  assert.deepEqual(refreshes, [
    ['codex', 'now'],
    ['claude', 'now'],
  ]);
  // a harness with no login has no group
  assert.equal(r.host.querySelectorAll('.plan-usage-harness').length, 1);
  assert.equal(r.host.querySelectorAll('.acct-limit').length, 1);
  answer = async () => undefined;
  await r.unmount();
});

test('with no login on either harness it says how to get limits shown', async () => {
  views.claude = view('claude', 'Claude Code', []);
  views.codex = view('codex', 'Codex', []);
  const r = await render(h(PlanUsage, { threadId: 't' }));
  await settle(act);
  assert.equal(r.host.querySelector('.plan-usage-harness'), null);
  assert.equal(one(r.host, 'p').textContent, 'Sign in with a subscription plan to see its limits here.');
  await r.unmount();
});

test("the chat's own login is marked on its harness only; a basic harness's chat marks none", async () => {
  views.claude = view('claude', 'Claude Code', [row('claude:default', { active: true }), row('claude:b')]);
  views.codex = view('codex', 'Codex', [row('codex:b', { active: true })]);
  const marks = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('.plan-usage-account')].map(
      (e) => `${e.dataset.account}:${one(e, '.plan-usage-who').textContent}`,
    );
  // a Claude chat pinned to b: b is this chat's, the default stays the new chats'
  Object.assign(chat, { family: 'claude', account: { id: 'b' } });
  let r = await render(h(PlanUsage, { threadId: 't' }));
  assert.deepEqual(chat.asked, ['claude', 't']);
  assert.deepEqual(marks(r.host), [
    'claude:default:claude:default@example.comNew chats',
    'claude:b:claude:b@example.comThis chat',
    'codex:b:codex:b@example.comNew chats',
  ]);
  await r.unmount();
  // an ACP chat runs on no login here
  Object.assign(chat, { family: 'acp', account: { id: 'b' } });
  r = await render(h(PlanUsage, { threadId: 't' }));
  assert.deepEqual(chat.asked, ['codex', 't']);
  assert.equal(r.host.textContent!.includes('This chat'), false);
  await r.unmount();
  // a chat with no login known marks none either
  Object.assign(chat, { family: 'codex', account: null });
  r = await render(h(PlanUsage, { threadId: 't' }));
  assert.equal(r.host.textContent!.includes('This chat'), false);
  await r.unmount();
});
