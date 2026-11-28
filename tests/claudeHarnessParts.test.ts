import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, flush, settingsStubs, fakeStore, rows, byText, iconStubs } from './support/harness-ui-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (calls.push([name, ...a]), ret);
const store = fakeStore<any>({
  prefs: { claudeBin: null },
  claude: { status: { state: 'ready' } },
  claudeAccounts: { accounts: [], active: 'acc-1', autoSwitch: true },
  claudeChats: { c: 1 },
  route: { name: 'home' },
});
let status: any = { state: 'ready' };
let ck: any = null;
let mp: any = { signedIn: true, balanceMicros: 5_000_000, user: { email: 'me@x' } };
let signedOut: any = null;
let composer = 'claude';
let billing: any;
let artifactsRead: () => Promise<any> = async () => ({ on: true, killed: false });
let artifactsSet: (on: boolean) => Promise<any> = async (on) => ({ on, killed: false });
let remoteRead: () => Promise<boolean> = async () => false;
let remoteSet: (on: boolean) => Promise<boolean> = async (on) => on;
stubStore({ getState: store.get, navigate: rec('navigate'), setPrefs: rec('setPrefs'), useStore: store.useStore });
installNativeStub({
  routing: {
    providers: async () => ({ providers: [], keys: 'ok' }),
    configs: async () => ({
      configs: [{ id: 'c1', name: 'Work', provider: 'openai', model: 'm', tierModels: {}, fallbacks: [] }],
      invalid: 0,
      state: 'ok',
    }),
    onChanged: () => () => {},
  },
  claude: {
    setAuthMode: rec('setAuthMode'),
    setApiKey: rec('setApiKey'),
    clearApiKey: rec('clearApiKey'),
    setCloudEnv: rec('setCloudEnv'),
    artifacts: () => artifactsRead(),
    setArtifacts: (on: boolean) => (calls.push(['setArtifacts', on]), artifactsSet(on)),
    remoteControlDefault: () => remoteRead(),
    setRemoteControlDefault: (on: boolean) => (calls.push(['setRemoteControlDefault', on]), remoteSet(on)),
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: rec('open') } });
mock.module('../src/lib/mopilot.ts', { namedExports: { formatCredits: (m: number) => `$${m}`, useMoPilot: () => mp } });
mock.module('../src/session/harness/claude.ts', {
  namedExports: {
    detectClaude: rec('detect'),
    pinClaudeChat: rec('pin'),
    recheckClaude: rec('recheck'),
    refreshClaudeAccounts: rec('refreshAccounts', Promise.resolve()),
    refreshClaudeUsage: rec('refreshUsage'),
    reloginClaudeAccount: rec('relogin'),
    setClaudeAutoSwitch: rec('autoSwitch'),
    switchClaudeAccount: rec('switch'),
  },
});
mock.module('../src/session/harness/billing.ts', {
  namedExports: {
    applyClaudeKey: (fn: () => any) => (calls.push(['apply']), fn()),
    useClaudeKey: () => ck,
    payWithMoPilotCredits: rec('payCredits'),
  },
});
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    composerHarness: () => composer,
    composerFamily: () => composer,
    useComposerFamily: (id: string | null) => (rec('useComposerFamily')(id), composer),
    useHarnessStatus: () => status,
  },
});
// the credits line is the account view's (harness/accountView.ts): its wording is real
const realAccounts = await import('../src/harness/accounts.ts');
mock.module('../src/harness/accounts.ts', {
  namedExports: {
    ...realAccounts,
    claudeSignedOut: (...a: any[]) => (calls.push(['signedOut', a[3]]), signedOut),
    signInAccountFor: (chats: any, pool: any, id: string) => `for-${id}`,
  },
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: rec('useSession'),
    useSessionField: (id: any, pick: any) => pick(rec('useSession')(id)),
  },
});
mock.module('../src/components/ui/icons.tsx', { namedExports: iconStubs() });
mock.module('../src/components/pages/settings/BillingRow.tsx', {
  namedExports: {
    BillingRow: (p: any) => ((billing = p), h('div', { id: 'billing' }, p.desc)),
    endpointLabel: (u: string | undefined, own: string) => u ?? own,
  },
});
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsStubs });
// the version row itself is tests/harnessVersionRow.test.ts': here, what Claude Code hands it
let versionRow: any = null;
mock.module('../src/components/harness/HarnessVersionRow.tsx', {
  namedExports: {
    HarnessVersionRow: (p: any) => ((versionRow = p), h('div', { className: 'row' }, h('b', null, 'Version'))),
  },
});
mock.module('../src/components/harness/claude/Customize.tsx', { namedExports: { ClaudeCustomize: () => null } });
const { claudeParts, ClaudeAdvanced, ClaudeRows: Rows } = await import('../src/components/harness/claude/parts.tsx');
const { native } = await import('../src/lib/native.ts');
const P = claudeParts as any;
// useBilling as the Pay with row and the accounts list read it
const BillingView = () => ((billing = P.useBilling()), h('div', { id: 'billing' }, billing.desc));

