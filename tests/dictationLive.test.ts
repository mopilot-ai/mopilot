// Live words while dictating on this Mac (src/components/ui/Dictation.tsx with dictationStream.ts): the caption follows
// the stream, the stream's final text is used when it answers, and the recording goes along the chain when it doesn't.
import { speechMock } from './support/speechMock.ts';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, flush, mount } from './support/composer-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[][] = [];
let engine = 'local';
let chain = ['local'];
let readChain = async () => chain;
let stream: (o: any) => Promise<any>;
let transcribe: () => Promise<any>;
stubStore({ getState: () => ({ prefs: { dictationLanguage: 'en' } }), toast: (t: string, k?: string) => calls.push(['toast', t, k]) });
installNativeStub({
  speech: {
    ...speechMock((...a: any[]) => (calls.push(['transcribe', a[3]]), transcribe())),
    begin: async () => 'capture',
    end: async (id: string) => void calls.push(['end', id]),
  },
  dictation: { micAsk: async () => 'granted', localStatus: async () => ({ authorization: 'authorized', available: true, onDevice: true }) },
  recordings: { save: async () => undefined },
});
mock.module('../src/session/voice.ts', {
  namedExports: { currentDictationEngine: async () => engine, currentDictationChain: () => readChain() },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: async () => new Uint8Array([1]) } });
mock.module('../src/components/ui/dictationStream.ts', { namedExports: { startStream: (o: any) => stream(o) } });

class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  ondataavailable: any;
  onstop: any;
  stream: any;
  constructor(s: any) {
    this.stream = s;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) });
    this.onstop?.();
  }
}
(globalThis as any).MediaRecorder = FakeRecorder;
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
});

const { createElement, act } = await import('react');
const { Dictation } = await import('../src/components/ui/Dictation.tsx');
const mic = () => $('button[aria-label="Dictate"]');
const press = () => act(async () => mic().click());

/** A stream the test drives: its caption callback, what finish answers, and whether it was cancelled. */
function liveStream(answer: string | null) {
  const s: any = { caption: null, cancelled: 0, finished: 0 };
  stream = async (o: any) => {
    s.caption = o.onCaption;
    s.options = o;
    return { engine: o.engine, finish: async () => (s.finished++, answer), cancel: () => void s.cancelled++ };
  };
  return s;
}

beforeEach(() => {
  calls.length = 0;
  engine = 'local';
  chain = ['local'];
  readChain = async () => chain;
  transcribe = async () => ({ text: 'from the recording' });
});

test('this Mac shows its words live, and its final text is what lands', async () => {
  const s = liveStream('streamed words');
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t) }));
  try {
    await press();
    await flush();
    assert.deepEqual([s.options.capture, s.options.lang], ['capture', 'en']);
    await act(async () => s.caption('streamed wo'));
    assert.equal($('.dictation-caption').textContent, 'streamed wo');
    await act(async () => s.caption('x'.repeat(60)));
    assert.equal($('.dictation-caption').textContent, `…${'x'.repeat(47)}`);
    await press();
    await flush();
    assert.deepEqual(texts, ['streamed words']);
    assert.ok(!calls.some((c) => c[0] === 'transcribe'), 'the recording is not sent anywhere');
    assert.equal($('.dictation-caption'), null);
  } finally {
    await m.unmount();
  }
});

test('a stream with no answer, or a pin to another service, leaves the recording to the chain', async () => {
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t) }));
  try {
    const failed = liveStream(null);
    await press();
    await flush();
    await press();
    await flush();
    assert.equal(failed.finished, 1);
    assert.deepEqual(texts, ['from the recording']);
    const moved = liveStream('local words');
    await press();
    await flush();
    chain = ['credits'];
    await press();
    await flush();
    assert.deepEqual([moved.finished, moved.cancelled], [0, 1]);
    assert.deepEqual(calls.filter((c) => c[0] === 'transcribe').at(-1), ['transcribe', 'credits']);
    // MoPilot credits has no stream; the ChatGPT login and this Mac do (here neither can start one)
    const engines: string[] = [];
    stream = async (o: any) => (engines.push(o.engine), null);
    for (const first of ['credits', 'chatgpt', 'local']) {
      engine = first;
      chain = [first];
      await press();
      await press();
      await flush();
    }
    assert.deepEqual(engines, ['chatgpt', 'local']);
  } finally {
    await m.unmount();
  }
});

test('discarding, a stream that starts after the recording stopped, and unmounting cancel the stream', async () => {
  const m = await mount(createElement(Dictation, { onText: () => undefined }));
  try {
    const thrown = liveStream('x');
    await press();
    await flush();
    await act(async () => ($('.dictation-cancel') as HTMLButtonElement).click());
    assert.equal(thrown.cancelled, 1);
    // the stream answers its start only after the recording stopped: it is cancelled, the recording is used
    const late = deferred<any>();
    let lateCancelled = 0;
    stream = () => late.promise;
    await press();
    await press();
    late.resolve({ engine: 'local', finish: async () => 'never', cancel: () => void lateCancelled++ });
    await flush();
    assert.equal(lateCancelled, 1);
    const kept = liveStream('y');
    await press();
    await flush();
    await m.unmount();
    assert.equal(kept.cancelled, 1, 'an unmounted recording takes its stream with it');
  } finally {
    await m.unmount();
  }
});

test('a recording given up while the chain is read again cancels the stream it heard', async () => {
  const s = liveStream('words');
  const reading = deferred<string[]>();
  const m = await mount(createElement(Dictation, { onText: () => undefined }));
  try {
    await press();
    await flush();
    readChain = () => reading.promise;
    await press(); // stop: the chain is read again
    await press(); // give up while it is read
    reading.resolve(['local']);
    await flush();
    assert.deepEqual([s.cancelled, s.finished], [1, 0]);
  } finally {
    await m.unmount();
  }
});
