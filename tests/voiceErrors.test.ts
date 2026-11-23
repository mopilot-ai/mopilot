// electron/platform/voice.cjs: how each dictation engine reports failures (network, server errors in
// their several shapes, helper permission) and its fallbacks for missing mime/text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDictation, extFor } = require('../electron/platform/voice.cjs');

const reply = (status: number, body: any) => async () => ({
  ok: status < 400,
  status,
  json: async () => (body instanceof Error ? Promise.reject(body) : body),
});
function chatgpt(fetch: any) {
  return createDictation({ chatgptHeaders: async () => ({ Authorization: 'x' }), fetch });
}
const audio = { engine: 'chatgpt', bytes: new Uint8Array([1]), mime: 'audio/webm' };

test('extFor: missing mime is webm', () => {
  assert.equal(extFor(undefined), 'webm');
  assert.equal(extFor('audio'), 'webm');
});

test('server errors: detail.message, detail, error.message, then the status', async () => {
  assert.deepEqual(await chatgpt(reply(400, { detail: { message: 'too long' } })).transcribe(audio), { error: 'too long' });
  assert.deepEqual(await chatgpt(reply(400, { detail: 'bad audio' })).transcribe(audio), { error: 'bad audio' });
  assert.deepEqual(await chatgpt(reply(400, { error: { message: 'quota' } })).transcribe(audio), { error: 'quota' });
  assert.deepEqual(await chatgpt(reply(502, new Error('not json'))).transcribe(audio), { error: 'Transcription failed (502)' });
  assert.deepEqual(await chatgpt(reply(500, null)).transcribe(audio), { error: 'Transcription failed (500)' });
});

test('a success without text is empty text; a network failure is its message or value', async () => {
  assert.deepEqual(await chatgpt(reply(200, {})).transcribe(audio), { text: '' });
  // a success whose answer can't be read is a failure, not an empty transcript
  assert.deepEqual(await chatgpt(reply(200, new Error('Unexpected token <'))).transcribe(audio), {
    error: 'Transcription failed: Unexpected token <',
  });
  assert.deepEqual(
    await chatgpt(async () => {
      throw new Error('offline');
    }).transcribe(audio),
    { error: 'offline' },
  );
  assert.deepEqual(
    await chatgpt(async () => {
      throw 'raw';
    }).transcribe(audio),
    { error: 'raw' },
  );
});

function local(helper: any) {
  return createDictation({ helper: () => helper });
}
function onPlatform(t: any, p: string) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: p });
  t.after(() => Object.defineProperty(process, 'platform', orig));
}
const wav = { engine: 'local', bytes: new Uint8Array([1]), mime: 'audio/wav', language: 'en' };

test('local engine: macOS only, WAV only (missing mime refused)', async (t) => {
  onPlatform(t, 'linux');
  assert.deepEqual(await local({}).transcribe(wav), { error: 'Local dictation needs macOS' });
  onPlatform(t, 'darwin');
  assert.deepEqual(await local({}).transcribe({ ...wav, mime: undefined }), { error: 'Local dictation needs WAV audio' });
});

test('local engine: empty text, denied permission, and other helper failures', async (t) => {
  onPlatform(t, 'darwin');
  assert.deepEqual(await local({ start: async () => {}, speechTranscribe: async () => ({}) }).transcribe(wav), { text: '' });
  const denied = Object.assign(new Error('no'), { reason: 'permission_denied' });
  assert.match(
    (
      await local({
        start: async () => {
          throw denied;
        },
      }).transcribe(wav)
    ).error,
    /Allow speech recognition/,
  );
  assert.deepEqual(
    await local({
      start: async () => {
        throw new Error('helper crashed');
      },
    }).transcribe(wav),
    { error: 'helper crashed' },
  );
  assert.deepEqual(
    await local({
      start: async () => {
        throw null;
      },
    }).transcribe(wav),
    { error: 'null' },
  );
});

