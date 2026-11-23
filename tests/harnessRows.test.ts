// src/components/harness/HarnessRows.tsx: a harness's row in All harnesses, for every harness family. Quiet while
// ready; else one line for its state and at most one button, wired to the harness's own action; a known problem with
// the installed version adds a note; the update pill and its flow. The states themselves: tests/rowState.test.ts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, fakeStore } from './support/harness-ui-kit.ts';
import { defaultHarnessExports } from './support/default-harness-fakes.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[][] = [];
let status: Record<string, any> = {};
let views: Record<string, any> = {};
let updates: Record<string, any> = {};
let issues: Record<string, any> = {};
let recheckFails: Error | null = null;
const store = fakeStore<any>({ basicHarnesses: [], accounts: { accounts: [] }, claudeChats: {}, codexBin: null, prefs: {} });
stubStore({
  useStore: store.useStore,
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  ...defaultHarnessExports(store.get, () => {}),
});
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessStatus: (k: string) => status[k],
    useHarnessAccounts: (k: string) => views[k],
    chooseAccount: (a: any) => calls.push(['chooseAccount', a.id]),
  },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { signInBasic: (id: string) => calls.push(['signInBasic', id]) } });
mock.module('../src/session/harness/harnessRuns.ts', {
  namedExports: {
    recheckHarness: async (k: string) => {
      calls.push(['recheck', k]);
      if (recheckFails) throw recheckFails;
    },
  },
});
mock.module('../src/components/harnessPicker/badges.tsx', {
  namedExports: {
    BasicHarnessIcon: ({ id }: any) => h('i', { 'data-basic-icon': id }),
    BasicBadge: ({ id }: any) => h('em', { 'data-badge': id }),
    signInHarness: (k: string) => calls.push(['signInHarness', k]),
  },
});
const mark = () => h('b', { 'data-mark': true });
mock.module('../src/components/harness/parts.tsx', { namedExports: { PARTS: { codex: { Icon: mark }, claude: { Icon: mark } } } });
// the pill and its flow are HarnessUpdate.tsx's (tests/harnessVersionLine.test.ts): here, where they show
mock.module('../src/components/harness/HarnessUpdate.tsx', {
  namedExports: {
    useHarnessUpdate: (k: string) => updates[k] ?? null,
    UpdatePill: ({ u }: any) => h('button', { 'data-pill': u.kind }, `Update to ${u.v.latest}`),
    UpdateFlow: ({ u }: any) => h('i', { 'data-flow': u.kind }),
  },
});
mock.module('../src/harness/knownIssues.ts', {
  namedExports: {
    knownIssueFor: (k: string, v: string | null) => (v ? (issues[k] ?? null) : null),
    knownIssueExit: (_i: any, label: string, to: string | null) => (to ? `Update to ${to} to fix it.` : `Use ${label} 2.0 or newer.`),
  },
});
const { HarnessRow, BasicRow } = await import('../src/components/harness/HarnessRows.tsx');

