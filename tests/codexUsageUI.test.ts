import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { defined } from './support/defined.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createRoot } = await import('react-dom/client');

// The real harness/select.ts over a fake store; every other dependency is a stub. (The usage dashboard these
// tests also drew is gone: each account row shows its own usage, tests/settings-accounts.test.ts.)
// (The store's refreshRateLimits adapter is tested against the real store in tests/store-boot.test.ts.)
const f = () => (globalThis as any).__codexUsageUI;
const nul = () => null;
const inert = [
  'addAccount',
  'chatFamily',
  'newChatHarness',
  'newChatFamily',
  'login',
  'nativeOf',
  'patchRuntime',
  'pinCodexChat',
  'removeAccount',
  'setChatConfig',
  'setPrefs',
  'switchAccount',
  'codexChatSelection',
  'addClaudeAccount',
  'pinClaudeChat',
  'reloginClaudeAccount',
  'removeClaudeAccount',
  'switchClaudeAccount',
  'modelLabel',
  'sessionOf',
  'flushSessionPatches',
  'useSessionField',
  'useSession',
  'useChatCaps',
  'whyText',
  'accountRowTab',
  'harnessInfo',
  'claudeModelFor',
  'claudeModelServed',
  'activeTier',
  'codexTiers',
];
const getState = () => f().state;
const boundary: Record<string, unknown> = {
  useStore: (selector: any) => selector(f().state),
  getState,
  // core's own name for it
  get: getState,
  refreshClaudeUsage: async () => {},
  refreshRateLimits: async () => {
    f().calls.push('main');
  },
  refreshAccountsUsage: async (age: number) => {
    f().calls.push(['accounts', age]);
    if (f().accountError) throw new Error('unavailable');
  },
  getMoPilot: () => ({ balanceMicros: null }),
  useMoPilot: () => ({ balanceMicros: null }),
  useClaudeKey: () => null,
  codexIncompatible: () => !!f().state.compatBad,
  incompatibleText: () => 'Incompatible',
  endpointLabel: () => 'OpenAI',
  HarnessIcon: nul,
  toast: (...args: any[]) => f().calls.push(['toast', ...args]),
  toastFailure: (what: string) => (e: unknown) => f().calls.push(['toast', what, e]),
  native: { shell: { openExternal: () => {} } },
  openLink: () => {},
  Group: (p: any) => createElement('section', null, p.title, p.desc, p.children),
  Row: (p: any) => createElement('article', null, p.title, p.desc, p.children),
  Segmented: nul,
  CodexResetCards: () => createElement('aside', null, 'Codex reset cards'),
  ClaudeResetCards: () => createElement('aside', null, 'Claude reset cards'),
  ...Object.fromEntries(inert.map((name) => [name, nul])),
};
// select.ts takes each store name from the slice that owns it
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub(boundary.native as object);
for (const rel of [
  'store/core.ts',
  'store/chats.ts',
  'store/accounts.ts',
  'store/projects.ts',
  'harness/codexSettings.ts',
  'harness/codexCompat.ts',
  'session/harness/claude.ts',
  'lib/format.ts',
  'lib/mopilot.ts',
  'store/session/useSession.ts',
  'store/session/useCaps.ts',
  'harness/caps.ts',
  'lib/settingsNav.ts',
  'harness/registry.ts',
  'harness/claudeTranslate.ts',
  '../shared/mopilotCaps.mjs',
  'session/harness/billing.ts',
  'harness/tiers.ts',
  'components/pages/HarnessSettings.tsx',
  'components/harnessPicker/HarnessPicker.tsx',
  'components/pages/Settings.tsx',
  'components/harness/ResetCards.tsx',
  'session/open.ts',
])
  mock.module(new URL(`../src/${rel}`, import.meta.url).href, { namedExports: boundary });
const { codexStatus, useHarnessStatus } = await import('../src/session/harness/select.ts');

const snap = (used: number, reset: number | null = 4e9) => ({
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: reset },
  secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: null },
});
const row = (id: string, used: number) => ({
  id,
  email: `${id}@example.test`,
  kind: 'chatgpt',
  planType: 'team',
  status: 'ok',
  limits: { ...snap(used), used, at: 42, reached: false },
});
function fixture(patch: any = {}) {
  const state = {
    conn: 'ready',
    connError: null,
    account: { type: 'chatgpt', email: 'wrong@example.test', planType: 'plus' },
    accounts: { active: 'a', accounts: [row('a', 97)], relay: true },
    rateLimits: { rateLimits: snap(5) },
    prefs: { defaultHarness: 'codex' },
    claude: { status: { state: 'ready', plan: 'Claude', usage: null } },
    claudeAccounts: { active: 'default', accounts: [] },
    claudeUsage: {},
    ...patch,
  };
  (globalThis as any).__codexUsageUI = { state, calls: [] };
  return (globalThis as any).__codexUsageUI;
}

