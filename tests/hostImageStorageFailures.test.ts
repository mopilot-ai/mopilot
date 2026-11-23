// Host private image storage refuses corrupt disk state, exhausted quotas and stalled writes without exposing private paths or crossing image positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHostImages } from '../host/src/chatImages.mjs';
import { IMAGE_CHUNK_BYTES, MAX_IMAGE_BYTES, hostImageUrl } from '../shared/host/images.mjs';
const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
const imageId = createHash('sha256').update(bytes).digest('hex');
const scope = { owner: 'owner', chatId: 'chat', imageId };
const chunk = (offset = 0, data = bytes) => ({ ...scope, offset, size: bytes.length, mime: 'image/png', data: data.toString('base64') });
function rig(t: any, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-image-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createHostImages({ dir, ...options }) };
}
const files = (dir: string) => fs.readdirSync(dir).map((name) => path.join(dir, name));

test('initial discovery ignores unrelated files but refuses too many entries and unsafe image files', async (t) => {
  const clean = rig(t);
  fs.writeFileSync(path.join(clean.dir, 'unrelated'), 'not an image');
  assert.equal((await clean.store.upload(chunk())).done, true);
  const crowded = rig(t, { entries: 1 });
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(crowded.dir, `junk${i}`), '');
  await assert.rejects(crowded.store.upload(chunk()), /full/);
  for (const kind of ['directory', 'oversize']) {
    const bad = rig(t);
    const file = path.join(bad.dir, `${'0'.repeat(64)}-${imageId}.part`);
    if (kind === 'directory') fs.mkdirSync(file);
    else {
      fs.writeFileSync(file, '');
      fs.truncateSync(file, MAX_IMAGE_BYTES + 1);
    }
    await assert.rejects(bad.store.upload(chunk()), /repair/);
  }
});

test('metadata is bounded and validated on each read, not trusted from a previous upload', async (t) => {
  for (const content of [
    '{invalid',
    ' '.repeat(4097),
    JSON.stringify({ size: 0, mime: 'image/png' }),
    JSON.stringify({ size: 8, mime: 'text/plain' }),
  ]) {
    const h = rig(t);
    await h.store.upload(chunk());
    fs.writeFileSync(files(h.dir).find((f) => f.endsWith('.json'))!, content);
    await assert.rejects(
      h.store.read({ ...scope, offset: 0, limit: 8 }),
      (error: any) => /record/.test(error.message) && !error.message.includes(h.dir),
    );
  }
});

test('orphan chunks, holes and corrupted completed files cannot be resumed as a different image', async (t) => {
  const h = rig(t);
  await h.store.upload(chunk(0, bytes.subarray(0, 2)));
  const meta = files(h.dir).find((f) => f.endsWith('.json'))!;
  const part = files(h.dir).find((f) => f.endsWith('.part'))!;
  await assert.rejects(h.store.upload(chunk(4, bytes.subarray(4))), /missing chunk/);
  fs.unlinkSync(meta);
  await assert.rejects(h.store.upload(chunk()), /missing chunk/);
  fs.writeFileSync(meta, JSON.stringify({ size: 8, mime: 'image/png' }));
  fs.truncateSync(part, 9);
  await assert.rejects(h.store.upload(chunk()), /missing chunk/);
  fs.rmSync(part);
  fs.mkdirSync(part);
  await assert.rejects(h.store.upload(chunk()), /record/);
  fs.rmSync(part, { recursive: true });
  fs.writeFileSync(part, '');
  fs.truncateSync(part, MAX_IMAGE_BYTES + 1);
  await assert.rejects(h.store.upload(chunk()), /record/);
});

test('append-only quota, a truncated finalized image and a zero-byte write fail without acknowledging completion', async (t) => {
  const h = rig(t, { quota: 2 });
  await h.store.upload(chunk(0, bytes.subarray(0, 2)));
  await assert.rejects(h.store.upload(chunk(2, bytes.subarray(2, 3))), /full/);
  const done = rig(t);
  await done.store.upload(chunk());
  fs.truncateSync(files(done.dir).find((f) => f.endsWith('.png'))!, 2);
  await assert.rejects(done.store.upload(chunk(2, bytes.subarray(2))), /full/);
  const zero = rig(t);
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file: any, flags: any, mode: any) => {
    const handle = await open(file, flags, mode);
    if (String(file).endsWith('.part') && flags !== 'wx') t.mock.method(handle, 'write', async () => ({ bytesWritten: 0 }));
    return handle;
  });
  await assert.rejects(zero.store.upload(chunk()), /could not be saved/);
});

test('oversized/empty chunks and more than 64 waiting uploads are bounded before disk work grows', async (t) => {
  const h = rig(t);
  for (const data of ['', Buffer.alloc(IMAGE_CHUNK_BYTES + 1).toString('base64')])
    await assert.rejects(h.store.upload({ ...chunk(), data }), /too large/);
  const waiting = rig(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const mkdir = fs.promises.mkdir.bind(fs.promises);
  t.mock.method(fs.promises, 'mkdir', async (...args: any[]) => {
    await gate;
    return (mkdir as any)(...args);
  });
  const work = Array.from({ length: 65 }, () =>
    waiting.store.upload(chunk()).then(
      () => 'ok',
      (error: any) => error.message,
    ),
  );
  release();
  const results = await Promise.all(work);
  assert.equal(results.filter((r) => r === 'ok').length, 64);
  assert.match(results[64], /still uploading/);
});

test('projection preserves missing image slots while never relaying caller paths or malformed image URLs', (t) => {
  const { store } = rig(t);
  for (const user of [null, {}, { content: 'invalid' }]) assert.equal(store.project(user), user);
  assert.deepEqual(
    store.project({ content: [{ type: 'image', url: hostImageUrl(imageId) }, { type: 'image', url: '/private/image' }, null] }).content,
    [{ type: 'image', url: hostImageUrl(imageId) }, { type: 'image' }, null],
  );
});

test('a metadata record that cannot be opened is a missing record or a refusal, and nothing is closed that was never opened', async (t) => {
  const missing = rig(t);
  await missing.store.upload(chunk());
  fs.rmSync(files(missing.dir).find((f) => f.endsWith('.json'))!);
  await assert.rejects(missing.store.upload(chunk(2, bytes.subarray(2))), /upload again/);
  const denied = rig(t);
  await denied.store.upload(chunk());
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file: any, flags: any, mode: any) => {
    if (String(file).endsWith('.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return open(file, flags, mode);
  });
  await assert.rejects(
    denied.store.read({ ...scope, offset: 0, limit: 8 }),
    (error: any) => /record/.test(error.message) && !error.message.includes(denied.dir),
  );
});
