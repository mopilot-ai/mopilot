// The macOS update download: progress, stall timeout, cancellation, and resume with Range.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const { downloadUpdate, statusFailure, STALL_MS } = createRequire(import.meta.url)('../electron/updates/download.cjs');

const URL_ = 'https://example.test/dl/MoPilot-2.0.0-arm64.zip';
const BYTES = Buffer.from('0123456789abcdefghij');
let dir: string;
beforeEach((t) => {
  assert.ok('mock' in t);
  // Only explicit ticks may expire a download; filesystem/CPU scheduling must not choose its error.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-dl-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A response whose body yields `chunks`, then ends, fails with `error`, or hangs until aborted. */
function reply(
  status: number,
  headers: Record<string, string>,
  chunks: Buffer[],
  end: 'end' | 'hang' | Error = 'end',
  signal?: AbortSignal,
  onHang?: () => void,
) {
  let i = 0;
  return {
    status,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { done: false, value: new Uint8Array(chunks[i++]) };
          if (end === 'end') return { done: true, value: undefined };
          if (end instanceof Error) throw end;
          return new Promise((_r, reject) => {
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            onHang?.();
          });
        },
      }),
    },
  };
}

const full = (extra: Record<string, string> = {}) => ({ 'content-length': String(BYTES.length), etag: '"v1"', ...extra });

function run(fetch: (url: string, init: any) => Promise<any>, o: any = {}) {
  const progress: [number, number | null][] = [];
  const waits: number[] = [];
  const signal = o.signal ?? new AbortController().signal;
  return {
    progress,
    waits,
    done: downloadUpdate({
      url: URL_,
      dir,
      fetch,
      signal,
      onProgress: (r: number, t: number | null) => progress.push([r, t]),
      wait: async (ms: number) => void waits.push(ms),
      ...o,
    }),
  };
}

test('a download writes the file, reports progress, and a second run reuses it', async () => {
  const seen: any[] = [];
  const fetch = async (url: string, init: any) => (
    seen.push([url, init.headers]), reply(200, full(), [BYTES.subarray(0, 8), BYTES.subarray(8)])
  );
  const a = run(fetch, { headers: { authorization: 'Bearer t' } });
  const file = await a.done;
  assert.deepEqual(fs.readFileSync(file), BYTES);
  assert.deepEqual(a.progress, [
    [0, 20],
    [8, 20],
    [20, 20],
  ]);
  assert.deepEqual(seen, [[URL_, { authorization: 'Bearer t' }]]);
  const b = run(async () => assert.fail('not downloaded again'));
  assert.equal(await b.done, file);
  assert.deepEqual(b.progress, [[20, 20]]);
  assert.equal(STALL_MS, 60_000);
});

test('one update is kept: files of another download are removed', async () => {
  fs.writeFileSync(path.join(dir, 'old.zip'), 'old');
  fs.mkdirSync(path.join(dir, 'stray'));
  await run(async () => reply(200, full(), [BYTES])).done;
  assert.equal(fs.existsSync(path.join(dir, 'old.zip')), false);
  assert.equal(fs.existsSync(path.join(dir, 'stray')), false);
});

test('a stalled download resumes where it stopped, with the validator, and succeeds', async (t) => {
  const seen: any[] = [];
  let n = 0;
  const fetch = async (_url: string, init: any) => {
    seen.push(init.headers);
    n++;
    if (n === 1) return reply(200, full(), [BYTES.subarray(0, 5)], 'hang', init.signal, () => t.mock.timers.tick(STALL_MS));
    return reply(206, { 'content-range': `bytes 5-19/20`, 'content-length': '15' }, [BYTES.subarray(5)]);
  };
  const a = run(fetch);
  const file = await a.done;
  assert.deepEqual(fs.readFileSync(file), BYTES);
  assert.deepEqual(seen[1], { range: 'bytes=5-', 'if-range': '"v1"' });
  assert.deepEqual(a.waits, [2000], 'a failure after progress waits the shortest time');
  assert.deepEqual(a.progress.at(-1), [20, 20]);
});

test('a download left by an earlier run resumes; one the server replaced starts over', async () => {
  // the earlier run got 5 bytes
  let n = 0;
  await run(async (_u: string, init: any) =>
    n++ ? reply(500, {}, []) : reply(200, full(), [BYTES.subarray(0, 5)], new Error('reset')),
  ).done.catch(() => {});
  // the server changed the file: it answers the whole of the new one (If-Range did not match)
  const next = Buffer.from('NEWFILE-NEWFILE-NEWF');
  const seen: any[] = [];
  const file = await run(async (_u: string, init: any) => (seen.push(init.headers), reply(200, full({ etag: '"v2"' }), [next]))).done;
  assert.equal(seen[0].range, 'bytes=5-');
  assert.deepEqual(fs.readFileSync(file), next);
});

