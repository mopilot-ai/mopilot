// electron/capabilities/contract/controlRefusals.cjs (#1724): the one line a chat keeps when computer use refused an app or a
// native turn was stopped, on every harness: its words, the note in the chat's file (once per turn and app), what the
// model is told, and a tool call's refusal reaching it through the Registry's guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ControlRefusals,
  refusalText,
  modelNote,
  helperRefusal,
  noGoError,
} = require('../electron/capabilities/contract/controlRefusals.cjs');
const { Registry, ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { noteNoGo } = require('../electron/capabilities/contract/actionGuard.cjs');

const SELF = { reason: 'self', app: 'ai.mopilot.code', name: 'MoPilot' };

test('the transcript line is short, and names the app or who holds the Mac', () => {
  assert.equal(refusalText(SELF), "Computer use can't control MoPilot itself.");
  assert.equal(
    refusalText({ reason: 'builtIn', app: 'com.apple.keychainaccess', name: 'Keychain Access' }),
    "Computer use can't control Keychain Access.",
  );
  assert.equal(refusalText({ reason: 'blocked', app: 'Notes', name: 'Notes' }), 'Notes is blocked in Settings → Computer use.');
  assert.equal(refusalText({ reason: 'busy', holder: 'Fix bug', chat: true }), 'Computer use stopped: "Fix bug" is using this Mac.');
  assert.equal(refusalText({ reason: 'busy', holder: null, chat: true }), 'Computer use stopped: another chat is using this Mac.');
  assert.equal(refusalText({ reason: 'busy', holder: null }), 'Computer use stopped: another app is using this Mac.');
});

test('the model is told why and what to do instead: MoPilot itself points at list_sidebar and the browser tools', () => {
  assert.match(
    modelNote(SELF),
    /^MoPilot stopped your last turn because computer use never controls MoPilot itself\. Do not try it again\. Its projects and chats are listed by the list_sidebar tool/,
  );
  assert.equal(
    modelNote({ reason: 'builtIn', app: 'x', name: 'Passwords' }),
    'MoPilot stopped your last turn because computer use never controls Passwords. Do not try Passwords again; tell the user if the task needs it.',
  );
  assert.match(
    modelNote({ reason: 'blocked', app: 'Notes', name: 'Notes' }),
    /because the user blocked Notes in Settings → Computer use\./,
  );
  assert.equal(
    modelNote({ reason: 'busy', holder: null }),
    'MoPilot stopped your last turn because another app was controlling this Mac. Do not retry computer use until the user asks.',
  );
});

test("the helper's refusal: MoPilot itself, or the deny list's app by its name", () => {
  assert.deepEqual(helperRefusal({ refused: 'MoPilot', name: 'MoPilot', bundleId: 'ai.mopilot.code' }), {
    reason: 'self',
    app: 'MoPilot',
    name: 'MoPilot',
  });
  assert.deepEqual(helperRefusal({ refused: 'MoPilot', bundleId: 'com.github.Electron' }), {
    reason: 'self',
    app: 'com.github.Electron',
    name: 'MoPilot',
  });
  assert.deepEqual(helperRefusal({ refused: 'password manager', name: '1Password', bundleId: 'com.1password.1password' }), {
    reason: 'builtIn',
    app: '1Password',
    name: '1Password',
  });
  // nothing but the reason: the reason stands for the app
  assert.deepEqual(helperRefusal({ refused: 'login window' }), { reason: 'builtIn', app: 'login window', name: 'login window' });
});

/** The store's patchMeta and get over one chat's meta, and the windows told. */
function rig(o: { turn?: string | null; refuse?: boolean } = {}) {
  const metas = new Map<string, any>();
  const changed: any[] = [];
  const chats = {
    record: (id: string) => ({ id, meta: metas.get(id) ?? { notes: [] } }),
    get: (id: string) => ({ id, meta: metas.get(id) }),
    patchMeta: (id: string, patch: any) => {
      if (o.refuse) return false;
      metas.set(id, { ...(metas.get(id) ?? { notes: [] }), ...patch });
      return true;
    },
  };
  let now = 100;
  const r = new ControlRefusals({
    chats,
    turnOf: () => (o.turn === undefined ? 'turn-live' : o.turn),
    changed: (id: string, chat: any) => changed.push([id, chat.meta.notes.length]),
    now: () => now++,
  });
  return { r, metas, changed };
}

test("a refusal is one note in the chat's file, after the turn it stopped, once per turn and app; windows are told", () => {
  const { r, metas, changed } = rig();
  assert.equal(r.note('c1', SELF, 'turn1'), true);
  assert.equal(r.note('c1', SELF, 'turn1'), false, 'the same turn and app: no second line');
  assert.equal(r.note('c1', { reason: 'blocked', app: 'Notes', name: 'Notes' }, 'turn1'), true);
  // the chat's running turn when the caller does not know it (a tool call), and a busy stop names no app
  assert.equal(r.note('c1', { reason: 'busy', holder: null }), true);
  assert.equal(r.note('c1', SELF), true, 'another turn: its own line');
  assert.deepEqual(metas.get('c1').notes, [
    {
      id: 'control-100-1',
      kind: 'control',
      text: "Computer use can't control MoPilot itself.",
      refused: { app: 'ai.mopilot.code', name: 'MoPilot' },
      turnId: 'turn1',
      turn: Number.MAX_SAFE_INTEGER,
      at: 100,
    },
    {
      id: 'control-101-2',
      kind: 'control',
      text: 'Notes is blocked in Settings → Computer use.',
      refused: { app: 'Notes', name: 'Notes' },
      turnId: 'turn1',
      turn: Number.MAX_SAFE_INTEGER,
      at: 101,
    },
    {
      id: 'control-102-3',
      kind: 'control',
      text: 'Computer use stopped: another app is using this Mac.',
      turnId: 'turn-live',
      turn: Number.MAX_SAFE_INTEGER,
      at: 102,
    },
    {
      id: 'control-103-4',
      kind: 'control',
      text: "Computer use can't control MoPilot itself.",
      refused: { app: 'ai.mopilot.code', name: 'MoPilot' },
      turnId: 'turn-live',
      turn: Number.MAX_SAFE_INTEGER,
      at: 103,
    },
  ]);
  assert.deepEqual(changed, [
    ['c1', 1],
    ['c1', 2],
    ['c1', 3],
    ['c1', 4],
  ]);
  // no chat: nothing
  assert.equal(r.note('', SELF), false);
});

test('a chat with no running turn keeps the line on its latest turn; a store that keeps nothing tells no window', () => {
  const idle = rig({ turn: null });
  assert.equal(idle.r.note('c1', SELF), true);
  assert.equal(idle.metas.get('c1').notes[0].turnId, null);
  const stuck = rig({ refuse: true });
  assert.equal(stuck.r.note('c1', SELF, 't'), false);
  assert.deepEqual(stuck.changed, []);
});

test("a tool call's no-go refusal reaches the Registry's onNoGo with its chat; outside a call nothing happens", async () => {
  const registry = new Registry();
  const seen: any[] = [];
  registry.register({
    name: 'refuser',
    policy: 'observe',
    handler: async () => {
      throw noGoError('MoPilot never controls MoPilot', 'refused', SELF);
    },
  });
  // no listener yet: the call still fails with its refusal
  const before = await registry.invoke('c1', 'c1', 'refuser', {});
  assert.deepEqual(before.error, { code: 'refused', message: 'MoPilot never controls MoPilot' });
  registry.onNoGo = (chatId: string, r: any) => seen.push([chatId, r]);
  const res = await registry.invoke('c1', 'c1', 'refuser', {});
  assert.equal(res.ok, false);
  assert.deepEqual(seen, [['c1', SELF]]);
  // outside any call: no chat to note it in
  noteNoGo(SELF);
  assert.equal(seen.length, 1);
  assert.ok(noGoError('m', 'refused', SELF) instanceof ToolError);
});

test('a chat with no record yet, or a record with no notes, gets its first line', () => {
  for (const rec of [undefined, {}, { meta: {} }]) {
    const patched: any[] = [];
    const r = new ControlRefusals({
      chats: { record: () => rec, get: () => ({}), patchMeta: (_id: string, p: any) => (patched.push(p), true) },
      turnOf: () => 't',
      changed: () => {},
    });
    assert.equal(r.note('c', SELF), true, JSON.stringify(rec));
    assert.equal(patched[0].notes.length, 1);
  }
});
