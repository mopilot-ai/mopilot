// Speech service contracts: checked provider selection (Automatic or pinned), capture ownership and durable native audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localSpeechReadiness, speechEngine, speechOperations, noSpeechReason, DICTATION_OFF } from '../shared/speech.mjs';
import { encodeWav } from '../src/lib/dictation.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createSpeech } = require('../electron/platform/speech.cjs');
const { createAudioAssets, audioDuration, MAX_AUDIO_BYTES } = require('../electron/platform/audioAssets.cjs');
const { createRecordings } = require('../electron/platform/recordings.cjs');
const available = { authorization: 'authorized', available: true, onDevice: true };
function world() {
  const prefs: any = { dictationLanguage: 'en', defaultHarness: 'claude' };
  const f = {
    account: 'claude-account',
    ref: { kind: 'claude', id: 'native', instance: 'account' },
    local: available as any,
    legacy: [] as any[],
    accounts: { chatgpt: false, credits: false } as Record<string, boolean | 'off'>,
    cap: null as any,
  };
  const deps = {
    prefs: () => prefs,
    ref: () => f.ref,
    identity: () => f.account,
    localStatus: async () => f.local,
    accounts: async () => f.accounts,
    caps: async () => f.cap,
    recordings: async () => f.legacy,
  };
  return { f, prefs, deps, speech: createSpeech(deps) };
}

test('local recognition is ready only with an available device-side recognizer and a valid permission', () => {
  for (const status of [null, undefined, false, 'authorized']) assert.equal(localSpeechReadiness(status).state, 'unknown');
  for (const authorization of ['denied', 'restricted'])
    assert.equal(localSpeechReadiness({ ...available, authorization }).state, 'blocked');
  for (const key of ['available', 'onDevice']) assert.equal(localSpeechReadiness({ ...available, [key]: false }).state, 'blocked');
  assert.equal(localSpeechReadiness({ ...available, authorization: 'notDetermined' }).state, 'permission');
  assert.equal(localSpeechReadiness({ ...available, authorization: 'other' }).state, 'unknown');
  assert.deepEqual(localSpeechReadiness(available), { state: 'ready', reason: null });
});

test('a pinned provider is the only one; Automatic takes the first usable, this Mac first', () => {
  const choices = [
    { id: 'local' as const, label: 'This Mac', state: 'ready' as const, reason: null },
    { id: 'chatgpt' as const, label: 'ChatGPT', state: 'permission' as const, reason: null },
  ];
  assert.equal(speechEngine(undefined, choices), 'local');
  assert.equal(speechEngine('local', choices), 'local');
  assert.equal(speechEngine(null, choices), 'local');
  assert.equal(speechEngine('credits', choices), null);
  assert.equal(speechEngine('unknown', []), null);
  assert.equal(speechEngine('unknown', choices), null);
  assert.equal(speechEngine(null, [{ ...choices[0], state: 'blocked' }]), null);
  assert.equal(speechEngine(null, [{ ...choices[0], state: 'unknown' }, choices[1]]), 'chatgpt');
  assert.equal(speechEngine('local', [{ ...choices[0], state: 'blocked' }, choices[1]]), null, 'a pin never falls back');
  assert.equal(speechOperations(null).conversation, false);
  assert.equal(speechOperations({ caps: { voiceChat: { state: 'route' }, audioInput: { state: 'native' } } }).audioMessage, true);
  assert.equal(speechOperations({ caps: { voiceChat: { state: 'native' } } }).conversation, true);
});

test('main options use actual services on every harness and do not silently replace an unavailable choice', async () => {
  const w = world();
  let o = await w.speech.options();
  assert.equal(o.engine, 'local');
  assert.deepEqual(
    o.choices.map((p: any) => p.state),
    ['ready', 'blocked', 'blocked'],
  );
  w.f.local = null;
  assert.equal((await w.speech.options('chat', { kind: 'claude' })).engine, null);
  w.prefs.dictationEngine = 'credits';
  w.f.accounts = { chatgpt: true, credits: true };
  o = await w.speech.options();
  assert.equal(o.engine, 'credits');
  assert.deepEqual(
    o.choices.map((p: any) => p.state),
    ['unknown', 'ready', 'ready'],
  );
  delete w.prefs.dictationEngine;
  assert.equal((await w.speech.options()).engine, 'chatgpt', 'Automatic: on-device unknown, the ChatGPT account next');
  w.f.accounts.chatgpt = false;
  assert.equal((await w.speech.options()).engine, 'credits');
  w.f.accounts.credits = 'off';
  const off = await w.speech.options();
  assert.equal(off.choices[2].reason, 'This dictation service is turned off in this app');
  assert.equal(off.engine, null);
  w.prefs.dictationEngine = 'claude';
  w.f.accounts.chatgpt = true;
  assert.deepEqual((await w.speech.options()).chain, [], 'a removed pinned service never falls back to an upload');
  delete w.prefs.dictationEngine;
  w.f.accounts.chatgpt = false;
  w.f.accounts.credits = false;
  assert.equal((await w.speech.options()).engine, null);
});

