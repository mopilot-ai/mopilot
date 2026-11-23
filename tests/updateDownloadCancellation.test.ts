// Update download cancellation must retire resumable work before any new network attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const { downloadUpdate } = createRequire(import.meta.url)('../electron/updates/download.cjs');
const url = 'https://example.test/update.zip';

for (const outcome of ['success', 'failure']) {
  test(`cancellation while reading partial size (${outcome}) prevents an attempt and permits retry`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cancel-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const name = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(dir, `${name}.zip.part`), 'a');
    fs.writeFileSync(path.join(dir, `${name}.zip.json`), JSON.stringify({ validator: '"v1"', total: 2 }));
    const controller = new AbortController();
    const reason = new Error('channel changed');
    const stat = fs.promises.stat.bind(fs.promises);
    t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof fs.promises.stat>) => {
      const result = await stat(...args);
      if (String(args[0]).endsWith('.part')) {
        controller.abort(reason);
        if (outcome === 'failure') throw new Error('stat failed');
      }
      return result;
    });
    let requests = 0;
    const done = downloadUpdate({
      url,
      dir,
      signal: controller.signal,
      onProgress: () => {},
      fetch: async () => {
        requests++;
        return new Response('ab', { status: 200, headers: { 'content-length': '2', etag: '"v1"' } });
      },
    });
    await assert.rejects(done, (error: unknown) => error === reason);
    assert.equal(requests, 0);
    assert.equal(fs.readFileSync(path.join(dir, `${name}.zip.part`), 'utf8'), 'a');
    t.mock.restoreAll();
    const file = await downloadUpdate({
      url,
      dir,
      signal: new AbortController().signal,
      onProgress: () => {},
      fetch: async (_url: string, init: { headers: Record<string, string> }) => {
        assert.equal(init.headers.range, 'bytes=1-');
        return new Response('b', { status: 206, headers: { 'content-range': 'bytes 1-1/2' } });
      },
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'ab');
  });
}

for (const boundary of ['entry', 'metadata', 'cached-size', 'response', 'body', 'drain', 'completed-size', 'rename']) {
  test(`cancellation at ${boundary} does not publish more progress or success`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cancel-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const name = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const file = path.join(dir, `${name}.zip`);
    const controller = new AbortController();
    const reason = new Error('disposed');
    const cached = ['entry', 'metadata', 'cached-size'].includes(boundary);
    if (cached) {
      fs.writeFileSync(file, 'ab');
      fs.writeFileSync(`${file}.json`, JSON.stringify({ complete: true, total: 2 }));
    }
    if (boundary === 'entry') controller.abort(reason);
    if (boundary === 'metadata') {
      const read = fs.promises.readFile.bind(fs.promises);
      t.mock.method(fs.promises, 'readFile', async (...args: Parameters<typeof fs.promises.readFile>) => {
        const result = await read(...args);
        controller.abort(reason);
        return result;
      });
    }
    if (['cached-size', 'completed-size'].includes(boundary)) {
      const stat = fs.promises.stat.bind(fs.promises);
      t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof fs.promises.stat>) => {
        const result = await stat(...args);
        controller.abort(reason);
        return result;
      });
    }
    if (boundary === 'rename') {
      const rename = fs.promises.rename.bind(fs.promises);
      t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof fs.promises.rename>) => {
        const result = await rename(...args);
        controller.abort(reason);
        return result;
      });
    }
    if (boundary === 'drain') {
      const create = fs.createWriteStream.bind(fs);
      t.mock.method(fs, 'createWriteStream', (...args: Parameters<typeof fs.createWriteStream>) => {
        const out = create(...args);
        const write = out.write.bind(out);
        t.mock.method(out, 'write', (chunk: Buffer) => {
          write(chunk);
          queueMicrotask(() => {
            controller.abort(reason);
            out.emit('drain');
          });
          return false;
        });
        return out;
      });
    }
    let retiredProgress = 0;
    let requests = 0;
    await assert.rejects(
      downloadUpdate({
        url,
        dir,
        signal: controller.signal,
        onProgress: () => {
          if (controller.signal.aborted) retiredProgress++;
        },
        fetch: async () => {
          requests++;
          if (boundary === 'response') controller.abort(reason);
          let read = false;
          return {
            status: 200,
            headers: new Headers({ 'content-length': '2' }),
            body: {
              getReader: () => ({
                read: async () => {
                  if (boundary === 'body') controller.abort(reason);
                  if (read) return { done: true };
                  read = true;
                  return { done: false, value: Buffer.from('ab') };
                },
              }),
            },
          };
        },
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(retiredProgress, 0);
    assert.equal(requests, cached ? 0 : 1);
  });
}

test('cancellation during retry backoff prevents the next request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = new Error('channel changed');
  let requests = 0;
  await assert.rejects(
    downloadUpdate({
      url,
      dir,
      signal: controller.signal,
      onProgress: () => {},
      fetch: async () => {
        requests++;
        throw new Error('offline');
      },
      wait: async () => controller.abort(reason),
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(requests, 1);
});
