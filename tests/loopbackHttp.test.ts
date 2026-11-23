// The HTTP pieces the loopback proxies share (electron/platform/loopbackHttp.cjs): hop-by-hop headers dropped, a body read whole up to
// a limit, a body cut off rejected rather than waited on forever, compressed answers decoded, and refusals as JSON or a cut connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripHop, readAll, decode, fail, HOP } = require('../electron/platform/loopbackHttp.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

test('stripHop drops the connection’s own headers and empty values', () => {
  assert.deepEqual(stripHop({ host: 'x', connection: 'keep-alive', 'content-length': '3', 'x-a': '1', 'x-b': null, 'x-c': undefined }), {
    'x-a': '1',
  });
  assert.ok(HOP.has('transfer-encoding'));
});

test('readAll: the whole body, a refusal past the limit, and a body cut off before its end', async () => {
  const s = new PassThrough();
  const whole = readAll(s);
  s.write('ab');
  s.end('c');
  assert.equal((await whole).toString(), 'abc');
  const big = new PassThrough();
  const limited = readAll(big, 3);
  big.write('abcd');
  await assert.rejects(limited, (e: any) => e.code === 'too_large');
  const cut = new PassThrough();
  const cutOff = readAll(cut);
  cut.write('a');
  cut.destroy();
  await assert.rejects(cutOff, (e: any) => e.code === 'cut_off');
  const broken = new PassThrough();
  const failed = readAll(broken);
  broken.destroy(new Error('reset'));
  await assert.rejects(failed, /reset/);
});

test('decode: each content-encoding, and bytes not compressed as labeled pass through', () => {
  const text = Buffer.from('hello');
  assert.equal(decode(zlib.gzipSync(text), 'gzip').toString(), 'hello');
  assert.equal(decode(zlib.brotliCompressSync(text), 'br').toString(), 'hello');
  assert.equal(decode(zlib.deflateSync(text), 'deflate').toString(), 'hello');
  if (zlib.zstdCompressSync) assert.equal(decode(zlib.zstdCompressSync(text), 'zstd').toString(), 'hello');
  assert.equal(decode(text, undefined), text);
  assert.equal(decode(text, 'gzip'), text);
  assert.ok(recentIgnored().some((e: any) => e.context === 'decode a gzip answer'));
});

test('fail: JSON with the message or the body given, or a cut connection once a reply started', () => {
  const res = (sent: boolean) => {
    const out: any = { headersSent: sent, head: null, body: null, destroyed: false };
    out.writeHead = (status: number, h: any) => (out.head = [status, h]);
    out.end = (b: string) => (out.body = b);
    out.destroy = () => (out.destroyed = true);
    return out;
  };
  const a = res(false);
  fail(a, 404, 'Not found');
  assert.deepEqual([a.head, JSON.parse(a.body)], [[404, { 'content-type': 'application/json' }], { error: { message: 'Not found' } }]);
  const b = res(false);
  fail(b, 400, 'x', { type: 'error' });
  assert.deepEqual(JSON.parse(b.body), { type: 'error' });
  const c = res(true);
  fail(c, 502, 'x');
  assert.equal(c.destroyed, true);
  assert.equal(c.body, null);
});
