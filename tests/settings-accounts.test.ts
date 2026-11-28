// Accounts UI: Settings → Accounts for Codex and Claude Code, the browser sign-in dialog and the quit banners (Codex's
// expired one is in codexExpiredBanner.test.ts). The profile menu's harness rows are in settings-accounts-menu.test.ts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  ctl,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  key,
  flush,
} from './support/settings-harness.ts';
import { window } from './support/dom.ts';

await setup();
const { createElement: h, act: reactAct } = await import('react');
const {
  initialsOf,
  avatarColor,
  AccountAvatar,
  AccountsSettings,
  ClaudeAccount,
  RefreshClaudeButton,
  RefreshCodexButton,
  AccountSignInDialog,
  AccountExpiredBanner,
} = await import('../src/components/accounts/Accounts.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});
const accounts = (p: any) => useStore.setState({ accounts: { ...useStore.getState().accounts, ...p } });
const find = (root: Element, label: string) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
/** Sign out or Remove sit in an account row's ⋯ menu: open it, then pick. */
async function fromRowMenu(rowEl: Element, label: string) {
  await click(rowEl.querySelector('[aria-label^="More for"]')!);
  await click(button(rowEl, label));
}
const mousedown = (el: Element) =>
  reactAct(async () => {
    el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any);
  });

