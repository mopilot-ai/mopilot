// The composer's dictation button (src/components/ui/Dictation.tsx): record, transcribe with the chosen
// engine, insert the text, and release the microphone whatever happens.
import { registerAudioCases } from './support/composer-audio-cases.ts';
import { speechMock } from './support/speechMock.ts';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, flush, mount } from './support/composer-kit.ts';
import { defined } from './support/defined.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import { SPEECH_WAIT_MS } from '../shared/speech.mjs';

const calls: any[][] = [];
let prefs: any;
let engine: () => Promise<string>;
let transcribe: (...a: any[]) => Promise<any>;
let save: () => any;
let saveAudio: (...a: any[]) => Promise<any>;
let currentCapture = true;
let begin = async () => 'capture';
let wav: (blob: Blob) => Promise<Uint8Array>;
stubStore({ getState: () => ({ prefs }), toast: (t: string, k?: string) => calls.push(['toast', t, k]) });
installNativeStub({
  speech: {
    ...speechMock((...a) => (calls.push(['transcribe', ...a]), transcribe(...a))),
    current: async () => currentCapture,
    begin: () => begin(),
    save: (...a: any[]) => saveAudio(...a),
  },
  dictation: {
    localStatus: async () => ({ authorization: 'authorized', available: true, onDevice: true }),
    transcribe: (...a: any[]) => (calls.push(['transcribe', ...a]), transcribe(...a)),
  },
  recordings: { save: (bytes: Uint8Array, text: string) => (calls.push(['save', bytes.length, text]), save()) },
});
mock.module('../src/session/voice.ts', {
  namedExports: { currentDictationEngine: () => engine(), currentDictationChain: async () => [await engine()] },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: (b: Blob) => wav(b) } });

class Track {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Stream {
  tracks = [new Track()];
  getTracks() {
    return this.tracks;
  }
}
let recorders: FakeRecorder[] = [];
let opusOk = true;
let ctorFails = false;
let startFails = false;
class FakeRecorder {
  static isTypeSupported = () => opusOk;
  state = 'inactive';
  ondataavailable: any;
  onstop: any;
  stream: any;
  opts: any;
  constructor(stream: any, opts: any) {
    this.stream = stream;
    this.opts = opts;
    if (ctorFails) throw new Error('no recorder');
    recorders.push(this);
  }
  start() {
    if (startFails) throw new Error('cannot start');
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([]) });
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    this.onstop?.();
  }
}
(globalThis as any).MediaRecorder = FakeRecorder;
let gum: (c: any) => Promise<any>;
let gumArgs: any[] = [];
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: (c: any) => (gumArgs.push(c), gum(c)) } });

const { createElement, createRef } = await import('react');
const { act } = await import('react');
const { Dictation } = await import('../src/components/ui/Dictation.tsx');

const btn = () => $('button[aria-label="Dictate"]');
const press = () => act(async () => btn().click());
async function render() {
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t) }));
  return { ...m, texts };
}

beforeEach(() => {
  calls.length = 0;
  currentCapture = true;
  begin = async () => 'capture';
  saveAudio = async () => ({ kind: 'audio', path: '/saved.wav', name: 'Audio message' });
  recorders = [];
  gumArgs = [];
  opusOk = true;
  ctorFails = startFails = false;
  prefs = { dictationLanguage: 'auto', micDeviceId: 'm1' };
  engine = async () => 'chatgpt';
  transcribe = async () => ({ text: '  hello world ' });
  save = () => undefined;
  wav = async (blob) => new Uint8Array([9, blob.size]);
  gum = async () => new Stream();
  delete (window as any).__voiceTestStream;
});

test('record, stop and the cloud transcript is inserted and saved with the recording', async () => {
  const m = await render();
  try {
    assert.equal(btn().className.includes('recording'), false);
    await press();
    assert.deepEqual(gumArgs, [{ audio: { deviceId: { exact: 'm1' } } }]);
    assert.equal(recorders[0].opts.mimeType, 'audio/webm;codecs=opus');
    assert.match(btn().className, /recording/);
    await press();
    await flush();
    const t = defined(calls.find((c) => c[0] === 'transcribe'));
    assert.deepEqual([t[2], t[3], t[4]], ['audio/webm', undefined, 'chatgpt']);
    assert.equal(t[1].length, 3);
    assert.deepEqual(m.texts, ['hello world']);
    assert.deepEqual(calls.at(-1), ['save', 3, 'hello world']);
    assert.equal(recorders[0].stream.tracks[0].stopped, true);
    assert.doesNotMatch(btn().className, /recording/);
  } finally {
    await m.unmount();
  }
});

