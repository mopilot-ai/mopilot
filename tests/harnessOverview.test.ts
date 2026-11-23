// A harness page's header and its Overview account card: who it runs as, the Switch menu, usage and the way
// to Accounts & billing, for any harness (the parts supply what differs).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, settingsStubs, popoverStubs, byText } from './support/harness-ui-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[][] = [];
const record =
  (name: string) =>
  (...a: any[]) =>
    void calls.push([name, ...a]);
let status: any = {};
let view: any = {};
const parts: any = {
  Icon: ({ size }: any) => h('i', { 'data-mark': size }),
  missingHint: 'Install it first.',
  signInLabel: 'Sign in',
  usageHint: 'Shown after the first turn',
  // the harness's binary, as its Version row reads it
  useBinary: (st: any) => ({ bin: st.bin ?? null, manual: 'set-path' }),
};
// the account view (harness/useAccountView.ts) reads each account's chats from the store: none here
stubStore({ useStore: (f: any) => f({ accounts: { accounts: [] }, claudeChats: {} }) });
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessStatus: () => status,
    useHarnessAccounts: () => view,
    addHarnessAccount: record('addHarnessAccount'),
    chooseAccount: (a: any) => calls.push(['chooseAccount', a.id]),
    verifyAccount: (a: any) => calls.push(['verifyAccount', a.id]),
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs });
mock.module('../src/components/accounts/menu.tsx', {
  namedExports: {
    AccountChoices: ({ h: harness }: any) => h('div', { 'data-choices': harness }),
    manageAccounts: record('manageAccounts'),
  },
});
mock.module('../src/components/harnessPicker/HarnessPicker.tsx', { namedExports: { signInHarness: record('signInHarness') } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Group: settingsStubs.Group } });
// the state labels are the real ones (harness/accountView.ts is pure)
mock.module('../src/components/harness/parts.tsx', { namedExports: { PARTS: { codex: parts, claude: parts } } });
let warning: string | null = null;
mock.module('../src/harness/registry.ts', { namedExports: { harnessInfo: (id: string) => ({ versions: { id } }) } });
mock.module('../src/harness/compat.ts', {
  namedExports: {
    versionWarning: (v: any, version: string | null) => (v && version ? warning : null),
  },
});
// the versions are read again when the page opens (src/harness/harnessUpdates.ts is tested on its own)
let versionChecks = 0;
let update: any = null;
mock.module('../src/harness/harnessUpdates.ts', {
  namedExports: { checkHarnessUpdates: async () => void (versionChecks += 1), useVersionOf: () => update },
});
// the version line's own behavior is in tests/harnessVersionLine.test.ts; here only where it sits
mock.module('../src/components/harness/HarnessVersionLine.tsx', {
  namedExports: {
    HarnessVersionLine: ({ kind, label, binary }: any) =>
      h('i', { 'data-version-of': kind, 'data-label': label, 'data-binary': JSON.stringify(binary) }),
  },
});
const { HarnessHeader, AccountCard } = await import('../src/components/harness/Overview.tsx');

const acct = (p: any = {}) => ({
  id: 'a',
  harness: 'codex',
  email: 'a@example.com',
  plan: 'Team',
  kind: 'subscription',
  status: 'ok',
  left: 70,
  limited: null,
  usage: { windows: [], source: 'polled', at: null },
  ...p,
});
const text = (el: Element | null | undefined) => el?.textContent ?? '';

beforeEach(() => {
  calls.length = 0;
  delete parts.CardAction;
});

