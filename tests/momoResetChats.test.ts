// Reset MoMo's chats (#2291, electron/momo/chatsReset.cjs): a chat its harness no longer has counts as deleted
// (session/chatDeletion.cjs nativeGone, Codex's "no rollout found" and the Claude SDK's "Session … not found"), one chat
// that fails never keeps the others, a running turn is stopped first, and a deleted chat's record leaves the disk
// (platform/chats.cjs forgetDeleted) so no restart finds it as MoMo's again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { flushPendingWrites } = require('../electron/platform/chats.cjs');
const { ChatDeletion, nativeGone } = require('../electron/session/chatDeletion.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { resetMomoChats } = require('../electron/momo/chatsReset.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'momo-reset-chats-'));
/** A MoMo chat on `kind`, its id the key of its native chat (bare for Codex, '<kind>:<id>' otherwise). */
const chat = (nativeId: string, kind = 'codex', momo = 'main') => ({
  id: kind === 'codex' ? nativeId : `${kind}:${nativeId}`,
  segments: [{ kind, nativeId, start: 0, count: null }],
  meta: { momo },
});

/** A real chat store and deletion over a scratch folder; each harness's delete is `remove[family]`. */
function world(o: { uiState?: boolean } = {}) {
  const root = tmp();
  const uiState = path.join(root, 'ui-state.json');
  const chats = new ChatsStore(path.join(root, 'threads'), o.uiState ? { uiState, legacyMirror: true } : { legacyMirror: false });
  const calls: string[] = [];
  const remove: any = {
    codex: async (t: any) => void calls.push(t.key),
    claude: async (t: any) => void calls.push(t.key),
    acp: async (t: any) => void calls.push(t.key),
  };
  const deletion = new ChatDeletion({ store: chats, remove, broadcast: () => undefined });
  const stopped: string[] = [];
  const live: any = { chats, chatDeletion: deletion, controller: { stopChat: async (id: string) => void stopped.push(id) } };
  const dir = path.join(root, 'momo');
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{"mainChatId":"a"}');
  const mainChat = { savedId: 'a' as unknown };
  return { root, uiState, chats, calls, remove, deletion, stopped, live, dir, mainChat };
}

test('the harness saying it has no such chat counts as deleted; any other failure does not', () => {
  assert.equal(nativeGone('codex', new Error('no rollout found for thread id 01a16c70-161e-7140-9b83-7b9f14281aa4')), true);
  assert.equal(nativeGone('claude', new Error('Session 5f0c not found in any project directory')), true);
  assert.equal(nativeGone('claude', 'Session not found (no projects directory)'), true);
  assert.equal(nativeGone('codex', new Error('thread not loaded: 01a16c70')), false, 'not loaded is not gone');
  assert.equal(nativeGone('codex', new Error('Session x not found')), false, 'each harness its own words');
  assert.equal(nativeGone('acp', new Error('no rollout found for thread id x')), false);
  assert.equal(nativeGone('claude', null), false);
});

test('a Codex chat with no rollout is deleted, its receipt given, like any other chat; a real failure still fails', async () => {
  const w = world();
  w.chats.commit(chat('a'));
  w.chats.commit(chat('b'));
  w.remove.codex = async (t: any) => {
    if (t.key === 'a') throw new Error(`no rollout found for thread id ${t.key}`);
    throw new Error('app-server went away');
  };
  const receipt = await w.deletion.delete('a');
  assert.equal(receipt.nativeDeleted, true);
  assert.equal(w.deletion.isDeleted('a'), true);
  await assert.rejects(w.deletion.delete('b'), /app-server went away/);
  assert.equal(w.deletion.isDeleted('b'), false, 'retryable');
});

