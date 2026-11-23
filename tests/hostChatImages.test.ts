// Host image durability, exact authenticated-client/chat ownership, bounded reads and retry recovery, using real private files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HostRefusal } from '../host/src/hostFs.mjs';
import { createHostImages } from '../host/src/chatImages.mjs';
import { hostImageId } from '../shared/host/images.mjs';
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const imageId = digest(bytes);
const scope = { owner: 'pair-a', chatId: 'chat-a', imageId };
const chunk = (offset: number, data: Buffer, extra = {}) => ({
  ...scope,
  offset,
  size: bytes.length,
  mime: 'image/png',
  data: data.toString('base64'),
  ...extra,
});
function rig(t: any, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createHostImages({ dir, ...options }) };
}

test('chunks survive lost acknowledgments and restart, keep repeated positions, and expose only opaque projected references', async (t) => {
  const { dir, store } = rig(t);
  assert.deepEqual(await store.upload(chunk(0, bytes.subarray(0, 5))), { imageId, received: 5, done: false });
  assert.equal((await store.upload(chunk(0, bytes.subarray(0, 5)))).received, 5, 'ambiguous chunk reply retry does not append twice');
  const restarted = createHostImages({ dir });
  assert.deepEqual(await restarted.upload(chunk(5, bytes.subarray(5))), { imageId, received: bytes.length, done: true });
  assert.equal((await restarted.upload(chunk(5, bytes.subarray(5)))).done, true);
  const attachments = await restarted.attachments(scope.owner, scope.chatId, [imageId, imageId]);
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].path, attachments[1].path);
  assert.equal(path.extname(attachments[0].path), '.png', 'the real harness image readers must retain the uploaded MIME');
  assert.equal(fs.statSync(attachments[0].path).mode & 0o777, 0o600);
  const projected = restarted.project({
    id: 'u',
    content: [
      { type: 'text', text: 'look' },
      { type: 'localImage', path: attachments[0].path },
    ],
  });
  assert.equal(hostImageId(projected.content[1].url), imageId);
  assert.equal(JSON.stringify(projected).includes(dir), false);
  const first = await restarted.read({ ...scope, offset: 0, limit: 5 });
  assert.equal(first.nextOffset, 5);
  assert.equal(first.done, false);
  const last = await restarted.read({ ...scope, offset: 5, limit: 20 });
  assert.equal(last.done, true);
  assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')]), bytes);
});

test('another chat cannot read, resolve or reuse an uploaded image; another client reads it only when its chat’s clients are named', async (t) => {
  const { store } = rig(t);
  await store.upload(chunk(0, bytes));
  const other = { owner: 'pair-b' };
  // no other client named: this client's own scope has nothing under that id
  await assert.rejects(store.read({ ...scope, ...other, offset: 0, limit: 10 }), /not available/);
  await assert.rejects(
    store.read({
      ...scope,
      chatId: 'chat-b',
      owners: ['pair-a', 'pair-b'],
      offset: 0,
      limit: 10,
    }),
    /not available/,
  );
  for (const wrong of [{ owner: 'pair-b' }, { chatId: 'chat-b' }])
    await assert.rejects(store.attachments(wrong.owner ?? scope.owner, wrong.chatId ?? scope.chatId, [imageId]), /not uploaded/);
  await assert.rejects(store.upload(chunk(0, bytes, { mime: 'image/jpeg' })), /differently/);
  await assert.rejects(store.attachments('', scope.chatId, [imageId]), /Pair/);
  assert.deepEqual(store.project({ content: [{ type: 'localImage', path: '/private/key.png' }] }), { content: [{ type: 'image' }] });
});

test('a picture sent by one client of the chat is read by another: its own copy first, then the clients named, never another chat’s', async (t) => {
  const { dir, store } = rig(t);
  await store.upload(chunk(0, bytes));
  const bytesOf = (r: any) => Buffer.from(r.data, 'base64');
  const viaPhone = await store.read({
    ...scope,
    owner: 'pair-b',
    owners: ['pair-c', 'pair-b', 'pair-a'],
    offset: 0,
    limit: 100,
  });
  assert.deepEqual(bytesOf(viaPhone), bytes);
  assert.equal(viaPhone.done, true);
  // the same bytes sent by the reader itself: served from its own scope
  await store.upload(chunk(0, bytes, { owner: 'pair-b' }));
  assert.deepEqual(
    bytesOf(
      await store.read({
        ...scope,
        owner: 'pair-b',
        owners: ['pair-a'],
        offset: 0,
        limit: 100,
      }),
    ),
    bytes,
  );
  // another chat's id with every client named stays refused, and a half-sent picture of a sibling is not a picture
  await assert.rejects(
    store.read({
      ...scope,
      chatId: 'chat-b',
      owner: 'pair-b',
      owners: ['pair-a'],
      offset: 0,
      limit: 5,
    }),
    /not available/,
  );
  await store.upload({
    ...chunk(0, bytes.subarray(0, 5)),
    owner: 'pair-d',
    chatId: 'chat-d',
    size: bytes.length,
  });
  await assert.rejects(
    store.read({
      ...scope,
      chatId: 'chat-d',
      owner: 'pair-b',
      owners: ['pair-d'],
      offset: 0,
      limit: 5,
    }),
    /not available/,
  );
  // a sibling's unreadable record is no picture of the reader's; the reader's own unreadable record is a fault that is told
  const metaOf = (owner: string) =>
    path.join(
      dir,
      `${createHash('sha256')
        .update(JSON.stringify([owner, 'chat-a']))
        .digest('hex')}-${imageId}.json`,
    );
  fs.writeFileSync(metaOf('pair-a'), 'not json');
  fs.rmSync(metaOf('pair-b'));
  await assert.rejects(
    store.read({
      ...scope,
      owner: 'pair-b',
      owners: ['pair-a'],
      offset: 0,
      limit: 5,
    }),
    /not available/,
  );
  await assert.rejects(
    store.read({
      ...scope,
      owner: 'pair-a',
      owners: ['pair-b'],
      offset: 0,
      limit: 5,
    }),
    /could not be read/,
  );
  // a check that fails while a sibling's scope is looked at is not swallowed as "not there"
  await assert.rejects(
    store.read({ ...scope, owner: 'pair-b', owners: ['pair-a'], offset: 0, limit: 5 }, () => {
      throw new HostRefusal('unknown_client', 'This client is no longer paired.');
    }),
    /no longer paired/,
  );
});