test('avatars use initials and a stable color', async () => {
  assert.equal(initialsOf('a.b-c@x.com'), 'AB');
  assert.equal(initialsOf(null), 'API');
  assert.equal(avatarColor('x@y.z'), avatarColor('x@y.z'));
  assert.match(avatarColor(null), /^#/);
  const { host, unmount } = await render(
    h('div', null, h(AccountAvatar, { account: { email: 'jo@x.com' } }), h(AccountAvatar, { account: { email: null }, size: 28 })),
  );
  const [a, b] = host.querySelectorAll('.profile-avatar') as any;
  assert.equal(text(a), 'JO');
  assert.equal(a.style.width, '18px');
  assert.equal(b.style.width, '28px');
  await unmount();
});

test('codex settings when signed out offer sign in, with or without Claude below', async () => {
  let r = await render(h(AccountsSettings, { only: 'codex' }));
  // the page is about who Codex runs as: a Codex left for first use starts, so "not signed in" is known
  assert.deepEqual(calls.slice(0, 2), [['ensureCodex'], ['refreshAccountsUsage', 'surface']]);
  // what it says with no account is the account view's, as on the harness page and in the profile menu
  await click(button(row(r.host, 'Codex: No account yet'), 'Sign in'));
  assert.deepEqual(calls.at(-1), ['login']);
  // a sign-in that could not start says so instead of doing nothing
  ctl.loginError = new Error('no app server');
  await click(button(row(r.host, 'Codex: No account yet'), 'Sign in'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't start signing in to Codex: no app server", 'error']);
  delete ctl.loginError;
  await r.unmount();
  // no account: what goes under it still shows (Use an API key), with no Add account of its own
  const got: any[] = [];
  r = await render(h(AccountsSettings, { only: 'codex', footer: (add: any) => (got.push(add), h('aside', { id: 'f' })) }));
  assert.ok(r.host.querySelector('#f'));
  assert.deepEqual(got.slice(-1), [null]);
  await r.unmount();
  // while Codex is starting (or left for first use) whether it is signed in is not known yet
  for (const [state, title] of [
    [{ state: 'detecting', idle: true }, 'Codex: Starts on first use'],
    [{ state: 'detecting' }, 'Codex: Checking…'],
    [{ state: 'signin' }, 'Codex: Not signed in'],
  ] as const) {
    ctl.status.codex = state;
    const s = await render(h(AccountsSettings, { only: 'codex' }));
    assert.ok(row(s.host, title));
    await s.unmount();
  }
  delete ctl.status.codex;
  useStore.setState({ conn: 'ready' });
  r = await render(h(AccountsSettings, { only: 'codex' }));
  assert.equal(find(r.host, 'Add account'), undefined);
  await r.unmount();
  ctl.refreshError = new Error('x');
  r = await render(h(AccountsSettings));
  await flush();
  assert.ok(find(r.host, 'Add account'));
  await r.unmount();
});

const codex = (p: any) => ({ id: 'x', email: 'x@x.com', kind: 'chatgpt', status: 'ok', chats: 0, isDefault: false, ...p });

test('codex settings rows show plan, status, limits and the right actions', async () => {
  const now = Date.now() / 1000;
  accounts({
    active: 'a',
    relay: false,
    accounts: [
      codex({
        id: 'a',
        email: 'a@x.com',
        planType: 'pro',
        isDefault: true,
        chats: 1,
        limits: {
          used: 30,
          primary: { windowDurationMins: 300, usedPercent: 30 },
          secondary: { windowDurationMins: 10080, usedPercent: 100 },
        },
      }),
      codex({
        id: 'b',
        email: null,
        kind: 'apiKey',
        chats: 2,
        limits: { primary: { windowDurationMins: null, usedPercent: 120 }, secondary: { windowDurationMins: 2880, usedPercent: 0 } },
      }),
      codex({ id: 'c', email: 'c@x.com', status: 'expired', limits: { primary: { windowDurationMins: 120, usedPercent: 10 } } }),
      codex({
        id: 'd',
        email: 'd@x.com',
        limits: { primary: { windowDurationMins: 45, usedPercent: 10 }, reached: true, resetsAt: now + 60 },
      }),
      codex({ id: 'e', email: 'e@x.com' }),
      codex({ id: 'f', email: 'f@x.com', limits: { primary: { windowDurationMins: 120, usedPercent: 50 } } }),
      codex({ id: 'm', email: 'm@x.com', mopilot: true }),
    ],
  });
  const { host, unmount } = await render(h(AccountsSettings, { only: 'codex' }));
  const r = (id: string) => host.querySelector(`[data-account="codex:${id}"]`)!;
  assert.equal(host.querySelector('[data-account="codex:m"]'), null);
  // the meters say what is left, so the line says what the account is and its chats, and warns when a window ran out
  assert.equal(text(r('a').querySelector('.acct-row-text')), 'a@x.comProIn useCodex login on this computer · 0% left (weekly) · 1 chat');
  assert.deepEqual([...r('a').querySelectorAll('.limit-meta')].map(text), ['5h70% left', 'Weekly0% left']);
  assert.ok(r('a').querySelector('.limit-fill.out'));
  // a key is billed per token, as every surface says, and has no plan windows to meter
  assert.equal(text(r('b').querySelector('.acct-row-text')), 'API keyBilled per token · 2 chats');
  assert.equal(r('b').querySelector('.acct-limits'), null);
  assert.equal(r('c').querySelector('.acct-limits'), null);
  assert.equal(text(r('c').querySelector('.acct-row-text')), 'c@x.comSign-in expired');
  assert.equal(text(r('d').querySelector('.limit-meta span')), '45m');
  // no reading yet: it says so, as the profile menu does
  assert.equal(text(r('e').querySelector('.acct-status')), 'Usage unknown');
  assert.equal(r('e').querySelector('.acct-limits'), null);
  assert.equal(text(r('f').querySelector('.limit-meta')), '2h50% left');
  assert.equal(find(r('a'), 'Use'), undefined);
  await click(button(r('b'), 'Use'));
  assert.deepEqual(calls.at(-1), ['switchAccount', 'b']);
  await click(button(r('c'), 'Sign in again'));
  assert.deepEqual(calls.at(-1), ['addAccount', 'c']);
  await click(button(host, 'Add account'));
  assert.deepEqual(calls.at(-1), ['addAccount']);
  // the refresh button sits beside the OpenAI heading
  const refresh = await render(h(RefreshCodexButton));
  await click(refresh.host.querySelector('[title="Refresh usage"]')!);
  assert.deepEqual(calls.at(-1), ['refreshAccountsUsage', 'now']);
  ctl.refreshError = new Error("Error invoking remote method 'x': Error: offline");
  await click(refresh.host.querySelector('[title="Refresh usage"]')!);
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'offline', 'error']);
  await refresh.unmount();
  // removing asks first; the default account signs the CLI out too
  ctl.confirm = false;
  await fromRowMenu(r('a'), 'Sign out');
  assert.deepEqual(calls.at(-1), ['confirm', 'Sign a@x.com out of Codex on this computer?']);
  ctl.confirm = true;
  await fromRowMenu(r('b'), 'Remove');
  assert.deepEqual(calls.slice(-2), [
    ['confirm', 'Remove this account from Codex on this computer?'],
    ['removeAccount', 'b'],
  ]);
  ctl.removeError = 'nope';
  await fromRowMenu(r('c'), 'Remove');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'nope', 'error']);
  await unmount();
  // without `only`, Claude Code's accounts follow Codex's
  const all = await render(h(AccountsSettings));
  assert.ok(all.host.querySelector('[data-account="codex:a"]'));
  assert.ok(find(all.host, 'Add account'));
  await all.unmount();
});

