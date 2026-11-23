// A sent picture outlives the temp folder's 24 h prune (#5183): copied at dispatch for every harness family, gone with its chat, kept for a fork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { createChatPictures } = require('../electron/platform/chatPictures.cjs');
const { wireChatPictures } = require('../electron/app/chatPicturesWiring.cjs');
const { register } = require('../electron/app/ipc/files.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatDeletion } = require('../electron/session/chatDeletion.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');

const PASTES = path.join(os.tmpdir(), 'sage-codex-attachments');
const PNG = 'data:image/png;base64,aGk=';

function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pictures-'));
  const made: string[] = [];
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of made) fs.rmSync(f, { force: true });
  });
  const root = path.join(dir, 'chat-pictures');
  const pictures = createChatPictures({ root: () => root });
  /** a real paste through the real fs:saveTempImage handler */
  const handlers = new Map<string, any>();
  register(
    { handle: (n: string, f: any) => handlers.set(n, f) } as any,
    {
      app: { getPath: () => dir },
      BrowserWindow: {},
      dialog: {},
      live: {},
    } as any,
  );
  const paste = async (url = PNG) => {
    const file = await handlers.get('fs:saveTempImage')({}, url);
    made.push(file);
    return file as string;
  };
  const read = (p: string) => handlers.get('fs:readImageDataUrl')({}, p);
  const image = (p: string) => ({ kind: 'image', path: p, name: 'p.png' });
  return { dir, root, pictures, paste, read, image };
}

test('a sent paste is copied once per content into the chat folder, 0600; other attachments are untouched', async (t) => {
  const w = world(t);
  const file = await w.paste();
  const other = path.join(w.dir, 'mine.png');
  fs.writeFileSync(other, 'hi');
  const doc = { kind: 'file', path: file, name: 'f' };
  const [a, b, c, d] = await w.pictures.keep('chat-1', [w.image(file), w.image(file), w.image(other), doc]);
  assert.ok(a.path.startsWith(w.root) && a.path.endsWith('.png'));
  assert.equal(a.name, 'p.png');
  assert.equal(b.path, a.path, 'idempotent by digest');
  assert.equal((await w.pictures.keep('chat-1', [w.image(file)]))[0].path, a.path, 'and across sends');
  assert.equal(c.path, other, "the user's own file keeps its path");
  assert.equal(d, doc);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'hi');
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(a.path)).length, 1, 'no part files left');
  assert.equal(w.pictures.wants([doc, w.image(other)]), false);
  assert.equal(w.pictures.wants([doc, w.image(file)]), true);
  assert.equal(w.pictures.wants(undefined), false);
  assert.equal(w.pictures.wants([null]), false);
  assert.equal(w.pictures.wants([{ kind: 'image' }, { kind: 'image', path: PASTES }, { kind: 'image', path: '/etc/../etc/x' }]), false);
});

test('a picture that cannot be copied keeps its path and never blocks the send', async (t) => {
  const w = world(t);
  const missing = path.join(PASTES, 'paste-never-written.png');
  const folder = path.join(PASTES, 'paste-folder.png');
  fs.mkdirSync(folder, { recursive: true });
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const real = await w.paste();
  fs.mkdirSync(w.root, { recursive: true });
  fs.writeFileSync(path.join(w.root, 'blocker'), 'x');
  const blocked = createChatPictures({ root: () => path.join(w.root, 'blocker') });
  const kept = await w.pictures.keep('c', [w.image(missing), w.image(folder)]);
  assert.deepEqual(
    kept.map((a: any) => a.path),
    [missing, folder],
  );
  assert.equal((await blocked.keep('c', [w.image(real)]))[0].path, real);
});

