import { speechMock } from './support/speechMock.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { iconStubs, mockSource, popoverStubs, withStoreSlices } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { SPEECH_WAIT_MS } from '../shared/speech.mjs';

const fixture = {
  language: 'auto',
  engine: 'chatgpt',
  opus: true,
  result: { text: ' dictated ' } as { text?: string; error?: string },
  media: async (): Promise<any> => fixture.stream,
  stream: { getTracks: () => [{ stop: () => fixture.stopped++ }] },
  stopped: 0,
  requests: 0,
  notices: [] as unknown[][],
  transcriptions: [] as unknown[][],
  recordings: [] as unknown[][],
  makeError: false,
  startError: false,
  engineError: null as unknown,
  transcribeError: null as unknown,
  transcribe: async (): Promise<{ text?: string; error?: string }> => fixture.result,
  pending: Promise.resolve(),
  recorder: null as Recorder | null,
};
(globalThis as any).__dictationFixture = fixture;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'happy-dom',
    mediaDevices: {
      getUserMedia: (constraints: unknown) => {
        fixture.requests++;
        assert.deepEqual(constraints, { audio: { deviceId: { exact: 'configured' } } });
        return fixture.media();
      },
    },
  },
});
class Recorder {
  stream: any;
  state = 'inactive';
  ondataavailable: ((event: any) => void) | null = null;
  onstop: (() => Promise<void>) | null = null;
  static isTypeSupported() {
    return fixture.opus;
  }
  constructor(stream: any) {
    if (fixture.makeError) throw new Error('cannot record');
    this.stream = stream;
    fixture.recorder = this;
  }
  start() {
    if (fixture.startError) throw new Error('cannot start');
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([]) });
    this.ondataavailable?.({ data: new Blob(['audio']) });
    fixture.pending = this.onstop?.() ?? Promise.resolve();
  }
}
(globalThis as any).MediaRecorder = Recorder;
const f = fixture;
const stubs: Record<string, Record<string, unknown>> = {
  store: {
    getState: () => ({ prefs: { dictationLanguage: f.language, micDeviceId: 'configured' } }),
    toast: (...args: unknown[]) => f.notices.push(args),
  },
  'session/voice.ts': {
    currentDictationEngine: async () => {
      if (f.engineError) throw f.engineError;
      return f.engine;
    },
    currentDictationChain: async () => {
      if (f.engineError) throw f.engineError;
      return [f.engine];
    },
  },
  'lib/dictation.ts': { recordingToWav: async () => new Uint8Array([1, 2, 3]) },
  'components/ui/Popover.tsx': popoverStubs(),
  'components/ui/icons.tsx': iconStubs(),
};
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub({
  speech: speechMock(async (...a) => {
    f.transcriptions.push(a);
    if (f.transcribeError) throw f.transcribeError;
    return f.transcribe();
  }),
  dictation: {
    localStatus: async () => ({ authorization: 'authorized', available: true, onDevice: true }),
    transcribe: async (...args: unknown[]) => {
      f.transcriptions.push(args);
      if (f.transcribeError) throw f.transcribeError;
      return f.transcribe();
    },
  },
  recordings: { save: (...args: unknown[]) => f.recordings.push(args) },
});
for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) mockSource(`src/${rel}`, exports);
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Dictation } = await import('../src/components/ui/Dictation.tsx');

async function mount(t: any) {
  Object.assign(fixture, {
    language: 'auto',
    engine: 'chatgpt',
    opus: true,
    result: { text: ' dictated ' },
    stopped: 0,
    requests: 0,
    notices: [],
    transcriptions: [],
    recordings: [],
    makeError: false,
    startError: false,
    engineError: null,
    transcribeError: null,
    pending: Promise.resolve(),
    recorder: null,
  });
  fixture.media = async () => fixture.stream;
  fixture.transcribe = async () => fixture.result;
  delete (window as any).__voiceTestStream;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const words: string[] = [];
  let closed = false;
  const render = async (onText = (text: string) => words.push(text)) => act(() => root.render(createElement(Dictation, { onText })));
  await render();
  const close = async () => {
    if (closed) return;
    closed = true;
    await act(() => root.unmount());
    host.remove();
  };
  t.after(close);
  const click = async () => {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.click();
      // the microphone grant check runs before getUserMedia
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
  };
  return { host, words, render, click, close };
}

test('dictation uses the latest comment callback and its microphone button never submits the parent form', async (t) => {
  const m = await mount(t);
  const old: string[] = [],
    current: string[] = [];
  await m.render((text) => old.push(text));
  assert.equal(m.host.querySelector('button')?.type, 'button');
  await m.click();
  assert.ok(m.host.querySelector('button.recording'));
  await m.render((text) => current.push(text));
  await m.click();
  await fixture.pending;
  assert.deepEqual(old, []);
  assert.deepEqual(current, ['dictated']);
  assert.equal(fixture.transcriptions[0][1], 'audio/webm');
  assert.equal(fixture.transcriptions[0][2], undefined);
  assert.equal(fixture.stopped, 1);
  assert.equal(fixture.recordings[0][1], 'dictated');
});

