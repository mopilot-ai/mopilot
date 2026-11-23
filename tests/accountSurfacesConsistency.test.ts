// The four account surfaces drawn from one store state (issue #1292): Settings → Accounts & billing, a harness
// page's account card, the profile menu and the harness/model picker must say the same status, name, plan and usage
// for every account, for Codex, Claude Code and an ACP harness, across signed in, lapsed, unverified, checking,
// not started and limited. The real harness/select.ts, account view and surface components run over a fake store;
// only the store's actions, the native bridge and the popover/settings chrome are stand-ins.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { autoMock, autoMockStore, window } from './support/thread-kit.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeNative, installNativeStub } from './support/ports/native.ts';

const NOW = Date.UTC(2026, 9, 17, 12);
mock.timers.enable({ apis: ['Date'], now: NOW });
// a reset 2h ahead (and 30s, so the minutes do not round down): "resets in 2h 0m"
const RESET = Math.floor(NOW / 1000) + 7230;

const fx = () => (globalThis as any).__accountSurfaces;
const nul = () => null;
const el =
  (tag: string) =>
  ({ children, title, desc, label, description, shortcut, dataAccount }: any) =>
    createElement(tag, { 'data-account': dataAccount }, label, title, desc, description, shortcut && ` ${shortcut}`, children);

autoMockStore('store', {
  useStore: (f: any) => f(fx().state),
  getState: () => fx().state,
  setState: nul,
});
autoMock('src/lib/mopilot.ts', 'mopilot', {
  useMoPilot: () => fx().mp,
  getMoPilot: () => fx().mp,
  formatCredits: (await import('../src/lib/credits.ts')).formatCredits,
});
autoMock('src/session/harness/billing.ts', 'billing', { useClaudeKey: () => null });
autoMock('src/session/harness/claude.ts', 'claude', { useClaudeLoginTerm: () => fx().term ?? null });
// the shared fake bridge, in the port the components read (src/lib/native.ts)
installNativeStub(fakeNative());
autoMock('src/store/session/useSession.ts', 'session');
autoMock('src/store/session/useCaps.ts', 'caps');
autoMock('src/components/panels/TerminalPanel.tsx', 'term', { TermView: nul });
autoMock('src/components/harnessPicker/HarnessPicker.tsx', 'picker', { HarnessIcon: nul, BasicHarnessIcon: nul, signInHarness: nul });
autoMock('src/components/harnessPicker/badges.tsx', 'badges', {
  HarnessIcon: nul,
  BasicHarnessIcon: nul,
  BasicBadge: nul,
  signInHarness: nul,
});
const part = (h: string) => ({
  useAutoSwitch: () => [true, async () => {}],
  Icon: nul,
  signInLabel: 'Sign in',
  missingHint: `Install ${h}`,
  usageHint: 'Usage shows later',
  signIn: nul,
});
autoMock('src/components/harness/parts.tsx', 'parts', { PARTS: { codex: part('codex'), claude: part('claude') } });
autoMock('src/components/pages/Settings.tsx', 'settings', { Group: el('section'), Row: el('article'), Select: nul });
autoMock('src/components/ui/Popover.tsx', 'popover', {
  // every menu is drawn open: the card's Switch menu lists the accounts not in use, as the profile submenu does
  Menu: ({ children }: any) => createElement('menu', null, children),
  MenuItem: el('article'),
  MenuLabel: el('header'),
  MenuSeparator: nul,
  // a submenu's own row (label, description, shortcut) apart from its items
  SubMenu: ({ label, description, shortcut, children }: any) =>
    createElement('section', null, createElement('div', { 'data-row': '' }, label, description, shortcut && ` ${shortcut}`), children),
  Tooltip: ({ children }: any) => children,
  useAnchor: () => ({ ref: nul, anchor: null, open: false, toggle: nul, close: nul }),
});

const { AccountsSettings, ClaudeAccount } = await import('../src/components/accounts/settings.tsx');
const { AccountCard } = await import('../src/components/harness/Overview.tsx');
const { HarnessAccountsMenu, BasicHarnessMenuRow } = await import('../src/components/accounts/menu.tsx');
const { HarnessRow, AccountList } = await import('../src/components/harnessPicker/rows.tsx');
const { BasicRows, UNCONFINED } = await import('../src/components/harnessPicker/BasicPicker.tsx');