test('the local engine gets WAV and the chosen language; a named language goes to the cloud as is', async () => {
  const m = await render();
  try {
    engine = async () => 'local';
    prefs.dictationLanguage = 'auto';
    await press();
    await press();
    await flush();
    // the one service gets the whole wait, which main is told so it stops the request after it
    assert.deepEqual(defined(calls.find((c) => c[0] === 'transcribe')).slice(1), [
      new Uint8Array([9, 3]),
      'audio/wav',
      'auto',
      'local',
      SPEECH_WAIT_MS,
    ]);
    calls.length = 0;
    engine = async () => 'credits';
    prefs.dictationLanguage = 'fr';
    opusOk = false;
    await press();
    await press();
    await flush();
    assert.equal(recorders[1].opts.mimeType, 'audio/webm');
    assert.deepEqual(defined(calls.find((c) => c[0] === 'transcribe')).slice(2), ['audio/webm', 'fr', 'credits', SPEECH_WAIT_MS]);
  } finally {
    await m.unmount();
  }
});

test('engine errors and failures are shown; an empty transcript inserts nothing', async () => {
  const m = await render();
  try {
    transcribe = async () => ({ error: 'Sign in first' });
    await press();
    await press();
    await flush();
    await press(); // Discard the retained failed recording before making a new one.
    transcribe = async () => ({ text: '   ' });
    await press();
    await press();
    await flush();
    transcribe = async () => ({});
    await press();
    await press();
    await flush();
    engine = () => Promise.reject(new Error('engine down'));
    await press();
    await flush();
    engine = () => Promise.reject('offline');
    await press();
    await flush();
    // an error main threw reads without Electron's wrapper; one with no message still says what failed
    transcribe = () => Promise.reject(new Error("Error invoking remote method 'speech:transcribe': Error: model missing"));
    engine = async () => 'credits';
    await press();
    await press();
    await flush();
    await press(); // Discard the retained recording.
    transcribe = () => Promise.reject(new Error(''));
    await press();
    await press();
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'toast'),
      [
        ['toast', 'Sign in first', 'error'],
        ['toast', 'engine down', 'error'],
        ['toast', 'offline', 'error'],
        ['toast', 'model missing', 'error'],
        ['toast', "Couldn't transcribe the recording", 'error'],
      ],
    );
    assert.deepEqual(m.texts, []);
    assert.ok(!calls.some((c) => c[0] === 'save'));
  } finally {
    await m.unmount();
  }
});

test('while transcribing the button shows progress, and a press gives up waiting without recording again (#2286)', async () => {
  const m = await render();
  const d = deferred<any>();
  transcribe = () => d.promise;
  try {
    await press();
    await press();
    await flush();
    assert.ok(btn().querySelector('svg'));
    assert.equal(recorders.length, 1);
    await press();
    assert.equal(recorders.length, 1);
    assert.deepEqual(gumArgs.length, 1);
    assert.equal(btn().getAttribute('aria-busy'), null, 'back to idle');
    // the abandoned clip's late answer changes nothing
    d.resolve({ text: 'done' });
    await flush();
    assert.deepEqual(m.texts, []);
  } finally {
    await m.unmount();
  }
});

test('a second press cancels pending microphone acquisition and stops its late stream', async () => {
  const d = deferred<Stream>();
  gum = () => d.promise;
  const m = await render();
  try {
    await press();
    await press();
    const stream = new Stream();
    d.resolve(stream);
    await flush();
    assert.equal(recorders.length, 0);
    assert.equal(stream.tracks[0].stopped, true);
    assert.equal(btn().getAttribute('aria-busy'), null);
  } finally {
    await m.unmount();
  }
});