test('the static parts and the mark', async () => {
  assert.equal(P.signInLabel, 'Sign in');
  assert.equal(P.addsAccountDirectly, true);
  assert.equal(P.refreshUsage, (await import('../src/session/harness/claude.ts')).refreshClaudeUsage);
  const r = await mount(h(P.Icon, { size: 20 }));
  assert.equal(r.host.querySelector('svg')?.getAttribute('width'), '20');
  assert.equal(r.host.querySelector('svg')?.getAttribute('aria-label'), 'Claude Code');
  await r.unmount();
});

test('sign in re-logs the login new chats use, or the one a chat is pinned to', () => {
  calls.length = 0;
  P.signIn();
  P.signIn('chat-9');
  assert.deepEqual(calls, [
    ['relogin', 'acc-1'],
    ['relogin', 'for-chat-9'],
  ]);
});

test('Your own provider: offered where the router runs, with the saved configs, described by the config chosen', async () => {
  ck = { mode: 'subscription', set: false, routed: { available: false, configId: null, name: null } };
  const r = await mount(h(BillingView));
  const desc = () => r.host.querySelector('#billing')?.textContent;
  assert.equal(billing.routed, undefined, 'not where this app has no router');
  ck = { mode: 'routed', set: false, routed: { available: true, configId: 'c1', name: 'Work' } };
  await r.render(h(BillingView));
  await flush(3);
  await r.render(h(BillingView));
  assert.deepEqual(billing.routed.configs, [{ id: 'c1', name: 'Work' }]);
  assert.equal(billing.routed.configId, 'c1');
  assert.equal(desc(), 'Work · your own provider, billed per token · chats on your other machines keep their own sign-in');
  calls.length = 0;
  await billing.routed.onChoose('c1');
  assert.deepEqual(calls, [['apply'], ['setAuthMode', 'routed', 'c1']]);
  ck = { mode: 'routed', set: false, routed: { available: true, configId: 'c1', name: null } };
  await r.render(h(BillingView));
  assert.equal(desc(), 'The model config chosen here was removed. Choose another.');
  ck = null;
  await r.unmount();
});

test('billing describes each mode and routes its actions through applyClaudeKey', async () => {
  const r = await mount(h(BillingView));
  const desc = () => r.host.querySelector('#billing')?.textContent;
  assert.equal(billing.mode, 'subscription');
  assert.equal(billing.hasKey, false);
  assert.equal(desc(), 'Claude subscription');
  status = { state: 'ready', plan: 'Max' };
  await r.render(h(BillingView));
  assert.equal(desc(), 'Claude subscription · Max');
  status = { state: 'signin' };
  await r.render(h(BillingView));
  assert.equal(billing.hasSubscription, false);
  assert.equal(desc(), 'Not signed in with Claude');
  ck = { mode: 'apiKey', set: true, baseUrl: 'https://proxy', hint: '1234' };
  await r.render(h(BillingView));
  assert.equal(billing.hasKey, true);
  assert.equal(desc(), 'https://proxy API key ending 1234 · billed per token');
  ck = { mode: 'mopilot', set: false };
  await r.render(h(BillingView));
  // the balance as the profile menu and Settings show it
  assert.equal(desc(), 'MoPilot credits · $5.00 left · me@x');
  mp = { signedIn: false, balanceMicros: 0, user: null };
  await r.render(h(BillingView));
  assert.equal(desc(), 'MoPilot credits · $0.00 left');
  assert.deepEqual(billing.credits, { signedIn: false });
  // a build without the MoPilot service offers no credits
  (native as any).mopilotService = false;
  await r.render(h(BillingView));
  assert.equal(billing.credits, undefined);
  delete (native as any).mopilotService;
  await r.render(h(BillingView));
  calls.length = 0;
  billing.onSwitch('apiKey');
  billing.onAddKey('sk', 'https://u');
  billing.onRemoveKey();
  billing.onSignIn();
  assert.deepEqual(calls, [
    ['apply'],
    ['setAuthMode', 'apiKey'],
    ['apply'],
    ['setApiKey', 'sk', 'https://u'],
    ['apply'],
    ['clearApiKey'],
    ['relogin', 'acc-1'],
  ]);
  await r.unmount();
  ck = null;
  status = { state: 'ready' };
});

