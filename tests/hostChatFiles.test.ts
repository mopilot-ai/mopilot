// Files and folders attached to a machine chat: the Mac measures and uploads them by digest, the Host keeps them in a private folder per message, and every refusal says what it is and what fixes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createHostImages } from '../host/src/chatImages.mjs';
import { createHostFiles } from '../host/src/chatFiles.mjs';
import { EMPTY_ID, FILE_FEATURE, FILE_MIME, MAX_FILE_BYTES, MAX_MESSAGE_FILES, fileRefs } from '../shared/host/files.mjs';
import { parseParams, requireFeatures, FEATURES } from '../shared/host/schema.mjs';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { uploadFiles } = require('../electron/host/fileTransfer.cjs');
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const bad = (m: string) => new Error(m);

function rig(t: any, options: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-chat-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createHostImages({ dir: path.join(dir, 'private', 'images'), ...options });
  const calls: any[] = [];
  const host: any = {
    speaks: (f: string) => f === FILE_FEATURE,
    call: async (method: string, p: any) => {
      calls.push(p);
      return { result: await store.upload({ ...p, owner: 'pair-a' }) };
    },
  };
  const input = (attachments: any[]) => ({ host, chatId: 'chat-a', epoch: 1, attachments, check: () => undefined });
  const put = (rel: string, data: string | Buffer) => {
    const file = path.join(dir, 'src', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  };
  return { dir, store, calls, host, input, put };
}

test('a file and a folder cross as digests, land in a private folder per message and are what the agent is handed', async (t) => {
  const r = rig(t);
  const note = r.put('notes.txt', 'hello');
  r.put('proj/a.txt', 'alpha');
  r.put('proj/deep/b.txt', 'alpha');
  r.put('proj/deep/empty.txt', '');
  fs.symlinkSync(note, path.join(r.dir, 'src', 'proj', 'link.txt'));
  const refs = await uploadFiles(
    r.input([
      { kind: 'file', path: note },
      { kind: 'file', path: path.join(r.dir, 'src', 'proj') },
    ]),
  );
  assert.deepEqual(refs, [
    { id: digest('hello'), name: 'notes.txt', rel: '' },
    { id: digest('alpha'), name: 'proj', rel: 'a.txt' },
    { id: digest('alpha'), name: 'proj', rel: 'deep/b.txt' },
    { id: EMPTY_ID, name: 'proj', rel: 'deep/empty.txt' },
  ]);
  assert.equal(r.calls.length, 2, 'the same bytes cross once and an empty file never does');
  assert(r.calls.every((c) => c.mime === FILE_MIME && !JSON.stringify(c).includes(r.dir)));
  const out = await r.store.files('pair-a', 'chat-a', 'key-1', refs, () => undefined);
  assert.deepEqual(
    out.map((o: any) => [o.kind, o.name]),
    [
      ['file', 'notes.txt'],
      ['file', 'proj'],
    ],
  );
  assert.equal(fs.readFileSync(out[0].path, 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(out[1].path, 'deep', 'b.txt'), 'utf8'), 'alpha');
  assert.equal(fs.readFileSync(path.join(out[1].path, 'deep', 'empty.txt'), 'utf8'), '');
  assert.equal(fs.existsSync(path.join(out[1].path, 'link.txt')), false, 'a link is not followed');
  assert.equal(fs.statSync(out[0].path).mode & 0o777, 0o600);
  assert.equal(
    fs.readdirSync(path.join(r.dir, 'private', 'images')).filter((n) => n.endsWith('.bin') || n.includes('.image.')).length,
    0,
    'the uploads are freed once the message has its own copies',
  );
  // a retry of the same message lands in the same folder
  await uploadFiles(r.input([{ kind: 'file', path: note }]));
  const again = await r.store.files('pair-a', 'chat-a', 'key-1', [refs[0]], () => undefined);
  assert.equal(again[0].path, out[0].path);
});

test('names that collide stay apart and a pasted file keeps its own name', async (t) => {
  const r = rig(t);
  const one = r.put('one/a.txt', 'x');
  const two = r.put('two/a.txt', 'y');
  const refs = await uploadFiles(
    r.input([
      { kind: 'file', path: one },
      { kind: 'file', path: two },
    ]),
  );
  assert.deepEqual(
    refs.map((x: any) => x.name),
    ['a.txt', 'a (2).txt'],
  );
  const noExt = r.put('three/README', 'z');
  const four = r.put('four/README', 'w');
  const more = await uploadFiles(
    r.input([
      { kind: 'file', path: noExt },
      { kind: 'file', path: four },
    ]),
  );
  assert.deepEqual(
    more.map((x: any) => x.name),
    ['README', 'README (2)'],
  );
});

test('an old Host is refused before any path is opened, with words that ask for the update', async (t) => {
  const r = rig(t);
  await assert.rejects(
    uploadFiles({ ...r.input([{ kind: 'file', path: '/never/read' }]), host: { speaks: () => false } }),
    (e: any) => e.code === 'feature_missing' && e.app === true && /Update it\.$/.test(e.message) && /machine/.test(e.message),
  );
  await assert.rejects(uploadFiles({ ...r.input([{ kind: 'file', path: '/never/read' }]), host: { speaks: () => true } }), {
    code: 'feature_missing',
  });
  assert.deepEqual(await uploadFiles(r.input([])), []);
  assert.equal(r.calls.length, 0);
});

test('size and count limits refuse before any byte is read, naming the file and the fix', async (t) => {
  const r = rig(t);
  const big = path.join(r.dir, 'src', 'big.bin');
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, MAX_FILE_BYTES + 1);
  await assert.rejects(
    uploadFiles(r.input([{ kind: 'file', path: big }])),
    (e: any) => e.app && /big\.bin is larger than 25 MB\. Remove it/.test(e.message),
  );
  // 3 files of 20 MB each are 60 MB together
  const twenty = (n: string) => {
    const f = path.join(r.dir, 'src', n);
    fs.closeSync(fs.openSync(f, 'w'));
    fs.truncateSync(f, 20 * 1024 * 1024);
    return { kind: 'file', path: f };
  };
  await assert.rejects(uploadFiles(r.input([twenty('a'), twenty('b'), twenty('c')])), /50 MB together\. Remove some/);
  const folder = path.join(r.dir, 'src', 'folder');
  fs.mkdirSync(folder);
  fs.copyFileSync(big, path.join(folder, 'huge.bin'));
  await assert.rejects(uploadFiles(r.input([{ kind: 'file', path: folder }])), /folder\/huge\.bin is larger than 25 MB/);
  fs.rmSync(path.join(folder, 'huge.bin'));
  await assert.rejects(uploadFiles(r.input([{ kind: 'file', path: folder }])), /folder has no files in it\. Remove it/);
  for (let n = 0; n <= MAX_MESSAGE_FILES; n++) fs.writeFileSync(path.join(folder, `f${n}`), 'x');
  await assert.rejects(uploadFiles(r.input([{ kind: 'file', path: folder }])), /folder has more than 200 files\. Attach a smaller folder/);
  const many = Array.from({ length: 17 }, () => ({ kind: 'file', path: big }));
  await assert.rejects(uploadFiles(r.input(many)), /Attach up to 16 files and folders at once/);
  assert.equal(r.calls.length, 0);
});