test('the dictation switch blocks every service with one reason; the reason names what would make one usable', async () => {
  const w = world();
  let on = false;
  Object.assign(w.deps, { enabled: () => on });
  w.f.accounts = { chatgpt: true, credits: true };
  const off = await w.speech.options();
  assert.equal(off.engine, null);
  assert.deepEqual(new Set(off.choices.map((c: any) => c.reason)), new Set([DICTATION_OFF]));
  assert.equal(off.choices.length, 3);
  assert.equal(noSpeechReason(null, off.choices), DICTATION_OFF);
  on = true;
  assert.equal((await w.speech.options()).engine, 'local');
  const blocked = [
    { id: 'local' as const, label: 'This Mac', state: 'blocked' as const, reason: 'Turn on Speech Recognition' },
    { id: 'chatgpt' as const, label: 'ChatGPT', state: 'blocked' as const, reason: 'Sign in' },
  ];
  assert.equal(noSpeechReason('chatgpt', blocked), 'Sign in');
  assert.match(noSpeechReason(null, blocked), /No dictation service is available/);
  assert.match(noSpeechReason('credits', blocked), /No dictation service is available/);
  assert.match(noSpeechReason(null, []), /No dictation service is available/);
});

test('an options read retiring at an await cannot publish a choice for the replacement account', async () => {
  const w = world();
  const gate = deferred<any>();
  w.deps.localStatus = () => gate.promise;
  const reading = w.speech.options('chat', { kind: 'claude' });
  w.f.account = 'another';
  gate.resolve(available);
  await assert.rejects(reading, /Speech settings changed/);
  assert.equal((await w.speech.options()).engine, 'local');
});

test('one capture owner spans windows; account, model and settings changes keep a dictation but retire audio and conversation', () => {
  const w = world();
  const id = w.speech.begin(1, 'chat:"a|b', {});
  assert.equal(w.speech.current(1, id), true);
  assert.equal(w.speech.current(2, id), false);
  assert.equal(w.speech.current(1, 'other'), false);
  // the chat it records for, to its own window only
  assert.deepEqual([w.speech.chatOf(1, id), w.speech.chatOf(2, id)], ['chat:"a|b', null]);
  assert.throws(() => w.speech.begin(2, 'other', {}), /already active/);
  w.speech.end(2, id);
  w.speech.close(2);
  assert.equal(w.speech.current(1, id), true);
  for (const mutate of [
    () => {
      w.f.ref.id = 'next';
    },
    () => {
      w.f.account = 'next';
    },
    () => {
      w.prefs.dictationLanguage = 'zh';
    },
    () => {
      w.prefs.dictationEngine = 'credits';
    },
    () => {
      w.prefs.model = 'other';
    },
  ]) {
    mutate();
    assert.equal(w.speech.current(1, id), true, 'a dictation still transcribes into its draft');
    assert.equal(w.speech.unchanged(1, id), false);
    assert.equal(w.speech.owns(1, id, 'chat:"a|b'), false);
  }
  w.speech.end(1, id);
  assert.equal(w.speech.current(1, id), false);
  assert.equal(w.speech.unchanged(1, id), false);
  const next = w.speech.begin(2, null, { kind: 'acp:gemini' });
  assert.equal(w.speech.current(2, next), true);
  w.speech.close(2);
  assert.equal(w.speech.current(2, next), false);
  w.speech.close(2);
});