test('a weak etag is not a validator: last-modified is used, and without either nothing is resumed', async () => {
  for (const [headers, expected] of [
    [{ etag: 'W/"weak"', 'last-modified': 'Wed, 14 Oct 2026 07:03:39 GMT' }, 'Wed, 14 Oct 2026 07:03:39 GMT'],
    [{ etag: 'W/"weak"' }, undefined],
  ] as const) {
    fs.rmSync(dir, { recursive: true, force: true });
    const seen: any[] = [];
    let n = 0;
    await run(async (_u: string, init: any) => {
      seen.push(init.headers);
      return n++
        ? reply(200, headers, [BYTES])
        : reply(200, { 'content-length': '20', ...headers }, [BYTES.subarray(0, 4)], new Error('reset'));
    }).done;
    assert.equal(seen[1]['if-range'], expected);
    assert.equal(seen[1].range, expected ? 'bytes=4-' : undefined);
  }
});

test('a server without a size: progress has no total, and the file is whatever arrived', async () => {
  const a = run(async () => reply(200, {}, [BYTES]));
  assert.deepEqual(fs.readFileSync(await a.done), BYTES);
  assert.deepEqual(a.progress, [
    [0, null],
    [20, null],
  ]);
});

test('a 416 for the partial file starts over', async () => {
  let n = 0;
  const statuses: number[] = [];
  await run(async (_u: string, init: any) => {
    n++;
    if (n === 1) return reply(200, full(), [BYTES.subarray(0, 3)], new Error('reset'));
    if (n === 2) return statuses.push(416), reply(416, {}, []);
    assert.equal(init.headers.range, undefined, 'the partial file is dropped');
    return reply(200, full(), [BYTES]);
  }).done;
  assert.deepEqual(statuses, [416]);
});

test('a resume answered with a different range starts over from the whole file', async () => {
  let n = 0;
  const file = await run(async () => {
    n++;
    if (n === 1) return reply(200, full(), [BYTES.subarray(0, 3)], new Error('reset'));
    return reply(206, { 'content-range': 'bytes 0-19/20' }, []);
  }).done.catch((e: Error) => e);
  // a 206 that does not continue the partial file is not a resume, and not a whole file either
  assert.equal((file as Error).message, statusFailure('Update download', URL_, 206));
});

test('an HTTP error status fails at once, naming the server', async () => {
  let n = 0;
  const e = await run(async () => (n++, reply(404, {}, []))).done.catch((x: Error) => x);
  assert.equal(e.message, 'Update download failed: example.test answered HTTP 404.');
  assert.equal(n, 1);
});

test('attempts that get nothing fail after the limit: a stall and a network error say which', async (t) => {
  const stall = run(async (_u: string, init: any) => reply(200, full(), [], 'hang', init.signal, () => t.mock.timers.tick(STALL_MS)), {
    maxFailures: 3,
  });
  const e1 = await stall.done.catch((x: Error) => x);
  assert.equal(e1.message, 'Update download stalled: example.test sent no data for 60 seconds. Check for updates resumes it.');
  assert.deepEqual(stall.waits, [2000, 4000], 'backs off between attempts');
  const net = run(
    async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    },
    { maxFailures: 2 },
  );
  const e2 = await net.done.catch((x: Error) => x);
  assert.equal(e2.message, "Update download failed: could not reach example.test. You're offline.");
  // a body that ends early counts as a failed attempt
  const short = run(async () => reply(200, full(), [BYTES.subarray(0, 2)]), { maxFailures: 1 });
  assert.match((await short.done.catch((x: Error) => x)).message, /the download ended early \(2 of 20 bytes\)/);
});