test('denied microphone is a toast; recorder failures release the microphone', async () => {
  const m = await render();
  try {
    gum = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await press();
    assert.deepEqual(calls.at(-1), ['toast', 'Microphone access is off for MoPilot.', 'error']);
    gum = () => Promise.reject(Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' }));
    await press();
    assert.deepEqual(calls.at(-1), ['toast', 'The microphone is in use by another app or could not start.', 'error']);
    const s1 = new Stream();
    gum = async () => s1;
    ctorFails = true;
    await press();
    assert.equal(s1.tracks[0].stopped, true);
    assert.deepEqual(calls.at(-1), ['toast', 'no recorder', 'error']);
    ctorFails = false;
    const s2 = new Stream();
    gum = async () => s2;
    startFails = true;
    await press();
    assert.equal(s2.tracks[0].stopped, true);
    assert.deepEqual(calls.at(-1), ['toast', 'cannot start', 'error']);
    // the test stream is never stopped
    const test = new Stream();
    (window as any).__voiceTestStream = test;
    await press();
    startFails = false;
    ctorFails = true;
    await press();
    ctorFails = false;
    await press();
    await press();
    await flush();
    assert.equal(test.tracks[0].stopped, false);
    assert.equal(gumArgs.length, 4);
  } finally {
    await m.unmount();
  }
});

test('unmounting mid-recording stops the recorder without transcribing and releases the microphone', async () => {
  const m = await render();
  await press();
  const r = recorders[0];
  await m.unmount();
  assert.equal(r.state, 'inactive');
  assert.equal(r.stream.tracks[0].stopped, true);
  assert.ok(!calls.some((c) => c[0] === 'transcribe'));
  // a finished recording that is already inactive is left alone; a test stream is not stopped
  const m2 = await render();
  const test = new Stream();
  (window as any).__voiceTestStream = test;
  await press();
  recorders[1].state = 'inactive';
  await m2.unmount();
  assert.equal(test.tracks[0].stopped, false);
});

test('unmounting while the microphone or the transcript is pending drops the result', async () => {
  let m = await render();
  let d = deferred<any>();
  gum = () => d.promise;
  await press();
  await m.unmount();
  const s = new Stream();
  d.resolve(s);
  await flush();
  assert.equal(s.tracks[0].stopped, true);
  assert.equal(recorders.length, 0);
  // the test stream is kept even then
  m = await render();
  d = deferred<any>();
  gum = () => d.promise;
  await press();
  await m.unmount();
  const test = new Stream();
  (window as any).__voiceTestStream = test;
  d.resolve(test);
  await flush();
  assert.equal(test.tracks[0].stopped, false);
  delete (window as any).__voiceTestStream;
  // a denied microphone after unmount is silent
  m = await render();
  d = deferred<any>();
  gum = () => d.promise;
  await press();
  await m.unmount();
  d.reject(new Error('denied'));
  await flush();
  assert.ok(!calls.some((c) => c[0] === 'toast'));
  // a transcript arriving after unmount is dropped
  m = await render();
  const t = deferred<any>();
  transcribe = () => t.promise;
  gum = async () => new Stream();
  await press();
  await press();
  await flush();
  await m.unmount();
  t.resolve({ text: 'late' });
  await flush();
  assert.ok(!calls.some((c) => c[0] === 'save'));
});

test('repeated stop clicks before the recorder stop event do not stop it twice', async () => {
  const m = await render();
  await press();
  const recorder = recorders[0];
  const finish = recorder.stop.bind(recorder);
  let stops = 0;
  recorder.stop = () => {
    stops++;
    recorder.state = 'inactive';
  };
  try {
    await press();
    await press();
    assert.equal(stops, 1, 'an inactive recorder must not receive another stop call');
  } finally {
    await act(async () => finish());
    await flush();
    await m.unmount();
  }
});

test('recording save failures are reported without losing the transcribed text', async () => {
  for (const asynchronous of [false, true]) {
    const m = await render();
    save = () => {
      if (asynchronous) return Promise.reject(new Error('disk full'));
      throw new Error('disk full');
    };
    try {
      await press();
      const recorder = recorders.at(-1)!;
      recorder.state = 'inactive';
      recorder.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      await act(async () => {
        await assert.doesNotReject(recorder.onstop());
      });
      assert.deepEqual(m.texts, ['hello world']);
      assert.deepEqual(calls.at(-1), ['toast', 'Could not save recording: disk full', 'error']);
      assert.doesNotMatch(btn().className, /recording/);
    } finally {
      await m.unmount();
    }
  }
});

test('a recording save failure after unmount does not show a stale notice', async () => {
  const m = await render();
  const pendingSave = deferred<void>();
  save = () => pendingSave.promise;
  await press();
  const recorder = recorders.at(-1)!;
  recorder.state = 'inactive';
  recorder.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
  let stopped!: Promise<void>;
  await act(async () => {
    stopped = recorder.onstop();
  });
  await flush();
  await m.unmount();
  pendingSave.reject(new Error('disk full'));
  await assert.doesNotReject(stopped);
  assert.ok(!calls.some((call) => call[0] === 'toast'));
});

test('non-Error recording failures are displayed without losing dictation', async () => {
  for (const [failure, message] of [
    ['plain failure', 'plain failure'],
    [null, 'null'],
  ]) {
    const m = await render();
    save = () => Promise.reject(failure);
    try {
      await press();
      const recorder = recorders.at(-1)!;
      recorder.state = 'inactive';
      recorder.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      await act(async () => {
        await assert.doesNotReject(recorder.onstop());
      });
      assert.deepEqual(m.texts, ['hello world']);
      assert.deepEqual(calls.at(-1), ['toast', `Could not save recording: ${message}`, 'error']);
    } finally {
      await m.unmount();
    }
  }
});

test('unmount during service preparation prevents microphone access and transcription', async () => {
  const d = deferred<string>();
  engine = () => d.promise;
  const m = await render();
  await press();
  await m.unmount();
  d.resolve('chatgpt');
  await flush();
  assert.equal(recorders.length, 0);
  assert.equal(gumArgs.length, 0);
  assert.ok(!calls.some((c) => c[0] === 'transcribe'));
});

registerAudioCases({
  createRef,
  mount,
  createElement,
  Dictation,
  act,
  press,
  flush,
  calls,
  render,
  get gumArgs() {
    return gumArgs;
  },
  set transcribe(value) {
    transcribe = value;
  },
  get recorders() {
    return recorders;
  },
  set begin(value) {
    begin = value;
  },
  set currentCapture(value) {
    currentCapture = value;
  },
  set wav(value) {
    wav = value;
  },
  set saveAudio(value) {
    saveAudio = value;
  },
});
