// File previews share a format matrix, bounded binary boundary, range transport and legacy Office content readers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { filePreviewKind, isBinaryPreviewPath, previewMediaType, previewExtension } from '../shared/filePreview.mjs';
import '../src/lib/native/fs.ts';
import type { NativeApi } from '../src/lib/native';
const require = createRequire(import.meta.url);
const { createAssetHandler } = require('../electron/platform/assetProtocol.cjs');
const { readPreview, MAX_PREVIEW_BYTES } = require('../electron/platform/readPreview.cjs');
const { powerPointText, legacyOfficeText } = require('../electron/platform/legacyOffice.cjs');
const CFB = require('cfb');
const WordExtractor = require('word-extractor');

test('one terminal extension matrix serves all shared preview kinds and MIME types', () => {
  const cases = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'],
    audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg', 'oga'],
    video: ['mp4', 'mov', 'm4v', 'webm', 'ogv'],
    pdf: ['pdf'],
    html: ['html', 'htm'],
    table: ['csv', 'tsv'],
    workbook: ['xlsx', 'xls'],
    word: ['docx'],
    slides: ['pptx'],
    legacy: ['doc', 'ppt'],
    source: ['ts', 'md', 'unknown', '__proto__'],
  };
  for (const [kind, extensions] of Object.entries(cases))
    for (const ext of extensions) {
      const file = `C:\\folder.name\\封面 #?%.${ext.toUpperCase()}`;
      assert.equal(previewExtension(file), ext);
      assert.equal(filePreviewKind(file), kind);
      assert.equal(isBinaryPreviewPath(file), ['pdf', 'workbook', 'word', 'slides', 'legacy'].includes(kind));
      const mime = previewMediaType(file);
      assert.equal(mime?.split('/')[0] ?? null, ['image', 'audio', 'video'].includes(kind) ? kind : null);
    }
  for (const file of ['/folder.png/no-extension', '/folder.mp4/', '/file.', 'README']) {
    assert.equal(filePreviewKind(file), 'source');
    assert.equal(previewExtension(file), '');
  }
});

test('the local asset handler retains ranges/status and correct media MIME types', async () => {
  const calls: unknown[][] = [];
  const net = {
    fetch: async (...args: unknown[]) => {
      calls.push(args);
      return new Response('bytes', { status: 206, headers: { 'Content-Range': 'bytes 2-6/9' } });
    },
  };
  const headers = new Headers({ Range: 'bytes=2-6' });
  const response = await createAssetHandler(net, false)({ url: 'codex-asset:///tmp/%E5%B0%81%E9%9D%A2%20%23%25.MOV', headers });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-range'), 'bytes 2-6/9');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'bytes');
  assert.equal((calls[0][1] as { headers: Headers }).headers, headers);
  assert.equal(calls[0][0], 'file:///tmp/%E5%B0%81%E9%9D%A2%20%23%25.MOV');
  await createAssetHandler(net, true)({ url: 'codex-asset:///C:/images/cover.avif', headers });
  assert.match(String(calls[1][0]), /C:.*cover.avif/);
  await createAssetHandler(net, true)({ url: 'codex-asset:///images/cover.bmp', headers });
  assert.equal((await createAssetHandler(net, false)({ url: 'codex-asset:///%XX.png' })).status, 400);
  assert.equal((await createAssetHandler(net, false)({ url: 'codex-asset:///tmp/private.txt' })).status, 403);
  assert.equal(
    (
      await createAssetHandler(
        {
          fetch: async () => {
            throw Error('ENOENT');
          },
        },
        false,
      )({ url: 'codex-asset:///gone.png' })
    ).status,
    404,
  );
});

test('the binary read boundary rejects unsupported, missing, directory and oversized inputs, then reads valid bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-read-'));
  try {
    for (const invalid of [null, 1, 'relative.pdf', path.join(dir, 'private.txt')])
      await assert.rejects(readPreview(invalid), /supported local document/);
    await assert.rejects(readPreview(path.join(dir, 'missing.pdf')), /ENOENT/);
    const folder = path.join(dir, 'folder.pdf');
    await fs.mkdir(folder);
    await assert.rejects(readPreview(folder), /document file/);
    const huge = path.join(dir, 'huge.pdf');
    await fs.writeFile(huge, '');
    await fs.truncate(huge, MAX_PREVIEW_BYTES + 1);
    await assert.rejects(readPreview(huge), /25 MB/);
    const file = path.join(dir, 'bytes.PDF');
    await fs.writeFile(file, '%PDF-1.7\n');
    const result = await readPreview(file);
    assert.equal(result.kind, 'binary');
    assert.equal(Buffer.from(result.data).toString(), '%PDF-1.7\n');
    const empty = path.join(dir, 'empty.xlsx');
    await fs.writeFile(empty, '');
    assert.equal((await readPreview(empty)).data.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a file that grows during a binary read is rejected and the handle closes on every exit', async () => {
  let closed = 0;
  const open = mock.method(fs, 'open', async () => ({
    stat: async () => ({ isFile: () => true, size: 2 }),
    read: async (data: Buffer) => {
      data.fill(1);
      return { bytesRead: data.length };
    },
    close: async () => {
      closed++;
    },
  }));
  try {
    await assert.rejects(readPreview('/tmp/growing.pdf'), /changed while reading/);
    assert.equal(closed, 1);
  } finally {
    open.mock.restore();
  }
});