test('local dictation sends WAV and configured language; cloud dictation preserves a selected language', async (t) => {
  const m = await mount(t);
  fixture.engine = 'local';
  fixture.language = 'zh';
  await m.click();
  await m.click();
  await fixture.pending;
  // the one service gets the whole wait, which main is told so it stops the request after it
  assert.deepEqual(fixture.transcriptions[0], [new Uint8Array([1, 2, 3]), 'audio/wav', 'zh', 'local', SPEECH_WAIT_MS]);
  fixture.engine = 'credits';
  fixture.opus = false;
  await m.click();
  await m.click();
  await fixture.pending;
  assert.deepEqual(fixture.transcriptions[1].slice(1), ['audio/webm', 'zh', 'credits', SPEECH_WAIT_MS]);
});

test('cancelling microphone acquisition stops the late stream and admits a fresh capture', async (t) => {
  const m = await mount(t);
  let permit!: (stream: unknown) => void;
  fixture.media = () =>
    new Promise((resolve) => {
      permit = resolve;
    });
  await m.click();
  await m.click();
  assert.equal(fixture.requests, 1);
  await act(async () => permit(fixture.stream));
  assert.equal(fixture.stopped, 1);
  assert.deepEqual(m.words, []);
});

test('microphone permission failure is reported; failures after unmount do not show a stale toast', async (t) => {
  const m = await mount(t);
  fixture.media = async () => {
    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  };
  await m.click();
  assert.deepEqual(
    fixture.notices.map((n: any[]) => [n[0], n[1], n[2]?.action?.label]),
    [['Microphone access is off for MoPilot.', 'error', 'Open System Settings']],
  );
  let reject!: (error: unknown) => void;
  fixture.media = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  await m.click();
  await m.close();
  await act(async () => reject(new Error('denied later')));
  assert.equal(fixture.notices.length, 1);
});

test('a late microphone permission grant releases its stream after the editor closes', async (t) => {
  const m = await mount(t);
  let resolve!: (stream: unknown) => void;
  fixture.media = () =>
    new Promise((done) => {
      resolve = done;
    });
  await m.click();
  await m.close();
  await act(async () => resolve(fixture.stream));
  assert.equal(fixture.stopped, 1);
  assert.equal(fixture.recorder, null);
});

test('closing a recording editor stops recording and releases microphone tracks without transcription', async (t) => {
  const m = await mount(t);
  await m.click();
  await m.close();
  assert.equal(fixture.recorder!.state, 'inactive');
  assert.equal(fixture.stopped, 1);
  assert.deepEqual(fixture.transcriptions, []);
});

test('supplied test streams remain owned by the caller on stop and editor cleanup', async (t) => {
  const m = await mount(t);
  (window as any).__voiceTestStream = fixture.stream;
  await m.click();
  await m.click();
  await fixture.pending;
  await m.close();
  assert.equal(fixture.requests, 0);
  assert.equal(fixture.stopped, 0);
});

test('a late grant for a caller-owned stream is left untouched after editor cleanup', async (t) => {
  const m = await mount(t);
  let resolve!: (stream: unknown) => void;
  fixture.media = () =>
    new Promise((done) => {
      resolve = done;
    });
  await m.click();
  await m.close();
  (window as any).__voiceTestStream = fixture.stream;
  await act(async () => resolve(fixture.stream));
  assert.equal(fixture.stopped, 0);
});

for (const failure of ['constructor', 'start']) {
  test(`a MediaRecorder ${failure} failure reports its cause and releases microphone tracks`, async (t) => {
    const m = await mount(t);
    fixture.makeError = failure === 'constructor';
    fixture.startError = failure === 'start';
    await m.click();
    assert.equal(fixture.stopped, 1);
    assert.equal(fixture.notices.length, 1);
    (window as any).__voiceTestStream = fixture.stream;
    await m.click();
    assert.equal(fixture.stopped, 1);
    assert.equal(fixture.notices.length, 2);
  });
}

for (const error of [new Error('engine failed'), 'engine failed']) {
  test(`transcription errors are reported for ${typeof error === 'string' ? 'non-Error' : 'Error'} failures`, async (t) => {
    const m = await mount(t);
    fixture.engineError = error;
    await m.click();
    await fixture.pending;
    assert.deepEqual(fixture.notices, [['engine failed', 'error']]);
    assert.deepEqual(m.words, []);
  });
}

test('an explicit transcription error and empty results never invoke the comment callback or save a recording', async (t) => {
  const m = await mount(t);
  for (const result of [{ error: 'try again' }, {}, { text: '  ' }]) {
    fixture.result = result;
    await m.click();
    await m.click();
    await fixture.pending;
  }
  assert.deepEqual(fixture.notices, [['try again', 'error']]);
  assert.deepEqual(m.words, []);
  assert.deepEqual(fixture.recordings, []);
});

test('transcription completing after the editor closes cannot append to a different comment', async (t) => {
  const m = await mount(t);
  let complete!: (result: any) => void;
  fixture.transcribe = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await m.click();
  await m.click();
  await m.close();
  await act(async () => {
    complete({ text: 'late' });
    await fixture.pending;
  });
  assert.deepEqual(m.words, []);
  assert.deepEqual(fixture.recordings, []);
});