test('the back-off is capped, and an abort ends it at once', async (t) => {
  const stall = run(async (_u: string, init: any) => reply(200, full(), [], 'hang', init.signal, () => t.mock.timers.tick(STALL_MS)), {
    maxFailures: 7,
  });
  await stall.done.catch(() => {});
  assert.deepEqual(stall.waits, [2000, 4000, 8000, 16000, 30000, 30000]);
  const abort = new AbortController();
  const timer = globalThis.setTimeout;
  const waiting = deferred<void>();
  t.mock.method(globalThis, 'setTimeout', ((callback: any, ms: number, ...args: any[]) => {
    const id = timer(callback, ms, ...args);
    if (ms === 2000) waiting.resolve();
    return id;
  }) as typeof setTimeout);
  let attempts = 0;
  const real = run(
    async () => {
      attempts++;
      throw new Error('offline');
    },
    { wait: undefined, signal: abort.signal },
  );
  const outcome = real.done.catch((x: Error) => x);
  await waiting.promise;
  abort.abort(new Error('channel changed'));
  assert.equal((await outcome).message, 'channel changed');
  t.mock.timers.tick(2000);
  assert.equal(attempts, 1, 'an aborted back-off never starts another attempt');
  const { getEventListeners } = await import('node:events');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('attempts that get no further than before count as failures, even when they receive bytes', async () => {
  // a server that ignores Range and drops the connection at the same point every time
  let n = 0;
  const a = run(async () => (n++, reply(200, { 'content-length': '20' }, [BYTES.subarray(0, 5)], new Error('reset'))), { maxFailures: 3 });
  assert.match((await a.done.catch((x: Error) => x)).message, /could not reach example\.test\. Reset\./);
  assert.equal(n, 3);
  // more than the announced size: the file is dropped and fetched again, then given up on
  const b = run(async () => reply(200, { 'content-length': '10', etag: '"v1"' }, [BYTES]), { maxFailures: 2 });
  assert.equal(
    (await b.done.catch((x: Error) => x)).message,
    'Update download failed: the download is larger than the server said (20 of 10 bytes). Check for updates tries again.',
  );
});

test('a file that cannot be written fails at once with why, without retrying', async () => {
  const crypto = await import('node:crypto');
  const name = crypto.createHash('sha256').update(URL_).digest('hex').slice(0, 16);
  fs.mkdirSync(path.join(dir, `${name}.zip.part`));
  let n = 0;
  const a = run(async () => (n++, reply(200, full(), [BYTES.subarray(0, 4), BYTES.subarray(4)])));
  assert.match((await a.done.catch((x: Error) => x)).message, /^Could not save the update\. Illegal operation on a directory\.$/);
  assert.equal(n, 1);
  // a write that fails while waiting for the stream to drain does not hang
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, `${name}.zip.part`), { recursive: true });
  const big = Buffer.alloc(4 * 1024 * 1024, 1);
  const b = run(async () => reply(200, { 'content-length': String(big.length * 2) }, [big, big], 'hang'));
  assert.match((await b.done.catch((x: Error) => x)).message, /^Could not save the update/);
});

test('aborting stops the download with the abort reason, and never retries', async () => {
  const abort = new AbortController();
  let n = 0;
  const a = run(
    async (_u: string, init: any) => {
      n++;
      queueMicrotask(() => abort.abort(new Error('channel changed')));
      return reply(200, full(), [BYTES.subarray(0, 2)], 'hang', init.signal);
    },
    { signal: abort.signal },
  );
  assert.equal((await a.done.catch((x: Error) => x)).message, 'channel changed');
  assert.equal(n, 1);
  const before = new AbortController();
  before.abort(new Error('gone'));
  assert.equal((await run(async () => assert.fail(), { signal: before.signal }).done.catch((x: Error) => x)).message, 'gone');
});

test('edge replies: the default stall limit, 206 without a resume, a resume without a size, and backpressure', async () => {
  // the default stall limit applies when none is given
  assert.deepEqual(fs.readFileSync(await run(async () => reply(200, full(), [BYTES]), { stallMs: undefined }).done), BYTES);
  // a 206 to a request that asked for no range, or one without a Content-Range, is not a resume
  for (const headers of [{ 'content-range': 'bytes 0-19/20' }, {}] as Record<string, string>[]) {
    fs.rmSync(dir, { recursive: true, force: true });
    let n = 0;
    const e = await run(async () => {
      n++;
      if (n === 1 && 'content-range' in headers) return reply(206, headers, []);
      if (n === 1) return reply(200, full(), [BYTES.subarray(0, 3)], new Error('reset'));
      return reply(206, headers, []);
    }).done.catch((x: Error) => x);
    assert.equal((e as Error).message, statusFailure('Update download', URL_, 206));
  }
  // a server that sent no size: the resumed download has none either
  fs.rmSync(dir, { recursive: true, force: true });
  let n = 0;
  const a = run(async () =>
    n++
      ? reply(206, { 'content-range': 'bytes 3-19/*' }, [BYTES.subarray(3)])
      : reply(200, { etag: '"v1"' }, [BYTES.subarray(0, 3)], new Error('reset')),
  );
  assert.deepEqual(fs.readFileSync(await a.done), BYTES);
  assert.deepEqual(a.progress.at(-1), [20, null]);
  // a chunk larger than the file stream's buffer waits for it to drain
  fs.rmSync(dir, { recursive: true, force: true });
  const big = Buffer.alloc(4 * 1024 * 1024, 7);
  const file = await run(async () => reply(200, { 'content-length': String(big.length), etag: '"big"' }, [big, big.subarray(0, 0)])).done;
  assert.equal(fs.statSync(file).size, big.length);
});