const acct = (p: any = {}) => ({
  id: 'a',
  harness: 'codex',
  email: 'a@example.com',
  plan: 'Team',
  kind: 'subscription',
  status: 'ok',
  left: 60,
  limited: null,
  usage: { windows: [{ label: 'Weekly', usedPercent: 40, resetsAt: null }], source: 'polled', at: null },
  ...p,
});
const basic = (p: any) => ({
  id: 'oc',
  label: 'opencode',
  state: 'admitted',
  reason: null,
  bin: null,
  version: '1.18',
  authMethods: [],
  login: null,
  ...p,
});
const text = (el: Element | null | undefined) => el?.textContent ?? '';
const upd = (kind: string, p: any = {}) => ({
  kind,
  label: kind,
  v: { updatable: true, latest: '2.0', ...p },
  update: async () => calls.push(['update', kind]),
});
const button = (host: Element, label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

beforeEach(() => {
  calls.length = 0;
  updates = {};
  issues = {};
  recheckFails = null;
  status = { codex: { state: 'ready', version: '1.0' }, claude: { state: 'ready', version: '1.0' } };
  views = {
    codex: { harness: 'codex', active: null, accounts: [], multi: true },
    claude: { harness: 'claude', active: null, accounts: [], multi: true },
  };
  store.set({ codexBin: null, prefs: {} });
});

test('ready: quiet, with no state word; the account line in full, meters, Default; the name opens the page', async () => {
  const a = acct();
  views.codex = { harness: 'codex', active: a, accounts: [a, acct({ id: 'b', email: 'b@example.com' })], multi: true };
  const r = await mount(h(HarnessRow, { h: 'codex' }));
  const row = r.host.querySelector('[data-harness-row="codex"]')!;
  assert.equal(row.getAttribute('data-row-state'), 'ready');
  // Codex is the default for new chats while none is saved
  assert.equal(text(row.querySelector('.hrow-name')), 'CodexDefault');
  assert.equal(row.querySelector('.harness-dot'), null);
  assert.equal(text(row.querySelector('.hrow-sub')), 'a@example.com · Team · 2 accounts');
  assert.equal(row.querySelector('.hrow-sub')!.getAttribute('title'), 'a@example.com · Team · 2 accounts');
  assert.match(text(row.querySelector('.hp-meters')), /Weekly.*60% left/);
  assert.equal(row.querySelector('.hrow-action'), null);
  await click(row.querySelector('.hrow-open'));
  assert.deepEqual(calls, [['navigate', { name: 'settings', section: 'codex' }]]);
  await r.unmount();
});

test('an update to offer: the pill on a quiet row, with its flow under it; none while the row has its own button', async () => {
  updates.claude = upd('claude');
  const r = await mount(h(HarnessRow, { h: 'claude' }));
  assert.equal(text(r.host.querySelector('[data-pill="claude"]')), 'Update to 2.0');
  assert.ok(r.host.querySelector('.hrow + [data-flow="claude"]'));
  status.claude = { state: 'signin', version: '1.0' };
  await r.render(h(HarnessRow, { h: 'claude' }));
  assert.equal(r.host.querySelector('[data-pill]'), null);
  assert.equal(text(r.host.querySelector('.hrow-action')), 'Sign in to Claude Code');
  await r.unmount();
});

test("needs sign-in, can't run, checking and first use: one line each, and the one button calls the harness's own action", async () => {
  status.claude = { state: 'signin', version: null };
  const r = await mount(h(HarnessRow, { h: 'claude' }));
  const row = () => r.host.querySelector('[data-harness-row]')!;
  assert.equal(row().getAttribute('data-row-state'), 'signin');
  assert.equal(text(row().querySelector('.hrow-sub')), 'Sign in once, then MoPilot can use it.');
  assert.ok(row().querySelector('.hrow-action.primary'));
  await click(row().querySelector('.hrow-action'));
  assert.deepEqual(calls.splice(0), [['signInHarness', 'claude']]);
  // can't run: the cause; Re-check looks again, and a check that throws says why
  status.claude = { state: 'error', version: null, error: "MoPilot can't find the claude command\nmore" };
  await r.render(h(HarnessRow, { h: 'claude' }));
  assert.equal(text(row().querySelector('.hrow-sub')), "MoPilot can't find the claude command");
  recheckFails = new Error('spawn failed');
  await click(button(r.host, 'Re-check'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.splice(0), [
    ['recheck', 'claude'],
    ['toast', "Couldn't check Claude Code: spawn failed", 'error'],
  ]);
  // with a CLI location set, the fix is choosing another: its page's Advanced tab
  await store.set({ prefs: { claudeBin: '/opt/claude' } });
  await r.render(h(HarnessRow, { h: 'claude' }));
  await click(button(r.host, 'Choose location…'));
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'settings', section: 'claude', tab: 'advanced' }]]);
  // Codex's own location is its override
  status.codex = { state: 'error', version: null, error: 'it broke' };
  await store.set({ codexBin: '/opt/codex' });
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.ok(button(r.host, 'Choose location…'));
  // checking: neutral, no meters, no button
  status.codex = { state: 'detecting', version: null };
  views.codex = { harness: 'codex', active: acct(), accounts: [acct()], multi: true };
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.equal(text(row().querySelector('.hrow-sub')), 'Checking…');
  assert.equal(row().querySelector('.hp-meters, .hrow-action'), null);
  // left for first use
  status.codex = { state: 'detecting', idle: true, version: null };
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.equal(row().getAttribute('data-row-state'), 'first-use');
  assert.equal(text(row().querySelector('.hrow-sub')), 'Starts with your first Codex chat');
  await r.unmount();
});

test('limit reached: when it resets, with its meters, and the next account to use; a lapsed login signs in again', async () => {
  const limited = acct({ email: 'meggie@example.com', limited: { resetsAt: Date.now() + 3_600_000 }, left: 0 });
  const next = acct({ id: 'b', email: 'daxhill6@example.test' });
  views.codex = { harness: 'codex', active: limited, accounts: [limited, next], multi: true };
  const r = await mount(h(HarnessRow, { h: 'codex' }));
  const row = () => r.host.querySelector('[data-harness-row]')!;
  assert.equal(row().getAttribute('data-row-state'), 'limit');
  assert.match(text(row().querySelector('.hrow-sub')), /^meggie@example.com · Team · Limit reached.* · 2 accounts$/);
  assert.ok(row().querySelector('.hp-meters'));
  await click(button(r.host, 'Use daxhill6@'));
  assert.deepEqual(calls.splice(0), [['chooseAccount', 'b']]);
  const lapsed = acct({ status: 'expired' });
  views.codex = { harness: 'codex', active: lapsed, accounts: [lapsed], multi: true };
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.equal(row().querySelector('.hp-meters'), null);
  await click(button(r.host, 'Sign in to Codex'));
  assert.deepEqual(calls.splice(0), [['chooseAccount', 'a']]);
  await r.unmount();
});