test('new-draft changes retire capture and old cleanup cannot clear a replacement', () => {
  const w = world();
  const old = w.speech.begin(1, null, { kind: 'claude' });
  assert.equal(w.speech.unchanged(1, old), true);
  w.prefs.defaultHarness = 'acp:gemini';
  assert.equal(w.speech.current(1, old), true);
  assert.equal(w.speech.unchanged(1, old), false);
  w.speech.end(1, old);
  const next = w.speech.begin(1, null, { kind: 'acp:gemini' });
  w.speech.end(1, old);
  assert.equal(w.speech.current(1, next), true);
  w.speech.end(1, next);
});

test('WAV validation rejects every malformed field and bounds duration before storing bytes', () => {
  const wav = Buffer.from(encodeWav(new Float32Array([0, 0]), 16000));
  assert.equal(audioDuration(wav), 0.125);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_AUDIO_BYTES + 1)]) assert.throws(() => audioDuration(bytes), /non-empty/);
  for (const offset of [0, 8, 12, 16, 20, 22, 24, 34, 36, 40, 4]) {
    const b = Buffer.from(wav);
    b[offset] ^= 1;
    assert.throws(() => audioDuration(b), /non-empty/, `offset ${offset}`);
  }
  const odd = Buffer.concat([wav, Buffer.alloc(1)]);
  odd.writeUInt32LE(odd.length - 44, 40);
  odd.writeUInt32LE(odd.length - 8, 4);
  assert.throws(() => audioDuration(odd), /non-empty/);
  assert.throws(() => audioDuration(encodeWav(new Float32Array(16000 * 120 + 1), 16000)), /two minutes/);
});

test('durable audio survives recent-recording pruning, Clear and reopening, with strict asset paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'audio');
  const assets = createAudioAssets(() => dir);
  const bytes = encodeWav(new Float32Array([0, 0]), 16000);
  const a = assets.save(bytes);
  assert.equal(a.kind, 'audio');
  assert.equal(a.durationMs, 0.125);
  const recordings = createRecordings(() => path.join(root, 'recordings'));
  for (let i = 0; i < 22; i++) await recordings.save(Buffer.from('clip'), 'text');
  recordings.clear();
  assert.deepEqual(await createAudioAssets(() => dir).read(a.path), {
    type: 'audio',
    mimeType: 'audio/wav',
    data: Buffer.from(bytes).toString('base64'),
  });
  for (const file of [null, '/elsewhere/clip.wav', path.join(dir, 'bad.wav')]) await assert.rejects(assets.read(file), /not a saved/);
  fs.writeFileSync(a.path, 'corrupt');
  await assert.rejects(assets.read(a.path), /non-empty/);
  fs.rmSync(a.path);
  await assert.rejects(assets.read(a.path), /ENOENT/);
});

test('failed service checks stay unknown without disabling independent services or guessing a legacy provider', async () => {
  const w = world();
  w.deps.accounts = async () => {
    throw new Error('offline');
  };
  let options = await w.speech.options();
  assert.equal(options.engine, 'local');
  assert.equal(options.choices[1].state, 'unknown');
  w.deps.localStatus = async () => {
    throw new Error('helper gone');
  };
  w.deps.caps = async () => {
    throw new Error('agent gone');
  };
  w.deps.recordings = async () => {
    throw new Error('disk unavailable');
  };
  options = await w.speech.options();
  assert.equal(options.engine, null);
  assert.equal(options.choices[0].state, 'unknown');
  const enabled = world();
  let local = false;
  Object.assign(enabled.deps, { localEnabled: () => local });
  assert.equal((await enabled.speech.options()).choices[0].state, 'blocked');
  const id = enabled.speech.begin(1, null, {});
  local = true;
  assert.equal(enabled.speech.current(1, id), true);
  assert.equal(enabled.speech.unchanged(1, id), false);
});

test('Automatic prefers this Mac and uses a signed-in account only when this Mac cannot dictate', async () => {
  const w = world();
  w.f.accounts.chatgpt = true;
  assert.equal((await w.speech.options()).engine, 'local');
  w.f.local = { ...available, authorization: 'notDetermined' };
  assert.equal((await w.speech.options()).engine, 'local', 'the first-use prompt is still this Mac');
  w.f.local = { ...available, onDevice: false };
  assert.equal((await w.speech.options()).engine, 'chatgpt');
  w.f.local = null;
  assert.equal((await w.speech.options()).engine, 'chatgpt');
  w.prefs.dictationEngine = 'chatgpt';
  assert.equal((await w.speech.options()).engine, 'chatgpt');
});
