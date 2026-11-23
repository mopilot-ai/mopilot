// The sidebar's account footer (src/components/sidebar/SidebarFooter.tsx): the account button, its warning and the
// profile menu, with its store, account, MoPilot and native dependencies replaced.
import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { defaultHarnessExports } from './support/default-harness-fakes.ts';
import { createElement, act } from 'react';
import { fakeStore, popoverExports, render, click, byText, maybeText } from './support/shell-chrome-kit.ts';
import { OPEN_BUG_REPORT, type BugReportRequest } from '../src/lib/bugReportEvent.ts';
import { appCss, resolveTypeScale } from './support/app-css.ts';

let phoneState: unknown = { visible: false };
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore<any>({ route: { name: 'home' }, prefs: {}, unread: {}, harness: 'codex' });
const calls: any[] = [];
// Observe the production event so the footer and Help tests exercise the real report entrypoint.
const recordBugReport = (event: Event) => calls.push(['bug', (event as CustomEvent<BugReportRequest>).detail.threadId]);
window.addEventListener(OPEN_BUG_REPORT, recordBugReport);
after(() => window.removeEventListener(OPEN_BUG_REPORT, recordBugReport));
let pendingSwitch = false;
let ownAccount: any = null;
let accounts: Record<string, { accounts: any[]; active: any }> = {};
let mp: any = { signedIn: false };
let signInResult: any = { ok: true };
const navigate = (route: any) => store.setState({ route });

stubStore({
  useStore: store.useStore,
  navigate,
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  ...defaultHarnessExports(store.getState, () => {}),
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: (id: string | null) => (calls.push(['session', id]), { pendingSwitch }),
    useSessionField: (id: any, pick: any) =>
      pick((((id: string | null) => (calls.push(['session', id]), { pendingSwitch })) as (id: any) => any)(id)),
  },
});
mock.module('../src/components/harnessPicker/HarnessPicker.tsx', {
  namedExports: { HarnessIcon: ({ h }: any) => createElement('i', { 'data-harness': h }) },
});
mock.module('../src/components/accounts/Accounts.tsx', {
  namedExports: {
    HarnessAccountsMenu: ({ h }: any) => createElement('div', { 'data-accounts': h }),
    BasicHarnessMenuRow: ({ b }: any) => createElement('div', { 'data-basic': b.id }, b.line),
    avatarColor: (e: string) => `rgb(${e.length}, 0, 0)`,
    initialsOf: (e?: string) => (e ? e[0].toUpperCase() : '?'),
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
installNativeStub({
  mopilot: { signIn: async () => (calls.push(['signIn']), signInResult) },
  remoteSettings: { state: async () => phoneState },
  win: { mini: () => calls.push(['mini']) },
});
mock.module('../src/session/open.ts', {
  namedExports: {
    openLink: (u: string) => calls.push(['openLink', u]),
    openMoPilotPage: (p: string) => calls.push(['openMoPilotPage', p]),
  },
});
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    composerHarness: (_id: string | null, s: any) => s.harness,
    useHarnessAccounts: (h: string) => accounts[h] ?? { accounts: [], active: null },
    useChatAccount: (_h: string, id: string | null) => (id ? ownAccount : null),
  },
});
// the account view (harness/accountView.ts) reads the real wording; only the attention rule is the test's
const realAccounts = await import('../src/harness/accounts.ts');
mock.module('../src/harness/accounts.ts', {
  namedExports: {
    ...realAccounts,
    accountName: (a: any) => a.email ?? 'Signed-in account',
    needsAttention: (a: any) => !!a.broken,
    // the summary's own rules are tests/profileSummary.test.ts's; here, the plans of the accounts in use
    profileSummary: (hs: any[]) => hs.flatMap((h) => (h.active?.plan ? [h.active.plan] : [])).join(' · ') || null,
  },
});
mock.module('../src/components/sidebar/SidebarUpdate.tsx', {
  namedExports: { SidebarUpdate: () => createElement('i', { 'data-sidebar-update': '' }) },
});
// Computer History's row has its own test (computerHistorySettingsUI.test.ts)
mock.module('../src/components/sidebar/SidebarHistory.tsx', { namedExports: { SidebarHistory: () => null } });
mock.module('../src/lib/mopilot.ts', { namedExports: { formatCredits: (m: number) => `$${m / 1e6}`, useMoPilot: () => mp } });

