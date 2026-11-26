// src/store: the default harness for new chats as the store keeps it (one pref, resolved through one rule), a chat's
// own harness beside it, and the window moving the old two prefs when main could not.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll, bootImpls, location, impl } from './support/store-harness.ts';
import { PREFS_VERSION } from '../src/store/types.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
});

test('the default harness is one pref: saved as picked, resolved against what runs, its fallback said', () => {
  set({ conn: 'ready', requiresAuth: false, claude: { status: { state: 'ready' } as any, models: [] }, basicHarnesses: [] });
  S.setDefaultHarness('acp:opencode');
  assert.equal(st().prefs.defaultHarness, 'acp:opencode');
  assert.equal(S.savedDefaultHarness(), 'acp:opencode');
  // not installed: Codex runs new chats, and the pages say so
  assert.deepEqual(S.defaultHarness(), { saved: 'acp:opencode', kind: 'codex', firstTier: 'codex', fallback: 'missing' });
  assert.equal(S.defaultHarnessFallbackNote(), 'opencode isn’t installed; new chats start in Codex');
  assert.equal(S.newChatBasic(), null);
  set({ basicHarnesses: [{ id: 'opencode', state: 'admitted' }] as any });
  assert.equal(S.newChatBasic(), 'opencode');
  assert.equal(S.newChatHarness(), 'codex');
  assert.equal(S.defaultHarnessFallbackNote(), null);
  // a first-tier pick replaces the basic one: nothing is left over to override it
  S.setDefaultHarness('claude');
  assert.deepEqual([S.newChatBasic(), S.newChatHarness(), S.newChatKind()], [null, 'claude', 'claude']);
});

test("a first-tier default that can't run says why: signed out, not installed, turned off (#1872)", () => {
  // a first run: Codex installed but signed out, Claude Code signed out, opencode signed in
  set({
    conn: 'ready',
    requiresAuth: true,
    claude: { status: { state: 'signin' } as any, models: [] },
    basicHarnesses: [{ id: 'opencode', state: 'admitted' }] as any,
  });
  S.setDefaultHarness('codex');
  assert.equal(S.defaultHarnessFallbackNote(), 'Codex isn’t signed in; new chats start in opencode');
  S.setDefaultHarness('claude');
  assert.equal(S.defaultHarnessFallbackNote(), 'Claude Code isn’t signed in; new chats start in opencode');
  set({ claude: { status: { state: 'missing' } as any, models: [] } });
  assert.equal(S.defaultHarnessFallbackNote(), 'Claude Code isn’t installed; new chats start in opencode');
  // nothing more is known: it can't run
  set({ conn: 'error', requiresAuth: false, claude: { status: { state: 'error' } as any, models: [] } });
  assert.equal(S.defaultHarnessFallbackNote(), 'Claude Code can’t run right now; new chats start in opencode');
  S.setDefaultHarness('codex');
  assert.equal(S.defaultHarnessFallbackNote(), 'Codex can’t run right now; new chats start in opencode');
  // what the Harnesses page says, the note says (one rule, harness/codexState.ts)
  set({ conn: 'error', connError: 'spawn codex ENOENT' } as any);
  assert.equal(S.defaultHarnessFallbackNote(), 'Codex isn’t installed; new chats start in opencode');
  // a file that is no program on Windows (a pinned path to something else) can't be run either: not installed
  set({ conn: 'error', connError: 'spawn EFTYPE' } as any);
  assert.equal(S.defaultHarnessFallbackNote(), 'Codex isn’t installed; new chats start in opencode');
  // a version that doesn't work isn't fixed by signing in
  set({ conn: 'ready', connError: null, requiresAuth: true, codexCompat: { versionStatus: 'tooOld', cliVersion: '0.1' } } as any);
  assert.equal(S.defaultHarnessFallbackNote(), 'Codex can’t run right now; new chats start in opencode');
  set({ codexCompat: null } as any);
  assert.equal(S.defaultHarnessFallbackNote(), 'Codex isn’t signed in; new chats start in opencode');
  // switched off by the server
  impl['flags.isEnabled'] = (k: string) => !k.startsWith('harness.');
  try {
    assert.equal(S.defaultHarnessFallbackNote(), 'Codex is turned off; new chats start in opencode');
    S.setDefaultHarness('claude');
    assert.equal(S.defaultHarnessFallbackNote(), 'Claude Code is turned off; new chats start in opencode');
  } finally {
    impl['flags.isEnabled'] = () => true;
  }
});

test('choosing the default: a first-tier harness left for first use starts, so new chats resolve to it', async () => {
  set({ conn: 'idle', requiresAuth: false, claude: { status: { state: 'ready' } as any, models: [] }, basicHarnesses: [] });
  // a basic harness or a running one: only the pref changes
  S.chooseDefaultHarness('acp:opencode');
  S.chooseDefaultHarness('claude');
  assert.equal(st().prefs.defaultHarness, 'claude');
  assert.equal(callsOf('codex.start').length, 0);
  // Codex idle: picked, it starts, rather than new chats quietly staying on Claude Code
  S.chooseDefaultHarness('codex');
  assert.equal(st().prefs.defaultHarness, 'codex');
  assert.equal(callsOf('codex.start').length, 1);
});