test('a footer gets each harness its Add account button, and null for Codex with no account yet', async () => {
  const seen: any[] = [];
  const footer = (add: any) => (seen.push(add === null ? null : 'add'), h('aside', { 'data-footer': true }, add));
  accounts({ active: 'a', relay: true, pool: 'spread', accounts: [codex({ id: 'a' }), codex({ id: 'b' })] });
  let r = await render(h(AccountsSettings, { only: 'codex', footer }));
  // the old Account selection row is the accounts list's automatic-switching toggle now (AccountActions)
  assert.throws(() => row(r.host, 'Account selection'));
  assert.ok(find(r.host.querySelector('[data-footer]')!, 'Add account'));
  await r.unmount();
  r = await render(h(ClaudeAccount, { footer }));
  assert.ok(find(r.host.querySelector('[data-footer]')!, 'Add account'));
  await r.unmount();
  assert.deepEqual(seen.slice(-2), ['add', 'add']);
});

const claude = (p: any) => ({
  id: 'default',
  harness: 'claude',
  email: 'cl@x.com',
  plan: 'Max',
  kind: 'subscription',
  status: 'ok',
  left: 50,
  usage: { windows: [], at: null },
  ...p,
});

test('the CLI login whose account another app renamed is named as such and offers to confirm it', async () => {
  const doubted = claude({ email: 'dz@x.com', unverified: true }),
    other = claude({ id: 'b2', email: 'b2@x.com', plan: null });
  ctl.harnessAccounts.claude = { active: other, accounts: [doubted, other] };
  ctl.status.claude = { state: 'ready', bin: '/bin/claude' };
  const { host, unmount } = await render(h(ClaudeAccount));
  await flush();
  const row = host.querySelector('[data-account="claude:default"]')!;
  assert.equal(text(row.querySelector('.acct-row-title')), 'Claude Code loginMax');
  assert.equal(text(row.querySelector('.profile-avatar')), '?');
  assert.match(text(row.querySelector('.acct-status')), /^Account unverified · /);
  assert.equal(row.textContent?.includes('dz@x.com'), false);
  await click(button(row, 'Sign in again to confirm'));
  assert.deepEqual(calls.at(-1), ['reloginClaudeAccount', 'default']);
  // signing it out names the CLI login, not the account another app wrote
  ctl.confirm = false;
  await fromRowMenu(row, 'Sign out');
  assert.deepEqual(calls.at(-1), ['confirm', 'Sign this account out of Claude Code on this computer?']);
  await unmount();
});