const { SidebarFooter } = await import('../src/components/sidebar/SidebarFooter.tsx');
const { native } = await import('../src/lib/native.ts');

const reset = (state: any = {}) => {
  store.reset({ route: { name: 'home' }, prefs: {}, unread: {}, harness: 'codex', basicHarnesses: [], ...state });
  calls.length = 0;
  pendingSwitch = false;
  ownAccount = null;
  accounts = {};
  mp = { signedIn: false };
  signInResult = { ok: true };
};
const button = (host: Element) => host.querySelector('[aria-label="Open profile menu"]') as HTMLElement;
const avatar = (host: Element) => host.querySelector('.account-avatar') as HTMLElement;
const name = (host: Element) => button(host).querySelector('.side-row-label')!.textContent;

test('the account control stays compact beside the bug report and exposes its menu state', async () => {
  reset({ systemUsername: 'A very long profile name' });
  accounts = { claude: { accounts: [], active: { plan: 'Max' } } };
  const sheet = document.createElement('style');
  sheet.textContent = resolveTypeScale(appCss());
  document.head.append(sheet);
  const { host, unmount } = await render(createElement(SidebarFooter));
  try {
    const profile = button(host);
    assert.equal(getComputedStyle(profile).flexGrow, '0', 'hover target must not fill the sidebar');
    assert.equal(getComputedStyle(profile).width, 'auto');
    assert.equal(getComputedStyle(profile).height, '32px');
    assert.equal(getComputedStyle(host.querySelector('.account-btn-text')!).flexDirection, 'row');
    assert.equal(getComputedStyle(host.querySelector('.account-btn-meta')!).textOverflow, 'ellipsis');
    assert.equal(profile.getAttribute('aria-haspopup'), 'menu');
    assert.equal(profile.getAttribute('aria-expanded'), 'false');
    assert.ok(profile.querySelector('.account-chevron'));
    await click(profile);
    assert.equal(profile.getAttribute('aria-expanded'), 'true');
    assert.ok(host.querySelector('[role=menu]'));
    assert.equal(getComputedStyle(profile).height, '32px');
    await click(host.querySelector('[data-menu-close]'));
    assert.equal(profile.getAttribute('aria-expanded'), 'false');
  } finally {
    await unmount();
    sheet.remove();
  }
});

test('the update row sits directly above the account button, which names the profile', async () => {
  reset();
  const { host, unmount } = await render(createElement(SidebarFooter));
  try {
    const footer = host.querySelector('.sidebar-footer')!;
    const update = footer.querySelector('[data-sidebar-update]')!;
    assert.ok(update);
    assert.equal(update.compareDocumentPosition(button(host)) & 4, 4, 'the account button follows the update row');
    assert.equal(button(host).querySelector('.side-row-label')!.textContent, 'N/A');
  } finally {
    await unmount();
  }
});

test('without MoPilot or system identity the avatar shows N/A without a harness badge', async () => {
  reset();
  const { host, unmount } = await render(createElement(SidebarFooter));
  assert.equal(avatar(host).textContent, 'N/A');
  assert.equal(avatar(host).getAttribute('style'), null);
  assert.equal(name(host), 'N/A');
  assert.equal(host.querySelector('.account-btn-meta'), null, 'no accounts: no second line');
  assert.equal(avatar(host).querySelector('[data-harness]'), null);
  assert.equal(host.querySelector('.account-avatar-warn'), null);
  assert.equal(calls.filter((c) => c[0] === 'session').length, 0);
  await unmount();
});

