// Chats' built-in browser folders don't stay (#2144, electron/capabilities/browser/chatFolders.cjs): a deleted chat's
// upload and download folders go at once, an archived chat's at the next sweep, files untouched for 7 days go, and a
// chat the store doesn't know only ages out (a chat at work never loses its files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  chatFolder,
  chatFolderName,
  removeChatFolders,
  sweepChatFolders,
  retainChatFolders,
  KEEP_MS,
} = require('../electron/capabilities/browser/chatFolders.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const NOW = Date.UTC(2026, 9, 23);
/** The filesystem as it is for files put there long ago: utimes can't move the change time back, so lstat says it. */
const longAgo = {
  ...fs.promises,
  lstat: async (p: string) => {
    const st: any = await fs.promises.lstat(p);
    st.ctimeMs = st.birthtimeMs = st.mtimeMs;
    return st;
  },
} as typeof fs.promises;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-folders-'));
function put(root: string, kind: string, chat: string, rel: string, ageMs = 0) {
  const p = path.join(chatFolder(root, kind, chat), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  const t = (NOW - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

test('a chat’s folder name keeps to safe characters', () => {
  assert.equal(chatFolderName('claude:3b5b/../x y'), 'claude_3b5b_.._x_y');
  assert.equal(chatFolderName(''), 'chat');
  assert.equal(chatFolderName('a'.repeat(200)).length, 120);
});

test('a deleted chat’s upload and download folders go at once', () => {
  const root = tmp();
  put(root, 'browser-uploads', 'claude:1', 'id.jpg');
  put(root, 'browser-downloads', 'claude:1', 'f.pdf');
  put(root, 'browser-uploads', 'claude:2', 'keep.jpg');
  removeChatFolders(root, 'claude:1');
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:1')), false);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-downloads', 'claude:1')), false);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:2')), true);
});

test('a deleted chat whose folder name another chat shares leaves the folder to the sweep', () => {
  const root = tmp();
  put(root, 'browser-uploads', 'claude:a/b', 'theirs.jpg');
  // 'claude:a/b' and 'claude:a_b' both make claude_a_b
  const records = new Map([
    ['claude:a/b', {}],
    ['claude:a_b', {}],
    ['claude:c', {}],
  ]);
  assert.equal(removeChatFolders(root, 'claude:a_b', { records }), false);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:a/b')), true);
  // the deleted chat itself still listed, and others with other names: it goes
  put(root, 'browser-uploads', 'claude:c', 'mine.jpg');
  assert.equal(removeChatFolders(root, 'claude:c', { records }), true);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:c')), false);
});

test('a sweep removes archived chats’ folders and files untouched for 7 days; a chat’s own folder stays', async () => {
  const root = tmp();
  put(root, 'browser-uploads', 'archived', 'fresh.jpg');
  const old = put(root, 'browser-uploads', 'active', 'screenshots/old.png', KEEP_MS + 1000);
  const oldDir = path.dirname(old);
  fs.utimesSync(oldDir, (NOW - KEEP_MS - 1000) / 1000, (NOW - KEEP_MS - 1000) / 1000);
  const fresh = put(root, 'browser-uploads', 'active', 'new.png', 1000);
  const aged = put(root, 'browser-downloads', 'unknown', 'report.pdf', KEEP_MS + 1);
  const unknownFresh = put(root, 'browser-downloads', 'unknown2', 'today.pdf');
  fs.writeFileSync(path.join(root, 'browser-uploads', 'stray-file'), 'x');
  // an empty folder last touched long ago goes as its files would
  const emptyOld = path.join(chatFolder(root, 'browser-uploads', 'active'), 'gifs');
  fs.mkdirSync(emptyOld);
  fs.utimesSync(emptyOld, (NOW - KEEP_MS - 1) / 1000, (NOW - KEEP_MS - 1) / 1000);
  const gone = await sweepChatFolders({ root, archived: (name: string) => name === 'archived', now: NOW, fsp: longAgo });
  assert.equal(fs.existsSync(emptyOld), false);
  assert.equal(gone, 1, 'the archived chat');
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'archived')), false);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(aged), false);
  assert.equal(
    fs.existsSync(chatFolder(root, 'browser-downloads', 'unknown')),
    true,
    'the chat’s own folder stays: the agent may just have been told it',
  );
  assert.equal(fs.existsSync(unknownFresh), true, 'a chat the store does not know keeps its recent files');
  // nothing there at all: nothing to do
  clearIgnored();
  assert.equal(await sweepChatFolders({ root: tmp(), archived: () => false, now: NOW }), 0);
  assert.deepEqual(recentIgnored(), []);
});