test('rows hand the CLI found to the version row, then the cloud toggle and the install guide', async () => {
  calls.length = 0;
  const r = await mount(h(Rows as any, { status: { state: 'missing', bin: null } }));
  assert.equal(versionRow.bin, null);
  assert.equal(versionRow.version, null);
  assert.equal(r.host.querySelector('[role=switch]')?.getAttribute('aria-checked'), 'false');
  await click(byText(r.host, 'button', 'Install guide'));
  assert.deepEqual(calls.at(-1), ['open', 'https://code.claude.com/docs/en/setup']);

  const candidates = [
    { path: '/a/claude', version: '2.1.302', via: 'self', from: 'standalone install' },
    { path: '/usr/bin/claude', version: null },
  ];
  const st = { state: 'ready', bin: '/usr/bin/claude', version: '2.1', candidates, offPath: true, terminal: null };
  store.set({ prefs: { claudeBin: '/usr/bin/claude' } });
  await r.render(h(Rows as any, { status: st }));
  assert.deepEqual(
    { kind: versionRow.kind, label: versionRow.label, name: versionRow.name, bin: versionRow.bin, version: versionRow.version },
    { kind: 'claude', label: 'Claude Code', name: 'claude', bin: '/usr/bin/claude', version: '2.1' },
  );
  assert.equal(versionRow.installs, candidates);
  assert.equal(versionRow.manual, '/usr/bin/claude');
  assert.equal(versionRow.where, st, 'whether the terminal runs it too');
  assert.equal(byText(r.host, 'button', 'Install guide'), undefined);
  store.set({ prefs: { claudeBin: null } });
  calls.length = 0;
  versionRow.onPick('/a/claude');
  versionRow.onPick(null);
  // the same pref as before, detected again at once with the path the store now holds
  assert.deepEqual(calls, [
    ['setPrefs', { claudeBin: '/a/claude' }],
    ['detect', true],
    ['setPrefs', { claudeBin: null }],
    ['detect', true],
  ]);

  ck = { cloudEnv: true };
  await r.render(h(Rows as any, { status: { state: 'ready', bin: '/b' } }));
  assert.equal(r.host.querySelector('[role=switch]')?.getAttribute('aria-checked'), 'true');
  calls.length = 0;
  await click(r.host.querySelector('[role=switch]'));
  assert.deepEqual(calls, [['apply'], ['setCloudEnv', false]]);
  ck = null;
  await r.unmount();
});

test('the banner stays hidden until the login lapsed, then offers the other accounts, a re-check and the terminal sign-in', async () => {
  signedOut = null;
  calls.length = 0;
  const r = await mount(h(P.Banner));
  assert.equal(r.host.innerHTML, '');
  assert.deepEqual(calls, [
    ['useComposerFamily', null],
    ['signedOut', null],
  ]);

  signedOut = { email: 'a@x', login: 'L1', others: [{ id: 'o1', email: null }] };
  store.set({ route: { name: 'thread', id: 't1' } });
  await flush(1);
  assert.equal(r.host.querySelector('[role=alert]')?.textContent?.includes('sign-in for a@x has expired'), true);
  const use = byText(r.host, 'button', 'Use another account')!;
  assert.equal(use.title, 'o1');
  calls.length = 0;
  await click(use);
  await click(byText(r.host, 'button', 'Re-check'));
  await click([...r.host.querySelectorAll('button')].find((b) => b.textContent === 'Sign in')!);
  assert.deepEqual(
    calls.filter((c) => !(['useComposerFamily', 'signedOut'] as (string | null)[]).includes(c[0])),
    [['pin', 't1', 'o1'], ['refreshAccounts'], ['recheck'], ['relogin', 'L1']],
  );

  // a Codex chat runs on no Claude login: Claude Code's lapsed one is not its banner (and a Claude chat showed Codex's)
  composer = 'codex';
  signedOut = { login: 'L2', others: [{ id: 'o1', email: 'one@x' }, { id: 'o2' }] };
  store.set({ route: { name: 'thread', id: 't2' } });
  await flush(1);
  assert.equal(r.host.querySelector('[role=alert]')?.textContent ?? null, null);
  // nor is it a page's outside a chat while new chats start on Codex
  store.set({ route: { name: 'home' } });
  await flush(1);
  assert.equal(r.host.querySelector('[role=alert]')?.textContent ?? null, null);
  // outside a chat with new chats on Claude Code, the login new chats use is switched, not pinned
  // (still no chat in focus: a new chats record re-renders it with the new family)
  composer = 'claude';
  store.set({ route: { name: 'settings', section: 'general' }, claudeChats: { ...store.get().claudeChats } });
  await flush(1);
  assert.equal(r.host.querySelector('[role=alert]')?.textContent?.includes('Claude Code sign-in has expired'), true);
  assert.equal(byText(r.host, 'button', 'Use one@x')?.title, 'one@x');
  calls.length = 0;
  await click(byText(r.host, 'button', 'Use o2'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'switch' || c[0] === 'pin'),
    [['switch', 'o2']],
  );
  // a basic harness's chat runs on no Claude login: nothing about Claude's covers it
  composer = 'acp';
  signedOut = { login: 'L3', others: [] };
  store.set({ route: { name: 'thread', id: 'acp:kimi:1' } });
  await flush(1);
  assert.equal(r.host.querySelector('[role=alert]')?.textContent ?? null, null);
  composer = 'claude';
  signedOut = null;
  store.set({ route: { name: 'home' } });
  await r.unmount();
});