test('system identity remains stable across chats and harness switches', async () => {
  reset({ systemUsername: 'binwang', route: { name: 'thread', id: 'claude:7' }, harness: 'claude' });
  ownAccount = { id: 'b' };
  accounts = {
    claude: { accounts: [{ id: 'b', email: 'bob@x.dev' }], active: { id: 'b', email: 'bob@x.dev', plan: 'Max' } },
    codex: { accounts: [{ id: 'c', broken: true }], active: null },
  };
  const { host, unmount } = await render(createElement(SidebarFooter));
  assert.equal(avatar(host).firstChild!.textContent, 'BI');
  assert.equal(name(host), 'binwang');
  assert.equal(host.querySelector('.account-btn-meta')!.textContent, 'Max', 'the plans in use under the name');
  assert.ok(host.querySelector('.account-avatar-warn'));
  await act(async () => store.setState({ harness: 'codex', route: { name: 'home' } }));
  assert.equal(avatar(host).firstChild!.textContent, 'BI');
  await unmount();
});

test('installed basic harnesses get a row in the profile menu, and one asking for a sign-in marks the avatar', async () => {
  const basic = (id: string, state: string) => ({
    id,
    label: id,
    state,
    reason: null,
    bin: null,
    version: null,
    authMethods: [],
    login: null,
  });
  reset({ basicHarnesses: [basic('opencode', 'admitted'), basic('gemini', 'missing')] });
  const { host, unmount } = await render(createElement(SidebarFooter));
  await click(button(host));
  // a harness that is not installed gets no row
  assert.deepEqual(
    [...host.querySelectorAll('[data-basic]')].map((e) => e.getAttribute('data-basic')),
    ['opencode'],
  );
  assert.equal(!!host.querySelector('.account-avatar-warn'), false);
  // signed out but never picked for new chats: nothing asks for attention
  await act(async () => store.setState({ basicHarnesses: [basic('opencode', 'signin')] }));
  assert.equal(!!host.querySelector('.account-avatar-warn'), false);
  // the one new chats use, signed out: it does
  await act(async () => store.setState({ prefs: { defaultHarness: 'acp:opencode' } }));
  assert.equal(!!host.querySelector('.account-avatar-warn'), true);
  await unmount();
});

test('MoPilot profile name is shown in the avatar and menu when signed in', async () => {
  reset({ systemUsername: 'system-user' });
  mp = { signedIn: true, user: { name: 'Jane Smith', email: 'jane@mopilot.dev' }, balanceMicros: 0 };
  const { host, unmount } = await render(createElement(SidebarFooter));
  assert.equal(avatar(host).firstChild!.textContent, 'JS');
  assert.equal(name(host), 'Jane Smith');
  assert.ok(avatar(host).classList.contains('colored'));
  assert.match(avatar(host).getAttribute('style')!, /background:/);
  await click(button(host));
  assert.ok(host.textContent!.includes('Jane Smith'));
  await unmount();
});

test('a build without the MoPilot service offers neither its sign-in nor its credits in the profile menu', async () => {
  reset();
  (native as any).mopilotService = false;
  try {
    const { host, unmount } = await render(createElement(SidebarFooter));
    await click(button(host));
    assert.equal(maybeCredits(host), null);
    assert.equal(host.textContent!.includes('Sign in to MoPilot'), false);
    assert.equal(host.textContent!.includes('Buy credits'), false);
    await unmount();
  } finally {
    delete (native as any).mopilotService;
  }
});