test('completed retry back-offs leave no abort subscriptions on the download signal', async (t) => {
  const { getEventListeners } = await import('node:events');
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: any, ms: number, ...args: any[]) => {
    const id = timer(callback, ms, ...args);
    if (ms === 2000 || ms === 4000) queueMicrotask(() => t.mock.timers.tick(ms));
    return id;
  }) as typeof setTimeout);
  const abort = new AbortController();
  let attempts = 0;
  await assert.rejects(
    run(
      async () => {
        attempts++;
        throw new Error('offline');
      },
      {
        signal: abort.signal,
        wait: undefined,
        stallMs: 60_000,
        maxFailures: 3,
      },
    ).done,
    /Offline/,
  );
  assert.equal(attempts, 3);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('repeated stream backpressure keeps only the file-close waiter between chunks', async (t) => {
  const create = fs.createWriteStream;
  let output: fs.WriteStream | undefined;
  let drains = 0;
  let mostCloseListeners = 0;
  t.mock.method(fs, 'createWriteStream', (file: any, options: any) => {
    output = create(file, { ...options, highWaterMark: 1 });
    output.on('drain', () => {
      drains++;
    });
    return output;
  });
  const file = await run(
    async () =>
      reply(
        200,
        full(),
        [...BYTES].map((byte) => Buffer.from([byte])),
      ),
    {
      onProgress: () => {
        mostCloseListeners = Math.max(mostCloseListeners, output?.listenerCount('close') ?? 0);
      },
    },
  ).done;
  assert.equal(drains, BYTES.length);
  assert.equal(mostCloseListeners, 1);
  assert.deepEqual(fs.readFileSync(file), BYTES);
});

test('the production watchdog expires at 60 seconds without bytes and resets after each chunk', async (t) => {
  const reads = Array.from({ length: 3 }, () => deferred<any>());
  const waiting = Array.from({ length: 3 }, () => deferred<void>());
  let attempt!: AbortSignal;
  let i = 0;
  const a = run(
    async (_url: string, init: any) => {
      attempt = init.signal;
      attempt.addEventListener('abort', () => reads[2].reject(attempt.reason), { once: true });
      return {
        status: 200,
        headers: new Headers(full()),
        body: {
          getReader: () => ({
            read: () => {
              waiting[i].resolve();
              return reads[i++].promise;
            },
          }),
        },
      };
    },
    { maxFailures: 1 },
  );
  const outcome = assert.rejects(a.done, {
    message: 'Update download stalled: example.test sent no data for 60 seconds. Check for updates resumes it.',
  });
  for (let n = 0; n < 3; n++) {
    await waiting[n].promise;
    t.mock.timers.tick(59_999);
    assert.equal(attempt.aborted, false, 'each chunk renews the full production stall window');
    if (n < 2) reads[n].resolve({ done: false, value: BYTES.subarray(n * 5, n * 5 + 5) });
  }
  t.mock.timers.tick(1);
  assert.equal(attempt.aborted, true);
  await outcome;
  assert.deepEqual(a.progress, [
    [0, 20],
    [5, 20],
    [10, 20],
  ]);
});

test('finished attempts clear their watchdog and cancellation subscription', async (t) => {
  const { getEventListeners } = await import('node:events');
  const controller = new AbortController();
  const attempts: AbortSignal[] = [];
  let n = 0;
  const a = run(
    async (_url: string, init: any) => {
      attempts.push(init.signal);
      return n++ ? reply(200, full(), [BYTES]) : reply(200, full(), [], new Error('reset'));
    },
    { signal: controller.signal },
  );
  assert.deepEqual(fs.readFileSync(await a.done), BYTES);
  assert.equal(attempts.length, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  t.mock.timers.tick(STALL_MS);
  assert.deepEqual(
    attempts.map((signal) => signal.aborted),
    [false, false],
    'neither retired timer can fire',
  );
  controller.abort(new Error('after completion'));
  assert.deepEqual(
    attempts.map((signal) => signal.aborted),
    [false, false],
  );
});