test('Reset deletes every MoMo chat past one that fails, stopping each turn first, and says how many are left', async () => {
  const w = world();
  for (const [id, kind, momo] of [
    ['a', 'codex', 'main'],
    ['b', 'claude', 'topic'],
    ['c', 'acp:opencode', 'routine'],
  ])
    w.chats.commit(chat(id, kind, momo));
  w.remove.claude = async () => {
    throw new Error('the Claude SDK is not ready');
  };
  const cleared: string[] = [];
  const ids = [...w.chats.records.keys()];
  await assert.rejects(
    resetMomoChats({ live: w.live, ids: () => ids, clear: (id: string) => cleared.push(id), dir: w.dir, mainChat: w.mainChat }),
    /1 of MoMo's chats couldn't be deleted/,
  );
  assert.deepEqual(cleared, ids);
  assert.deepEqual(w.stopped, ids, 'every turn stopped before its chat goes');
  assert.equal(w.deletion.isDeleted('acp:opencode:c'), true, 'the chat after the failing one still goes');
  assert.equal(w.mainChat.savedId, undefined, 'the main chat is read again');
  assert.ok(fs.existsSync(path.join(w.dir, 'state.json')) && fs.existsSync(path.join(w.dir, 'workspace')), 'kept while a chat is left');
  // the deleted chats' records are off the disk; the one left keeps its record
  assert.deepEqual(fs.readdirSync(path.join(w.root, 'threads')).sort(), [path.basename(w.chats.file('claude:b'))]);
  assert.ok(w.chats.records.has('a'), 'this process keeps the record, so its deletion fence holds');
  assert.equal(w.chats.patchMeta('a', { momo: 'main' }), false);

  // a retry: the chat left goes now, the deleted ones are not deleted again
  w.remove.claude = async (t: any) => void w.calls.push(t.key);
  w.calls.length = 0;
  w.live.controller.stopChat = () => {
    throw new Error('controller gone');
  };
  await resetMomoChats({ live: w.live, ids: () => ids, clear: () => undefined, dir: w.dir, mainChat: w.mainChat });
  assert.deepEqual(w.calls, ['claude:b']);
  assert.equal(fs.existsSync(path.join(w.dir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(w.dir, 'workspace')), false);
  // after a restart nothing of MoMo's chats is read back
  assert.equal(new ChatsStore(path.join(w.root, 'threads'), { legacyMirror: false }).records.size, 0);
});

test('Reset before the chats are open refuses; with no controller the chats still go; a live chat is never forgotten', async () => {
  const w = world();
  await assert.rejects(
    resetMomoChats({ live: {}, ids: () => [], clear: () => undefined, dir: w.dir, mainChat: w.mainChat }),
    /before the chats are open/,
  );
  w.chats.commit(chat('a'));
  assert.equal(w.chats.forgetDeleted('a'), false, 'not deleted: kept');
  assert.equal(w.chats.forgetDeleted(''), false);
  assert.ok(fs.existsSync(w.chats.file('a')));
  delete w.live.controller;
  await resetMomoChats({ live: w.live, ids: () => ['a'], clear: () => undefined, dir: w.dir, mainChat: w.mainChat });
  assert.equal(fs.existsSync(w.chats.file('a')), false);
});

test('a chat made while Reset runs is deleted too; the chats are read again at most three times', async () => {
  const w = world();
  w.chats.commit(chat('a'));
  let reads = 0;
  const ids = () => {
    reads++;
    // a main chat a start had under way lands after the first read
    if (reads === 2) w.chats.commit(chat('late'));
    return [...w.chats.records.keys()];
  };
  await resetMomoChats({ live: w.live, ids, clear: () => undefined, dir: w.dir, mainChat: w.mainChat });
  assert.equal(w.deletion.isDeleted('late'), true);
  assert.deepEqual(w.calls, ['a', 'late']);
  // chats that keep coming are not chased for ever
  let n = 0;
  const endless = () => [`new-${n++}`];
  await resetMomoChats({ live: w.live, ids: endless, clear: () => undefined, dir: w.dir, mainChat: w.mainChat });
  assert.equal(n, 3);
});

test('the pin and account of a deleted chat are not written back to ui-state.json for older builds', async () => {
  const w = world({ uiState: true });
  w.chats.commit({ ...chat('mine', 'claude'), meta: { momo: 'main', pinned: true } });
  w.chats.commit({ ...chat('other', 'claude'), meta: { pinned: true } });
  const pinned = () => (flushPendingWrites(), JSON.parse(fs.readFileSync(w.uiState, 'utf8')).pinned);
  assert.deepEqual(Object.keys(pinned()).sort(), ['claude:mine', 'claude:other']);
  await resetMomoChats({ live: w.live, ids: () => ['claude:mine'], clear: () => undefined, dir: w.dir, mainChat: w.mainChat });
  w.chats.patchMeta('claude:other', { unread: true });
  assert.deepEqual(Object.keys(pinned()), ['claude:other']);
});
