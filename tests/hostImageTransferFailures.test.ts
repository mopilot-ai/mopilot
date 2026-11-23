// Host image transfer failure boundaries: installed file ports, ownership error precedence, format detection, bounded RPC work and hostile acknowledgments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeFs as installFakeFs } from './support/ports/fs.ts';
import { MAX_IMAGE_BYTES, IMAGE_CHUNK_BYTES, MAX_MESSAGE_IMAGES } from '../shared/host/images.mjs';
const require = createRequire(import.meta.url);
const { uploadImages, readHostImage, mimeOf } = require('../electron/host/imageTransfer.cjs');
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const input = { chatId: 'chat', epoch: 1, attachments: [{ kind: 'image', path: '/private/picked' }], check: () => {} };
const host = (answer?: (p: any) => any) => ({
  speaks: () => true,
  call: async (_method: string, p: any) => ({ result: answer ? answer(p) : { imageId: p.imageId, received: p.size, done: true } }),
});

function filePort(
  t: any,
  options: { close?: () => Promise<void>; read?: (...args: any[]) => Promise<any>; open?: () => Promise<any>; size?: number } = {},
) {
  const file = {
    stat: async () => ({ isFile: () => true, size: options.size ?? png.length }),
    read:
      options.read ??
      (async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: png.copy(buffer, offset, position, position + length),
      })),
    close: options.close ?? (async () => {}),
  };
  installFakeFs(t, { promises: { open: options.open ?? (async () => file) } });
}

test('closing a captured image cannot expose a private file error or mask an earlier ownership refusal', async (t) => {
  let retire = false;
  filePort(t, {
    close: async () => {
      throw Object.assign(new Error('EIO: /private/picked'), { code: 'EIO' });
    },
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = png.copy(buffer, offset, position, position + length);
      if (retire) retired = true;
      return { bytesRead };
    },
  });
  let retired = false;
  const check = () => {
    if (retired) throw Object.assign(new Error('pair retired'), { code: 'stale_epoch' });
  };
  await assert.rejects(
    uploadImages({ ...input, host: host(), check }),
    (error: any) => error.code === 'unsupported' && !error.message.includes('/private'),
  );
  retire = true;
  await assert.rejects(uploadImages({ ...input, host: host(), check }), { code: 'stale_epoch' });
});

test('format detection distinguishes valid JPEG/GIF/WebP and rejects partial or misleading magic bytes', () => {
  for (const [bytes, expected] of [
    [png, 'image/png'],
    [Buffer.from('ffd8ff00', 'hex'), 'image/jpeg'],
    [Buffer.from('ffd800', 'hex'), null],
    [Buffer.from('ff00ff', 'hex'), null],
    [Buffer.from('00d8ff', 'hex'), null],
    [Buffer.from('GIF87a'), 'image/gif'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('GIF88a'), null],
    [Buffer.from('RIFFxxxxWEBP'), 'image/webp'],
    [Buffer.from('RIFFxxxxNOPE'), null],
    [Buffer.from('NOPExxxxWEBP'), null],
  ] as const)
    assert.equal(mimeOf(bytes), expected);
});

test('changing files, raw open failures and unsupported attachments refuse before an upload', async (t) => {
  for (const size of [png.length - 1, png.length + 1])
    await t.test(`file length changed from stat ${size}`, async (st) => {
      filePort(st, { size });
      await assert.rejects(uploadImages({ ...input, host: host() }), { code: 'unsupported' });
    });
  await t.test('non-Error open refusal is sanitized', async (st) => {
    filePort(st, {
      open: async () => {
        throw null;
      },
    });
    await assert.rejects(uploadImages({ ...input, host: host() }), { code: 'unsupported' });
  });
  for (const attachments of [
    [{ kind: 'file', path: '/private/not-image' }],
    Array.from({ length: MAX_MESSAGE_IMAGES + 1 }, () => input.attachments[0]),
  ])
    await assert.rejects(uploadImages({ ...input, attachments, host: host() }), { code: 'unsupported' });
  await assert.rejects(uploadImages({ ...input, host: { call: async () => {} } }), { code: 'feature_missing' });
});

test('a Host must acknowledge the exact digest, bounded progress and completion state', async (t) => {
  filePort(t);
  for (const alter of [
    () => null,
    (p: any) => ({ imageId: p.imageId, received: '8', done: true }),
    (p: any) => ({ imageId: p.imageId, received: -1, done: false }),
    (p: any) => ({ imageId: p.imageId, received: p.size + 1, done: true }),
    (p: any) => ({ imageId: p.imageId, received: p.size, done: false }),
    (p: any) => ({ imageId: 'other', received: p.size, done: true }),
  ])
    await assert.rejects(uploadImages({ ...input, host: host(alter) }), { code: 'invalid' });
});

test('a hostile Host trickling one byte per reply cannot keep a bounded historical read alive indefinitely', async () => {
  for (const bare of [{}, { speaks: () => true }])
    assert.equal(await readHostImage({ ...input, host: bare, imageId: '0'.repeat(64) }), null);
  let calls = 0;
  const limit = Math.ceil(MAX_IMAGE_BYTES / IMAGE_CHUNK_BYTES) + 1;
  const trickling = {
    speaks: () => true,
    call: async (_method: string, p: any) => {
      calls++;
      return { imageId: p.imageId, size: limit + 10, mime: 'image/png', data: 'eA==', nextOffset: p.offset + 1, done: false };
    },
  };
  assert.equal(await readHostImage({ ...input, host: trickling, imageId: '0'.repeat(64) }), null);
  assert.equal(calls, limit);
});