test('the profile menu, signed out of MoPilot: sign in reports a failure with an error, and stays quiet otherwise', async () => {
  reset();
  const { host, unmount } = await render(createElement(SidebarFooter));
  assert.equal(host.querySelector('[role=menu]'), null);
  await click(button(host));
  const menu = host.querySelector('[role=menu]')!;
  assert.equal(menu.getAttribute('data-placement'), 'top-start');
  assert.equal(button(host).classList.contains('menu-open'), true);
  assert.deepEqual(
    [...menu.querySelectorAll('[data-accounts]')].map((e) => e.getAttribute('data-accounts')),
    ['codex', 'claude'],
  );
  assert.equal(maybeCredits(host), null);
  const signIn = byText(host, 'Sign in to MoPilot');
  assert.equal(signIn.querySelector('.menu-desc'), null);
  for (const [result, toasts] of [
    [{ ok: true }, []],
    [{ ok: false }, []],
    [{ ok: false, error: 'denied' }, [['toast', 'denied', 'error']]],
  ] as const) {
    signInResult = result;
    calls.length = 0;
    await click(byText(host, 'Sign in to MoPilot'));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'signIn'),
      [['signIn']],
    );
    assert.deepEqual(
      calls.filter((c) => c[0] === 'toast'),
      toasts,
    );
  }
  mp = { signedIn: false, signingIn: true };
  await click(host.querySelector('[data-menu-close]'));
  await click(button(host));
  assert.equal(byText(host, 'Sign in to MoPilot').querySelector('.menu-desc')!.textContent, 'Finish in your browser…');
  await unmount();
});

const maybeCredits = (host: Element) =>
  [...host.querySelectorAll('[role=menuitem]')].find((e) => e.textContent!.startsWith('Credits')) ?? null;

test('the profile menu, signed in: credits, buy credits, and every settings, quick chat and help entry', async () => {
  reset({ prefs: { miniShortcut: true } });
  mp = { signedIn: true, user: { email: 'me@mopilot.dev' }, balanceMicros: 2_500_000 };
  const { host, unmount } = await render(createElement(SidebarFooter));
  await click(button(host));
  const credits = maybeCredits(host)!;
  // the credits view's balance, as Settings and the billing rows show it
  assert.equal(credits.getAttribute('data-shortcut'), '$2.50');
  assert.equal(credits.querySelector('.menu-desc')!.textContent, 'me@mopilot.dev');
  assert.equal(maybeText(host, 'Sign in to MoPilot'), null);
  await click(credits);
  assert.deepEqual(store.getState().route, { name: 'settings', section: 'mopilot' });
  await click(byText(host, 'Buy credits'));
  assert.deepEqual(calls.at(-1), ['openMoPilotPage', '/credits']);
  assert.equal(byText(host, 'Open Quick Chat').getAttribute('data-shortcut'), '⌥Space');
  await click(byText(host, 'Open Quick Chat'));
  assert.deepEqual(calls.at(-1), ['mini']);
  for (const [label, route] of [
    ['Accounts & billing', { name: 'settings', section: 'accounts' }],
    ['Settings', { name: 'settings' }],
    ['Keyboard shortcuts', { name: 'settings', section: 'shortcuts' }],
  ] as const) {
    await click(byText(host, label));
    assert.deepEqual(store.getState().route, route);
  }
  // one way to accounts and one to Settings; the harness pages are a click away in Settings
  assert.equal(maybeText(host, 'Manage harnesses'), null);
  assert.equal(maybeText(host, 'Usage & billing'), null);
  const help = host.querySelector('[data-submenu="Help"]')!;
  assert.ok(help);
  assert.deepEqual(
    [...help.querySelectorAll('[role=menuitem]')].map((item) => item.textContent),
    ['Keyboard shortcuts', 'Report a bug'],
  );
  // Help's report goes to MoPilot on every harness, as the footer button does, not to one harness's tracker
  await click(byText(host, 'Report a bug'));
  assert.deepEqual(calls.at(-1), ['bug', null]);
  assert.equal(maybeText(host, 'Report an issue'), null);
  // signed in without a known user: no description; no Quick Chat shortcut without the pref
  mp = { signedIn: true, balanceMicros: 0 };
  await act(async () => store.setState({ prefs: {} }));
  assert.equal(maybeCredits(host)!.querySelector('.menu-desc')!.textContent, '');
  assert.equal(byText(host, 'Open Quick Chat').getAttribute('data-shortcut'), null);
  await unmount();
});