/* ------------------------------------------------------------------ */
/* one store state per scenario                                        */
/* ------------------------------------------------------------------ */

const codexLogin = (p: any = {}) => ({
  id: 'a',
  email: 'a@x.com',
  planType: 'pro',
  kind: 'chatgpt',
  baseUrl: null,
  isDefault: true,
  status: 'ok',
  error: null,
  chats: 0,
  limits: {
    primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: RESET },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null },
    used: 30,
    reached: false,
    resetsAt: null,
    at: NOW,
  },
  ...p,
});
const claudeLogin = (p: any = {}) => ({ id: 'default', email: 'c@x.com', loggedIn: true, subscriptionType: 'max', ...p });
const claudeStatus = (p: any = {}) => ({
  state: 'ready',
  bin: '/bin/claude',
  version: '2.1',
  plan: 'Max',
  email: 'c@x.com',
  usage: null,
  ...p,
});
const weekly = (usedPercent: number, resetsAt: number | null = null) => ({
  windows: [{ label: 'Weekly', usedPercent, resetsAt }],
  at: NOW,
  fetchState: 'success',
});

function state(p: { codex?: any; claude?: any } = {}) {
  return {
    conn: 'ready',
    connError: null,
    requiresAuth: false,
    account: null,
    rateLimits: null,
    codexBin: '/bin/codex',
    codexBinInUse: null,
    userAgent: 'codex_cli_rs/0.50.0',
    codexCompat: null,
    accounts: {
      active: 'a',
      accounts: [codexLogin(), codexLogin({ id: 'b', email: 'b@x.com', planType: 'plus', isDefault: false })],
      relay: false,
      pool: 'single',
      login: null,
    },
    claude: { status: claudeStatus(), models: [] },
    claudeAccounts: { active: 'default', accounts: [claudeLogin()], login: null },
    claudeUsage: { default: weekly(40) },
    claudeChats: {},
    segments: {},
    prefs: { defaultHarness: 'codex' },
    basicHarnesses: [
      { id: 'opencode', label: 'opencode', state: 'admitted', reason: null, bin: '/bin/opencode', version: '1', authMethods: [] },
      { id: 'kimi', label: 'kimi', state: 'signin', reason: null, bin: '/bin/kimi', version: '1', authMethods: [] },
    ],
    home: '/Users/me',
    ...p.codex,
    ...p.claude,
  };
}

/**
 * What every surface must say about one account: its name and plan, and how it is doing as its full status, the
 * meters beside it (each window's "x% left") or, in a narrow slot, the short form.
 */
interface Expect {
  name: string;
  plan: string | null;
  status: string;
  short?: string;
  meters?: string[];
}

