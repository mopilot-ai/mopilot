import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { sourceImports } from './support/source-modules.ts';
import './support/dom.ts';
import { create } from 'zustand';

let state: any;
let pendingSwitch: any = null;
const { pickPendingModel } = createRequire(import.meta.url)('../electron/session/pendingModel.cjs');
const messages: string[] = [];
const fixture = {
  getState: () => state,
  chatFamily: (id: string) => (id.startsWith('claude') ? 'claude' : 'codex'),
  setPrefs: (patch: any) => Object.assign(state.prefs, patch),
  setChatConfig: (id: string, patch: any) => {
    state.chatConfig[id] = { ...state.chatConfig[id], ...patch };
  },
  patchRuntime: (id: string, update: any) => {
    state.runtime[id] = { ...state.runtime[id], ...update(state.runtime[id] ?? {}) };
  },
  sessionOf: () => ({ pendingSwitch }),
  native: {
    session: {
      pendingModel: async (id: string, harness: string, model: string | null, effort?: string | null) =>
        pickPendingModel(
          {
            get: () => ({ pendingSwitch }),
            patch: (_id: string, patch: any) => {
              pendingSwitch = patch.pendingSwitch;
            },
          },
          id,
          harness,
          model,
          effort,
        ),
    },
  },
  toast: (message: string) => messages.push(message),
  toastFailure: (message: string) => () => messages.push(message),
  // the hooks subscribe to this window store (useChatAccount)
  useStore: (select: (s: any) => any) => app(select),
};
const app = create<any>(() => ({}));
(globalThis as any).__selectionFixture = fixture;
const url = new URL('../src/session/harness/select.ts', import.meta.url).href;
// Isolate store/native dependencies while executing the actual selection writer, the real
// Codex/Claude selection translators, segment ownership and React (for the hooks).
const STORE_ALIAS: Record<string, string> = { get: 'getState', set: 'setState' };
const stubs: Record<string, string> = {};
for (const { specifier, names } of sourceImports(new URL(url))) {
  if (
    [
      '../../harness/codexSettings',
      '../../harness/claudeTranslate',
      '../../harness/ownership',
      './chatAccount',
      '../../harness/claude/own',
      '../../../shared/switchModel.mjs',
      '../../../shared/modelChoice.mjs',
      '../../lib/format',
      'react',
    ].includes(specifier)
  )
    continue;
  // a slice's own name for the barrel's getState and setState reads the fixture's
  stubs[specifier] =
    'const f=globalThis.__selectionFixture;' +
    names.map((name) => `export const ${name}=f.${STORE_ALIAS[name] ?? name}??(()=>{});`).join('');
}
// the real per-chat account reader (src/session/harness/chatAccount.ts), over the same window store
const accountUrl = new URL('../src/session/harness/chatAccount.ts', import.meta.url).href;
const accountStubs: Record<string, string> = {};
for (const { specifier, names } of sourceImports(new URL(accountUrl)))
  if (specifier === '../../store/core')
    accountStubs[specifier] =
      'const f=globalThis.__selectionFixture;' +
      names.map((name) => `export const ${name}=f.${STORE_ALIAS[name] ?? name}??(()=>{});`).join('');
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL === url && stubs[s]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs[s]) };
    if (c.parentURL === accountUrl && accountStubs[s])
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(accountStubs[s]) };
    try {
      return next(s, c);
    } catch (e) {
      if (s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c);
      throw e;
    }
  },
});
const { setSelection, selectionFor, useChatAccount, rememberChatSelection, composerSelect, draftPicked, clearDraftPick } = await import(
  url
);
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

function reset() {
  pendingSwitch = null;
  messages.length = 0;
  state = {
    prefs: {
      model: 'default-model',
      effort: 'medium',
      serviceTier: 'default',
      claudeSelection: { model: 'sonnet', effort: 'medium', fast: false },
    },
    chatConfig: {
      codex: { model: 'chat-model', effort: 'high', serviceTier: 'priority' },
      other: { model: 'other-model', effort: 'low', serviceTier: 'default' },
    },
    runtime: { claude: { settings: { model: 'opus', effort: 'high' } } },
    models: [],
    claude: {
      models: [
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
      ],
    },
  };
}