function ppt(records: Buffer[], name = 'PowerPoint Document') {
  const compound = CFB.utils.cfb_new();
  CFB.utils.cfb_add(compound, name, Buffer.concat(records));
  return CFB.write(compound, { type: 'buffer' });
}
function atom(type: number, bytes: Buffer, container = false) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(container ? 15 : 0, 0);
  header.writeUInt16LE(type, 2);
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

test('legacy PowerPoint parses nested Unicode and ANSI text and ignores non-text records', async () => {
  const bytes = ppt([
    atom(
      1000,
      Buffer.concat([atom(4000, Buffer.from('封面\rSecond line', 'utf16le')), atom(4008, Buffer.from([0x80])), atom(1, Buffer.alloc(0))]),
      true,
    ),
  ]);
  assert.equal(powerPointText(bytes), '封面\nSecond line\n\n€');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-ppt-'));
  try {
    const file = path.join(dir, 'slides.ppt');
    await fs.writeFile(file, bytes);
    assert.equal((await readPreview(file)).kind, 'text');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('legacy PowerPoint refuses corrupt, encrypted, empty and excessively nested records', () => {
  assert.throws(() => powerPointText(Buffer.from('broken')));
  assert.throws(() => powerPointText(ppt([], 'EncryptedSummary')), /Encrypted/);
  assert.throws(() => powerPointText(ppt([], 'Other stream')), /could not be read/);
  assert.throws(() => powerPointText(ppt([Buffer.alloc(1)])), /damaged/);
  const bad = atom(4000, Buffer.alloc(0));
  bad.writeUInt32LE(20, 4);
  assert.throws(() => powerPointText(ppt([bad])), /damaged/);
  assert.throws(() => powerPointText(ppt([])), /No readable text/);
  let nested = atom(4000, Buffer.from('hello', 'utf16le'));
  for (let n = 0; n < 66; n++) nested = atom(1000, nested, true);
  assert.throws(() => powerPointText(ppt([nested])), /too complex/);
});

test('legacy Word extracts document text and reports an empty document', async () => {
  let body = 'Legacy Word content';
  const extract = mock.method(WordExtractor.prototype, 'extract', async () => ({ getBody: () => body }));
  try {
    assert.equal(await legacyOfficeText(Buffer.alloc(0), 'doc'), body);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-doc-'));
    try {
      const file = path.join(dir, 'document.doc');
      await fs.writeFile(file, 'binary');
      assert.deepEqual(await readPreview(file), { kind: 'text', text: body });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    body = ' ';
    await assert.rejects(legacyOfficeText(Buffer.alloc(0), 'doc'), /No readable text/);
  } finally {
    extract.mock.restore();
  }
});

test('the registered IPC method and actual bridge carry binary document reads', async () => {
  const handlers = new Map<string, Function>();
  require('../electron/app/ipc/files.cjs').register(
    { handle: (name: string, callback: Function) => handlers.set(name, callback) },
    { app: { getPath: () => '/tmp' }, live: {} },
  );
  assert.ok(handlers.has('fs:readPreview'));
  await assert.rejects(handlers.get('fs:readPreview')!({}, '/tmp/not-supported.exe'), /supported local document/);
  const { buildApi } = require('../electron/bridge/spec.cjs');
  const calls: unknown[][] = [];
  const api = buildApi(
    { fs: require('../electron/bridge/fs.cjs') },
    {
      ipcRenderer: {
        invoke: async (...args: unknown[]) => {
          calls.push(args);
          return { kind: 'binary', data: new Uint8Array([1]) };
        },
      },
    },
  );
  const result: Awaited<ReturnType<NativeApi['fs']['readPreview']>> = await api.fs.readPreview('/tmp/document.pdf');
  assert.equal(result.kind, 'binary');
  assert.deepEqual(calls, [['fs:readPreview', '/tmp/document.pdf']]);
});