test('real paste, send, 25 h pass, next paste prunes: the recorded picture still reads (fails without the copy)', async (t) => {
  const w = world(t);
  const file = await w.paste();
  const [kept] = await w.pictures.keep('chat-1', [w.image(file)]);
  const old = (Date.now() - 25 * 3_600_000) / 1000;
  fs.utimesSync(file, old, old);
  await w.paste('data:image/png;base64,Ym8=');
  assert.equal(fs.existsSync(file), false, 'the temp paste was pruned');
  assert.equal(await w.read(file), null, 'what the history held before the fix: nothing to draw');
  assert.equal(await w.read(kept.path), 'data:image/png;base64,aGk=');
});

function controller(chats: Map<string, any>, seen: any[], started = true) {
  const take = async (_chatId: string, _ref: any, item: any) => (seen.push(item), { started });
  return new ChatController({
    state: new SessionStore(),
    chats: { records: chats, record: (id: string) => chats.get(id) },
    codex: { startTurn: take, steer: take },
    claudeTurns: { startTurn: take, steer: take },
    acpTurns: { startTurn: take },
    beforeDispatch: (d: any) => seen.push(['before', d.item.attachments[0]?.path]),
    claude: {},
    acp: {},
  });
}

for (const kind of ['claude', 'codex', 'acp:gemini'])
  test(`${kind}: dispatch hands the adapter and the journal the durable path; a text message is unchanged`, async (t) => {
    const w = world(t);
    const seen: any[] = [];
    const chats = new Map([['c1', { id: 'c1', segments: [{ kind, nativeId: 'c1' }], meta: {} }]]);
    const c = controller(chats, seen);
    c.pictures = w.pictures;
    const file = await w.paste();
    const item = { id: 'q', text: 'look', attachments: [w.image(file)], opts: { human: true } };
    const result = await c.dispatch('c1', 'turn', item, 1);
    assert.equal(result.started, true);
    const sent = seen.find((x) => !Array.isArray(x));
    assert.ok(sent.attachments[0].path.startsWith(w.root), 'the adapter records the durable path');
    assert.deepEqual(seen[0], ['before', sent.attachments[0].path], 'so does the delivery journal');
    assert.equal(item.attachments[0].path, sent.attachments[0].path, 'the queue and a retry hold the same durable path');
    seen.length = 0;
    const plain = { id: 'r', text: 'hi', attachments: [], opts: { human: true } };
    await c.dispatch('c1', 'turn', plain, 1);
    assert.equal(seen.at(-1), plain);
    c.pictures = null;
    seen.length = 0;
    await c.dispatch('c1', 'turn', item, 1);
    assert.equal(
      seen.find((x) => !Array.isArray(x)),
      item,
      'without a keeper the item goes as before',
    );
  });