test('a file moved or copied in with its old times kept is not taken for an old one', async () => {
  const root = tmp();
  // as `mv` or `cp -p` leaves it: an old modification time, a new change time (the real one, now)
  const moved = put(root, 'browser-uploads', 'chat', 'from-2024.pdf', 0);
  const old = (NOW - 400 * 86_400_000) / 1000;
  fs.utimesSync(moved, old, old);
  await sweepChatFolders({ root, archived: () => false, now: Date.now() });
  assert.equal(fs.existsSync(moved), true);
  // an empty folder made just now stays too, even below the chat's own
  fs.mkdirSync(path.join(chatFolder(root, 'browser-uploads', 'chat'), 'screenshots'));
  await sweepChatFolders({ root, archived: () => false, now: Date.now() });
  assert.equal(fs.existsSync(path.join(chatFolder(root, 'browser-uploads', 'chat'), 'screenshots')), true);
});

test('a folder that can’t be swept is recorded and the rest go on', async () => {
  const root = tmp();
  put(root, 'browser-uploads', 'a', 'x.png', KEEP_MS + 1);
  put(root, 'browser-uploads', 'b', 'y.png', KEEP_MS + 1);
  const real = fs.promises;
  const fsp = {
    ...longAgo,
    readdir: async (p: string, o: any) => {
      if (p.endsWith(`${path.sep}a`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return real.readdir(p, o);
    },
  };
  clearIgnored();
  await sweepChatFolders({ root, archived: () => false, now: NOW, fsp });
  assert.equal(fs.existsSync(path.join(chatFolder(root, 'browser-uploads', 'b'), 'y.png')), false, 'the rest go on');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ["remove a chat's old browser files"],
  );
});

test('retention: the deletion hook removes the chat’s folders and never fails the deletion; the sweep runs on timers', async () => {
  const root = tmp();
  put(root, 'browser-uploads', 'claude:x', 'f.png');
  const before: string[] = [];
  const deletion: any = { onDeleted: (r: any) => before.push(r.chatId) };
  const timers: any[] = [];
  const fake = {
    setTimeout: (fn: () => void, ms: number) => (timers.push(['timeout', ms, fn]), { unref() {} }),
    setInterval: (fn: () => void, ms: number) => (timers.push(['interval', ms, fn]), { unref() {} }),
  };
  const records = new Map<string, any>([
    ['claude:y', { meta: { archived: NOW } }],
    ['claude:z', { meta: { archived: null } }],
    // two ids that make one folder name: one archived, one live, so the folder stays
    ['claude:w/1', { meta: { archived: NOW } }],
    ['claude:w?1', { meta: {} }],
  ]);
  const sweep = retainChatFolders({ root, chats: { records }, deletion, timers: fake });
  deletion.onDeleted({ chatId: 'claude:x' });
  assert.deepEqual(before, ['claude:x'], 'the hook already there still runs');
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:x')), false);
  assert.deepEqual(
    timers.map(([k, ms]) => [k, ms]),
    [
      ['timeout', 60_000],
      ['interval', 3_600_000],
    ],
  );
  put(root, 'browser-uploads', 'claude:y', 'archived.png');
  put(root, 'browser-uploads', 'claude:z', 'kept.png');
  put(root, 'browser-uploads', 'claude:w?1', 'shared-name.png');
  assert.equal(await sweep(), 1);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:y')), false);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:z')), true);
  assert.equal(fs.existsSync(chatFolder(root, 'browser-uploads', 'claude:w?1')), true, 'a live chat with the same folder name keeps it');
  // a folder that can't be removed: the deletion still succeeds, the failure is recorded
  const locked = path.join(root, 'browser-uploads');
  fs.chmodSync(locked, 0o500);
  clearIgnored();
  try {
    assert.doesNotThrow(() => deletion.onDeleted({ chatId: 'claude:z' }));
  } finally {
    fs.chmodSync(locked, 0o700);
  }
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ["remove a deleted chat's browser files"],
  );
  // no store yet, no deletion service: the sweep still runs, removing nothing by archive
  const bare = retainChatFolders({ root: tmp(), chats: null, timers: fake });
  assert.equal(await bare(), 0);
});
