// The downloaded-update loopback feed: serving files, read failures and client disconnection.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { serveUpdate } = createRequire(import.meta.url)('../electron/updates/download.cjs');

const BYTES = Buffer.from('0123456789abcdefghij');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-dl-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

for (const partial of [false, true]) {
  test(`a local update read failure ${partial ? 'after some bytes' : 'after stat'} ends the response without an uncaught error`, async (t) => {
    const { PassThrough } = await import('node:stream');
    const http = await import('node:http');
    const source = new PassThrough();
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    t.mock.method(fs, 'createReadStream', () => {
      opened();
      return source as any;
    });
    const file = path.join(dir, 'u.zip');
    fs.writeFileSync(file, BYTES);
    const feed = await serveUpdate({ file, update: { name: '2.0.0', notes: '' } });
    let request!: import('node:http').ClientRequest;
    let responded!: () => void;
    const headers = new Promise<void>((resolve) => {
      responded = resolve;
    });
    const outcome = new Promise<string>((resolve) => {
      request = http.get(feed.feedUrl.replace('feed.json', 'update.zip'), (res) => {
        responded();
        res.resume();
        res.on('end', () => resolve('complete'));
        res.on('error', () => resolve('failed'));
        res.on('aborted', () => resolve('failed'));
      });
      request.on('error', () => resolve('failed'));
    });
    try {
      await opening;
      if (partial) {
        source.write(BYTES.subarray(0, 3));
        await headers;
      }
      assert.doesNotThrow(() => source.emit('error', new Error('update file read failed')));
      assert.equal(await outcome, 'failed');
      assert.equal(source.destroyed, true);
    } finally {
      source.destroy();
      request.destroy();
      feed.close();
    }
  });
}

test('a local update client disconnect closes its in-progress file read', async (t) => {
  const { PassThrough } = await import('node:stream');
  const http = await import('node:http');
  const source = new PassThrough();
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  t.mock.method(fs, 'createReadStream', () => {
    opened();
    return source as any;
  });
  const file = path.join(dir, 'u.zip');
  fs.writeFileSync(file, BYTES);
  const feed = await serveUpdate({ file, update: { name: '2.0.0', notes: '' } });
  let responded!: () => void;
  const headers = new Promise<void>((resolve) => {
    responded = resolve;
  });
  const request = http.get(feed.feedUrl.replace('feed.json', 'update.zip'), (res) => {
    res.on('error', () => {});
    responded();
  });
  request.on('error', () => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await opening;
    source.write(BYTES.subarray(0, 3));
    await headers;
    const closed = new Promise<void>((resolve) => source.on('close', resolve));
    request.destroy();
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('file read remained open')), 1000);
      }),
    ]);
    assert.equal(source.destroyed, true);
  } finally {
    clearTimeout(timeout);
    source.destroy();
    request.destroy();
    feed.close();
  }
});

test('the loopback feed serves the update and its file to Squirrel, and nothing else', async () => {
  const file = path.join(dir, 'u.zip');
  fs.writeFileSync(file, BYTES);
  const s = await serveUpdate({ file, update: { name: '2.0.0', notes: 'n', pub_date: 'd' } });
  try {
    assert.match(s.feedUrl, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/feed\.json$/);
    const feed = await (await fetch(s.feedUrl)).json();
    assert.deepEqual(feed, { name: '2.0.0', notes: 'n', pub_date: 'd', url: s.feedUrl.replace('feed.json', 'update.zip') });
    const zip = await fetch(feed.url);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.deepEqual(Buffer.from(await zip.arrayBuffer()), BYTES);
    assert.equal((await fetch(new URL('/other', s.feedUrl))).status, 404);
    fs.rmSync(file);
    assert.equal((await fetch(feed.url)).status, 404);
  } finally {
    s.close();
  }
});