test('local engine: a clip without words is nothing to type, not a recording to retry; other recognizer failures still fail', async (t) => {
  onPlatform(t, 'darwin');
  const failing = (message: string) =>
    local({
      start: async () => {},
      speechTranscribe: async () => {
        throw Object.assign(new Error(message), { reason: 'speech_failed' });
      },
    }).transcribe(wav);
  // a helper older than Speech.swift's own empty answer reports macOS's error 1110 in these words
  assert.deepEqual(await failing('No speech detected'), { text: '' });
  assert.deepEqual(await failing('Recognition request was canceled'), { error: 'Recognition request was canceled' });
  const other = Object.assign(new Error('No speech detected'), { reason: 'speech_unavailable' });
  assert.deepEqual(
    await local({
      start: async () => {},
      speechTranscribe: async () => {
        throw other;
      },
    }).transcribe(wav),
    { error: 'No speech detected' },
  );
});

test('cloud dictation rejects malformed successful JSON instead of leaking non-text into the editor', async () => {
  for (const engine of ['chatgpt', 'credits']) {
    for (const body of [
      null,
      [],
      'transcript',
      7,
      true,
      { text: 7 },
      { text: false },
      { text: [] },
      { text: {} },
      { error: { message: 'refused' } },
    ]) {
      const service = createDictation({
        chatgptHeaders: async () => ({ Authorization: 'x' }),
        gatewayKey: () => 'key',
        apiBase: 'https://api.example.test',
        fetch: reply(200, body),
      });
      assert.deepEqual(await service.transcribe({ ...audio, engine }), { error: 'Transcription failed: invalid response' });
    }
    for (const body of [{ text: '' }, { text: null }, {}]) {
      const service = createDictation({
        chatgptHeaders: async () => ({}),
        gatewayKey: () => 'key',
        apiBase: 'https://api.example.test',
        fetch: reply(200, body),
      });
      assert.deepEqual(await service.transcribe({ ...audio, engine }), { text: '' });
    }
  }
});

test('structured or blank server error messages fall back to a renderable HTTP status', async () => {
  for (const body of [
    { detail: { code: 'bad_audio' } },
    { detail: [1] },
    { detail: 7 },
    { detail: { message: { code: 'bad' } } },
    { detail: '  ', error: { message: [] } },
    { error: { message: 42 } },
  ])
    assert.deepEqual(await chatgpt(reply(400, body)).transcribe(audio), { error: 'Transcription failed (400)' });
  assert.deepEqual(await chatgpt(reply(400, { detail: { message: 42 }, error: { message: 'readable error' } })).transcribe(audio), {
    error: 'readable error',
  });
});

test('local dictation enforces the same transcript shape as both cloud engines', async (t) => {
  onPlatform(t, 'darwin');
  for (const body of [null, [], 'transcript', 7, { text: {} }, { text: false }, { detail: 'helper error' }]) {
    assert.deepEqual(await local({ start: async () => {}, speechTranscribe: async () => body }).transcribe(wav), {
      error: 'Transcription failed: invalid response',
    });
  }
});

test('local engine while macOS has not asked yet (Chrome side panel, #2286): the prompt goes up and the clip ends at once', async (t) => {
  onPlatform(t, 'darwin');
  const calls: string[] = [];
  const helper = (request: () => Promise<unknown>) => ({
    start: async () => {},
    speechStatus: async () => ({ authorization: 'notDetermined' }),
    speechRequest: () => (calls.push('request'), request()),
    speechTranscribe: async () => (calls.push('transcribe'), { text: 'never' }),
  });
  const { SPEECH_ASKED } = require('../electron/platform/voice.cjs');
  // the prompt is never awaited: an answer that never comes still ends the clip
  assert.deepEqual(await local(helper(() => new Promise(() => {}))).transcribe(wav), { error: SPEECH_ASKED });
  assert.deepEqual(await local(helper(async () => Promise.reject(new Error('gone')))).transcribe(wav), { error: SPEECH_ASKED });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['request', 'request']);
  // once allowed, the clip is transcribed
  const allowed = { ...helper(async () => null), speechStatus: async () => ({ authorization: 'authorized' }) };
  assert.deepEqual(await local(allowed).transcribe(wav), { text: 'never' });
});