test('a login whose folder moved says it needs to be confirmed again, why, and offers to sign in again', async () => {
  const d = claude({}),
    moved = claude({ id: 'b2', email: 'b2@x.com', status: 'signin', reconfirm: true }),
    out = claude({ id: 'c3', email: 'c3@x.com', status: 'signin' });
  ctl.harnessAccounts.claude = { active: d, accounts: [d, moved, out] };
  ctl.status.claude = { state: 'ready', bin: '/bin/claude' };
  const { host, unmount } = await render(h(ClaudeAccount));
  await flush();
  const r = (id: string) => host.querySelector(`[data-account="claude:${id}"]`)!;
  const lines = (id: string) => [...r(id).querySelectorAll('.acct-status')].map(text);
  assert.ok(lines('b2').includes('Needs to be confirmed again'));
  assert.ok(lines('b2').includes('Its data folder moved. Sign in again to confirm it.'));
  // a plain sign-out keeps its own words and no reason
  assert.ok(lines('c3').includes('Signed out'));
  assert.equal(
    lines('c3').some((l) => l.includes('data folder moved')),
    false,
  );
  await click(button(r('b2'), 'Sign in again'));
  assert.deepEqual(calls.at(-1), ['reloginClaudeAccount', 'b2']);
  await unmount();
});

test('claude accounts list usage, chats, errors and per-account actions', async () => {
  // each account carries its own usage (harness/accounts.ts claudeAccounts): the rows draw only that
  const d = claude({ left: 75, usage: { windows: [{ label: '5h', usedPercent: 25 }], source: 'parsed', at: null } }),
    b = claude({ id: 'b2', email: null, plan: null, left: null, status: 'expired' }),
    c = claude({
      id: 'c3',
      email: 'c3@x.com',
      plan: null,
      left: 0,
      limited: { resetsAt: null },
      usage: { windows: [{ label: 'Week', usedPercent: 100 }], source: 'parsed', at: null },
    });
  ctl.harnessAccounts.claude = { active: d, accounts: [d, b, c] };
  ctl.status.claude = {
    state: 'error',
    error: 'line one\nline two',
    bin: '/bin/claude',
    usage: { windows: [{ label: '5h', usedPercent: 25 }] },
  };
  ctl.claudeUsageError = new Error('x');
  useStore.setState({
    claudeUsage: { c3: { windows: [{ label: 'Week', usedPercent: 100 }] } },
    claudeChats: { t1: { id: 'default' }, t2: { id: 'c3' }, t3: { id: 'c3' } },
  });
  const { host, unmount } = await render(h(ClaudeAccount));
  await flush();
  assert.equal(
    calls.some((c) => c[0] === 'refreshClaudeUsage'),
    false,
    'unavailable accounts do not fetch usage',
  );
  const r = (id: string) => host.querySelector(`[data-account="claude:${id}"]`)!;
  assert.equal(text(r('default').querySelector('.acct-row-title')), 'cl@x.comMaxIn use');
  assert.equal(text(r('default').querySelector('.acct-status')), 'Claude Code login on this computer · 1 chat');
  assert.equal(text(r('default').querySelector('.acct-status.warn')), 'line one');
  assert.equal(text(r('default').querySelector('.limit-meta')), '5h75% left');
  assert.equal(text(r('c3').querySelector('.acct-status')), 'Limit reached · 2 chats');
  assert.ok(r('c3').querySelector('.limit-fill.out'));
  assert.equal(r('b2').querySelector('.acct-limits'), null);
  await click(button(r('b2'), 'Sign in again'));
  assert.deepEqual(calls.at(-1), ['reloginClaudeAccount', 'b2']);
  await click(button(r('c3'), 'Use'));
  assert.deepEqual(calls.at(-1), ['switchClaudeAccount', 'c3']);
  ctl.confirm = false;
  await fromRowMenu(r('default'), 'Sign out');
  assert.deepEqual(calls.at(-1), ['confirm', 'Sign cl@x.com out of Claude Code on this computer?']);
  ctl.confirm = true;
  await fromRowMenu(r('b2'), 'Remove');
  assert.deepEqual(calls.slice(-2), [
    ['confirm', 'Sign this account out and remove it from MoPilot?'],
    ['removeClaudeAccount', 'b2'],
  ]);
  await click(button(host, 'Add account'));
  assert.deepEqual(calls.at(-1), ['addClaudeAccount']);
  ctl.claudeRefreshError = new Error('x');
  // the re-check button sits beside the Anthropic heading
  const recheck = await render(h(RefreshClaudeButton));
  await click(recheck.host.querySelector('[title="Re-check sign-in and usage"]')!);
  await flush();
  await recheck.unmount();
  // a re-check whose account list couldn't be read says so
  assert.deepEqual(calls.slice(-3), [
    ['refreshClaudeAccounts'],
    ['recheckClaude'],
    ['toast', "Couldn't refresh the Claude Code accounts: x", 'error'],
  ]);
  await unmount();
});