test('the advanced section is one version row (no separate CLI location), the cloud, artifacts and Remote Control rows', async () => {
  const r = await mount(h(ClaudeAdvanced));
  // Re-check moved to the page header; "Choose another…" in the version row replaced the CLI location row
  assert.deepEqual(rows(r.host), ['Version', 'Use cloud provider', 'Artifacts and designs', 'Connect new sessions to Remote Control']);
  assert.equal(byText(r.host, 'button', 'Re-check'), undefined);
  assert.equal(r.host.querySelector('input'), null);
  await r.unmount();
});

test('signed-out actions, the card action and auto switch', async () => {
  const r = await mount(h('div', null, h(P.SignedOutActions), h(P.CardAction)));
  calls.length = 0;
  for (const b of r.host.querySelectorAll('button')) await click(b);
  assert.deepEqual(calls, [['navigate', { name: 'settings', section: 'accounts' }], ['payCredits', 'claude'], ['recheck'], ['recheck']]);
  await r.unmount();
  // a build without the MoPilot service offers no credits
  (native as any).mopilotService = false;
  const oss = await mount(h(P.SignedOutActions));
  assert.deepEqual(
    [...oss.host.querySelectorAll('button')].map((b) => b.textContent),
    ['Use an API key', 'Re-check'],
  );
  await oss.unmount();
  delete (native as any).mopilotService;
  let pair: any;
  store.set({ claudeAccounts: { accounts: [], active: null, autoSwitch: true } });
  const r2 = await mount(h(() => ((pair = P.useAutoSwitch()), null)));
  assert.equal(pair[0], true);
  pair[1](false);
  assert.deepEqual(calls.at(-1), ['autoSwitch', false]);
  await r2.unmount();
});

test('the binary the header names is the one its Version row reads: status binary, installs found, the path set', async () => {
  const candidates = [{ path: '/u/claude', version: '2.1.302', via: 'self' }];
  let binary: any;
  store.set({ prefs: { claudeBin: '/s/wrapper.sh' } });
  const r = await mount(h(() => ((binary = P.useBinary({ bin: '/s/wrapper.sh', candidates })), null)));
  assert.deepEqual(binary, { bin: '/s/wrapper.sh', installs: candidates, manual: '/s/wrapper.sh' });
  await r.unmount();
  // none found
  store.set({ prefs: { claudeBin: null } });
  const none = await mount(h(() => ((binary = P.useBinary({ bin: null })), null)));
  assert.deepEqual(binary, { bin: null, installs: undefined, manual: null });
  await none.unmount();
});

