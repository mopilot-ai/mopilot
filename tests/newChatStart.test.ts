// src/session/newChatStart.ts: new chats follow the last used harness, model and effort, or start from Settings' fixed
// default, with the store, send and selection layers replaced by spies.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { sourceImports } from './support/source-modules.ts';

let state: any;
let picked: { h: string; sel: { model: string | null; effort: string | null } } | null = null;
let onMachine = new Set<string>();
const calls: [string, ...any[]][] = [];
let sentListener: ((chatId: string, kind: string) => void) | null = null;
const selections: Record<string, { model: string | null; effort: string | null }> = {};
const fixture = {
  get: () => state,
  setPrefs: (patch: any) => {
    calls.push(['setPrefs', patch]);
    state.prefs = { ...state.prefs, ...patch };
  },
  onMessageSent: (listener: (chatId: string, kind: string) => void) => {
    sentListener = listener;
    return () => undefined;
  },
  onMachineNow: (id: string) => onMachine.has(id),
  savedDefaultHarness: (s: any = state) => s.prefs.defaultHarness,
  newChatHarness: (s: any = state) => s.firstTier ?? 'codex',
  isMomoChat: (momo: Record<string, unknown>, id: string) => Object.hasOwn(momo, id),
  clearDraftPick: () => {
    calls.push(['clearDraftPick']);
    picked = null;
  },
  draftPicked: () => picked,
  rememberChatSelection: (id: string) => calls.push(['rememberChatSelection', id]),
  selectionFor: (h: string) => selections[h],
  setSelection: (h: string, patch: any, threadId: unknown) => {
    calls.push(['setSelection', h, patch, threadId]);
    selections[h] = { ...selections[h], ...patch };
  },
};
(globalThis as any).__newChatStartFixture = fixture;
const url = new URL('../src/session/newChatStart.ts', import.meta.url).href;
// the real harness-kind rules (shared/defaultHarness.mjs, harness/adapter.ts); everything else is the fixture
const REAL = new Set(['../../shared/defaultHarness.mjs', '../harness/adapter']);
const stubs: Record<string, string> = {};
for (const { specifier, names } of sourceImports(new URL(url))) {
  if (REAL.has(specifier)) continue;
  stubs[specifier] =
    'const f=globalThis.__newChatStartFixture;' + names.map((name) => `export const ${name}=f.${name}??(()=>{});`).join('');
}
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL === url && stubs[s]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs[s]) };
    try {
      return next(s, c);
    } catch (e) {
      if (s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c);
      throw e;
    }
  },
});
const M = await import(url);

beforeEach(() => {
  calls.length = 0;
  picked = null;
  onMachine = new Set();
  selections.codex = { model: 'gpt-a', effort: 'medium' };
  selections.claude = { model: 'sonnet', effort: 'high' };
  state = {
    momoChats: { momo1: {} },
    prefs: { defaultHarness: 'codex', newChatStart: 'last', lastHarness: null, newChatDefault: null },
  };
});

test('new chats follow the last used unless a fixed default was chosen; older prefs follow the last used', () => {
  assert.equal(M.newChatStartMode(), 'last');
  state.prefs.newChatStart = undefined;
  assert.equal(M.newChatStartMode(), 'last');
  state.prefs.newChatStart = 'default';
  assert.equal(M.newChatStartMode(state), 'default');
});

test('a message sent here makes its harness and its own model and effort the last used', () => {
  assert.equal(sentListener, M.rememberUsedChat, 'listens to every message main takes');
  sentListener!('c1', 'claude');
  assert.deepEqual(calls, [
    ['setPrefs', { lastHarness: 'claude' }],
    ['rememberChatSelection', 'c1'],
  ]);
  // the same harness again: only the chat's selection is read again
  calls.length = 0;
  M.rememberUsedChat('c2', 'claude');
  assert.deepEqual(calls, [['rememberChatSelection', 'c2']]);
  // a basic harness counts too
  calls.length = 0;
  M.rememberUsedChat('c3', 'acp:opencode');
  assert.equal(state.prefs.lastHarness, 'acp:opencode');
  // with a fixed default only the harness is remembered: the open draft keeps the default's model and effort
  state.prefs.newChatStart = 'default';
  calls.length = 0;
  M.rememberUsedChat('c4', 'codex');
  assert.deepEqual(calls, [['setPrefs', { lastHarness: 'codex' }]]);
});

test("a chat on another machine, MoMo's chats and an unknown harness don't count", () => {
  onMachine.add('remote');
  M.rememberUsedChat('remote', 'codex');
  M.rememberUsedChat('momo1', 'claude');
  M.rememberUsedChat('c1', undefined);
  M.rememberUsedChat('c1', 'acp:');
  assert.deepEqual(calls, []);
  assert.equal(state.prefs.lastHarness, null);
});

test('a fixed default sets the fresh draft back to its model and effort', () => {
  state.prefs.newChatStart = 'default';
  state.prefs.newChatDefault = { harness: 'codex', model: 'gpt-b', effort: 'xhigh' };
  M.applyNewChatDefault();
  assert.deepEqual(calls, [['clearDraftPick'], ['setSelection', 'codex', { model: 'gpt-b', effort: 'xhigh' }, null]]);
  // already there: nothing to write
  calls.length = 0;
  M.applyNewChatDefault();
  assert.deepEqual(calls, [['clearDraftPick']]);
  // only the effort differs: still set back
  selections.codex.effort = 'low';
  calls.length = 0;
  M.applyNewChatDefault();
  assert.deepEqual(calls.at(-1), ['setSelection', 'codex', { model: 'gpt-b', effort: 'xhigh' }, null]);
});