test('deleting a chat removes its pictures; a failed removal never blocks the delete; other chats keep theirs', async (t) => {
  const w = world(t);
  const file = await w.paste();
  const [a] = await w.pictures.keep('root', [w.image(file)]);
  const [b] = await w.pictures.keep('other', [w.image(file)]);
  const row = (id: string) => ({ id, segments: [{ kind: 'codex', nativeId: id }], meta: {}, schemaVersion: 2 });
  const store: any = Object.assign(Object.create(ChatsStore.prototype), {
    records: new Map([['root', row('root')]]),
    archiveEpochs: new Map([['root', 0]]),
    newer: new Set(),
    unreadable: new Set(),
    now: () => 1,
    fallback: true,
    mirror: () => {},
    onChange: () => {},
    isDeleted: () => false,
    admitCommit: () => true,
  });
  const noop = async () => {};
  const deletion = new ChatDeletion({ store, remove: { codex: noop, claude: noop, acp: noop }, broadcast: () => {} });
  const live: any = { controller: {}, chatDeletion: deletion, chats: store, codex: {} };
  wireChatPictures({ live, userData: w.dir });
  assert.ok(live.controller.pictures);
  const receipt = await deletion.delete('root');
  assert.equal(receipt.nativeDeleted, true);
  await waitFor(() => !fs.existsSync(a.path), 'the deleted chat folder to go');
  assert.equal(fs.existsSync(a.path), false, 'the chat folder is gone');
  assert.equal(fs.existsSync(b.path), true, 'another chat keeps its picture');
  // a removal that fails does not fail the delete
  fs.rmSync(w.root, { recursive: true, force: true });
  fs.writeFileSync(w.root, 'a file where the folder should be');
  store.records.set('two', row('two'));
  store.archiveEpochs.set('two', 0);
  const noted = t.mock.method(console, 'debug', () => {});
  assert.equal((await deletion.delete('two')).nativeDeleted, true);
  await waitFor(
    () => noted.mock.calls.some((c: any) => /remove a deleted chat's pictures/.test(String(c.arguments[0]))),
    'the failed removal to be noted',
  );
});

test('a fork shares the pictures: the original chat deleted first keeps them until the fork goes', async (t) => {
  const w = world(t);
  const file = await w.paste();
  const [kept] = await w.pictures.keep('parent', [w.image(file)]);
  await w.pictures.share('nobody', 'x');
  await w.pictures.share('parent', 'fork-1');
  await w.pictures.share('parent', 'fork-1');
  await w.pictures.share('parent', 'fork-2');
  assert.equal(await fs.promises.readFile(path.join(path.dirname(path.dirname(kept.path)), '.forks'), 'utf8'), '["fork-1","fork-2"]');
  await w.pictures.remove('parent');
  assert.equal(fs.existsSync(kept.path), true, 'forks still name it');
  await w.pictures.remove('fork-1', ['fork-1', 'native-1']);
  assert.equal(fs.existsSync(kept.path), true);
  await w.pictures.remove('fork-2');
  assert.equal(fs.existsSync(kept.path), false, 'the last fork takes the folder');
  // a live parent keeps its folder when its last fork goes
  const [again] = await w.pictures.keep('parent', [w.image(file)]);
  await w.pictures.share('parent', 'fork-3');
  await w.pictures.remove('fork-3');
  assert.equal(fs.existsSync(again.path), true);
  await w.pictures.remove('parent');
  assert.equal(fs.existsSync(again.path), false);
  // nothing to remove, and a damaged fork list reads as none
  await createChatPictures({ root: () => path.join(w.dir, 'never') }).remove('x');
  const [third] = await w.pictures.keep('p3', [w.image(file)]);
  fs.writeFileSync(path.join(path.dirname(path.dirname(third.path)), '.forks'), 'not json');
  await w.pictures.remove('p3');
  assert.equal(fs.existsSync(third.path), false);
  fs.rmSync(w.root, { recursive: true, force: true });
  fs.writeFileSync(w.root, 'file');
  await assert.rejects(w.pictures.remove('p3'));
});

test('a Codex fork that keeps its history shares the parent chat pictures; side chats and failures do not', async (t) => {
  const w = world(t);
  const file = await w.paste();
  const [kept] = await w.pictures.keep('chatA', [w.image(file)]);
  // chatA switched harness: the parent thread is its second segment
  const segments = [
    { kind: 'claude', nativeId: 'cl' },
    { kind: 'codex', nativeId: 'thread-2' },
  ];
  const records = new Map([
    ['momoChat', { id: 'momoChat', segments, meta: { momo: 'main' } }],
    ['chatA', { id: 'chatA', segments, meta: {} }],
  ]);
  const live: any = { controller: {}, chats: { records }, codex: {}, chatDeletion: {} };
  assert.throws(
    () => wireChatPictures({ live: { controller: {}, chats: { records }, chatDeletion: {} }, userData: w.dir }),
    /opened first/,
  );
  assert.throws(() => wireChatPictures({ live: { controller: {}, chats: { records }, codex: {} }, userData: w.dir }), /opened first/);
  wireChatPictures({ live, userData: w.dir });
  await live.codex.onFork('thread-2', 'forked');
  await live.codex.onFork('unknown-thread', 'forked-2');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(kept.path)), '.forks'), 'utf8')), ['forked']);
  // CodexAdapter.fork reports forks with history only, and a failing hook never fails the fork
  const calls: any[] = [];
  const adapter: any = Object.create(CodexAdapter.prototype);
  adapter.request = async () => ({ thread: { id: 'new' } });
  adapter.meta = new Map();
  adapter.onFork = async (...a: any[]) => calls.push(a);
  await adapter.fork({ threadId: 'p' });
  await adapter.fork({ threadId: 'p', excludeTurns: true, ephemeral: true });
  await adapter.fork({ threadId: 'p', ephemeral: true });
  await adapter.fork({});
  assert.deepEqual(calls, [['p', 'new']]);
  adapter.onFork = async () => {
    throw new Error('disk full');
  };
  assert.equal((await adapter.fork({ threadId: 'p' })).thread.id, 'new');
  const none: any = Object.create(CodexAdapter.prototype);
  none.request = async () => ({ thread: { id: 'n2' } });
  none.meta = new Map();
  assert.equal((await none.fork({ threadId: 'p' })).thread.id, 'n2');
  none.request = async () => ({});
  assert.deepEqual(await none.fork({ threadId: 'p' }), {});
});

