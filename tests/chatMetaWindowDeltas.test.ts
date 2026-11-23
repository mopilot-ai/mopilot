// A window's chat-meta patch changes only what that window changed (#2520): its config goes as key-level changes and its
// notes as the ones it added, merged in main onto the chat as main has it now, so keys and notes main wrote while the
// window's copy was older (a turn's kept model and effort, a harness switch, a refusal note) stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chatChanges, type ChatMaps, type ChatNote } from '../src/lib/chatMeta.ts';
import { tmp } from './support/chat-store-profile.ts';

const require = createRequire(import.meta.url);
const { ChatsStore, registerChats } = require('../electron/platform/chats.cjs');
const { windowPatch } = require('../electron/platform/windowMetaPatch.cjs');

test("a window cannot replace or clear main's captured host-continuation model", () => {
  assert.deepEqual(windowPatch({ continueModel: { owner: 'forged', model: 'wrong' }, pinned: true }, {}), { pinned: true });
  assert.deepEqual(windowPatch({ continueModel: null }, {}), {});
});

test('a stale window cannot clear the initial session title or echo it back as an edit', (t) => {
  const w = world(t);
  w.store.patchMeta('c', { initialTitle: 'Login timing' });
  assert.equal(w.ipc('c', { initialTitle: null, pinned: true }), true);
  assert.equal(w.store.get('c').meta.initialTitle, 'Login timing');
  assert.deepEqual(w.windowSends(maps(), maps({ chatInitialTitles: { c: 'Forged title' } })), []);
});

const maps = (o: Partial<ChatMaps> = {}): ChatMaps => ({
  pinned: {},
  unread: {},
  worktreeOf: {},
  chatProject: {},
  claudeArchived: {},
  claudeChats: {},
  chatNotes: {},
  chatConfig: {},
  segments: {},
  ...o,
});

function world(t: any) {
  const { threads, ui } = tmp(t);
  const store = new ChatsStore(threads, { uiState: ui });
  const h = new Map<string, any>();
  const sent: any[] = [];
  registerChats({ handle: (ch: string, f: any) => h.set(ch, f) }, { store, uiState: ui, broadcast: (...a: any[]) => sent.push(a) });
  /** What boot.ts sends for a window's change from `prev` to `next`. */
  const windowSends = (prev: ChatMaps, next: ChatMaps) => {
    const { meta } = chatChanges(prev, next);
    return Object.entries(meta).map(([id, patch]) => ipc(id, patch));
  };
  /** A window's patch as it arrives over IPC. */
  const ipc = (id: string, patch: unknown) => h.get('chats:patchMeta')({ sender: 'w1' }, id, patch);
  return { store, windowSends, ipc, sent };
}

test('a stale window changing one config key keeps the keys main wrote meanwhile', (t) => {
  const w = world(t);
  w.store.patchMeta('c', { config: { model: 'opus' } });
  const seen = maps({ chatConfig: { c: { model: 'opus' } } });
  // main keeps the turn's effort (keepSelection) before the window hears of it
  w.store.patchMeta('c', { config: { model: 'opus', effort: 'low' } });
  // the window, on its older copy, puts the chat in plan mode
  assert.deepEqual(w.windowSends(seen, maps({ chatConfig: { c: { model: 'opus', permission: 'plan' } } })), [true]);
  assert.deepEqual(w.store.get('c').meta.config, { model: 'opus', effort: 'low', permission: 'plan' });
  // the other windows hear the merged config
  assert.deepEqual(w.sent.at(-1)[2].chat.meta.config, { model: 'opus', effort: 'low', permission: 'plan' });
});

test("a window's own config change wins its keys, a null is kept as the chat's own, and a removed key goes", (t) => {
  const w = world(t);
  w.store.patchMeta('c', { config: { model: 'opus', effort: 'max', serviceTier: 'priority' } });
  const before = maps({ chatConfig: { c: { model: 'opus', effort: 'max', serviceTier: 'priority' } } });
  w.windowSends(before, maps({ chatConfig: { c: { model: 'sonnet', effort: null } } }));
  assert.deepEqual(w.store.get('c').meta.config, { model: 'sonnet', effort: null });
  // no change: nothing sent, nothing written
  const same = maps({ chatConfig: { c: { model: 'sonnet', effort: null } } });
  assert.deepEqual(w.windowSends(same, maps({ chatConfig: { c: { model: 'sonnet', effort: null } } })), []);
  // a chat's first config: written whole
  w.windowSends(maps(), maps({ chatConfig: { n: { model: 'gpt-a' } } }));
  assert.deepEqual(w.store.get('n').meta.config, { model: 'gpt-a' });
  // the window drops the chat's config: only the keys it had go
  w.store.patchMeta('n', { config: { model: 'gpt-a', effort: 'low' } });
  w.windowSends(maps({ chatConfig: { n: { model: 'gpt-a' } } }), maps());
  assert.deepEqual(w.store.get('n').meta.config, { effort: 'low' });
  // the last key gone: no config left
  w.windowSends(maps({ chatConfig: { n: { effort: 'low' } } }), maps({ chatConfig: { n: {} } }));
  assert.equal(w.store.get('n').meta.config, null);
});

test('a stale window adding a note keeps the notes main added meanwhile', (t) => {
  const w = world(t);
  const mine: ChatNote = { id: 'n-window', kind: 'answers', text: 'Answered', turnId: 't1', turn: 0, at: 2 };
  const mains: ChatNote = { id: 'n-main', kind: 'control', text: 'Refused TextEdit', turnId: 't1', turn: 0, at: 1 };
  // main adds a note (controlRefusals) before the window hears of it
  w.store.patchMeta('c', { notes: [mains] });
  w.windowSends(maps(), maps({ chatNotes: { c: [mine] } }));
  assert.deepEqual(w.store.get('c').meta.notes, [mains, mine]);
  // the same note again (a window that heard of it late): kept once
  w.windowSends(maps({ chatNotes: { c: [] } }), maps({ chatNotes: { c: [mains, mine] } }));
  assert.deepEqual(w.store.get('c').meta.notes, [mains, mine]);
});

test('a window sending a whole config or notes list (an older build) cannot replace what main has', (t) => {
  const w = world(t);
  w.store.patchMeta('c', { config: { model: 'opus', effort: 'low' }, notes: [{ id: 'a', kind: 'account', text: 'x' }] });
  const patch = w.ipc;
  assert.equal(patch('c', { config: { model: 'gpt-a' }, notes: [], unread: true }), true);
  assert.deepEqual(w.store.get('c').meta.config, { model: 'opus', effort: 'low' });
  assert.equal(w.store.get('c').meta.notes.length, 1);
  assert.equal(w.store.get('c').meta.unread, true);
  // malformed deltas change nothing
  assert.equal(patch('c', { configKeys: 'x', notesAdded: 'y' }), false);
  assert.equal(patch('c', { configKeys: { set: 5, unset: 'effort' }, notesAdded: [null, 7] }), false);
});

test("a chat whose saved config or notes aren't what they should be takes a window's change as its first", () => {
  assert.deepEqual(
    windowPatch({ configKeys: { set: { effort: 'low' }, unset: [] }, notesAdded: [{ id: 'a' }] }, { config: 'broken', notes: {} }),
    {
      config: { effort: 'low' },
      notes: [{ id: 'a' }],
    },
  );
  // not a patch at all: as it came (main refuses it)
  assert.equal(windowPatch(null, {}), null);
});