test('claude account: detecting, sign-in in progress with the login terminal, and errors without text', async () => {
  const d = claude({});
  ctl.harnessAccounts.claude = { active: d, accounts: [d] };
  ctl.status.claude = { state: 'detecting' };
  let r = await render(h(ClaudeAccount));
  assert.match(text(r.host), /Checking…/);
  assert.ok(button(r.host, 'Add account').disabled);
  assert.equal(
    calls.some((c) => c[0] === 'refreshClaudeUsage'),
    false,
  );
  await r.unmount();
  ctl.status.claude = { state: 'ready' };
  ctl.harnessAccounts.claude = { active: null, accounts: [claude({})] };
  useStore.setState({ claudeAccounts: { login: { id: 'x' } } });
  ctl.loginTerm = { id: 'term1', title: 'claude auth', command: ['claude', 'auth', 'login'] };
  r = await render(h(ClaudeAccount));
  assert.equal(r.host.querySelector('.acct-chip.on'), null);
  assert.ok(button(r.host, 'Use'));
  await click(button(row(r.host, 'Finish signing in in Terminal'), 'Cancel'));
  assert.deepEqual(calls.at(-1), ['cancelClaudeLogin']);
  const term = JSON.parse(r.host.querySelector('[data-stub=TermView]')!.getAttribute('data-props')!);
  assert.deepEqual(term.tab, { id: 'term1', cwd: '/Users/me', title: 'claude auth', command: ['claude', 'auth', 'login'], signIn: true });
  assert.equal(term.visible, true);
  await r.unmount();
  const e = claude({ email: null });
  ctl.harnessAccounts.claude = { active: e, accounts: [e] };
  ctl.status.claude = { state: 'error' };
  ctl.loginTerm = null;
  r = await render(h(ClaudeAccount));
  assert.equal(text(r.host.querySelector('.acct-status.warn')), '');
  await r.unmount();
});

test('claude account when the CLI is missing links to the install guide', async () => {
  ctl.status.claude = { state: 'missing' };
  const { host, unmount } = await render(h(ClaudeAccount));
  await click(button(row(host, 'Claude Code isn’t installed'), 'Install'));
  assert.deepEqual(calls.at(-1), ['shell.openExternal', 'https://code.claude.com/docs/en/setup']);
  await unmount();
});

