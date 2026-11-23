// src/session/harness/claude.ts shows the text and thinking main streams through
// lib/streamNotifications.ts (PR #346): deltas are joined once per frame, and every other event first
// shows what is held, so the transcript order never changes. The harness module is real; the store,
// main's IPC and React are fakes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { moduleSourceFakes } from './support/module-source-fakes.ts';

const noopExports = (names: string) =>
  names
    .split(' ')
    .map((n) => `export const ${n} = () => {};`)
    .join('\n');
const fakes: Record<string, string> = {
  react: noopExports('useEffect useMemo useRef useSyncExternalStore'),
  '../../lib/native':
    'export const native = { claude: globalThis.__claudeDisplayFixture.native, flags: { isEnabled: () => false } }; export const installedNative = () => native;',
  // the store's names, served for each slice the harness takes them from (below)
  '../../store/chats': `
    const f = globalThis.__claudeDisplayFixture;
    export const getState = () => f.state;
    export const setState = (patch) => Object.assign(f.state, typeof patch === 'function' ? patch(f.state) : patch);
    export const patchRuntime = () => {};
    export const chatFamily = (id) => id.startsWith('claude:') ? 'claude' : 'codex';
    export const chatOf = (id) => id;
    export const nativeOf = (id) => id;
    export const toast = (...args) => f.shown.push(['toast', args[0]]);
    export const suggestOtherHarness = (...args) => f.shown.push(['suggestOtherHarness', args]);
    export const applyNotification = (method, params) => f.shown.push([method, params]);
    export const buildInput = (text) => [{ type: 'text', text }];
    export const useStore = Object.assign(() => {}, { subscribe: () => () => {} });
    ${noopExports('openPaneTab modelChangeNote newTurn provisionalTitle threadTitle upsertThread touchChat setDraft selectionAttachment accountNote setElsewhere otherAppDone sendHeld unhideFolder rememberChatProject setChatConfig notify navigate')}
    export const ELSEWHERE_LABEL = {};
  `,
  '../../store/session/useSession': noopExports('sessionOf ensureSession useSessions flushSessionPatches'),
  '../../harness/adapters/proxy': 'export const chatProxy = { claudeOwn: async () => {} };',
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

const fixture: any = { state: {}, shown: [], onEvent: null };
fixture.native = {
  onEvent: (fn: any) => (fixture.onEvent = fn),
  onItems: (fn: any) => ((fixture.onItems = fn), () => {}),
  onAccountsEvent: () => {},
  onCatalog: () => {},
  accounts: async () => fixture.state.claudeAccounts,
  detect: async () => ({ state: 'ready', account: 'default', bin: '/fake/claude', version: '1', candidates: [], plan: null }),
  probe: async () => ({ models: [], account: {} }),
  refreshAccounts: async () => fixture.state.claudeAccounts,
  list: async () => [],
  usage: async () => '',
  presence: async () => ({}),
};
(globalThis as any).__claudeDisplayFixture = fixture;
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => {
  globalThis.setInterval = originalInterval;
  hooks.deregister();
  delete (globalThis as any).__claudeDisplayFixture;
});
fixture.state = {
  prefs: { claudeBin: null },
  home: '/fake',
  route: { name: 'home' },
  focused: true,
  claude: { status: { state: 'ready', usage: null }, models: [] },
  claudeAccounts: { active: 'default', accounts: [{ id: 'default', loggedIn: true }] },
  claudeChats: {},
  claudeArchived: {},
  claudeUsage: {},
  claudeCatalogs: {},
  threads: {},
  threadOrder: [],
  runtime: {},
  pending: [],
  elsewhere: {},
};
const { startClaude } = await import('../src/session/harness/claude.ts');
startClaude();
const send = (e: any) => fixture.onEvent(e);
const item = (key: string, method: string, params: any) =>
  fixture.onItems({ chatId: key, key, method, params: { threadId: key, ...params } });
const text = (key: string, delta: string) => item(key, 'item/agentMessage/delta', { turnId: 'T', itemId: 'msg1:0', delta });
const thought = (key: string, delta: string) =>
  item(key, 'item/reasoning/summaryTextDelta', { turnId: 'T', itemId: 'msg1:1', summaryIndex: 0, delta });
const methods = () => fixture.shown.map(([m]: [string]) => m);

test("an unresolved Claude limit offers recovery while main's translator owns its reset-time note", () => {
  fixture.shown = [];
  send({ kind: 'limitUnresolved', key: 'claude:limited', reason: 'limit' });
  assert.deepEqual(fixture.shown, [['suggestOtherHarness', ['claude:limited', 'claude', false]]]);
  send({ kind: 'limitUnresolved', key: 'claude:limited', reason: 'expired' });
  assert.equal(fixture.shown.length, 1);
});

test('streamed text and thinking are held and joined, then shown before the next event that is not a stream event', async () => {
  const key = 'claude:display-1';
  fixture.shown = [];
  item(key, 'turn/started', { turn: { id: 'T' } });
  assert.deepEqual(methods(), ['turn/started']);
  text(key, 'Hel');
  text(key, 'lo');
  thought(key, 'hmm');
  assert.equal(fixture.shown.length, 1, 'deltas wait for the paint');
  // an approval card arriving: what was streamed shows first
  send({ kind: 'permission', key, requestId: 'cperm-1' });
  assert.deepEqual(fixture.shown.slice(1), [
    ['item/agentMessage/delta', { threadId: key, turnId: 'T', itemId: 'msg1:0', delta: 'Hello' }],
    ['item/reasoning/summaryTextDelta', { threadId: key, turnId: 'T', itemId: 'msg1:1', summaryIndex: 0, delta: 'hmm' }],
  ]);
  // a toast from main flushes too, and is still shown
  text(key, '!');
  send({ kind: 'toast', text: 'heads up', level: 'info' });
  assert.deepEqual(
    fixture.shown.slice(-2).map(([m, p]: [string, any]) => (m === 'toast' ? p : p.delta)),
    ['!', 'heads up'],
  );
});

test("without another event the held text still shows within a frame's fallback timer", async () => {
  const key = 'claude:display-2';
  fixture.shown = [];
  text(key, 'late');
  assert.equal(methods().includes('item/agentMessage/delta'), false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fixture.shown.at(-1)[1].delta, 'late');
});

test('a steered event shows the text streamed before it, ahead of the item main sends for the message', () => {
  const key = 'claude:display-3';
  fixture.state.threads[key] = { id: key, cwd: '/repo' };
  fixture.shown = [];
  text(key, 'working');
  send({ kind: 'steered', key, chatId: key, text: 'also this', clientId: 'c-1', attachments: [] });
  item(key, 'item/completed', { turnId: 'T', item: { type: 'userMessage', id: 'c-1' } });
  assert.deepEqual(methods(), ['item/agentMessage/delta', 'item/completed']);
});