test('the header names the harness once, with its state, its version line, last error and its own buttons', async () => {
  status = { state: 'ready', version: '2.1.296', bin: '/u/claude' };
  // the click handler records no event: a failed comparison would otherwise print the whole DOM
  parts.CardAction = () => h('button', { onClick: () => calls.push(['recheck']) }, 'Re-check');
  versionChecks = 0;
  const r = await mount(h(HarnessHeader, { h: 'claude' }));
  assert.equal(text(r.host.querySelector('h1')), 'Claude Code');
  assert.equal(versionChecks, 1, 'the page reads the versions when it opens');
  assert.equal(r.host.querySelector('[data-mark]')?.getAttribute('data-mark'), '28');
  // the state, with no tested / not yet tested badge; the version on hover, and its version line with any update
  assert.equal(text(r.host.querySelector('.harness-head-meta')), 'Ready');
  assert.equal(r.host.querySelector('.harness-head-meta')!.getAttribute('title'), 'Version 2.1.296');
  const line = r.host.querySelector('.harness-head-text > [data-version-of]')!;
  assert.deepEqual([line.getAttribute('data-version-of'), line.getAttribute('data-label')], ['claude', 'Claude Code']);
  // the binary the harness's Version row names, so both say the same words
  assert.deepEqual(JSON.parse(line.getAttribute('data-binary')!), { bin: '/u/claude', manual: 'set-path' });
  assert.ok(r.host.querySelector('.harness-dot.ok'));
  assert.equal(!!r.host.querySelector('.harness-head-error'), false);
  await click(byText(r.host, 'button', 'Re-check'));
  assert.deepEqual(calls, [['recheck']]);
  delete parts.CardAction;
  status = { state: 'error', version: null, error: 'it broke\nmore detail' };
  await r.render(h(HarnessHeader, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.harness-head-meta')), 'Error');
  assert.equal(r.host.querySelector('.harness-head-meta')!.hasAttribute('title'), false);
  assert.equal(text(r.host.querySelector('.harness-head-error')), 'it broke');
  assert.equal(!!r.host.querySelector('button'), false);
  await r.unmount();
});

test('not installed, still checking, not signed in or broken: says which, and offers sign-in only when signed out', async () => {
  status = { state: 'missing' };
  view = { active: null, accounts: [], multi: true };
  const r = await mount(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'Not installed');
  assert.equal(text(r.host.querySelector('.acct-card-sub')), 'Install it first.');
  assert.equal(!!r.host.querySelector('button'), false);
  // uninstalled with a login still on record: the card says it is not installed, not who it would run as
  view = {
    active: {
      id: 'a',
      harness: 'codex',
      email: 'a@x.com',
      plan: 'Pro',
      kind: 'subscription',
      status: 'ok',
      left: 50,
      limited: null,
      usage: { windows: [] },
    },
    accounts: [],
    multi: true,
  };
  await r.render(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'Not installed');
  view = { active: null, accounts: [], multi: true };
  status = { state: 'signin' };
  await r.render(h(AccountCard, { h: 'claude' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'Not signed in');
  assert.equal(!!r.host.querySelector('.acct-card-sub'), false);
  await click(byText(r.host, 'button', 'Sign in'));
  assert.deepEqual(calls, [['signInHarness', 'claude']]);
  // detecting or broken with no account yet is not "signed out": no sign-in offered
  for (const [state, label] of [
    ['detecting', 'Checking…'],
    ['error', 'No account yet'],
  ]) {
    status = { state };
    await r.render(h(AccountCard, { h: 'claude' }));
    assert.equal(text(r.host.querySelector('.acct-card-name')), label);
    assert.equal(!!r.host.querySelector('button'), false);
  }
  await r.unmount();
});

test('several accounts: the one in use, its usage per window, Switch opening the shared menu, and the way to manage them', async () => {
  status = { state: 'ready' };
  const windows = [
    { label: '5h', usedPercent: 1, resetsAt: null, resetsText: '3:40pm' },
    { label: 'Weekly', usedPercent: 0, resetsAt: null },
  ];
  const a = acct({ usage: { windows, source: 'parsed', at: 1 } });
  const b = acct({ id: 'b', email: 'b@example.com' });
  view = { active: a, accounts: [a, b], multi: true };
  const r = await mount(h(AccountCard, { h: 'claude' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'a@example.com');
  assert.equal(text(r.host.querySelector('.acct-card-sub')), 'Team');
  assert.deepEqual([...r.host.querySelectorAll('.limit-meta')].map(text), ['5h99% left', 'Weekly100% left']);
  assert.equal(text(r.host.querySelector('.limit-reset')), 'Resets 3:40pm');
  assert.equal(text(r.host.querySelector('.acct-card-foot span')), '2 accounts');
  assert.equal(!!r.host.querySelector('[role=menu]'), false);
  const sw = byText(r.host, 'button', 'Switch')!;
  assert.equal(sw.getAttribute('aria-expanded'), 'false');
  await click(sw);
  assert.equal(sw.getAttribute('aria-expanded'), 'true');
  const menu = r.host.querySelector('[role=menu]')!;
  assert.equal(menu.getAttribute('data-placement'), 'bottom-end');
  assert.equal(menu.querySelector('[data-choices]')?.getAttribute('data-choices'), 'claude');
  await click(byText(menu, 'button', 'Manage accounts…'));
  assert.deepEqual(calls.at(-1), ['manageAccounts', 'claude', 'a']);
  await click(byText(r.host, 'button', 'Manage accounts'));
  assert.deepEqual(calls.at(-1), ['manageAccounts', 'claude', 'a']);
  await r.unmount();
});

test('one account: Add account instead of Switch; a key or credits say how they bill; no reading says when it comes', async () => {
  status = { state: 'ready' };
  const key = acct({ kind: 'apiKey', plan: 'API key', left: null });
  view = { active: key, accounts: [key], multi: true };
  const r = await mount(h(AccountCard, { h: 'codex' }));
  assert.equal(!!byText(r.host, 'button', /Switch/), false);
  await click(byText(r.host, 'button', 'Add account'));
  assert.deepEqual(calls, [['addHarnessAccount', 'codex']]);
  assert.equal(text(r.host.querySelector('.acct-card-note')), 'Billed per token');
  assert.equal(text(r.host.querySelector('.acct-card-foot span')), '1 account');
  const plain = acct();
  view = { active: plain, accounts: [plain], multi: true };
  await r.render(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-note')), 'Shown after the first turn');
  assert.equal(!!r.host.querySelector('.acct-limits'), false);
  await r.unmount();
});

test('a lapsed login says so and signs in again; an account left out of the list keeps its own avatar', async () => {
  status = { state: 'signin' };
  const lapsed = acct({ status: 'expired', plan: null });
  const other = acct({ id: 'b', email: 'b@example.com' });
  view = { active: lapsed, accounts: [lapsed, other], multi: true };
  const r = await mount(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-sub')), 'Sign-in expired');
  assert.ok(r.host.querySelector('.acct-card-sub.warn'));
  assert.equal(!!r.host.querySelector('.acct-card-note'), false);
  await click(byText(r.host, 'button', 'Sign in again'));
  assert.deepEqual(calls, [['chooseAccount', 'a']]);
  assert.ok(byText(r.host, 'button', /Switch/));
  // the MoPilot credits account is not in the account list
  const credits = acct({ id: 'm', email: null, plan: 'MoPilot credits', kind: 'apiKey', left: null });
  status = { state: 'ready' };
  view = { active: credits, accounts: [credits], multi: true };
  await r.render(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'MoPilot credits');
  // the plan is not repeated when it is the name
  assert.equal(text(r.host.querySelector('.acct-card-sub')), '');
  assert.equal(text(r.host.querySelector('.profile-avatar')), 'API');
  // the account in use counts though the switcher does not list it
  assert.equal(text(r.host.querySelector('.acct-card-foot span')), '1 account');
  await r.unmount();
});

test('the header warns only when the installed version will not work', async () => {
  status = { state: 'ready', version: '0.1' };
  warning = 'Older than the oldest version MoPilot works with';
  const r = await mount(h(HarnessHeader, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.harness-head-warn')), 'Older than the oldest version MoPilot works with');
  warning = null;
  await r.render(h(HarnessHeader, { h: 'claude' }));
  assert.equal(!!r.host.querySelector('.harness-head-warn'), false);
  await r.unmount();
});

test('a too-old version says so once: the error it starts with is not repeated beside the warning (#3518)', async () => {
  status = { state: 'error', version: '0.147.0', error: "Codex 0.147.0 doesn't work with this version of MoPilot" };
  warning = 'Version 0.147.0 is too old for MoPilot.';
  const r = await mount(h(HarnessHeader, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.harness-head-warn')), 'Version 0.147.0 is too old for MoPilot.');
  assert.equal(r.host.querySelector('.harness-head-error'), null);
  // while its update runs, that is the state, with no error or warning beside it
  update = { state: 'updating' };
  await r.render(h(HarnessHeader, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.harness-head-meta')), 'Updating');
  assert.equal(r.host.querySelector('.harness-head-warn'), null);
  assert.equal(r.host.querySelector('.harness-head-error'), null);
  // one waiting for chats hasn't started: the harness reads as it is
  update = { state: 'waiting' };
  await r.render(h(HarnessHeader, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.harness-head-warn')), 'Version 0.147.0 is too old for MoPilot.');
  update = null;
  warning = null;
  await r.unmount();
});

test('a login whose account another app renamed is named as the CLI login, with a question mark and a way to confirm it', async () => {
  status = { state: 'ready' };
  const doubted = acct({ id: 'default', harness: 'claude', email: 'dz@example.com', plan: 'Claude Max 20×', unverified: true });
  view = { active: doubted, accounts: [doubted], multi: true };
  const r = await mount(h(AccountCard, { h: 'claude' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'Claude Code login');
  assert.equal(text(r.host.querySelector('.profile-avatar')), '?');
  assert.match(text(r.host.querySelector('.acct-card-sub')), /^Claude Max 20× · Account unverified · /);
  assert.ok(r.host.querySelector('.acct-card-sub.warn'));
  assert.equal(r.host.textContent?.includes('dz@example.com'), false);
  await click(byText(r.host, 'button', 'Sign in again to confirm'));
  assert.deepEqual(calls, [['verifyAccount', 'default']]);
  await r.unmount();
});

test('a harness left for first use says it starts on first use, not "Checking…"', async () => {
  status = { state: 'detecting', idle: true, version: null };
  view = { active: null, accounts: [] };
  const r = await mount(h(HarnessHeader, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.harness-head-meta')), 'Starts on first use');
  await r.render(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'Starts on first use');
  assert.equal(text(r.host.querySelector('.acct-card-sub')), 'Nothing runs until your first chat with it');
  // one being looked for is still "Checking…"
  status = { state: 'detecting', version: null };
  await r.render(h(AccountCard, { h: 'codex' }));
  assert.equal(text(r.host.querySelector('.acct-card-name')), 'Checking…');
  assert.equal(r.host.querySelector('.acct-card-sub'), null);
  await r.unmount();
});

test('a sign-in the card started runs in the card, with or without an account', async () => {
  parts.LoginTerm = () => h('div', { className: 'login-term' }, 'claude auth login');
  try {
    status = { state: 'signin', version: null };
    view = { active: null, accounts: [] };
    const r = await mount(h(AccountCard, { h: 'claude' }));
    assert.equal(text(r.host.querySelector('.acct-card .login-term')), 'claude auth login');
    status = { state: 'signin', version: null };
    const a = acct({ status: 'signin' });
    view = { active: a, accounts: [a] };
    await r.render(h(AccountCard, { h: 'claude' }));
    assert.equal(text(r.host.querySelector('.acct-card .login-term')), 'claude auth login');
    await r.unmount();
  } finally {
    delete parts.LoginTerm;
  }
});
