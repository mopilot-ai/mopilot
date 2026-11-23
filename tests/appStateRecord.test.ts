// Main-process app-state reads reject non-record JSON without modifying the saved file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPrefs, PREFS_VERSION } from '../src/store/types.ts';

const { createAppState } = createRequire(import.meta.url)('../electron/app/appState.cjs');
const { flushPendingWrites } = createRequire(import.meta.url)('../electron/platform/chats.cjs');
const defaults = { model: null, effort: null, permission: 'default', serviceTier: null, branchPrefix: 'mopilot/' };

function fixture(t: any, dialog?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-app-state-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claude: { chatNames?: (key: string) => boolean; setChatNames: (fn: (key: string) => boolean) => void } = {
    setChatNames: (fn) => (claude.chatNames = fn),
  };
  const state = createAppState({ app: { getPath: () => dir }, live: {}, claude, dialog, isFlagEnabled: () => false });
  return { state, claude, file: path.join(dir, 'ui-state.json') };
}

test('background and window preference reads share branch naming across harnesses and profile upgrades', (t) => {
  const { state, file } = fixture(t);
  for (const defaultHarness of ['codex', 'claude', 'acp:opencode']) {
    for (const [prefsVersion, branchPrefix, expected] of [
      [undefined, 'codex/', 'mopilot/'],
      [2, 'codex/', 'mopilot/'],
      [3, 'codex/', 'mopilot/'],
      [3, 'me-', 'me-'],
      [PREFS_VERSION, 'codex/', 'codex/'],
      [PREFS_VERSION + 1, 'codex/', 'codex/'],
      [PREFS_VERSION, undefined, 'mopilot/'],
    ]) {
      const prefs = { defaultHarness, prefsVersion, branchPrefix };
      const raw = JSON.stringify({ prefs });
      fs.writeFileSync(file, raw);
      assert.equal(state.uiPrefs().branchPrefix, expected);
      assert.equal(loadPrefs(prefs).branchPrefix, expected);
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
  }
});

test('valid JSON scalars and arrays cannot become the app state', (t) => {
  const { state, file } = fixture(t);
  for (const value of [null, [], [{ prefs: { model: 'wrong' } }], 'text', 12, true]) {
    const raw = JSON.stringify(value);
    fs.writeFileSync(file, raw);
    assert.deepEqual(state.uiPrefs(), defaults, raw);
    assert.deepEqual(state.readState(), {}, raw);
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'a read never rewrites damaged state');
  }
});

test('records retain saved preferences and unknown fields; missing and malformed files use defaults', (t) => {
  const { state, file } = fixture(t);
  assert.deepEqual(state.readState(), {});
  assert.deepEqual(state.uiPrefs(), defaults);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(state.readState(), {});
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  const saved = { prefs: { model: 'saved', permission: 'auto' }, futureField: { keep: true } };
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(state.readState(), saved);
  assert.deepEqual(state.uiPrefs(), { ...defaults, ...saved.prefs });
});

test('opening the chat store moves the old default-harness prefs to one, once, before any window reads them', (t) => {
  const { state, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ prefs: { model: 'm', harness: 'codex', basicHarness: 'opencode' }, sidebarOpen: false }));
  state.openChats();
  flushPendingWrites();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  // and a window ran here before: the welcome page counts as finished (chats.cjs settleWelcome, #2034)
  assert.deepEqual(saved.prefs, { model: 'm', defaultHarness: 'acp:opencode', welcomeDone: true });
  assert.equal(saved.sidebarOpen, false);
  // already moved: left as it is
  const before = fs.readFileSync(file, 'utf8');
  state.openChats();
  flushPendingWrites();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a failed move of the default-harness prefs is noted, and the chat store still opens', (t) => {
  const { state, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ prefs: { harness: 'claude' } }));
  // ui-state.json can't be replaced (a full disk, say); other files can
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (to === file) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  assert.doesNotThrow(() => state.openChats());
  assert.ok(state.chats);
  flushPendingWrites();
  // the old prefs are kept, to be moved at the next start (or by the window: src/store/boot.ts)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).prefs, { harness: 'claude' });
});

test('the chat store it opens tells the Claude harness which sessions a chat owns', (t) => {
  const { state, claude } = fixture(t);
  state.openChats();
  // a fork no chat's record names may be discarded (claude:discardFork); a chat's own session may not
  state.chats.records.set('claude:own', { segments: [{ kind: 'claude', nativeId: 'own' }] });
  assert.equal(claude.chatNames!('claude:own'), true);
  assert.equal(claude.chatNames!('claude:fork'), false);
});

test('a state file that keeps failing to save is shown to the user once, and a notice that cannot be shown is noted', async (t) => {
  const messages: any[] = [];
  const { state, file } = fixture(t, {
    showMessageBox: async (options: unknown) => {
      messages.push(options);
      throw new Error('no window to show it');
    },
  });
  state.openChats();
  const error = console.error;
  console.error = () => {};
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (to === file) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  t.after(() => {
    console.error = error;
  });
  state.writeState({ sidebar: 1 });
  for (let i = 0; i < 7; i++) flushPendingWrites();
  await new Promise((r) => setImmediate(r));
  assert.equal(messages.length, 1);
  assert.match(messages[0].detail, /ui-state\.json/);
});

test('with no dialog to show it, a failing save is still logged', (t) => {
  const { state, file } = fixture(t);
  state.openChats();
  const error = console.error;
  console.error = () => {};
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (to === file) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  t.after(() => {
    console.error = error;
  });
  state.writeState({ sidebar: 2 });
  for (let i = 0; i < 7; i++) flushPendingWrites();
});