test('Report a bug sits beside the account button and reports on the chat on screen, or on none', async () => {
  reset();
  const { host, unmount } = await render(createElement(SidebarFooter));
  try {
    const profile = button(host);
    const bug = host.querySelector<HTMLButtonElement>('button[aria-label="Report a bug"]');
    assert.ok(bug, 'the signed-out footer has a direct bug-report button');
    assert.equal(bug.type, 'button');
    assert.equal(bug.tabIndex, 0);
    assert.equal(profile.contains(bug), false);
    assert.equal(bug.closest('.account-row'), profile.parentElement, 'one row with the account button');
    assert.equal(profile.compareDocumentPosition(bug) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(profile.querySelector('.account-chevron'), 'the chevron identifies the account menu');
    await click(bug);
    assert.deepEqual(calls.at(-1), ['bug', null]);
    assert.equal(host.querySelector('[role=menu]'), null, 'it does not open the profile menu');
    await act(async () => store.setState({ route: { name: 'thread', id: 'claude:7' } }));
    await click(bug);
    assert.deepEqual(calls.at(-1), ['bug', 'claude:7']);
    await click(profile);
    assert.ok(host.querySelector('[role=menu]'), 'the account menu still opens independently');
    assert.equal(maybeText(host, 'Report an issue'), null);
  } finally {
    await unmount();
  }
});

test('Report a bug opens the existing report flow for the current chat on every harness, or no chat on other pages', async () => {
  reset();
  const requests: BugReportRequest[] = [];
  const onReport = (event: Event) => requests.push((event as CustomEvent<BugReportRequest>).detail);
  window.addEventListener(OPEN_BUG_REPORT, onReport);
  const { host, unmount } = await render(createElement(SidebarFooter));
  try {
    const cases = [
      { route: { name: 'home' }, harness: 'codex', threadId: null },
      { route: { name: 'thread', id: 'codex-chat' }, harness: 'codex', threadId: 'codex-chat' },
      { route: { name: 'thread', id: 'claude:7' }, harness: 'claude', threadId: 'claude:7' },
      { route: { name: 'thread', id: 'acp:opencode:8' }, harness: 'acp:opencode', threadId: 'acp:opencode:8' },
      { route: { name: 'settings' }, harness: 'acp:opencode', threadId: null },
    ];
    for (const [index, { route, harness, threadId }] of cases.entries()) {
      await act(async () => store.setState({ route, harness }));
      await click(host.querySelector('button[aria-label="Report a bug"]'));
      assert.equal(requests.length, index + 1, 'each click opens one report');
      assert.deepEqual(requests.at(-1), { threadId });
      assert.equal(host.querySelector('[role=menu]'), null, 'reporting never opens the account menu');
    }
    assert.deepEqual(
      calls.filter((call) => call[0] === 'openLink'),
      [],
      'reporting stays in MoPilot',
    );
  } finally {
    window.removeEventListener(OPEN_BUG_REPORT, onReport);
    await unmount();
  }
});

test('the profile menu offers Connect your phone only to an account with Mobile Remote', async () => {
  const { isConnectPhoneOpen, closeConnectPhone } = await import('../src/lib/phoneEntry.ts');
  reset({});
  const closed = await render(createElement(SidebarFooter));
  await click(button(closed.host));
  assert.equal(maybeText(closed.host, 'Connect your phone…'), null);
  await closed.unmount();
  phoneState = { visible: true, devices: [] };
  const { host, unmount } = await render(createElement(SidebarFooter));
  await act(async () => void (await Promise.resolve()));
  await click(button(host));
  await click(byText(host, 'Connect your phone…'));
  assert.equal(isConnectPhoneOpen(), true);
  closeConnectPhone();
  phoneState = { visible: false };
  await unmount();
});