test("a draft with the user's own pick keeps it, unless Settings changed the default just now", () => {
  state.prefs.newChatStart = 'default';
  state.prefs.newChatDefault = { harness: 'codex', model: 'gpt-b', effort: 'xhigh' };
  picked = { h: 'codex', sel: { model: 'gpt-a', effort: 'medium' } };
  M.applyNewChatDefault();
  assert.deepEqual(calls, []);
  M.applyNewChatDefault(true);
  assert.deepEqual(calls, [['clearDraftPick'], ['setSelection', 'codex', { model: 'gpt-b', effort: 'xhigh' }, null]]);
});

test("a pick in another chat or window since gives the draft's own pick back, in either mode", () => {
  // the draft picked Opus at low; a Claude chat's pick wrote Sonnet at high since
  state.firstTier = 'claude';
  picked = { h: 'claude', sel: { model: 'opus', effort: 'low' } };
  M.applyNewChatDefault();
  assert.deepEqual(calls, [['setSelection', 'claude', { model: 'opus', effort: 'low' }, null]]);
  state.prefs.newChatStart = 'default';
  state.prefs.newChatDefault = { harness: 'codex', model: 'gpt-b', effort: 'xhigh' };
  selections.claude = { model: 'sonnet', effort: 'low' };
  calls.length = 0;
  M.applyNewChatDefault();
  assert.deepEqual(calls, [['setSelection', 'claude', { model: 'opus', effort: 'low' }, null]]);
});

test('no fixed default applies while following the last used, or for another or a basic harness', () => {
  state.prefs.newChatDefault = { harness: 'codex', model: 'gpt-b', effort: 'xhigh' };
  M.applyNewChatDefault();
  state.prefs.newChatStart = 'default';
  state.prefs.newChatDefault = null;
  M.applyNewChatDefault();
  // saved for a harness that is no longer the default
  state.prefs.newChatDefault = { harness: 'claude', model: 'opus', effort: 'high' };
  M.applyNewChatDefault();
  // a basic harness starts with its own options
  state.prefs.defaultHarness = 'acp:opencode';
  state.prefs.newChatDefault = { harness: 'acp:opencode', model: null, effort: null };
  M.applyNewChatDefault();
  assert.deepEqual(
    calls.filter(([name]) => name === 'setSelection'),
    [],
  );
});

test('choosing a fixed default with none saved keeps what the default harness uses now', () => {
  state.prefs.defaultHarness = 'claude';
  M.setNewChatStart('default');
  assert.deepEqual(state.prefs.newChatDefault, { harness: 'claude', model: 'sonnet', effort: 'high' });
  assert.equal(state.prefs.newChatStart, 'default');
  // what it keeps is already the draft's: nothing to set back
  assert.equal(calls.filter(([name]) => name === 'setSelection').length, 0);
});

test('a fixed default already saved for the default harness is kept, and applied over a draft pick', () => {
  state.prefs.newChatDefault = { harness: 'codex', model: 'gpt-b', effort: 'low' };
  picked = { h: 'codex', sel: { model: 'gpt-a', effort: 'medium' } };
  M.setNewChatStart('default');
  assert.deepEqual(calls, [
    ['setPrefs', { newChatStart: 'default' }],
    ['clearDraftPick'],
    ['setSelection', 'codex', { model: 'gpt-b', effort: 'low' }, null],
  ]);
});

test('back to the last used, or a basic default harness: only the mode is saved', () => {
  M.setNewChatStart('last');
  state.prefs.defaultHarness = 'acp:opencode';
  M.setNewChatStart('default');
  assert.deepEqual(
    calls.filter(([name]) => name === 'setPrefs'),
    [
      ['setPrefs', { newChatStart: 'last' }],
      ['setPrefs', { newChatStart: 'default' }],
    ],
  );
  assert.equal(state.prefs.newChatDefault, null);
});

test("Settings' fixed model and effort are saved and applied at once", () => {
  state.prefs.newChatStart = 'default';
  picked = { h: 'codex', sel: { model: 'gpt-a', effort: 'medium' } };
  M.setNewChatDefault('codex', 'gpt-c', 'high');
  assert.deepEqual(state.prefs.newChatDefault, { harness: 'codex', model: 'gpt-c', effort: 'high' });
  assert.deepEqual(calls.at(-1), ['setSelection', 'codex', { model: 'gpt-c', effort: 'high' }, null]);
});

test("Settings' fixed model and effort write only the fixed default: choosing the harness is setDefaultHarness's", () => {
  state.prefs.lastHarness = 'claude';
  M.setNewChatDefault('acp:opencode', null, null);
  assert.deepEqual(calls[0], ['setPrefs', { newChatDefault: { harness: 'acp:opencode', model: null, effort: null } }]);
  assert.equal(state.prefs.lastHarness, 'claude');
});

test("a draft that moved to a newer last used harness leaves its old pick's harness as it is now", () => {
  // picked Opus on Claude; a later message on Codex moved the draft there
  state.firstTier = 'codex';
  picked = { h: 'claude', sel: { model: 'opus', effort: 'low' } };
  M.applyNewChatDefault();
  assert.deepEqual(calls, []);
});