test('sign-in dialog: add or re-sign, copy and reopen the link, cancel by button, Escape or backdrop', async () => {
  let r = await render(h(AccountSignInDialog));
  assert.equal(r.host.innerHTML, '');
  await r.unmount();
  accounts({ login: { authUrl: 'https://auth', targetId: null }, accounts: [codex({ id: 't', email: null })] });
  r = await render(h(AccountSignInDialog));
  assert.match(text(r.host), /Add a ChatGPT account/);
  assert.match(text(r.host), /Already signed in\?/);
  await click(button(r.host, 'Copy link'));
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['clipboard.write', 'https://auth'],
    ['toast', 'Sign-in link copied'],
  ]);
  await click(button(r.host, 'Open again'));
  assert.deepEqual(calls.at(-1), ['shell.openExternal', 'https://auth']);
  await click(r.host.querySelector('[aria-label=Cancel]')!);
  await click(find(r.host, 'Cancel')!);
  await key(window as any, { key: 'a' });
  await key(window as any, { key: 'Escape' });
  await mousedown(r.host.querySelector('.dialog')!);
  await mousedown(r.host.querySelector('.sketch-backdrop')!);
  assert.equal(calls.filter((c) => c[0] === 'cancelAccountLogin').length, 4);
  await r.unmount();
  accounts({ login: { authUrl: 'https://auth', targetId: 't' } });
  r = await render(h(AccountSignInDialog));
  assert.match(text(r.host), /Sign in again as this account/);
  assert.match(text(r.host), /Sign in with the same account to restore it/);
  await r.unmount();
  accounts({ accounts: [codex({ id: 't', email: 't@x.com' })] });
  r = await render(h(AccountSignInDialog));
  assert.match(text(r.host), /Sign in again as t@x\.com/);
  assert.match(text(r.host), /Sign in with t@x\.com to restore it/);
  await r.unmount();
});

test('banners: codex restarting, gave up and restart, and harness banners', async () => {
  ctl.parts = { codex: { Banner: () => h('div', { id: 'codex-banner' }) }, claude: {} };
  let r = await render(h(AccountExpiredBanner));
  assert.ok(r.host.querySelector('#codex-banner'));
  assert.equal(r.host.querySelector('.acct-banner'), null);
  await r.unmount();
  useStore.setState({ codexRestart: { attempt: 1 } });
  r = await render(h(AccountExpiredBanner));
  assert.equal(text(r.host.querySelector('[role=status]')), 'Codex quit. Restarting it…');
  await r.unmount();
  useStore.setState({ codexRestart: { attempt: 3 } });
  r = await render(h(AccountExpiredBanner));
  assert.equal(text(r.host.querySelector('[role=status]')), 'Codex quit. Restarting it (try 3)…');
  await r.unmount();
  useStore.setState({ codexRestart: 'gaveUp' });
  r = await render(h(AccountExpiredBanner));
  // no copy named (an older main): Settings → Codex → Advanced, where the binary is picked
  assert.equal(text(r.host.querySelector('[role=alert]')).startsWith('Codex keeps quitting'), true);
  await click(button(r.host, 'Settings'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'codex', tab: 'advanced' }]);
  calls.length = 0;
  await click(button(r.host, 'Restart Codex'));
  await flush();
  assert.deepEqual(calls, [['setState', { codexRestart: null }], ['codex.restart'], ['connect']]);
  assert.equal(r.host.querySelector('.acct-banner'), null);
  await r.unmount();
});

test("codex settings show the app-server's own login before the pool lists it, with nothing to remove", async () => {
  useStore.setState({ account: { type: 'chatgpt', email: 'own@x.com', planType: 'plus' } });
  const { host, unmount } = await render(h(AccountsSettings, { only: 'codex' }));
  const r = host.querySelector('[data-account="codex:default"]')!;
  assert.equal(text(r.querySelector('.acct-email')), 'own@x.com');
  assert.equal(r.querySelector('[aria-label^="More for"]'), null);
  await unmount();
});

test('claude accounts still list their rows when the usage refresh fails', async () => {
  const d = claude({});
  ctl.harnessAccounts.claude = { active: d, accounts: [d] };
  ctl.status.claude = { state: 'ready', bin: '/bin/claude' };
  ctl.claudeUsageError = new Error('usage endpoint down');
  const { host, unmount } = await render(h(ClaudeAccount));
  await flush();
  assert.ok(
    calls.some((c) => c[0] === 'refreshClaudeUsage'),
    'a ready harness fetches usage',
  );
  assert.ok(host.querySelector('[data-account="claude:default"]'), 'the row shows without usage figures');
  await unmount();
});