test('a fork of a fork is registered under the chat that holds the pictures; deleting A then B leaves C its pictures', async (t) => {
  const w = world(t);
  const file = await w.paste();
  const [kept] = await w.pictures.keep('A', [w.image(file)]);
  const records = new Map([
    ['A', { id: 'A', segments: [{ kind: 'codex', nativeId: 'A' }], meta: {} }],
    ['B', { id: 'B', segments: [{ kind: 'codex', nativeId: 'B' }], meta: {} }],
  ]);
  const live: any = { controller: {}, chats: { records }, codex: {}, chatDeletion: {} };
  wireChatPictures({ live, userData: w.dir });
  await live.codex.onFork('A', 'B');
  await live.codex.onFork('B', 'C');
  await w.pictures.remove('A');
  await w.pictures.remove('B', ['B']);
  assert.match(await w.read(kept.path), /^data:image\/png/, "C still reads A's picture");
  await w.pictures.remove('C');
  assert.equal(fs.existsSync(kept.path), false);
});

test('concurrent forks all register, and a delete waits for a copy in flight', async (t) => {
  const w = world(t);
  const file = await w.paste();
  await w.pictures.keep('P', [w.image(file)]);
  await Promise.all([w.pictures.share('P', 'f1'), w.pictures.share('P', 'f2'), w.pictures.share('P', 'f3')]);
  const dir = fs.readdirSync(w.root)[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.root, dir, '.forks'), 'utf8')), ['f1', 'f2', 'f3']);
  // a send and a delete of the same chat started together: the folder is not recreated after the delete
  const other = await w.paste('data:image/png;base64,Ym8=');
  await Promise.all([w.pictures.keep('Q', [w.image(other)]), w.pictures.remove('Q')]);
  assert.equal(fs.readdirSync(w.root).length, 1, 'only P is left');
});

test('a file keeps its name in the durable copy', async (t) => {
  const w = world(t);
  const dir = path.join(PASTES, 'panel-test-name');
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Quarterly Report.PNG');
  fs.writeFileSync(file, 'x');
  const [kept] = await w.pictures.keep('c', [w.image(file)]);
  assert.equal(path.basename(kept.path), 'Quarterly Report.PNG');
});

test('a failed send leaves the durable path in the queued item, so a retry after 25 h sends a picture that reads', async (t) => {
  const w = world(t);
  const seen: any[] = [];
  const chats = new Map([['c1', { id: 'c1', segments: [{ kind: 'codex', nativeId: 'c1' }], meta: {} }]]);
  const c = controller(chats, seen, false);
  c.pictures = w.pictures;
  const file = await w.paste();
  const item = { id: 'q', text: 'look', attachments: [w.image(file)], opts: { human: true } };
  await c.dispatch('c1', 'turn', item, 1);
  const old = (Date.now() - 25 * 3_600_000) / 1000;
  fs.utimesSync(file, old, old);
  await w.paste('data:image/png;base64,Ym8=');
  assert.equal(fs.existsSync(file), false);
  assert.match(await w.read(item.attachments[0].path), /^data:image\/png/);
});
