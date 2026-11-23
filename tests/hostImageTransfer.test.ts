// Mac image transport uses negotiated bounded chunks, real durable Host storage and exact-owner checks before any decoder receives bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createHostImages } from '../host/src/chatImages.mjs';
import { IMAGE_CHUNK_BYTES, MAX_IMAGE_BYTES } from '../shared/host/images.mjs';
const require = createRequire(import.meta.url);
const { uploadImages, readHostImage } = require('../electron/host/imageTransfer.cjs');
const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(IMAGE_CHUNK_BYTES + 47, 12)]);
const imageId = createHash('sha256').update(bytes).digest('hex');
function rig(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-image-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'picked.png');
  fs.writeFileSync(file, bytes);
  let store = createHostImages({ dir: path.join(dir, 'private') });
  let lost = true;
  const calls: any[] = [];
  const host = {
    speaks: () => true,
    call: async (method: string, p: any) => {
      calls.push({ method, ...p });
      if (method === 'chat.image') return store.read({ ...p, owner: 'pair-a' });
      const result = await store.upload({ ...p, owner: 'pair-a' });
      if (lost) {
        lost = false;
        store = createHostImages({ dir: path.join(dir, 'private') });
        throw new Error('ack lost');
      }
      return { result };
    },
  };
  const input = { host, chatId: 'chat-a', epoch: 1, attachments: [{ kind: 'image', path: file }], check: () => {} };
  return { input, calls, file };
}

test('Mac retries a lost upload acknowledgment after Host restart, preserves repeated image positions and verifies all downloaded bytes', async (t) => {
  const { input, calls } = rig(t);
  await assert.rejects(uploadImages(input), /ack lost/);
  assert.deepEqual(await uploadImages({ ...input, attachments: [...input.attachments, ...input.attachments] }), [imageId, imageId]);
  const read = await readHostImage({ ...input, imageId });
  assert.deepEqual(read, { data: bytes, mime: 'image/png' });
  assert(calls.every((call) => call.data === undefined || Buffer.from(call.data, 'base64').length <= IMAGE_CHUNK_BYTES));
  assert(calls.every((call) => !JSON.stringify(call).includes(input.attachments[0].path)));
  assert(calls.filter((call) => call.method === 'chat.image').length > 1);
});

test('old Host refuses before opening local paths; owner retirement after a chunk prevents any further upload or read', async (t) => {
  const { input, calls } = rig(t);
  await assert.rejects(
    uploadImages({ ...input, host: { speaks: () => false }, attachments: [{ kind: 'image', path: '/private/never-read' }] }),
    { code: 'feature_missing' },
  );
  assert.equal(calls.length, 0);
  let current = true;
  const check = () => {
    if (!current) throw Object.assign(new Error('retired'), { code: 'stale_epoch' });
  };
  const host = {
    speaks: () => true,
    call: async (_method: string, p: any) => {
      current = false;
      return { result: { imageId: p.imageId, received: IMAGE_CHUNK_BYTES, done: false } };
    },
  };
  await assert.rejects(uploadImages({ ...input, host, check }), { code: 'stale_epoch' });
  current = true;
  await assert.rejects(readHostImage({ ...input, host, imageId, check }), { code: 'stale_epoch' });
});

test('oversized files, forged chunks, changed size/mime and checksum mismatches never reach a decoder', async (t) => {
  const { input, file } = rig(t);
  fs.truncateSync(file, MAX_IMAGE_BYTES + 1);
  await assert.rejects(uploadImages(input), { code: 'unsupported' });
  for (const overrides of [
    { size: MAX_IMAGE_BYTES + 1 },
    { imageId: '0'.repeat(64) },
    { nextOffset: 0 },
    { done: false },
    { data: '!invalid' },
    { mime: 'image/jpeg' },
    { data: Buffer.from('changed').toString('base64'), nextOffset: 7, size: 7 },
  ]) {
    const host = {
      speaks: () => true,
      call: async () => ({
        imageId,
        size: 8,
        mime: 'image/png',
        data: bytes.subarray(0, 8).toString('base64'),
        nextOffset: 8,
        done: true,
        ...overrides,
      }),
    };
    assert.equal(await readHostImage({ ...input, host, imageId }), null);
  }
  let n = 0;
  const host = {
    speaks: () => true,
    call: async () => {
      n++;
      return {
        imageId,
        size: n === 1 ? 16 : 17,
        mime: n === 1 ? 'image/png' : 'image/jpeg',
        data: bytes.subarray(0, 8).toString('base64'),
        nextOffset: n * 8,
        done: false,
      };
    },
  };
  assert.equal(await readHostImage({ ...input, host, imageId }), null);
  assert.equal(n, 2);
});

test('explicit image capture uses the installed filesystem and native-image ports, closes the handle, and refuses an empty conversion', async (t) => {
  const { mock } = await import('node:test');
  const { useFakeFs } = await import('./support/ports/fs.ts');
  const source = Buffer.from('picked-heic');
  let closed = 0;
  let empty = false;
  const decoded: Buffer[] = [];
  useFakeFs(t, {
    promises: {
      open: async (file: string) => {
        assert.equal(file, '/private/port-only-image.heic');
        return {
          stat: async () => ({ isFile: () => true, size: source.length }),
          read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
            bytesRead: source.copy(buffer, offset, position, position + length),
          }),
          close: async () => {
            closed++;
          },
        };
      },
    },
  });
  const port = mock.module('../electron/platform/ports/electronApi.cjs', {
    namedExports: {
      api: {
        nativeImage: {
          createFromBuffer: (data: Buffer) => {
            decoded.push(Buffer.from(data));
            return { isEmpty: () => empty, toPNG: () => bytes };
          },
        },
      },
    },
  });
  t.after(() => port.restore());
  const uploads: any[] = [];
  const input = {
    chatId: 'chat-port',
    epoch: 1,
    attachments: [{ kind: 'image', path: '/private/port-only-image.heic' }],
    check: () => {},
    host: {
      speaks: () => true,
      call: async (_method: string, params: any) => {
        uploads.push(params);
        return {
          result: {
            imageId: params.imageId,
            received: params.offset + Buffer.from(params.data, 'base64').length,
            done: params.offset + Buffer.from(params.data, 'base64').length === params.size,
          },
        };
      },
    },
  };
  assert.deepEqual(await uploadImages(input), [imageId]);
  assert.deepEqual(decoded, [source]);
  assert.equal(closed, 1);
  assert(uploads.every((part) => part.mime === 'image/png'));
  const before = uploads.length;
  empty = true;
  await assert.rejects(uploadImages(input), { code: 'unsupported' });
  assert.equal(uploads.length, before, 'a failed native conversion never uploads bytes');
  assert.equal(closed, 2, 'the failed conversion also releases its file handle');
});
