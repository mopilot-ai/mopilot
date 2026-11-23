// ChatGPT dictation sends a clip again after a network failure, a timeout or a server error, as the official app does;
// a refusal of the request or of the clip is answered at once, and MoPilot credits is asked once (electron/platform/voice.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDictation, TOO_SHORT } = require('../electron/platform/voice.cjs');

type Answer = { ok: boolean; status: number; body?: any } | Error;
function rig(answers: Answer[]) {
  const posted: { url: string; form: FormData }[] = [];
  const waits: number[] = [];
  const dictation = createDictation({
    chatgptHeaders: async () => ({ Authorization: 'Bearer t' }),
    gatewayKey: () => 'gw',
    apiBase: 'https://api.example.test',
    helper: () => ({}),
    sleep: async (ms: number) => void waits.push(ms),
    fetch: async (url: string, init: any) => {
      posted.push({ url, form: init.body });
      const a = answers.shift() ?? { ok: true, status: 200, body: { text: 'done' } };
      if (a instanceof Error) throw a;
      return { ok: a.ok, status: a.status, json: async () => a.body ?? {} };
    },
  });
  const send = (engine: string) => dictation.transcribe({ engine, bytes: new Uint8Array([1]), mime: 'audio/webm' });
  return { send, posted, waits };
}
const fail = (status: number, body: any = {}) => ({ ok: false, status, body });

test('ChatGPT: a network failure or server error is sent again, 500 ms then 1 s, with one session and a new attempt id', async () => {
  const r = rig([new Error('socket hang up'), fail(503)]);
  assert.deepEqual(await r.send('chatgpt'), { text: 'done' });
  assert.deepEqual(r.waits, [500, 1000]);
  const ids = r.posted.map((p) => [p.form.get('dictation_session_id'), p.form.get('attempt_id')]);
  assert.equal(new Set(ids.map((i) => i[0])).size, 1);
  assert.deepEqual(
    ids.map((i) => String(i[1]).split(':')[1]),
    ['1', '2', '3'],
  );
  // three tries at most: the last reason is the answer
  const down = rig([fail(502), fail(0), fail(408, { detail: 'Request timed out' })]);
  assert.deepEqual(await down.send('chatgpt'), { error: 'Request timed out' });
  assert.equal(down.posted.length, 3);
});

test('a refusal of the request is answered at once; a clip too short says so and is not retried', async () => {
  const denied = rig([fail(401, { detail: 'Unauthorized' })]);
  assert.deepEqual(await denied.send('chatgpt'), { error: 'Unauthorized' });
  assert.deepEqual(denied.waits, []);
  for (const body of [
    { detail: { code: 'audio_too_short', message: 'x' } },
    { error: { code: 'audio_too_short' } },
    { code: 'audio_too_short' },
  ]) {
    const short = rig([fail(400, body)]);
    assert.deepEqual(await short.send('chatgpt'), { error: TOO_SHORT });
    assert.equal(short.posted.length, 1);
  }
});

test('MoPilot credits is asked once: the gateway bills each request', async () => {
  const r = rig([fail(500, { error: { message: 'upstream' } })]);
  assert.deepEqual(await r.send('credits'), { error: 'upstream' });
  assert.equal(r.posted.length, 1);
  assert.equal(r.posted[0].form.get('model'), 'gpt-4o-mini-transcribe');
  const lost = rig([new Error('socket hang up')]);
  assert.deepEqual(await lost.send('credits'), { error: 'socket hang up' });
  assert.deepEqual(lost.waits, []);
});

test('the retry wait defaults to a real timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posted: number[] = [];
  const dictation = createDictation({
    chatgptHeaders: async () => ({}),
    gatewayKey: () => 'gw',
    apiBase: 'https://api.example.test',
    helper: () => ({}),
    fetch: async () => {
      posted.push(Date.now());
      if (posted.length === 1) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ text: 'later' }) };
    },
  });
  const sending = dictation.transcribe({ engine: 'chatgpt', bytes: new Uint8Array([1]), mime: 'audio/webm' });
  await new Promise(setImmediate);
  t.mock.timers.tick(500);
  assert.deepEqual(await sending, { text: 'later' });
});
