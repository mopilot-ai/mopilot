import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { moduleSourceFakes } from './support/module-source-fakes.ts';
import { turnsOver } from './support/claude-turns-fake.ts';

// Exercise the renderer's real detection/recovery and transcript replay without Electron or React.
const noopExports = (names: string) =>
  names
    .split(' ')
    .map((n) => `export const ${n} = () => {};`)
    .join('\n');
const fakes: Record<string, string> = {
  react: noopExports('useEffect useMemo useRef useSyncExternalStore'),
  '../../lib/native':
    'export const native = { claude: globalThis.__claudeAuthFixture.native }; export const installedNative = () => native;',
  // the store's names, served for each slice the harness takes them from (below)
  '../../store/chats': `
    const f = globalThis.__claudeAuthFixture;
    export const getState = () => f.state;
    export const setState = (patch) => Object.assign(f.state, typeof patch === 'function' ? patch(f.state) : patch);
    export const patchRuntime = (id, patch) => Object.assign(f.state.runtime[id], patch(f.state.runtime[id]));
    export const chatFamily = (id) => id.startsWith('claude:') ? 'claude' : 'codex';
    export const toast = (...args) => f.toasts.push(args);
    export const openPaneTab = (...args) => f.panes.push(args);
    ${noopExports('useStore applyNotification chatOf modelChangeNote nativeOf suggestOtherHarness newTurn provisionalTitle threadTitle upsertThread touchChat buildInput setDraft selectionAttachment accountNote setElsewhere otherAppDone sendHeld unhideFolder rememberChatProject setChatConfig notify navigate')}
    export const ELSEWHERE_LABEL = {};
  `,
  '../../store/session/useSession': noopExports('sessionOf ensureSession useSessions flushSessionPatches'),
  '../../harness/adapters/proxy': 'export const chatProxy = {};',
  './select': noopExports('composerFirstTier composerFamily useComposerFamily'),
};
// the harness takes each store name from the slice that owns it: the store fake above serves each of those slices
for (const slice of ['send', 'panes', 'threads', 'projects', 'notifications']) fakes[`../../store/${slice}`] = fakes['../../store/chats'];
// core names getState and setState get and set
fakes['../../store/core'] = `${fakes['../../store/chats']}\nexport const get = getState;\nexport const set = setState;${
  /\bsetPrefs\b/.test(fakes['../../store/chats']) ? '' : '\nexport const setPrefs = () => {};'
}`;
const sourceFor = moduleSourceFakes(fakes, new URL('../src/session/harness/claude.ts', import.meta.url));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const source = sourceFor(specifier, context.parentURL);
    if (source !== undefined) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
      throw e;
    }
  },
});

const fixture: any = { state: {}, toasts: [], panes: [], calls: [], states: {}, messages: [] };
fixture.native = {
  detect: async (_bin: unknown, force: boolean, verify: boolean, account = fixture.state.claudeAccounts.active) => {
    fixture.calls.push({ account, force, verify });
    return { state: fixture.states[account] ?? 'ready', account, bin: '/fake/claude', version: '1', candidates: [], plan: null };
  },
  probe: async () => ({ models: [], account: {} }),
  refreshAccounts: async () => fixture.state.claudeAccounts,
  list: async () => [],
  usage: async () => ({ state: 'success', text: '' }),
  reloginCommand: async () => ['/fake/claude', 'auth', 'login'],
  signInEnded: async () => {},
  turns: turnsOver(() => fixture.messages),
};
(globalThis as any).__claudeAuthFixture = fixture;
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => {
  globalThis.setInterval = originalInterval;
  hooks.deregister();
  delete (globalThis as any).__claudeAuthFixture;
});
const { detectClaude, recheckClaude, reloginClaudeAccount, endClaudeLoginTerm, loadClaudeTurns } = await import(
  '../src/session/harness/claude.ts'
);
const { onAccountsEvent } = await import('../src/session/harness/claude/accounts.ts');