const SCENARIOS: { name: string; state: any; accounts: Record<string, Expect>; empty?: Record<string, string> }[] = [
  {
    name: 'signed in',
    state: state(),
    accounts: {
      'codex:a': { name: 'a@x.com', plan: 'Pro', status: '70% left (5h)', short: '70% left', meters: ['70% left', '90% left'] },
      'codex:b': { name: 'b@x.com', plan: 'Plus', status: '70% left (5h)', short: '70% left', meters: ['70% left', '90% left'] },
      'claude:default': { name: 'c@x.com', plan: 'Max', status: '60% left (weekly)', short: '60% left', meters: ['60% left'] },
    },
  },
  {
    name: 'lapsed',
    state: state({
      codex: { accounts: { active: 'a', accounts: [codexLogin({ status: 'expired' })], relay: false, pool: 'single', login: null } },
      claude: {
        claude: { status: claudeStatus({ state: 'signin' }), models: [] },
        claudeAccounts: { active: 'default', accounts: [claudeLogin({ loggedIn: false })], login: null },
      },
    }),
    accounts: {
      'codex:a': { name: 'a@x.com', plan: 'Pro', status: 'Sign-in expired' },
      'claude:default': { name: 'c@x.com', plan: 'Max', status: 'Signed out' },
    },
  },
  {
    name: 'unverified',
    state: state({
      claude: { claudeAccounts: { active: 'default', accounts: [claudeLogin({ identity: 'unverified' })], login: null } },
    }),
    accounts: {
      'claude:default': { name: 'Claude Code CLI login', plan: 'Max', status: 'Account unverified · 60% left' },
    },
  },
  {
    name: 'checking',
    state: state({
      codex: { conn: 'connecting' },
      claude: { claude: { status: claudeStatus({ state: 'detecting' }), models: [] } },
    }),
    accounts: {
      'codex:a': { name: 'a@x.com', plan: 'Pro', status: 'Checking…', short: 'Checking…' },
      'claude:default': { name: 'c@x.com', plan: 'Max', status: 'Checking…', short: 'Checking…' },
    },
  },
  {
    name: 'not started',
    state: state({
      codex: { conn: 'idle', accounts: { active: null, accounts: [], relay: false, pool: 'single', login: null } },
      claude: {
        claude: { status: claudeStatus({ state: 'detecting', idle: true, email: null, plan: null }), models: [] },
        claudeAccounts: { active: 'default', accounts: [], login: null },
        claudeUsage: {},
      },
    }),
    accounts: {},
    empty: { codex: 'Starts on first use', claude: 'Starts on first use' },
  },
  {
    // #1867: a CLI login nobody signed in to is no account: every surface says the harness is signed out, as for Codex
    name: 'never signed in',
    state: state({
      codex: { requiresAuth: true, accounts: { active: null, accounts: [], relay: false, pool: 'single', login: null } },
      claude: {
        claude: { status: claudeStatus({ state: 'signin', email: null, plan: null }), models: [] },
        claudeAccounts: {
          active: 'default',
          accounts: [claudeLogin({ email: null, loggedIn: false, subscriptionType: null })],
          login: null,
        },
        claudeUsage: {},
      },
    }),
    accounts: {},
  },
  {
    name: 'limited',
    state: state({
      codex: {
        accounts: {
          active: 'a',
          accounts: [
            codexLogin({
              limits: {
                primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET },
                secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
                used: 100,
                reached: true,
                resetsAt: RESET,
                at: NOW,
              },
            }),
          ],
          relay: false,
          pool: 'single',
          login: null,
        },
      },
      claude: { claudeUsage: { default: weekly(100, RESET) } },
    }),
    accounts: {
      'codex:a': { name: 'a@x.com', plan: 'Pro', status: 'Limit reached · resets in 2h 0m', short: 'Limit reached' },
      'claude:default': { name: 'c@x.com', plan: 'Max', status: 'Limit reached · resets in 2h 0m', short: 'Limit reached' },
    },
  },
];

/* ------------------------------------------------------------------ */
/* drawing the four surfaces                                           */
/* ------------------------------------------------------------------ */

const host = (markup: string) => {
  const div = window.document.createElement('div');
  div.innerHTML = markup;
  return div as unknown as Element;
};
const draw = (node: any) => host(renderToStaticMarkup(node));
const picker = (h: string) =>
  createElement(
    'div',
    null,
    createElement(HarnessRow, { h, chatId: null, current: false, hovered: false, onHover: nul, rowRef: nul } as any),
    createElement(AccountList, { h, chatId: null, busy: false } as any),
  );
const surfaces = (h: 'codex' | 'claude') => ({
  settings: draw(h === 'codex' ? createElement(AccountsSettings, { only: 'codex' }) : createElement(ClaudeAccount)),
  card: draw(createElement(AccountCard, { h })),
  profile: draw(createElement(HarnessAccountsMenu, { h })),
  picker: draw(picker(h)),
});

const STATE_WORDS = [
  'Checking…',
  'Sign-in expired',
  'Signed out',
  'Limit reached',
  'Account unverified',
  'Starts on first use',
  'Not signed in',
];
const textOf = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ');

/** One surface's elements for an account, by the data-account key every surface marks its rows with. */
const marked = (root: Element, key: string) => [...root.querySelectorAll(`[data-account="${key}"]`)];

