// Dictation engines: which one a user gets, the WAV the local engine reads, and the three transcribe paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encodeWav } from '../src/lib/dictation.ts';

const require = createRequire(import.meta.url);
const { createDictation, normalizeEngine, extFor, CREDITS_MODEL } = require('../electron/platform/voice.cjs');

test('encodeWav writes a 16-bit mono PCM header and clamps samples', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(wav.buffer);
  const tag = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(wav.length, 44 + 8);
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)], [0, 32767, -32768, 32767]);
});

test('unknown engines are the ChatGPT engine; extensions come from the mime type', () => {
  assert.equal(normalizeEngine(undefined), 'chatgpt');
  assert.equal(normalizeEngine('nope'), 'chatgpt');
  assert.equal(normalizeEngine('local'), 'local');
  assert.equal(extFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extFor('audio/wav'), 'wav');
});

function rig(
  o: {
    headers?: any;
    key?: string | null;
    apiBase?: string | null;
    res?: { ok: boolean; status?: number; body: any };
    enabled?: () => boolean;
  } = {},
) {
  const fetched: { url: string; init: any }[] = [];
  const calls: any[] = [];
  const dictation = createDictation({
    chatgptHeaders: async () => ('headers' in o ? o.headers : { Authorization: 'Bearer chatgpt' }),
    gatewayKey: () => ('key' in o ? o.key : 'gw-key'),
    apiBase: 'apiBase' in o ? (o.apiBase as string | null) : 'https://api.example.test',
    enabled: o.enabled,
    helper: () => ({
      start: async () => ({}),
      speechTranscribe: async (b64: string, language: string) => (calls.push({ b64, language }), { text: 'local text' }),
    }),
    fetch: async (url: string, init: any) => {
      fetched.push({ url, init });
      const r = o.res ?? { ok: true, body: { text: 'remote text' } };
      return { ok: r.ok, status: r.status ?? 200, json: async () => r.body };
    },
  });
  return { dictation, fetched, calls };
}

test('chatgpt engine posts to the ChatGPT backend with the account headers', async () => {
  const r = rig();
  assert.deepEqual(await r.dictation.transcribe({ engine: 'chatgpt', bytes: new Uint8Array([1, 2]), mime: 'audio/webm', language: 'en' }), {
    text: 'remote text',
  });
  assert.equal(r.fetched[0].url, 'https://chatgpt.com/backend-api/transcribe');
  assert.equal(r.fetched[0].init.headers.Authorization, 'Bearer chatgpt');
  assert.equal(r.fetched[0].init.body.get('language'), 'en');
  // no engine at all is the same engine (what every install had before)
  await r.dictation.transcribe({ bytes: new Uint8Array([1]), mime: 'audio/webm' });
  assert.equal(r.fetched[1].url, 'https://chatgpt.com/backend-api/transcribe');
  const out = rig({ headers: null });
  assert.match(
    (await out.dictation.transcribe({ engine: 'chatgpt', bytes: new Uint8Array(1), mime: 'audio/webm' })).error,
    /Sign in with ChatGPT/,
  );
});

test('switched-off dictation sends nothing on any engine or path', async () => {
  const r = rig({ enabled: () => false });
  for (const engine of ['chatgpt', 'credits', 'local', undefined])
    assert.deepEqual(await r.dictation.transcribe({ engine, bytes: new Uint8Array([1]), mime: 'audio/wav' }), {
      error: 'Dictation is turned off in this app',
    });
  assert.deepEqual([r.fetched, r.calls], [[], []]);
});

test('credits engine posts to the gateway with the device key and the transcription model', async () => {
  const r = rig();
  assert.deepEqual(await r.dictation.transcribe({ engine: 'credits', bytes: new Uint8Array([1]), mime: 'audio/webm', language: 'zh' }), {
    text: 'remote text',
  });
  assert.equal(r.fetched[0].url, 'https://api.example.test/v1/audio/transcriptions');
  assert.equal(r.fetched[0].init.headers.Authorization, 'Bearer gw-key');
  assert.equal(r.fetched[0].init.body.get('model'), CREDITS_MODEL);
  const signedOut = rig({ key: null });
  assert.match(
    (await signedOut.dictation.transcribe({ engine: 'credits', bytes: new Uint8Array(1), mime: 'audio/webm' })).error,
    /Sign in to MoPilot/,
  );
  assert.equal(signedOut.fetched.length, 0);
  // a build without the MoPilot service has no gateway to send to, whatever key it is handed
  const noService = rig({ apiBase: null });
  assert.match(
    (await noService.dictation.transcribe({ engine: 'credits', bytes: new Uint8Array(1), mime: 'audio/webm' })).error,
    /Sign in to MoPilot/,
  );
  assert.equal(noService.fetched.length, 0);
  const failing = rig({ res: { ok: false, status: 402, body: { error: { message: 'Out of credits' } } } });
  assert.deepEqual(await failing.dictation.transcribe({ engine: 'credits', bytes: new Uint8Array(1), mime: 'audio/webm' }), {
    error: 'Out of credits',
  });
});

test('local engine sends WAV to the helper as base64 and refuses anything else', { skip: process.platform !== 'darwin' }, async () => {
  const r = rig();
  const out = await r.dictation.transcribe({ engine: 'local', bytes: new Uint8Array([1, 2, 3]), mime: 'audio/wav', language: 'auto' });
  assert.deepEqual(out, { text: 'local text' });
  assert.deepEqual(r.calls, [{ b64: Buffer.from([1, 2, 3]).toString('base64'), language: 'auto' }]);
  assert.match((await r.dictation.transcribe({ engine: 'local', bytes: new Uint8Array(1), mime: 'audio/webm' })).error, /WAV/);
  assert.equal(r.fetched.length, 0);
});