let serial = 0;
let chat: string;
const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const turn = (id: string, error = message) => ({ id, status: 'failed', items: [], error: { message: error } });
beforeEach(() => {
  chat = `claude:auth-${++serial}`;
  fixture.state = {
    prefs: { claudeBin: null },
    home: '/fake',
    route: { name: 'thread', id: chat },
    claude: { status: { state: 'signin', usage: null }, models: [] },
    claudeAccounts: {
      active: 'default',
      accounts: [
        { id: 'default', loggedIn: false },
        { id: 'pinned', loggedIn: false },
      ],
    },
    claudeChats: {},
    claudeArchived: {},
    claudeUsage: {},
    threads: {},
    threadOrder: [],
    runtime: { [chat]: { turns: [turn(`t-${serial}`)] } },
  };
  fixture.toasts = [];
  fixture.calls = [];
  fixture.states = {};
  fixture.messages = [];
  fixture.panes = [];
});

test('successful verified login clears authentication errors, preserving other errors and turn status', async () => {
  const rt = fixture.state.runtime[chat];
  const other = turn('network', 'Connection reset');
  rt.turns.push(other);
  await recheckClaude();
  assert.equal(rt.turns[0].error, null);
  assert.equal(rt.turns[0].status, 'failed');
  assert.equal(rt.turns[1], other);
  assert.deepEqual(fixture.calls, [{ account: 'default', force: true, verify: true }]);
});

test('failed verification preserves the authentication error and reports signed out', async () => {
  fixture.states.default = 'signin';
  await recheckClaude();
  assert.equal(fixture.state.runtime[chat].turns[0].error.message, message);
  assert.equal(fixture.toasts.at(-1)[1], 'error');
});

test('auth status without verification does not dismiss expired credentials', async () => {
  await detectClaude(true);
  assert.equal(fixture.state.runtime[chat].turns[0].error.message, message);
});

test('verifying the active login leaves pinned and Codex chats alone', async () => {
  const pinned = `claude:pinned-${serial}`;
  const codex = `codex:${serial}`;
  fixture.state.claudeChats[pinned] = { id: 'pinned' };
  fixture.state.runtime[pinned] = { turns: [turn('pinned')] };
  fixture.state.runtime[codex] = { turns: [turn('codex')] };
  await recheckClaude();
  assert.equal(fixture.state.runtime[chat].turns[0].error, null);
  assert.equal(fixture.state.runtime[pinned].turns[0].error.message, message);
  assert.equal(fixture.state.runtime[codex].turns[0].error.message, message);
});

test('Re-check verifies the pinned login and reports its failure rather than active-login success', async () => {
  fixture.state.claudeChats[chat] = { id: 'pinned' };
  fixture.states.pinned = 'signin';
  await recheckClaude('pinned');
  assert.equal(fixture.state.runtime[chat].turns[0].error.message, message);
  assert.equal(fixture.toasts.at(-1)[1], 'error');
  fixture.states.pinned = 'ready';
  await recheckClaude('pinned');
  assert.equal(fixture.state.runtime[chat].turns[0].error, null);
  assert.ok(fixture.calls.some((c: any) => c.account === 'pinned' && c.verify));
});

test('login terminal completion automatically verifies and clears the login being renewed', async () => {
  fixture.state.claudeChats[chat] = { id: 'pinned' };
  await reloginClaudeAccount('pinned');
  assert.equal(fixture.panes.length, 1);
  endClaudeLoginTerm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.state.runtime[chat].turns[0].error, null);
  assert.ok(fixture.calls.some((c: any) => c.account === 'pinned' && c.verify));
});

test('a sign-in that cannot start says why instead of doing nothing', async () => {
  const real = fixture.native.reloginCommand;
  fixture.native.reloginCommand = async () => {
    throw new Error('EACCES: the account folder is not writable');
  };
  try {
    fixture.toasts.length = 0;
    fixture.panes.length = 0;
    await reloginClaudeAccount('pinned');
    assert.equal(fixture.panes.length, 0);
    assert.deepEqual(fixture.toasts, [["Couldn't start the sign-in: EACCES: the account folder is not writable", 'error']]);
  } finally {
    fixture.native.reloginCommand = real;
  }
});