test('a path that cannot be read, a special file and a file that changed while it was read are refused as unreadable', async (t) => {
  const r = rig(t);
  await assert.rejects(
    uploadFiles(r.input([{ kind: 'file', path: path.join(r.dir, 'gone.txt') }])),
    /gone\.txt could not be read\. Attach it again\./,
  );
  const pipe = path.join(r.dir, 'fifo');
  require('node:child_process').execFileSync('mkfifo', [pipe]);
  await assert.rejects(uploadFiles(r.input([{ kind: 'file', path: pipe }])), /fifo could not be read/);
  const f = r.put('shrinks.txt', 'abcdef');
  const real = fs.promises.open;
  const { installFs } = require('../electron/platform/ports/fs.cjs');
  const prior = installFs({
    ...fs,
    promises: {
      ...fs.promises,
      open: async (...a: any[]) => {
        fs.truncateSync(f, 2);
        return (real as any)(...a);
      },
    },
  });
  try {
    await assert.rejects(uploadFiles(r.input([{ kind: 'file', path: f }])), /shrinks\.txt could not be read/);
  } finally {
    installFs(prior);
  }
  const unreadableDir = path.join(r.dir, 'src', 'locked');
  fs.mkdirSync(unreadableDir);
  fs.writeFileSync(path.join(unreadableDir, 'x'), 'x');
  fs.chmodSync(unreadableDir, 0);
  try {
    await assert.rejects(uploadFiles(r.input([{ kind: 'file', path: unreadableDir }])), /locked could not be read/);
  } finally {
    fs.chmodSync(unreadableDir, 0o700);
  }
});