test('the artifacts row reads the switch, turns it off and on, and keeps the newest answer', async () => {
  const artifactsSwitch = (r: any) => r.host.querySelectorAll('[role=switch]')[1] as HTMLButtonElement;
  const desc = (r: any) => byText(r.host, '.row', /Artifacts and designs/)?.querySelector('i')?.textContent;
  let answer: (v: any) => void = () => {};
  artifactsRead = () => new Promise((res) => (answer = res));
  const r = await mount(h(Rows as any, { status: { state: 'ready' } }));
  // unknown until main answers
  assert.equal(artifactsSwitch(r).disabled, true);
  assert.equal(artifactsSwitch(r).getAttribute('aria-checked'), 'false');
  answer({ on: true, killed: false });
  await flush();
  assert.equal(artifactsSwitch(r).getAttribute('aria-checked'), 'true');
  assert.equal(
    desc(r),
    'Lets Claude Code publish pages, slides and designs to claude.ai. Adds about 12k tokens to every request. Needs a claude.ai Pro, Max, Team or Enterprise login.',
  );
  // off at once; an older answer arriving after a newer one is dropped
  const answers: ((v: any) => void)[] = [];
  artifactsSet = () => new Promise((res) => answers.push(res));
  calls.length = 0;
  await click(artifactsSwitch(r));
  assert.equal(artifactsSwitch(r).getAttribute('aria-checked'), 'false');
  await click(artifactsSwitch(r));
  assert.deepEqual(calls, [
    ['setArtifacts', false],
    ['setArtifacts', true],
  ]);
  answers[1]({ on: true, killed: false });
  answers[0]({ on: false, killed: false });
  await flush();
  assert.equal(artifactsSwitch(r).getAttribute('aria-checked'), 'true');
  await r.unmount();

  // switched off remotely: shown off, greyed, and said so; a read that fails leaves it greyed
  artifactsRead = async () => ({ on: true, killed: true });
  const k = await mount(h(Rows as any, { status: { state: 'ready' } }));
  await flush();
  assert.equal(artifactsSwitch(k).getAttribute('aria-checked'), 'false');
  assert.equal(artifactsSwitch(k).disabled, true);
  assert.match(desc(k) ?? '', /Turned off for now\.$/);
  await k.unmount();
  artifactsRead = async () => {
    throw new Error('no main');
  };
  const f = await mount(h(Rows as any, { status: { state: 'ready' } }));
  await flush();
  assert.equal(artifactsSwitch(f).disabled, true);
  await f.unmount();
  artifactsRead = async () => ({ on: true, killed: false });
  artifactsSet = async (on) => ({ on, killed: false });
});

test('the Remote Control row reads the setting, saves a change, and keeps the newest answer', async () => {
  const remoteSwitch = (r: any) => r.host.querySelectorAll('[role=switch]')[2] as HTMLButtonElement;
  const title = (r: any) => byText(r.host, '.row', /Connect new sessions to Remote Control/);
  let answer: (v: boolean) => void = () => {};
  remoteRead = () => new Promise((res) => (answer = res));
  const r = await mount(h(Rows as any, { status: { state: 'ready' } }));
  assert.ok(title(r));
  // unknown until main answers
  assert.equal(remoteSwitch(r).disabled, true);
  answer(true);
  await flush();
  assert.equal(remoteSwitch(r).disabled, false);
  assert.equal(remoteSwitch(r).getAttribute('aria-checked'), 'true');
  assert.match(title(r)?.querySelector('i')?.textContent ?? '', /Needs a claude\.ai subscription login\.$/);
  // off at once; an older answer arriving after a newer one is dropped
  const answers: ((v: boolean) => void)[] = [];
  remoteSet = () => new Promise((res) => answers.push(res));
  calls.length = 0;
  await click(remoteSwitch(r));
  assert.equal(remoteSwitch(r).getAttribute('aria-checked'), 'false');
  await click(remoteSwitch(r));
  assert.deepEqual(calls, [
    ['setRemoteControlDefault', false],
    ['setRemoteControlDefault', true],
  ]);
  answers[1](true);
  answers[0](false);
  await flush();
  assert.equal(remoteSwitch(r).getAttribute('aria-checked'), 'true');
  await r.unmount();
  // a read that arrives after the row went away, and one that fails, leave it greyed
  remoteRead = async () => {
    throw new Error('no main');
  };
  const f = await mount(h(Rows as any, { status: { state: 'ready' } }));
  await flush();
  assert.equal(remoteSwitch(f).disabled, true);
  await f.unmount();
  remoteRead = async () => false;
  remoteSet = async (on) => on;
});

test('This Mac missing-agent hint keeps its wording (the machine picker shares the function, #5072)', () => {
  assert.equal(P.missingHint, 'Install Claude Code, or set its path in Settings → Claude Code.');
});