test('Codex model selection updates the chat and future defaults, preserving other chat selections', () => {
  reset();
  setSelection('codex', { model: 'new-model', effort: 'low', fast: false }, 'codex');
  assert.deepEqual(state.chatConfig.codex, { model: 'new-model', effort: 'low', serviceTier: 'default' });
  assert.deepEqual(selectionFor('codex'), { model: 'new-model', effort: 'low', fast: false });
  assert.deepEqual(state.chatConfig.other, { model: 'other-model', effort: 'low', serviceTier: 'default' });
});

for (const patch of [{ effort: 'low' }, { fast: false }, { tier: 'flex' }])
  test(`Codex partial selection saves the chat's complete selection as defaults: ${JSON.stringify(patch)}`, () => {
    reset();
    setSelection('codex', patch, 'codex');
    assert.equal(state.prefs.model, 'chat-model');
    assert.equal(state.prefs.effort, 'effort' in patch ? 'low' : 'high');
    assert.equal(state.prefs.serviceTier, 'tier' in patch ? 'flex' : 'fast' in patch ? 'default' : 'priority');
    assert.equal(state.chatConfig.codex.serviceTier, state.prefs.serviceTier);
  });

test('Codex reset clears both the chat selection and future defaults', () => {
  reset();
  setSelection('codex', { model: null, effort: null, fast: false }, 'codex');
  assert.deepEqual(state.chatConfig.codex, { model: null, effort: null, serviceTier: 'default' });
  assert.deepEqual(selectionFor('codex'), { model: null, effort: null, fast: false });
});

for (const patch of [{ model: 'sonnet', effort: 'low' }, { effort: 'low' }, { fast: true }])
  test(`Claude selection updates defaults from its own model/effort: ${JSON.stringify(patch)}`, () => {
    reset();
    setSelection('claude', patch, 'claude');
    const expected = { model: 'opus', effort: 'high', fast: false, ...patch };
    assert.deepEqual(selectionFor('claude'), expected);
    assert.deepEqual(state.runtime.claude.settings, { model: expected.model, effort: expected.effort });
    assert.equal(state.prefs.model, 'default-model', 'Codex defaults remain separate');
  });

test('new-chat picks update defaults; a pending harness switch does not alter the source chat', () => {
  reset();
  setSelection('codex', { model: 'new-default', effort: 'low' }, null);
  assert.equal(state.prefs.model, 'new-default');
  assert.equal(state.chatConfig.codex.model, 'chat-model');
  pendingSwitch = { harness: 'claude' };
  setSelection('claude', { model: 'opus', effort: 'low' }, 'codex');
  assert.deepEqual(selectionFor('claude'), { model: 'opus', effort: 'low', fast: false });
  assert.equal(state.chatConfig.codex.model, 'chat-model');
});

for (const harness of ['codex', 'claude'] as const)
  test(`a ${harness} model pick updates its pending switch and preserves the account and handoff choices`, () => {
    reset();
    pendingSwitch = { harness, model: 'old-model', modelLabel: 'Old', account: 'pinned', mode: 'workspace', goal: 'keep working' };
    setSelection(harness, { model: harness === 'codex' ? 'custom-model' : 'opus' }, 'other');
    assert.equal(pendingSwitch.model, harness === 'codex' ? 'custom-model' : 'opus');
    assert.ok(pendingSwitch.modelLabel);
    assert.deepEqual([pendingSwitch.account, pendingSwitch.mode, pendingSwitch.goal], ['pinned', 'workspace', 'keep working']);
    setSelection(harness, { model: null }, 'other');
    assert.equal(pendingSwitch.model, null);
    assert.equal(pendingSwitch.modelLabel, '');
    assert.equal(pendingSwitch.account, 'pinned');
  });

test('an effort-only pick leaves the pending model and handoff choices intact', () => {
  reset();
  pendingSwitch = { harness: 'claude', model: 'opus', account: 'pinned', mode: 'auto' };
  const before = pendingSwitch;
  setSelection('claude', { effort: 'high' }, 'other');
  assert.equal(pendingSwitch, before);
});