test('a retired chat stops the upload between steps instead of being read as an unreadable file', async (t) => {
  const r = rig(t);
  const f = r.put('a.txt', 'abc');
  let live = true;
  const check = () => {
    if (!live) throw Object.assign(new Error('moved'), { code: 'stale_epoch' });
  };
  r.host.call = async () => {
    live = false;
    return { result: { imageId: digest('abc'), received: 3, done: true } };
  };
  await assert.rejects(uploadFiles({ ...r.input([{ kind: 'file', path: f }]), check }), { code: 'stale_epoch' });
  let checks = 0;
  const flaky = () => {
    if (++checks > 4) throw Object.assign(new Error('moved'), { code: 'stale_epoch' });
  };
  const folder = path.join(r.dir, 'src', 'tree');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'x'), 'x');
  await assert.rejects(uploadFiles({ ...r.input([{ kind: 'file', path: folder }]), check: flaky }), { code: 'stale_epoch' });
});

test('the Host refuses references that name a path, escape the folder, repeat or exceed the bounds', () => {
  const id = digest('x');
  assert.deepEqual(fileRefs(undefined, bad), {});
  assert.deepEqual(fileRefs([], bad), {});
  assert.deepEqual(fileRefs([{ id, name: 'a.txt' }], bad), { files: [{ id, name: 'a.txt', rel: '' }] });
  for (const v of [
    'x',
    Array(MAX_MESSAGE_FILES + 1).fill({ id, name: 'a' }),
    [null],
    [{ id: 'nope', name: 'a' }],
    [{ id, name: '..' }],
    [{ id, name: '.' }],
    [{ id, name: 'a/b' }],
    [{ id, name: 3 }],
    [{ id, name: 'a', rel: '../x' }],
    [{ id, name: 'a', rel: '/x' }],
    [{ id, name: 'a', rel: 'x//y' }],
    [{ id, name: 'a', rel: 3 }],
    [{ id, name: 'a', rel: 'x'.repeat(1025) }],
    [
      { id, name: 'a', rel: 'x' },
      { id, name: 'a', rel: 'x' },
    ],
  ])
    assert.throws(() => fileRefs(v, bad), /Attach fewer files|not available|attached twice/, JSON.stringify(v).slice(0, 40));
});

test('the wire gate: files need chatFiles on both ends, the parser keeps them, and an empty message with files is a message', () => {
  assert(FEATURES.includes(FILE_FEATURE));
  const id = digest('x');
  const without = { features: ['epoch', 'dedupe', 'chatImages'] };
  const withFiles = { features: ['epoch', 'dedupe', 'chatImages', FILE_FEATURE] };
  assert.throws(() => requireFeatures('chat.send', without, { files: [{ id }] }), /chatFiles/);
  assert.throws(() => requireFeatures('chat.attach', without, { mime: FILE_MIME }), /chatFiles/);
  requireFeatures('chat.send', withFiles, { files: [{ id }] });
  requireFeatures('chat.attach', withFiles, { mime: FILE_MIME });
  requireFeatures('chat.send', without, {});
  const parsed: any = parseParams('chat.send', { chatId: 'c', epoch: 1, key: UUID(1), text: '', files: [{ id, name: 'a.txt' }] });
  assert.deepEqual(parsed.files, [{ id, name: 'a.txt', rel: '' }]);
  assert.throws(() => parseParams('chat.send', { chatId: 'c', epoch: 1, key: UUID(1), text: '' }), /Type a message first/);
  const part: any = parseParams('chat.attach', {
    chatId: 'c',
    epoch: 1,
    key: 'attach-key-1',
    imageId: id,
    offset: 0,
    size: 1,
    mime: FILE_MIME,
    data: 'eA==',
  });
  assert.equal(part.mime, FILE_MIME);
});

