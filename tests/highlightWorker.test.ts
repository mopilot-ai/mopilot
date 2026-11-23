// Code blocks highlight in a worker: the client's request/reply protocol, the fallback to the window's engine when the
// worker is missing or dies, and the worker's own answers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const fakeHl = {
  loadLanguage: async () => {},
  codeToHtml: (code: string, o: { lang: string; theme: string }) => `<pre data-lang="${o.lang}" data-theme="${o.theme}">${code}</pre>`,
  codeToTokensBase: (code: string) => [[{ content: code }]],
};
mock.module('shiki', {
  namedExports: {
    bundledLanguages: { typescript: 1 },
    createHighlighter: async () => {
      return fakeHl;
    },
  },
});
const { WORKER_TIMEOUT_MS, createHighlightClient, highlight, tokenizeLines } = await import('../src/lib/highlight.ts');

/** A worker that the test drives: it records requests and answers (or fails) when told to. */
class FakeWorker {
  static made: FakeWorker[] = [];
  static autoReply: ((request: any) => any) | null = null;
  requests: any[] = [];
  terminated = false;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  constructor(..._args: unknown[]) {
    FakeWorker.made.push(this);
  }
  postMessage(request: any) {
    this.requests.push(request);
    const reply = FakeWorker.autoReply?.(request);
    if (reply) queueMicrotask(() => this.onmessage?.({ data: reply }));
  }
  terminate() {
    this.terminated = true;
  }
}
const asWorker = (w: FakeWorker) => w as unknown as Worker;

test('a request is answered by its own reply, in any order', async () => {
  const w = new FakeWorker();
  const client = createHighlightClient(() => asWorker(w));
  const first = client.run('a', 'ts', true);
  const second = client.run('b', 'ts', false);
  assert.deepEqual(
    w.requests.map((r) => [r.id, r.code, r.dark]),
    [
      [0, 'a', true],
      [1, 'b', false],
    ],
  );
  w.onmessage!({ data: { id: 1, html: '<b/>', final: true } });
  w.onmessage!({ data: { id: 0, html: '<a/>', final: false } });
  w.onmessage!({ data: { id: 7, html: 'nobody asked', final: true } });
  assert.deepEqual(await first, { html: '<a/>', final: false });
  assert.deepEqual(await second, { html: '<b/>', final: true });
});

test('an error the engine reported rejects that request only and keeps the worker', async () => {
  const w = new FakeWorker();
  const client = createHighlightClient(() => asWorker(w));
  const bad = client.run('a', 'ts', true);
  const good = client.run('b', 'ts', true);
  w.onmessage!({ data: { id: 0, error: 'no grammar' } });
  w.onmessage!({ data: { id: 1, html: 'ok', final: true } });
  await assert.rejects(bad, /no grammar/);
  assert.deepEqual(await good, { html: 'ok', final: true });
  assert.equal(w.terminated, false);
});

test('a crashed worker hands every waiting request and all later ones to the window', async () => {
  const w = new FakeWorker();
  const made: FakeWorker[] = [w];
  const client = createHighlightClient(() => asWorker(made[0]));
  const waiting = client.run('a', 'ts', true);
  w.onerror!({});
  assert.equal(await waiting, null);
  assert.equal(w.terminated, true);
  assert.equal(await client.run('b', 'ts', true), null);
  assert.equal(w.requests.length, 1, 'a broken worker gets no more requests');
});

test('an unreadable reply also retires the worker', async () => {
  const w = new FakeWorker();
  const client = createHighlightClient(() => asWorker(w));
  const waiting = client.run('a', 'ts', true);
  w.onmessageerror!({});
  assert.equal(await waiting, null);
  assert.equal(w.terminated, true);
});