test('status uses the selected account identity, windows and timestamp through account switches', () => {
  const f = fixture({ accounts: { active: 'a', accounts: [row('a', 97), row('b', 5)] } });
  for (const [id, used] of [
    ['a', 97],
    ['b', 5],
    [null, 97],
  ] as const) {
    f.state.accounts.active = id;
    const status = codexStatus(f.state);
    assert.equal(status.email, `${id ?? 'a'}@example.test`);
    assert.equal(status.plan, 'ChatGPT Team');
    assert.equal(status.usage?.windows[0].usedPercent, used);
    assert.equal(status.usage?.at, 42);
  }
  f.state.accounts.accounts[0].limits = null;
  assert.equal(codexStatus(f.state).usage, null);
  f.state.accounts.accounts[0].kind = 'apiKey';
  assert.equal(codexStatus(f.state).state, 'apikey');
  assert.equal(codexStatus(f.state).plan, 'API key');
});

test('status preserves standalone login fallback and missing plan, email and window fields', () => {
  for (const [account, rateLimits, expected] of [
    [null, null, null],
    [{ type: 'apiKey' }, null, 'API key'],
    [{ type: 'chatgpt', planType: 'plus' }, { rateLimits: snap(5) }, 'ChatGPT Plus'],
    [{ type: 'chatgpt' }, { rateLimits: { primary: {}, planType: 'team' } }, 'ChatGPT Team'],
    [{ type: 'chatgpt' }, null, 'ChatGPT'],
  ]) {
    const f = fixture({ accounts: { active: null, accounts: [] }, account, rateLimits });
    assert.equal(codexStatus(f.state).plan, expected);
  }
  const f = fixture();
  f.state.accounts.accounts[0].email = null;
  f.state.accounts.accounts[0].planType = null;
  delete f.state.accounts.accounts[0].limits.at;
  assert.equal(codexStatus(f.state).email, null);
  assert.equal(codexStatus(f.state).plan, 'ChatGPT');
  assert.ok(defined(codexStatus(f.state).usage).at > 0);
});

test('status keeps connection and authentication states while selecting managed usage', () => {
  for (const [patch, state] of [
    [{ conn: 'idle' }, 'detecting'],
    [{ conn: 'connecting' }, 'detecting'],
    [{ conn: 'error', connError: 'ENOENT' }, 'missing'],
    [{ conn: 'error', connError: 'spawn C:\\Program Files\\codex\\codex.exe ENOENT' }, 'missing'],
    [{ conn: 'error', connError: 'spawn EACCES' }, 'missing'],
    [{ conn: 'error', connError: 'failed' }, 'error'],
    // a Codex that ran and quit, whatever its output says, is not missing
    [{ conn: 'error', connError: 'Codex app-server exited (1).\nopen config.toml: ENOENT' }, 'error'],
    [{ conn: 'error', connError: 'reading ENOENT from a pipe' }, 'error'],
    [{ conn: 'ready', compatBad: true }, 'error'],
    [{ requiresAuth: true }, 'signin'],
  ] as const) {
    const f = fixture(patch);
    assert.equal(codexStatus(f.state).state, state);
  }
});

test('an app-server that quit says so in a short line, without its exit code or stderr (#1863)', () => {
  const f = fixture({ conn: 'error', connError: "Codex app-server exited (101).\nthread 'main' panicked at src/main.rs:12" });
  assert.equal(codexStatus(f.state).error, 'Codex quit unexpectedly.');
  assert.equal(
    codexStatus(fixture({ conn: 'error', connError: 'Codex app-server exited (SIGKILL).\n' }).state).error,
    'Codex quit unexpectedly.',
  );
  assert.equal(codexStatus(fixture({ conn: 'ready' }).state).error, null);
});

test('the status hook subscribes to managed usage changes and retains the Claude status', async () => {
  const f = fixture();
  function Probe({ h }: any) {
    const s = useHarnessStatus(h);
    return createElement('output', null, JSON.stringify(s));
  }
  const host = document.createElement('div'),
    root = createRoot(host as any);
  try {
    await act(() => root.render(createElement(Probe, { h: 'codex' })));
    assert.equal(JSON.parse(host.textContent!).usage.windows[0].usedPercent, 97);
    f.state.accounts = { active: 'b', accounts: [row('b', 5)] };
    await act(() => root.render(createElement(Probe, { h: 'codex' })));
    assert.equal(JSON.parse(host.textContent!).usage.windows[0].usedPercent, 5);
    await act(() => root.render(createElement(Probe, { h: 'claude' })));
    assert.deepEqual(JSON.parse(host.textContent!), f.state.claude.status);
  } finally {
    await act(() => root.unmount());
  }
});