test('the Host store keeps a file apart from a picture with the same bytes, refuses a half upload and a mixed name, and frees what it copied', async (t) => {
  const r = rig(t);
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const id = digest(png);
  const scope = { owner: 'pair-a', chatId: 'chat-a', imageId: id, offset: 0, size: png.length, data: png.toString('base64') };
  await r.store.upload({ ...scope, mime: 'image/png' });
  await r.store.upload({ ...scope, mime: FILE_MIME });
  const refs = [{ id, name: 'p.bin', rel: '' }];
  const [one] = await r.store.files('pair-a', 'chat-a', 'k', refs, () => undefined);
  assert.deepEqual(fs.readFileSync(one.path), png);
  assert.equal((await r.store.attachments('pair-a', 'chat-a', [id])).length, 1, 'the picture is still there');
  // an upload that never finished is not a file
  const half = digest('half');
  await r.store.upload({
    owner: 'pair-a',
    chatId: 'chat-a',
    imageId: half,
    offset: 0,
    size: 4,
    mime: FILE_MIME,
    data: Buffer.from('ha').toString('base64'),
  });
  await assert.rejects(
    r.store.files('pair-a', 'chat-a', 'k2', [{ id: half, name: 'h', rel: '' }], () => undefined),
    /not uploaded yet/,
  );
  await assert.rejects(
    r.store.files('pair-a', 'chat-a', 'k3', [{ id: digest('never'), name: 'h', rel: '' }], () => undefined),
    /not uploaded yet/,
  );
  // a name used as a file and as a folder at once
  await assert.rejects(
    r.store.files(
      'pair-a',
      'chat-a',
      'k4',
      [
        { id, name: 'm', rel: '' },
        { id, name: 'm', rel: 'x' },
      ],
      () => undefined,
    ),
    /file and a folder at once/,
  );
  await assert.rejects(
    r.store.files('pair-a', 'chat-a', 'k5', Array(MAX_MESSAGE_FILES + 1).fill(refs[0]), () => undefined),
    /Attach fewer files/,
  );
  // another client cannot take it
  await assert.rejects(
    r.store.files('pair-b', 'chat-a', 'k6', refs, () => undefined),
    /not uploaded yet/,
  );
});

test('files over the message total are refused on the Host too', async (t) => {
  const r = rig(t, { quota: 200 * 1024 * 1024 });
  const refs: { id: string; name: string; rel: string }[] = [];
  for (let n = 0; n < 3; n++) {
    const data = Buffer.alloc(20 * 1024 * 1024, n + 1);
    const id = digest(data);
    for (let offset = 0; offset < data.length; offset += 96 * 1024)
      await r.store.upload({
        owner: 'pair-a',
        chatId: 'chat-a',
        imageId: id,
        offset,
        size: data.length,
        mime: FILE_MIME,
        data: data.subarray(offset, offset + 96 * 1024).toString('base64'),
      });
    refs.push({ id, name: `f${n}`, rel: '' });
  }
  await assert.rejects(
    r.store.files('pair-a', 'chat-a', 'big', refs, () => undefined),
    /50 MB together/,
  );
});