test('missing chunks, mismatched replays and bad digests fail visibly and leave a usable retry', async (t) => {
  const { store } = rig(t);
  await assert.rejects(store.upload(chunk(5, bytes.subarray(5))), /Start/);
  await store.upload(chunk(0, bytes.subarray(0, 5)));
  await assert.rejects(store.upload(chunk(0, Buffer.from('wrong'))), /differently/);
  await assert.rejects(store.attachments(scope.owner, scope.chatId, [imageId]), /not uploaded/);
  await assert.rejects(store.upload(chunk(5, Buffer.from('wrongxx'))), /checksum/);
  assert.equal((await store.upload(chunk(0, bytes))).done, true);
});

test('quota bounds persistent bytes and count, including after restart; accepted images remain readable', async (t) => {
  const { dir, store } = rig(t, { quota: bytes.length, entries: 1 });
  await store.upload(chunk(0, bytes));
  const other = Buffer.from('other image');
  await assert.rejects(store.upload(chunk(0, other, { imageId: digest(other), size: other.length })), /full/);
  const restarted = createHostImages({ dir, quota: bytes.length, entries: 1 });
  await assert.rejects(restarted.upload(chunk(0, other, { imageId: digest(other), size: other.length })), /full/);
  assert.equal((await restarted.read({ ...scope, offset: 0, limit: 100 })).done, true);
});

test('retired queued operations never dispatch, and read failures do not reveal private store paths', async (t) => {
  const { dir, store } = rig(t);
  await assert.rejects(
    store.upload(chunk(0, bytes), () => {
      throw new HostRefusal('unknown_client', 'retired');
    }),
    /retired/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
  await store.upload(chunk(0, bytes));
  const attachment = (await store.attachments(scope.owner, scope.chatId, [imageId]))[0];
  fs.unlinkSync(attachment.path);
  await assert.rejects(store.read({ ...scope, offset: 0, limit: 10 }), (error: Error) => !error.message.includes(dir));
});

test('a partially written chunk followed by EIO resumes the exact original chunk after restart', async (t) => {
  const { dir, store } = rig(t);
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file: any, flags: any, mode: any) => {
    const handle = await open(file, flags, mode);
    if (String(file).endsWith('.part') && flags === (fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)) {
      const write: any = handle.write.bind(handle);
      let calls = 0;
      t.mock.method(handle, 'write', (async (buffer: any, offset: any, length: any, position: any) => {
        if (calls++ === 0) return write(buffer, offset, Math.min(2, length), position);
        throw Object.assign(new Error('disk write failed'), { code: 'EIO' });
      }) as any);
    }
    return handle;
  });
  await assert.rejects(store.upload(chunk(0, bytes)), /Try again/);
  t.mock.restoreAll();
  const restarted = createHostImages({ dir });
  assert.deepEqual(await restarted.upload(chunk(0, bytes)), { imageId, received: bytes.length, done: true });
  const answer = await restarted.read({ ...scope, offset: 0, limit: 100 });
  assert.deepEqual(Buffer.from(answer.data, 'base64'), bytes);
});

test('metadata published before retirement remains charged against the entry quota after restart', async (t) => {
  const { dir, store } = rig(t, { entries: 1 });
  let retired = false;
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file: any, flags: any, mode: any) => {
    const handle = await open(file, flags, mode);
    if (String(file).endsWith('.json') && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) retired = true;
    return handle;
  });
  await assert.rejects(
    store.upload(chunk(0, bytes), () => {
      if (retired) throw new HostRefusal('unknown_client', 'retired');
    }),
    /retired/,
  );
  t.mock.restoreAll();
  const restarted = createHostImages({ dir, entries: 1 });
  const other = Buffer.from('another');
  await assert.rejects(restarted.upload(chunk(0, other, { imageId: digest(other), size: other.length })), /full/);
  assert.equal((await restarted.upload(chunk(0, bytes))).done, true, 'the original upload can still recover its own reserved slot');
});
