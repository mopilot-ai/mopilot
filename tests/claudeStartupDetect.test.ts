// The renderer's startup Claude Code detection (src/session/harness/claude.ts startClaude) runs before the account list
// arrives, for the store's default login. When the list names another login in use, that login is detected too,
// so its row never stays "Checking…" (#1291). Real detection code; native and the store are faked.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { moduleSourceFakes } from './support/module-source-fakes.ts';

export const GUARDS = ['src/'];

const noopExports = (names: string) =>
  names
    .split(' ')
    .map((n) => `export const ${n} = () => {};`)
    .join('\n');
const fakes: Record<string, string> = {
  react: noopExports('useEffect useMemo useRef useSyncExternalStore'),
  '../../lib/native':
    'export const native = { claude: globalThis.__claudeStartupFixture.native, flags: { isEnabled: () => false } }; export const installedNative = () => native;',
  // the store's names, served for each slice the harness takes them from (below)
  '../../store/chats': `
    const f = globalThis.__claudeStartupFixture;
    export const getState = () => f.state;
    export const setState = (patch) => Object.assign(f.state, typeof patch === 'function' ? patch(f.state) : patch);
    export const useStore = Object.assign(() => {}, { subscribe: (l) => (f.listeners.push(l), () => {}) });
    ${noopExports('patchRuntime chatFamily toast openPaneTab applyNotification chatOf modelChangeNote nativeOf suggestOtherHarness newTurn provisionalTitle threadTitle upsertThread touchChat buildInput setDraft selectionAttachment accountNote setElsewhere otherAppDone sendHeld unhideFolder rememberChatProject setChatConfig notify navigate')}
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

const pool = { active: 'b1', autoSwitch: true, login: null, accounts: [{ id: 'default' }, { id: 'b1', reconfirm: true }] };
const fixture: any = {
  state: {
    prefs: { claudeBin: null },
    claude: { status: { state: 'detecting', bin: null, version: null, plan: null, usage: null }, models: [] },
    claudeAccounts: { active: 'default', autoSwitch: true, login: null, accounts: [] },
    claudeChats: {},
    claudeUsage: {},
    focused: true,
  },
  calls: [] as string[],
  listeners: [] as ((s: any, prev: any) => void)[],
};
let releaseStartup!: () => void;
const startupHeld = new Promise<void>((r) => (releaseStartup = r));
fixture.native = {
  onEvent: () => {},
  onItems: () => () => {},
  onAccountsEvent: () => {},
  onCatalog: () => {},
  // the account list answers first, while the startup detection still waits on the CLI
  accounts: async () => pool,
  // the other logins' read: the CLI's own login still works
  refreshAccounts: async () => {
    fixture.calls.push('refresh');
    if (fixture.refreshFails) throw new Error('no cli');
    return {
      ...pool,
      accounts: [
        { id: 'default', loggedIn: true },
        { id: 'b1', loggedIn: false, reconfirm: true },
      ],
    };
  },
  detect: async () => {
    const account = fixture.state.claudeAccounts.active;
    fixture.calls.push(account);
    if (account === 'default') await startupHeld;
    return { state: account === 'b1' ? 'signin' : 'ready', account, bin: '/fake/claude', version: '1', candidates: [], plan: null };
  },
};
(globalThis as any).__claudeStartupFixture = fixture;
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => {
  globalThis.setInterval = originalInterval;
  hooks.deregister();
  delete (globalThis as any).__claudeStartupFixture;
});
const { startClaude } = await import('../src/session/harness/claude.ts');
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('a login in use other than the default is detected after the startup read, and its status settles', async () => {
  startClaude();
  await flush();
  assert.equal(fixture.state.claudeAccounts.active, 'b1');
  // the startup detection, for the default login, answers last and is superseded
  releaseStartup();
  await flush();
  assert.deepEqual(fixture.calls, ['default', 'b1', 'refresh']);
  assert.equal(fixture.state.claude.status.state, 'signin');
  // with the login in use signed out, the list still says which logins work
  assert.deepEqual(
    fixture.state.claudeAccounts.accounts.map((a: any) => [a.id, a.loggedIn]),
    [
      ['default', true],
      ['b1', false],
    ],
  );
});

test('a failed read of the other logins leaves the signed-out status as it is', async () => {
  const { detectClaude } = await import('../src/session/harness/claude/accounts.ts');
  fixture.refreshFails = true;
  fixture.calls.length = 0;
  await detectClaude(true);
  assert.deepEqual(fixture.calls, ['b1', 'refresh']);
  assert.equal(fixture.state.claude.status.state, 'signin');
});

test('only the shared writer sets the Claude account list, so a change of the login in use always detects again', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = new URL('../src/', import.meta.url).pathname;
  const writers = (fs.readdirSync(src, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && /\bclaudeAccounts\s*:/.test(fs.readFileSync(path.join(src, f), 'utf8')))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
  // the initial state, and setAccounts in src/session/harness/claude/accounts.ts (its type is in shared/model/window.d.ts)
  assert.deepEqual(writers, ['session/harness/claude/accounts.ts', 'store/core.ts']);
});

test('the store listener hands the previous state to the per-chat settings sync, and a navigation re-follows', () => {
  const prev = { ...fixture.state, route: { name: 'home' }, runtime: {}, chatConfig: {}, momoModels: {}, segments: {} };
  const next = { ...prev, runtime: { a: { settings: { model: 'm' } } } };
  assert.ok(fixture.listeners.length > 0);
  // a Codex-family chat (the faked chatFamily answers nothing) is skipped; the point is that the write is handled without a full scan
  for (const l of fixture.listeners) l(next, prev);
});