test('a Host data folder the process cannot write turns a copy failure into a retryable refusal, never a path', async (t) => {
  const r = rig(t);
  const data = Buffer.from('abc');
  const id = digest(data);
  await r.store.upload({
    owner: 'pair-a',
    chatId: 'chat-a',
    imageId: id,
    offset: 0,
    size: 3,
    mime: FILE_MIME,
    data: data.toString('base64'),
  });
  const blocker = path.join(r.dir, 'private', 'chat-files');
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, 'a file where the folder goes');
  await assert.rejects(
    r.store.files('pair-a', 'chat-a', 'k', [{ id, name: 'a', rel: '' }], () => undefined),
    (e: any) => !e.message.includes(r.dir),
  );
  const direct = createHostFiles({
    dir: path.join(r.dir, 'direct'),
    blobs: { blobPaths: async () => [], release: async () => undefined },
  });
  assert.deepEqual(await direct.materialize('o', 'c', 'k', []), []);
});

test('a message with files is delivered on a negotiated Host: uploads first, then one send carrying digests, never paths', async (t) => {
  const w = world(t);
  w.remote('chat');
  const note = path.join(w.dir, 'notes.txt');
  fs.writeFileSync(note, 'hello there');
  const store = createHostImages({ dir: path.join(w.dir, 'host-private', 'images') });
  const host: any = w.host;
  const calls: any[] = [];
  host.speaks = () => true;
  host.call = async (_m: string, p: any) => {
    calls.push(p);
    return { result: await store.upload({ ...p, owner: 'paired-mac' }) };
  };
  const key = UUID(21);
  const reply = await w.service.send(
    'chat',
    { ...msg('read this', key), attachments: [{ kind: 'file', path: note, name: 'notes.txt' }] },
    null,
  );
  assert.equal(reply.action, 'started');
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0].item.files, [{ id: digest('hello there'), name: 'notes.txt', rel: '' }]);
  assert.equal(w.sent[0].item.images, undefined);
  assert.equal(JSON.stringify(calls).includes(w.dir), false);
});

test('the first message of a chat carries its files too, and an old Host leaves it queued with the update words', async (t) => {
  const w = world(t);
  w.remote('chat2');
  const note = path.join(w.dir, 'a.txt');
  fs.writeFileSync(note, 'a');
  w.service.begin('chat2', { harness: 'claude' });
  const host: any = w.host;
  const key = UUID(22);
  const queued = await w.service.send('chat2', { ...msg('go', key), attachments: [{ kind: 'file', path: note }] }, null);
  assert.equal(queued.action, 'queued');
  assert.match(queued.error, /cannot receive files yet/);
  assert.equal(w.sent.length, 0);
  host.speaks = () => true;
  host.call = async (_m: string, p: any) => ({ result: { imageId: p.imageId, received: p.size, done: true } });
  assert.deepEqual(await w.service.sendNow('chat2', key), { status: 'sent' });
  assert.equal(w.started.at(-1)?.item.files.length, 1);
});

test('a local skill is refused with its own words, and delivery refuses it again', async (t) => {
  const w = world(t);
  w.remote('chat3');
  const reply = await w.service.send('chat3', { ...msg('x', UUID(23)), attachments: [{ kind: 'skill', name: 's' }] }, null);
  assert.equal(reply.action, 'failed');
  assert.match(reply.error, /Only images, files, folders and selected text/);
  const { deliverRemote } = require('../electron/host/remoteSendDelivery.cjs');
  const entry: any = {
    chatId: 'chat3',
    key: UUID(24),
    epoch: 1,
    options: { item: { text: 'x', opts: {}, attachments: [{ kind: 'skill', path: '/s' }] } },
  };
  const check = { validate: async () => undefined };
  await assert.rejects(
    deliverRemote(entry, { hostId: 'box', epoch: 1, folder: '/f' }, w.host, {
      checks: check,
      subscribed: undefined,
      disposed: () => false,
      outbox: { pending: () => [{ key: entry.key, state: 'queued' }] },
      ownerOf: () => ({ hostId: 'box', epoch: 1, folder: '/f' }),
      state: () => undefined,
      projection: { remember() {}, forget() {} },
      hostFor: () => w.host,
      kindOf: () => undefined,
    }),
    (e: any) => e.code === 'unsupported' && e.app === true && /Only images, files, folders and selected text/.test(e.message),
  );
});