test("a chat's own harness is its current segment's, whatever new chats default to", () => {
  set({
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    segments: {
      k: [{ nativeId: 'acp:kimi:1', harness: 'codex', start: 0 }],
      sw: [
        { nativeId: 'sw', harness: 'codex', start: 0 },
        { nativeId: 'cl', harness: 'claude', start: 2 },
      ],
    } as any,
  });
  assert.deepEqual(
    ['k', 'acp:qwen:2', 'sw', 'plain'].map((id) => S.chatKind(id)),
    ['acp:kimi', 'acp:qwen', 'claude', 'codex'],
  );
});

test('a window whose saved prefs still hold the old two fields moves them itself, and never reads them', async () => {
  location.hash = '';
  bootImpls({
    'app.info': async () => ({ home: '/home/me', dark: false, codexHome: '/home/me/.codex' }),
    'state.read': async () => ({ prefs: { prefsVersion: PREFS_VERSION, harness: 'codex', basicHarness: 'opencode' } }),
  });
  await S.boot({ quickChat: true });
  assert.equal(st().prefs.defaultHarness, 'acp:opencode');
  assert.equal('harness' in st().prefs, false);
  assert.equal('basicHarness' in st().prefs, false);
  assert.deepEqual(callsOf('prefs.patch')[0], [{ defaultHarness: 'acp:opencode' }, ['harness', 'basicHarness']]);
});

test('saved prefs without a valid default load as Codex', async () => {
  location.hash = '';
  bootImpls({
    'app.info': async () => ({ home: '/home/me', dark: false, codexHome: '/home/me/.codex' }),
    'state.read': async () => ({ prefs: { prefsVersion: PREFS_VERSION, defaultHarness: 'acp:Not Valid' } }),
  });
  await S.boot({ quickChat: true });
  assert.equal(st().prefs.defaultHarness, 'codex');
  assert.equal(S.savedDefaultHarness(), 'codex');
});

test('new chats start on the harness last used, or on the saved default once a fixed default is chosen', () => {
  set({ conn: 'ready', requiresAuth: false, claude: { status: { state: 'ready' } as any, models: [] }, basicHarnesses: [] });
  S.setDefaultHarness('codex');
  // nothing used yet: the saved default
  assert.equal(S.defaultHarness().kind, 'codex');
  S.setPrefs({ lastHarness: 'claude' });
  assert.deepEqual([S.defaultHarness().kind, S.newChatHarness(), S.savedDefaultResolved().kind], ['claude', 'claude', 'codex']);
  // picking the harness the draft starts on anyway leaves no pick; another one is the draft's
  S.pickNewChatHarness('claude');
  assert.equal(st().newChatHarnessPick, null);
  S.pickNewChatHarness('codex');
  assert.deepEqual([st().newChatHarnessPick, S.defaultHarness().kind], ['codex', 'codex']);
  S.resetNewChatDefaults();
  assert.equal(S.defaultHarness().kind, 'claude');
  // a fixed default: the saved one, whatever was used last
  S.setPrefs({ newChatStart: 'default' });
  assert.equal(S.defaultHarness().kind, 'codex');
  S.pickNewChatHarness('codex');
  assert.equal(st().newChatHarnessPick, null);
});

test("a last used harness that can't run now falls back like the saved default, and says so", () => {
  set({ conn: 'ready', requiresAuth: false, claude: { status: { state: 'ready' } as any, models: [] }, basicHarnesses: [] });
  S.setDefaultHarness('claude');
  S.setPrefs({ lastHarness: 'acp:opencode' });
  assert.deepEqual(S.defaultHarness(), { saved: 'acp:opencode', kind: 'codex', firstTier: 'codex', fallback: 'missing' });
  assert.equal(S.defaultHarnessFallbackNote(), 'opencode isn’t installed; new chats start in Codex');
});

test('choosing the default anywhere is the latest choice while new chats follow the last used, and moves a fixed default', () => {
  set({ conn: 'ready', requiresAuth: false, claude: { status: { state: 'ready' } as any, models: [] }, basicHarnesses: [] });
  S.setPrefs({ lastHarness: 'codex', model: 'gpt-a', effort: 'low', claudeSelection: { model: 'opus', effort: 'high', fast: false } });
  // the account menu and Welcome choose it the same way as Settings
  S.setDefaultHarness('claude');
  assert.deepEqual([st().prefs.lastHarness, S.defaultHarness().kind], ['claude', 'claude']);
  assert.deepEqual(st().prefs.newChatDefault, { harness: 'claude', model: 'opus', effort: 'high' });
  // a fixed default already for that harness is kept; with a fixed default the last used stays as it was
  S.setPrefs({ newChatStart: 'default', newChatDefault: { harness: 'codex', model: 'gpt-b', effort: 'xhigh' } });
  S.setDefaultHarness('codex');
  assert.deepEqual([st().prefs.lastHarness, st().prefs.newChatDefault], ['claude', { harness: 'codex', model: 'gpt-b', effort: 'xhigh' }]);
  // a basic harness keeps its own options
  S.setDefaultHarness('acp:opencode');
  assert.deepEqual(st().prefs.newChatDefault, { harness: 'acp:opencode', model: null, effort: null });
});