test('a worker that cannot start or be written to retires without an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const noStart = createHighlightClient(() => {
      throw new Error('no workers here');
    });
    assert.equal(await noStart.run('a', 'ts', true), null);
    assert.equal(await noStart.run('b', 'ts', true), null);

    const w = new FakeWorker();
    w.postMessage = () => {
      throw new Error('DataCloneError');
    };
    const noWrite = createHighlightClient(() => asWorker(w));
    assert.equal(await noWrite.run('a', 'ts', true), null);
    assert.equal(w.terminated, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the worker highlights code blocks; the window does not start its own engine', async (t) => {
  FakeWorker.made = [];
  FakeWorker.autoReply = ({ id, code, lang, dark }) => ({ id, html: `worker:${lang}:${dark}:${code}`, final: !code.startsWith('retry') });
  (globalThis as any).Worker = FakeWorker;
  t.after(() => {
    delete (globalThis as any).Worker;
    FakeWorker.autoReply = null;
  });
  assert.equal(await highlight('x', 'ts', true), 'worker:ts:true:x');
  assert.equal(FakeWorker.made.length, 1);
  assert.equal(FakeWorker.made[0].requests.length, 1);
  // a final result stays in the window: a block that mounts again does not wait for the worker
  assert.equal(await highlight('x', 'ts', true), 'worker:ts:true:x');
  assert.equal(FakeWorker.made[0].requests.length, 1);
  // a fallback the engine would ask again is not kept
  await highlight('retry me', 'ts', true);
  await highlight('retry me', 'ts', true);
  assert.equal(FakeWorker.made[0].requests.length, 3);
});

test('diff tokens come from the window engine', async () => {
  assert.deepEqual(await tokenizeLines('line', 'typescript', true), [[['line', '']]]);
});

test('a worker that dies mid-stream leaves highlighting to the window, with nothing lost', async (t) => {
  FakeWorker.autoReply = null;
  (globalThis as any).Worker = FakeWorker;
  t.after(() => delete (globalThis as any).Worker);
  const live = FakeWorker.made[0];
  const pending = highlight('after crash', 'typescript', false);
  await new Promise((resolve) => setImmediate(resolve));
  live.onerror!({});
  assert.equal(await pending, '<pre data-lang="typescript" data-theme="codex-light">after crash</pre>');
  assert.match(await highlight('again', 'typescript', true), /data-theme="codex-dark">again/);
  assert.equal(FakeWorker.made.length, 1, 'the worker is not started again');
});

test('the worker script answers each request, and reports a failure as its message', async () => {
  const posted: any[] = [];
  const self_ = { postMessage: (m: unknown) => posted.push(m), onmessage: null as any };
  (globalThis as any).self = self_;
  try {
    const { answer } = await import('../src/lib/highlightWorker.ts');
    self_.onmessage({ data: { id: 3, code: 'c', lang: 'typescript', dark: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(posted, [{ id: 3, html: '<pre data-lang="typescript" data-theme="codex-dark">c</pre>', final: true }]);
    const failing = (error: unknown) => async () => {
      throw error;
    };
    assert.deepEqual(await answer({ id: 4, code: 'c', lang: 'text', dark: true }, failing(new Error('startup failed'))), {
      id: 4,
      error: 'startup failed',
    });
    assert.deepEqual(await answer({ id: 5, code: 'c', lang: 'text', dark: true }, failing('plain failure')), {
      id: 5,
      error: 'plain failure',
    });
  } finally {
    delete (globalThis as any).self;
  }
});

test('a worker that never answers is retired after the timeout and the window takes over', async () => {
  assert.equal(WORKER_TIMEOUT_MS > 0, true);
  const w = new FakeWorker();
  const client = createHighlightClient(() => asWorker(w), 5);
  assert.equal(await client.run('a', 'ts', true), null);
  assert.equal(w.terminated, true);
  assert.equal(await client.run('b', 'ts', true), null);
});

test('the engine keeps final results and asks again for a fallback', async () => {
  const { highlightEntry } = await import('../src/lib/highlightEngine.ts');
  const first = await highlightEntry('same', 'typescript', true);
  assert.equal(first.final, true);
  assert.deepEqual(await highlightEntry('same', 'typescript', true), first);
  assert.equal((await highlightEntry('none', 'unknown-lang', true)).final, true);
});
