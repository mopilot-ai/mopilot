// A transcription nobody waits for any more is stopped in main: the caller's signal (its share of the wait over) or the
// recording ending aborts the upload, and no further attempt is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDictation, WATCH_MS } = require('../electron/platform/voice.cjs');

const clip = { bytes: new Uint8Array([1, 2]), mime: 'audio/webm' };

/** A fetch that never answers until its signal aborts, which rejects it as a real fetch does. */
function hangingFetch() {
  const seen: { url: string; init: any }[] = [];
  const fetch = (url: string, init: any) => {
    seen.push({ url, init });
    return new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(new Error('This operation was aborted'));
      init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
    });
  };
  return { seen, fetch };
}

function service(fetch: any, extra: Record<string, unknown> = {}) {
  return createDictation({
    chatgptHeaders: async () => ({ Authorization: 'Bearer chatgpt' }),
    gatewayKey: () => 'gw-key',
    apiBase: 'https://api.example.test',
    sleep: async () => undefined,
    fetch,
    ...extra,
  });
}

test('the caller giving up aborts a ChatGPT upload, and no attempt is sent after it', async () => {
  const net = hangingFetch();
  const gaveUp = new AbortController();
  const answer = service(net.fetch).transcribe({ engine: 'chatgpt', ...clip, signal: gaveUp.signal });
  await new Promise(setImmediate);
  assert.equal(net.seen.length, 1);
  assert.equal(net.seen[0].init.signal.aborted, false);
  gaveUp.abort();
  // a network failure is sent again (three attempts), but not once nobody waits; it reads as a timeout, not the abort
  assert.deepEqual(await answer, { error: 'The dictation service took too long' });
  assert.equal(net.seen.length, 1);
  assert.equal(net.seen[0].init.signal.aborted, true);
});

test('a retry waiting out its backoff is not sent once the caller gave up', async () => {
  const gaveUp = new AbortController();
  const sent: unknown[] = [];
  const dictation = service(
    async (url: string) => {
      sent.push(url);
      return { ok: false, status: 503, json: async () => ({}) };
    },
    { sleep: async () => gaveUp.abort() },
  );
  assert.deepEqual(await dictation.transcribe({ engine: 'chatgpt', ...clip, signal: gaveUp.signal }), {
    error: 'The dictation service took too long',
  });
  assert.equal(sent.length, 1);
});

test('a signal already aborted stops the MoPilot credits upload at once; without one, nothing is aborted', async () => {
  const net = hangingFetch();
  const gaveUp = new AbortController();
  gaveUp.abort();
  assert.deepEqual(await service(net.fetch).transcribe({ engine: 'credits', ...clip, signal: gaveUp.signal }), {
    error: 'The dictation service took too long',
  });
  assert.equal(net.seen[0].url, 'https://api.example.test/v1/audio/transcriptions');
  let signal: AbortSignal | undefined;
  const dictation = service(async (_url: string, init: any) => {
    signal = init.signal;
    return { ok: true, status: 200, json: async () => ({ text: 'done' }) };
  });
  assert.deepEqual(await dictation.transcribe({ engine: 'credits', ...clip }), { text: 'done' });
  assert.equal(signal?.aborted, false);
});

test('the recording ending aborts the upload within a second, and the watch stops with the request', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const net = hangingFetch();
  let ended = false;
  const current = () => {
    if (ended) throw new Error('This voice input was cancelled');
  };
  const answer = service(net.fetch).transcribe({ engine: 'chatgpt', ...clip, current });
  await new Promise(setImmediate);
  t.mock.timers.tick(WATCH_MS);
  assert.equal(net.seen[0].init.signal.aborted, false, 'still recording: the upload goes on');
  ended = true;
  t.mock.timers.tick(WATCH_MS);
  assert.deepEqual(await answer, { error: 'The dictation service took too long' });
  assert.equal(net.seen.length, 1);
});

test('an answer that arrives as the caller gives up is kept', async () => {
  const gaveUp = new AbortController();
  const dictation = service(async () => {
    gaveUp.abort();
    return { ok: true, status: 200, json: async () => ({ text: 'just in time' }) };
  });
  assert.deepEqual(await dictation.transcribe({ engine: 'chatgpt', ...clip, signal: gaveUp.signal }), { text: 'just in time' });
});
