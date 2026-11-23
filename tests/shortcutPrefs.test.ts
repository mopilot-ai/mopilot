// Atomic shortcut edits preserve independent windows, validate persisted state and publish only successful writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPrefsDelta } from '../src/lib/chatMeta.ts';
const require = createRequire(import.meta.url);
const { registerShortcutPrefs } = require('../electron/platform/shortcutPrefs.cjs');
const { inspectUiState, updateUiState, flushPendingWrites } = require('../electron/platform/chats.cjs');
// the state the app holds in memory, written at once here so the tests read the file back
const ui = {
  inspect: inspectUiState,
  update: (file: string, fn: (s: any) => any) => {
    const next = updateUiState(file, fn);
    flushPendingWrites();
    return next;
  },
};
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mopilot-binding-'));
  const file = path.join(dir, 'state.json');
  const handlers = new Map<string, Function>();
  const pushes: any[][] = [];
  const updates: any[] = [];
  registerShortcutPrefs(
    { handle: (id: string, fn: Function) => handlers.set(id, fn) },
    { file, ui, broadcast: (...args: any[]) => pushes.push(args), onPrefs: (p: any) => updates.push(p) },
  );
  return {
    file,
    pushes,
    updates,
    save: (id: unknown, key?: unknown) => handlers.get('prefs:binding')!({}, id, key),
    recording: (on: unknown, calls: boolean[]) =>
      handlers.get('prefs:recording')!({ sender: { setIgnoreMenuShortcuts: (on: boolean) => calls.push(on) } }, on),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('independent window edits combine; reset and removal are distinct and retain other preferences', () => {
  const f = fixture();
  try {
    assert.equal(f.save('new-chat', '⇧⌘X'), true);
    assert.equal(f.save('archive', null), true);
    let state = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.deepEqual(state.prefs.keybindings, { 'new-chat': '⇧⌘X', archive: null });
    assert.equal(f.save('new-chat'), true);
    state = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.deepEqual(state.prefs.keybindings, { archive: null });
    let prefs: any = { keybindings: {}, fontSize: 15 };
    for (const [, sender, delta] of f.pushes) {
      assert.equal(sender, null);
      prefs = applyPrefsDelta(prefs, delta);
    }
    assert.deepEqual(prefs, { keybindings: { archive: null }, fontSize: 15 });
    assert.equal(f.updates.length, 3);
    writeFileSync(f.file, JSON.stringify({ prefs: { fontSize: 18 } }));
    assert.equal(f.save('settings', '⇧⌘Y'), true);
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).prefs.fontSize, 18);
  } finally {
    f.clean();
  }
});
test('invalid ids, values, newer schemas and malformed persisted data never publish successful edits', () => {
  const f = fixture();
  try {
    for (const [id, key] of [
      ['pin', '⌘Z'],
      ['pin', '⌘Q'],
      ['pin', '⌘C'],
      ['__proto__', 'x'],
      ['new-chat', ''],
      ['new-chat', 2],
      [null, null],
    ])
      assert.equal(f.save(id, key), false);
    for (const state of [
      null,
      [],
      { stateVersion: 3 },
      { prefs: [] },
      { prefs: { keybindings: [] } },
      { prefs: { keybindings: { pin: 1 } } },
    ]) {
      const text = JSON.stringify(state);
      writeFileSync(f.file, text);
      assert.equal(f.save('new-chat', 'x'), false);
      assert.equal(readFileSync(f.file, 'utf8'), text);
    }
    writeFileSync(f.file, '{truncated');
    assert.throws(() => f.save('new-chat', 'x'));
    assert.equal(f.pushes.length, 0);
    assert.equal(f.updates.length, 0);
    rmSync(f.file);
    mkdirSync(f.file);
    assert.throws(() => f.save('new-chat', null));
    rmSync(f.file, { recursive: true });
    assert.equal(f.save('new-chat', '⇧⌘X'), true);
    assert.deepEqual(applyPrefsDelta({ keybindings: { other: '⇧⌘Y' } }, { binding: { id: 'new-chat', key: null } }), {
      keybindings: { other: '⇧⌘Y', 'new-chat': null },
    });
  } finally {
    f.clean();
  }
});

test('two stale windows cannot create a conflicting assignment; failed edits retain prior data', () => {
  const f = fixture();
  try {
    assert.equal(f.save('pin', '⇧⌘Q'), true);
    const before = readFileSync(f.file, 'utf8');
    assert.equal(f.save('rename', '⇧⌘Q'), false);
    assert.equal(readFileSync(f.file, 'utf8'), before);
    assert.equal(f.pushes.length, 1);
    assert.equal(f.save('pin', null), true);
    assert.equal(f.save('rename', '⇧⌘Q'), true);
  } finally {
    f.clean();
  }
});

test('native shortcut recording is scoped to its sender and validates the input', () => {
  const f = fixture();
  try {
    const values: boolean[] = [];
    assert.equal(f.recording(true, values), true);
    assert.equal(f.recording(false, values), true);
    assert.equal(f.recording('yes', values), false);
    assert.deepEqual(values, [true, false]);
  } finally {
    f.clean();
  }
});