test('a known problem with the installed version: a note saying what breaks and how out; Update when that fixes it', async () => {
  issues.codex = { text: 'may skip a payment confirmation', fixedIn: '2.0' };
  const r = await mount(h(HarnessRow, { h: 'codex' }));
  assert.equal(
    text(r.host.querySelector('[data-known-issue="codex"]')),
    'Codex 1.0 may skip a payment confirmation. Use Codex 2.0 or newer.',
  );
  assert.equal(r.host.querySelector('[data-known-issue] button'), null);
  // with the fixed version offered: one Update, in the note, and no pill beside it
  updates.codex = upd('codex');
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.match(text(r.host.querySelector('[data-known-issue]')), /Update to 2.0 to fix it\.Update$/);
  assert.equal(r.host.querySelector('[data-pill]'), null);
  await click(r.host.querySelector('[data-known-issue] button'));
  assert.deepEqual(calls.splice(0), [['update', 'codex']]);
  // an update that does not reach the fix offers no button there
  updates.codex = upd('codex', { latest: '1.5' });
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.equal(r.host.querySelector('[data-known-issue] button'), null);
  // not updatable at all
  updates.codex = upd('codex', { updatable: false });
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.equal(r.host.querySelector('[data-known-issue] button'), null);
  // a harness that has not said its version yet (an idle Codex) is matched on the version main found installed
  status.codex = { state: 'ready', version: null };
  updates.codex = upd('codex', { updatable: false, installed: '1.0' });
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.match(text(r.host.querySelector('[data-known-issue]')), /^Codex 1.0 may skip/);
  status.codex = { state: 'ready', version: '1.0' };
  // the row's own button comes first: the note keeps its words but not its button
  updates.codex = upd('codex');
  status.codex = { state: 'signin', version: '1.0' };
  await r.render(h(HarnessRow, { h: 'codex' }));
  assert.ok(r.host.querySelector('[data-known-issue]'));
  assert.equal(r.host.querySelector('[data-known-issue] button'), null);
  await r.unmount();
});

test('a basic harness: ready, sign in through its own login, set up or re-check; its row opens Other harnesses', async () => {
  const r = await mount(h(BasicRow, { b: basic({}) }));
  const row = () => r.host.querySelector('[data-harness-row]')!;
  assert.equal(row().getAttribute('data-harness-row'), 'acp:oc');
  assert.equal(text(row().querySelector('.hrow-name')), 'opencode');
  assert.ok(row().querySelector('[data-badge=oc]'));
  assert.equal(text(row().querySelector('.hrow-sub')), 'Signed in and billed by opencode');
  await click(row().querySelector('.hrow-open'));
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'settings', section: 'other-harnesses' }]]);
  await r.render(h(BasicRow, { b: basic({ state: 'signin', authMethods: [{ id: 'm', name: 'Login' }] }) }));
  assert.equal(row().querySelector('[data-badge]'), null);
  await click(button(r.host, 'Sign in to opencode'));
  assert.deepEqual(calls.splice(0), [['signInBasic', 'oc']]);
  await r.render(h(BasicRow, { b: basic({ state: 'signin', login: { command: 'oc login' } }) }));
  assert.ok(button(r.host, 'Sign in to opencode'));
  await r.render(h(BasicRow, { b: basic({ state: 'unsupported', reason: 'its tool bridge is missing' }) }));
  assert.equal(text(row().querySelector('.hrow-sub')), 'its tool bridge is missing');
  await click(button(r.host, 'Re-check'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.splice(0), [['recheck', 'acp:oc']]);
  // its update and known problem work the same way
  updates['acp:oc'] = upd('acp:oc');
  issues['acp:oc'] = { text: 'drops images', fixedIn: null };
  await r.render(h(BasicRow, { b: basic({}) }));
  assert.equal(r.host.querySelector('[data-pill]'), null);
  assert.equal(text(r.host.querySelector('[data-known-issue]')), 'opencode 1.18 drops images. Update to 2.0 to fix it.');
  await r.unmount();
});