for (const sc of SCENARIOS)
  test(`every surface says the same about each account: ${sc.name}`, () => {
    (globalThis as any).__accountSurfaces = { state: sc.state, mp: { signedIn: false, user: null, balanceMicros: null } };
    for (const h of ['codex', 'claude'] as const) {
      const drawn = surfaces(h);
      for (const [key, want] of Object.entries(sc.accounts).filter(([k]) => k.startsWith(`${h}:`))) {
        const others = STATE_WORDS.filter((w) => !want.status.includes(w));
        for (const [surface, root] of Object.entries(drawn)) {
          const els = marked(root, key);
          assert.ok(els.length, `${sc.name}: ${surface} shows ${key}`);
          for (const e of els) {
            // a submenu's own row counts whole: its shortcut slot is part of what it says
            const t = textOf(e.closest('[data-row]') ?? e);
            const where = `${sc.name}: ${surface} ${key}: "${t}"`;
            // a narrow slot (the picker's harness row) says only how the account is doing
            if (t.includes(want.name) && want.plan) assert.ok(t.includes(want.plan), `${where} names the plan ${want.plan}`);
            const says =
              t.includes(want.status) ||
              (!!want.meters && want.meters.every((m) => t.includes(m))) ||
              (!!want.short && t.includes(want.short));
            assert.ok(says, `${where} says ${want.status}`);
            for (const w of others) assert.ok(!t.includes(w), `${where} never says ${w}`);
          }
        }
      }
      const empty = sc.empty?.[h];
      if (empty)
        for (const [surface, root] of Object.entries(drawn))
          assert.ok(textOf(root).includes(empty), `${sc.name}: ${surface} of ${h} says "${empty}": "${textOf(root)}"`);
    }
  });

test('a never-signed-in Claude Code login: Settings offers Sign in, never "Sign in again" or "In use" (#1867)', () => {
  const sc = SCENARIOS.find((x) => x.name === 'never signed in')!;
  (globalThis as any).__accountSurfaces = { state: sc.state, mp: { signedIn: false, user: null, balanceMicros: null } };
  const t = textOf(draw(createElement(ClaudeAccount)));
  assert.match(t, /Claude Code: Not signed in\s*Sign in/);
  const card = textOf(draw(createElement(AccountCard, { h: 'claude' })));
  assert.match(card, /Not signed in/);
  for (const x of [t, card])
    for (const w of ['Sign in again', 'In use', 'Claude Code login', '1 account']) assert.ok(!x.includes(w), `never "${w}": ${x}`);
  // while its own sign-in runs in the terminal below, no second Sign in
  (globalThis as any).__accountSurfaces = { state: sc.state, mp: { signedIn: false, user: null, balanceMicros: null }, term: { id: 't' } };
  assert.doesNotMatch(textOf(draw(createElement(ClaudeAccount))), /Not signed in\s*Sign in/);
  // while an added login's sign-in runs, Cancel stands in for it
  const s2 = { ...sc.state, claudeAccounts: { ...sc.state.claudeAccounts, login: { id: 'x' } } };
  (globalThis as any).__accountSurfaces = { state: s2, mp: { signedIn: false, user: null, balanceMicros: null } };
  assert.doesNotMatch(textOf(draw(createElement(ClaudeAccount))), /Not signed in\s*Sign in/);
});

test('an ACP harness is "Managed by" itself, the same in the profile menu and the picker', () => {
  (globalThis as any).__accountSurfaces = { state: state(), mp: { signedIn: false, user: null, balanceMicros: null } };
  const { basicHarnesses } = fx().state;
  const profile = draw(createElement('div', null, ...basicHarnesses.map((b: any) => createElement(BasicHarnessMenuRow, { key: b.id, b }))));
  const picked = draw(createElement(BasicRows, { current: null, onPick: nul }));
  const line = (root: Element, key: string) => {
    const e = marked(root, key)[0];
    return textOf(e.querySelector('.acct-line') ?? e);
  };
  assert.equal(line(profile, 'acp:opencode'), 'Managed by opencode · Ready');
  assert.equal(line(picked, 'acp:opencode'), 'Managed by opencode · Ready');
  assert.equal(line(profile, 'acp:kimi'), 'Managed by kimi · Not signed in');
  // only an admitted one can start a chat from the picker
  assert.equal(marked(picked, 'acp:kimi').length, 0);
});