test('an effort pick replaces the level a pending switch was recorded with', () => {
  reset();
  pendingSwitch = { harness: 'claude', model: 'opus', effort: 'low', account: 'pinned', mode: 'auto' };
  setSelection('claude', { effort: 'high' }, 'other');
  assert.deepEqual(
    [pendingSwitch.model, pendingSwitch.effort, pendingSwitch.account, pendingSwitch.mode],
    ['opus', 'high', 'pinned', 'auto'],
  );
  setSelection('claude', { effort: null }, 'other');
  assert.equal(pendingSwitch.effort, null);
});

test('a refused or failed pending model write reports why and leaves the pending choice intact', async () => {
  reset();
  const writer = fixture.native.session.pendingModel;
  pendingSwitch = { harness: 'codex', model: 'original-model' };
  const original = pendingSwitch;
  try {
    fixture.native.session.pendingModel = async () => false;
    setSelection('codex', { model: 'new-model' }, 'other');
    await Promise.resolve();
    assert.match(messages[0], /pending switch changed/);
    fixture.native.session.pendingModel = async () => {
      throw new Error('ipc down');
    };
    setSelection('codex', { model: 'new-model' }, 'other');
    await Promise.resolve();
    assert.equal(messages[1], "Couldn't change the pending model");
    assert.equal(pendingSwitch, original);
  } finally {
    fixture.native.session.pendingModel = writer;
  }
});

test("a chat's account follows its Codex thread and both harnesses' pools", async () => {
  const pinned = { 'thread-1': { id: 'one', pinned: true }, 'thread-2': { id: 'two', pinned: false } };
  app.setState(
    {
      claudeChats: { claude: { id: 'c2', pinned: true } },
      claudeAccounts: { active: 'c1', accounts: [{ id: 'c1', loggedIn: true }] },
      accounts: { active: 'x', accounts: [], chatAccounts: pinned },
      segments: { chat: [{ nativeId: 'thread-1', harness: 'codex' }] },
    },
    true,
  );
  const seen: Record<string, any> = {};
  const View = ({ h, id }: { h: string; id: string | null }) => {
    seen[`${h}:${id ?? ''}`] = useChatAccount(h, id);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const show = () =>
    act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(View, { h: 'codex', id: 'chat' }),
          createElement(View, { h: 'claude', id: 'claude' }),
          createElement(View, { h: 'codex', id: null }),
        ),
      ),
    );
  try {
    await show();
    assert.equal(seen['codex:'], null, 'a chat that has not started has no account of its own');
    assert.deepEqual(seen['codex:chat'], { id: 'one', pinned: true, serving: 'one' });
    // Claude's own login isn't known here: no pin, and the chat runs on the active one
    assert.deepEqual(seen['claude:claude'], { id: 'c1', pinned: false, serving: 'c1' });
    // the chat has another Codex thread now: only its segments change
    await act(async () => app.setState({ segments: { chat: [{ nativeId: 'thread-1' }, { nativeId: 'thread-2', harness: 'codex' }] } }));
    assert.deepEqual(seen['codex:chat'], { id: 'two', pinned: false, serving: 'two' });
    // on Claude Code now: its Codex account is still its Codex thread's (R-5)
    await act(async () =>
      app.setState({
        segments: {
          chat: [
            { nativeId: 'thread-1', harness: 'codex' },
            { nativeId: 'claude:s', harness: 'claude' },
          ],
        },
      }),
    );
    assert.deepEqual(seen['codex:chat'], { id: 'one', pinned: true, serving: 'one' });
    await act(async () => app.setState({ claudeAccounts: { active: 'c1', accounts: [{ id: 'c2', loggedIn: true }] } }));
    assert.deepEqual(seen['claude:claude'], { id: 'c2', pinned: true, serving: 'c2' });
    await act(async () => app.setState({ accounts: { active: 'x', accounts: [], chatAccounts: {} } }));
    assert.equal(seen['codex:chat'], null);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a speed choice made before Claude history loads preserves the linked chat saved model and effort over global defaults', () => {
  reset();
  delete state.runtime.claude;
  state.chatConfig.claude = { model: 'opus', effort: 'low' };
  setSelection('claude', { fast: true }, 'claude');
  assert.deepEqual(selectionFor('claude'), { model: 'opus', effort: 'low', fast: true });
  assert.deepEqual(state.chatConfig.claude, { model: 'opus', effort: 'low' }, 'speed changes do not replace persisted model or effort');
  assert.equal(state.runtime.claude, undefined, 'a speed toggle does not synthesize transcript state');
});

