import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, flush, fakeStore } from './support/harness-ui-kit.ts';
import { iconStubs, mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (calls.push([name, ...a]), ret);
const store = fakeStore<any>({ accounts: { accounts: [], active: null, autoSwitch: false } });
let exists!: (v: boolean) => void;
let existsFailed!: (e: Error) => void;
let mp: any = { signedIn: true, balanceMicros: 7_000_000, user: { email: 'me@x' } };
let billing: any;
stubStore({
  addCodexApiKey: rec('addKey'),
  login: rec('login'),
  navigate: rec('navigate'),
  refreshAccountsUsage: rec('refreshUsage', Promise.resolve()),
  removeAccount: rec('remove'),
  setAutoSwitch: rec('autoSwitch'),
  setAccountPool: rec('pool'),
  setCodexMode: rec('mode'),
  useStore: store.useStore,
  get: store.getState,
});
installNativeStub({
  fs: { exists: (p: string) => (calls.push(['exists', p]), new Promise((r, j) => ((exists = r), (existsFailed = j)))) },
});
let codexBins: any = { bins: null, error: null };
mock.module('../src/harness/codexBinaries.ts', { namedExports: { useCodexBinaries: () => codexBins } });
mock.module('../src/lib/mopilot.ts', { namedExports: { formatCredits: (m: number) => `$${m}`, useMoPilot: () => mp } });
mock.module('../src/components/pages/settings/BillingRow.tsx', {
  namedExports: {
    BillingRow: (p: any) => ((billing = p), h('div', { id: 'billing' }, p.desc)),
    endpointLabel: (u: string | undefined, own: string) => u ?? own,
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs(undefined, { CodexMark: ({ size }: any) => h('svg', { id: 'mark', width: size }) }));
const { codexParts } = await import('../src/components/harness/codex/parts.tsx');
const { native } = await import('../src/lib/native.ts');
const P = codexParts as any;
// useBilling as the Pay with row and the accounts list read it
const BillingView = () => ((billing = P.useBilling()), h('div', { id: 'billing' }, billing.desc));

test('a look for the ChatGPT mark that fails keeps the bundled mark, and the next icon asks again', async () => {
  const a = await mount(h(P.Icon, { size: 16 }));
  await act(async () => existsFailed(new Error('EPERM')));
  assert.ok(a.host.querySelector('#mark'));
  assert.equal(a.host.querySelector('.chatgpt-mark'), null);
  await a.unmount();
  calls.length = 0;
});

test('the icon is the bundled mark until the ChatGPT app mark is found, checked once and shared', async () => {
  const a = await mount(h(P.Icon, { size: 16 }));
  const b = await mount(h(P.Icon, { size: 16 }));
  const c = await mount(h(P.Icon, { size: 16 }));
  await c.unmount();
  assert.equal(a.host.querySelector('#mark')?.getAttribute('width'), '16');
  assert.equal(calls.filter((x) => x[0] === 'exists').length, 1);
  assert.match(calls[0][1], /ChatGPT\.app.*chatgptTemplate@2x\.png$/);
  await act(async () => exists(true));
  for (const r of [a, b]) {
    const span = r.host.querySelector('.chatgpt-mark') as HTMLElement;
    assert.equal(span.getAttribute('aria-label'), 'Codex');
    assert.equal(span.style.width, '16px');
  }
  const d = await mount(h(P.Icon, { size: 10 }));
  assert.ok(d.host.querySelector('.chatgpt-mark'));
  assert.equal(calls.filter((x) => x[0] === 'exists').length, 1);
  for (const r of [a, b, d]) await r.unmount();
});

test('billing reads the mode from the account in use and acts on its key', async () => {
  const set = (accounts: any[], active: string | null) => store.set({ accounts: { accounts, active, autoSwitch: false } });
  set([], null);
  const r = await mount(h(BillingView));
  const desc = () => r.host.querySelector('#billing')?.textContent;
  assert.equal(billing.mode, 'subscription');
  assert.equal(billing.hasKey, false);
  assert.equal(billing.hasSubscription, false);
  assert.equal(desc(), 'Not signed in with ChatGPT');

  set([{ id: 'g', kind: 'chatgpt' }], 'none');
  await flush(1);
  assert.equal(desc(), 'ChatGPT · signed in');
  set(
    [
      { id: 'g', kind: 'chatgpt', email: 'g@x' },
      { id: 'k', kind: 'apiKey' },
    ],
    'g',
  );
  await flush(1);
  assert.equal(desc(), 'ChatGPT · g@x');
  assert.equal(billing.hasKey, true);
  calls.length = 0;
  billing.onAddKey('sk-1', 'https://u');
  await billing.onRemoveKey();
  assert.deepEqual(calls, [
    ['addKey', 'sk-1', 'https://u', 'k'],
    ['remove', 'k'],
  ]);

  set(
    [
      { id: 'k1', kind: 'apiKey', mopilot: true },
      { id: 'k2', kind: 'apiKey', baseUrl: 'https://or' },
    ],
    'k2',
  );
  await flush(1);
  assert.equal(billing.mode, 'apiKey');
  assert.equal(desc(), 'https://or API key · billed per token');
  set([{ id: 'k1', kind: 'apiKey' }], 'k1');
  await flush(1);
  assert.equal(desc(), 'OpenAI API key · billed per token');

  set([{ id: 'm', kind: 'apiKey', mopilot: true }], 'm');
  await flush(1);
  assert.equal(billing.mode, 'mopilot');
  // the balance as the profile menu and Settings show it
  assert.equal(desc(), 'MoPilot credits · $7.00 left · me@x');
  assert.equal(billing.hasKey, false);
  mp = { signedIn: false, balanceMicros: 0 };
  await r.render(h(BillingView));
  assert.equal(desc(), 'MoPilot credits · $0.00 left');
  assert.deepEqual(billing.credits, { signedIn: false });
  // a build without the MoPilot service offers no credits
  (native as any).mopilotService = false;
  await r.render(h(BillingView));
  assert.equal(billing.credits, undefined);
  delete (native as any).mopilotService;
  calls.length = 0;
  billing.onAddKey('sk-2');
  assert.equal(await billing.onRemoveKey(), undefined);
  billing.onSignIn();
  assert.deepEqual(calls, [['addKey', 'sk-2', undefined, undefined], ['login']]);
  // a switch goes to the account store; Your own provider is Claude Code's only, so Codex does nothing with it
  calls.length = 0;
  await billing.onSwitch('apiKey');
  await billing.onSwitch('routed');
  assert.deepEqual(calls, [['mode', 'apiKey']]);
  await r.unmount();
});

test('static parts, sign in, usage refresh and auto switch', async () => {
  assert.equal(P.signInLabel, 'Sign in');
  assert.equal(P.fastTip, null);
  calls.length = 0;
  P.signIn();
  await P.refreshUsage();
  assert.deepEqual(calls, [['login'], ['refreshUsage', 'surface']]);
  let pair: any;
  store.set({ accounts: { accounts: [], active: null, autoSwitch: true } });
  const r2 = await mount(h(() => ((pair = P.useAutoSwitch()), null)));
  assert.equal(pair[0], true);
  calls.length = 0;
  await pair[1](false);
  // without the relay there is no pool to set
  assert.deepEqual(calls, [['autoSwitch', false]]);
  // behind the relay the same switch spreads new chats, or keeps them on one account
  store.set({ accounts: { accounts: [], active: null, autoSwitch: true, relay: true } });
  calls.length = 0;
  await pair[1](false);
  await pair[1](true);
  assert.deepEqual(calls, [
    ['autoSwitch', false],
    ['pool', 'single'],
    ['autoSwitch', true],
    ['pool', 'spread'],
  ]);
  await r2.unmount();
});

test("the binary the header names is the one Codex's Version row reads, and the status's while the installs can't be read", async () => {
  let binary: any;
  const read = async () => {
    const r = await mount(h(() => ((binary = P.useBinary({ bin: '/st/codex' })), null)));
    await r.unmount();
    return binary;
  };
  store.set({ codexBin: '/picked/codex' });
  const candidates = [{ path: '/picked/codex', version: '0.163.0' }];
  codexBins = { bins: { candidates, current: '/picked/codex' }, error: null };
  assert.deepEqual(await read(), { bin: '/picked/codex', installs: candidates, manual: '/picked/codex' });
  // still reading: no binary yet, so the header waits as the row says "Detecting…"
  codexBins = { bins: null, error: null };
  assert.deepEqual(await read(), { bin: null, installs: undefined, manual: '/picked/codex' });
  // the lookup failed: the binary the status names
  codexBins = { bins: null, error: 'gone' };
  assert.deepEqual(await read(), { bin: '/st/codex', installs: undefined, manual: '/picked/codex' });
});

test('This Mac missing-agent hint keeps its wording (the machine picker shares the function, #5072)', () => {
  assert.equal(P.missingHint, 'Install Codex, or set its path in Settings → Codex.');
});