test('a login signed in as another account than it was added as says so, and which one to sign in as (#1582)', () => {
  fixture.toasts.length = 0;
  onAccountsEvent({ type: 'notice', kind: 'otherAccount', id: 'b1', email: 'dz@example.com', addedAs: 'meg@example.com' });
  onAccountsEvent({ type: 'notice', kind: 'otherAccount', id: 'b1', email: null, addedAs: null });
  assert.deepEqual(fixture.toasts, [
    ['meg@example.com is signed in as dz@example.com. Sign in again as meg@example.com in Accounts & billing.', 'error'],
    ['An added Claude login is signed in as another account. Sign in again in Accounts & billing.', 'error'],
  ]);
});

test('transcript replay keeps a recovered live turn dismissed under its transcript id', async () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  fixture.state.runtime[chat].turns = [turn(`ct-${uuid}`)];
  fixture.messages = [
    { type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'reply', error: 'authentication_failed', message: { content: [{ type: 'text', text: message }] } },
    { type: 'result', subtype: 'success', is_error: true, usage: {} },
  ];
  await recheckClaude();
  const replay = await loadClaudeTurns(chat, chat, '/fake');
  assert.equal(replay[0].id, `h-${uuid}`);
  assert.equal(replay[0].status, 'failed');
  assert.equal(replay[0].error, null);
});

test('a new authentication failure after recovery still appears', async () => {
  await recheckClaude();
  const next = turn(`new-${serial}`);
  fixture.state.runtime[chat].turns.push(next);
  fixture.states.default = 'signin';
  await recheckClaude();
  assert.equal(fixture.state.runtime[chat].turns.at(-1), next);
  assert.equal(next.error.message, message);
});

test('module source fakes follow the same dependency from extracted modules without capturing another file', () => {
  const from = new URL('../src/session/harness/claude.ts', import.meta.url);
  const nested = new URL('../src/session/harness/claude/accounts.ts', import.meta.url).href;
  const find = moduleSourceFakes({ '../store/store': 'store fake', react: 'react fake' }, from);
  assert.equal(find('../store/store', from.href), 'store fake');
  assert.equal(find('../../store/store.ts', nested), 'store fake');
  assert.equal(find('../store/store', nested), undefined, 'another file with the same relative spelling stays real');
  assert.equal(find('react', nested), 'react fake');
  assert.equal(find('other-package', nested), undefined);
  assert.equal(find('../store/store'), undefined);
});

test('a Re-check overtaken by a newer detection reports where that one lands, never a red "detecting" (#1385)', async () => {
  const real = fixture.native.detect;
  const gates: Array<() => void> = [];
  // each detection waits until the test lets it answer
  fixture.native.detect = async (...args: any[]) => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return real(...args);
  };
  try {
    const recheck = recheckClaude();
    await new Promise((resolve) => setImmediate(resolve));
    // another detection starts while the Re-check's own is out (a sign-in finishing, the account list moving)
    const newer = detectClaude(true);
    await new Promise((resolve) => setImmediate(resolve));
    gates[0]();
    await new Promise((resolve) => setImmediate(resolve));
    // the Re-check's own answer was superseded: still checking, and nothing said yet
    assert.equal(fixture.state.claude.status.state, 'detecting');
    assert.deepEqual(fixture.toasts, []);
    gates[1]();
    await Promise.all([recheck, newer]);
    assert.equal(fixture.state.claude.status.state, 'ready');
    assert.deepEqual(fixture.toasts, [['Claude Code is signed in.']]);
  } finally {
    fixture.native.detect = real;
  }
});

test('a Re-check whose answer is dropped (the login in use changed meanwhile) says nothing rather than "detecting"', async () => {
  const real = fixture.native.detect;
  let answer!: () => void;
  fixture.native.detect = async (...args: any[]) => {
    await new Promise<void>((resolve) => (answer = resolve));
    return real(...args);
  };
  try {
    const recheck = recheckClaude();
    await new Promise((resolve) => setImmediate(resolve));
    fixture.state.claudeAccounts.active = 'pinned';
    answer();
    await recheck;
    assert.equal(fixture.state.claude.status.state, 'detecting');
    assert.deepEqual(fixture.toasts, []);
  } finally {
    fixture.native.detect = real;
  }
});