test('a Claude Automatic choice stays automatic when effort or speed becomes the new-chat default', () => {
  reset();
  delete state.runtime.claude;
  state.chatConfig.claude = { model: null, effort: null };
  setSelection('claude', { effort: 'high' }, 'claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: null, effort: 'high', fast: false });
  assert.deepEqual(state.chatConfig.claude, { model: null, effort: 'high' });
  // a saved wire id reads as the list's alias
  state.chatConfig.claude = { model: 'claude-opus-5-5', effort: 'low' };
  setSelection('claude', { fast: true }, 'claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'opus', effort: 'low', fast: true });
});

test('a message sent in a Codex chat makes its own selection the new-chat default; one on the defaults changes nothing', () => {
  reset();
  rememberChatSelection('codex');
  assert.deepEqual([state.prefs.model, state.prefs.effort, state.prefs.serviceTier], ['chat-model', 'high', 'priority']);
  // already the default: no write
  const prefs = state.prefs;
  rememberChatSelection('codex');
  assert.equal(state.prefs, prefs);
  // a chat that never picked keeps the defaults
  reset();
  state.chatConfig.plain = {};
  rememberChatSelection('plain');
  assert.deepEqual([state.prefs.model, state.prefs.effort, state.prefs.serviceTier], ['default-model', 'medium', 'default']);
});

test("a message sent in a Claude chat makes its own model and effort Claude's new-chat default", () => {
  reset();
  rememberChatSelection('claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'opus', effort: 'high', fast: false });
  // the same again: nothing written
  const prefs = state.prefs;
  rememberChatSelection('claude');
  assert.equal(state.prefs, prefs);
  // only the effort differs
  state.runtime.claude.settings.effort = 'low';
  rememberChatSelection('claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'opus', effort: 'low', fast: false });
  // its own model with no effort keeps the default's effort
  reset();
  state.runtime.claude.settings = { model: 'opus', effort: null };
  rememberChatSelection('claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'opus', effort: 'medium', fast: false });
  // an effort it saved as none: the default's effort, as a pick there would keep
  reset();
  state.runtime.claude.settings = { model: 'opus', effort: null };
  state.chatConfig.claude = { effort: null };
  rememberChatSelection('claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'opus', effort: 'medium', fast: false });
});

test("a Claude chat with nothing of its own, on MoMo's brain, or about to switch leaves the defaults alone", () => {
  reset();
  state.runtime = {};
  rememberChatSelection('claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'sonnet', effort: 'medium', fast: false });
  reset();
  state.momoModels = { claude: 'opus' };
  rememberChatSelection('claude');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'sonnet', effort: 'medium', fast: false });
  reset();
  pendingSwitch = { harness: 'codex' };
  rememberChatSelection('claude');
  rememberChatSelection('codex');
  assert.deepEqual(state.prefs.claudeSelection, { model: 'sonnet', effort: 'medium', fast: false });
  assert.equal(state.prefs.model, 'default-model');
});

test("a pick in a new chat's composer is that draft's until a new draft starts; a chat's own pick is not", () => {
  reset();
  state.newChatHarnessRevision = 3;
  composerSelect('codex', { effort: 'low' }, 'codex');
  assert.equal(draftPicked(), null);
  assert.equal(state.chatConfig.codex.effort, 'low');
  composerSelect('codex', { effort: 'xhigh' }, null);
  assert.equal(state.prefs.effort, 'xhigh');
  // what the draft shows, kept to give back after a pick elsewhere writes the same defaults
  assert.deepEqual(draftPicked(), { rev: 3, h: 'codex', sel: { model: 'chat-model', effort: 'xhigh', fast: true } });
  assert.equal(draftPicked({ newChatHarnessRevision: 4 }), null, 'a new draft has no pick');
  clearDraftPick();
  assert.equal(draftPicked(), null);
});