test("MoMo's brain menu shows a basic harness it can't confine off, with why; other pickers list it as usual (#2278)", () => {
  const base = state();
  const gemini = { id: 'gemini', label: 'Gemini CLI', state: 'admitted', reason: null, bin: '/bin/gemini', version: '1', authMethods: [] };
  const kimi = { ...gemini, id: 'kimi', label: 'kimi', isolates: true, momoBlocked: 'MoMo needs a kimi provider' };
  const basics = [{ ...base.basicHarnesses[0], isolates: true }, gemini, kimi];
  (globalThis as any).__accountSurfaces = {
    state: { ...base, basicHarnesses: basics },
    mp: { signedIn: false, user: null, balanceMicros: null },
  };
  const row = (root: Element, id: string) => root.querySelector(`[data-harness="${id}"]`)!;
  const momo = draw(createElement(BasicRows, { current: null, onPick: nul, momo: true }));
  assert.equal(row(momo, 'opencode').getAttribute('aria-disabled'), null);
  assert.equal(textOf(marked(momo, 'acp:opencode')[0]), 'Managed by opencode · Ready');
  assert.equal(row(momo, 'gemini').getAttribute('aria-disabled'), 'true');
  assert.equal(textOf(marked(momo, 'acp:gemini')[0]), UNCONFINED);
  // one that isolates but can't run MoMo now says why (#2357)
  assert.equal(row(momo, 'kimi').getAttribute('aria-disabled'), 'true');
  assert.equal(textOf(marked(momo, 'acp:kimi')[0]), 'MoMo needs a kimi provider');
  const coding = draw(createElement(BasicRows, { current: null, onPick: nul }));
  assert.equal(row(coding, 'gemini').getAttribute('aria-disabled'), null);
  assert.notEqual(textOf(marked(coding, 'acp:gemini')[0]), UNCONFINED);
});

test('one server account behind the CLI login and an added login is one row on every surface (#1312)', () => {
  // main left the CLI's own login out of each list as the same account as the added one (identity/contract/sameAccount.cjs)
  const folded = state({
    codex: {
      accounts: {
        active: 'b',
        same: { default: 'b' },
        accounts: [codexLogin({ id: 'b', email: 'dz@x.com', isDefault: false, chats: 1 })],
        relay: false,
        pool: 'single',
        login: null,
      },
    },
    claude: {
      claudeAccounts: { active: 'x', same: { default: 'x' }, accounts: [claudeLogin({ id: 'x', email: 'dz@x.com' })], login: null },
      claudeUsage: { x: weekly(40), default: weekly(40) },
      claudeChats: { c1: { id: 'default' }, c2: { id: 'default' }, c3: { id: 'x' } },
    },
  });
  (globalThis as any).__accountSurfaces = { state: folded, mp: { signedIn: false, user: null, balanceMicros: null } };
  for (const [h, shown, cli, chats] of [
    ['codex', 'b', 'Codex login on this computer', '1 chat'],
    ['claude', 'x', 'Claude Code login on this computer', '3 chats'],
  ] as const) {
    for (const [surface, root] of Object.entries(surfaces(h))) {
      assert.equal(marked(root, `${h}:default`).length, 0, `${surface} of ${h} never lists the folded login`);
      assert.ok(marked(root, `${h}:${shown}`).length, `${surface} of ${h} lists the account`);
    }
    // Settings says the row is the CLI's login too, with the chats of both logins
    const row = textOf(marked(surfaces(h).settings, `${h}:${shown}`)[0]);
    assert.ok(row.includes(cli) && row.includes(chats), `settings of ${h}: "${row}"`);
  }
});

test('#2308: a list told an account can’t be picked here says why on its row and disables it; the others stay', () => {
  const two = state({
    codex: {
      accounts: {
        active: 'b',
        same: {},
        accounts: [
          codexLogin({ id: 'b', email: 'b@x.com', isDefault: false }),
          codexLogin({ id: 'k', email: 'k@x.com', isDefault: false }),
        ],
        relay: false,
        pool: 'single',
        login: null,
      },
    },
  });
  (globalThis as any).__accountSurfaces = { state: two, mp: { signedIn: false, user: null, balanceMicros: null } };
  const root = draw(
    createElement(AccountList, {
      h: 'codex',
      chatId: null,
      busy: false,
      unavailable: (a: any) => (a.id === 'k' ? 'MoMo needs a ChatGPT sign-in on Codex' : null),
    } as any),
  );
  const [k] = marked(root, 'codex:k');
  const [b] = marked(root, 'codex:b');
  assert.ok(textOf(k).includes('MoMo needs a ChatGPT sign-in on Codex'));
  assert.ok(k.hasAttribute('disabled') || k.getAttribute('aria-disabled') === 'true');
  assert.ok(!textOf(b).includes('MoMo needs'));
  assert.ok(!b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true');
});
