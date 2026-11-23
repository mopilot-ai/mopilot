// This Mac's streaming dictation in the window (src/components/ui/dictationStream.ts): 16 kHz PCM out, live guesses in,
// the final text on finish, and null whenever streaming can't help (the recording is transcribed instead).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[][] = [];
let start: () => Promise<void>;
let append: () => Promise<void>;
let finish: () => Promise<any>;
let listener: ((e: any) => void) | null = null;
installNativeStub({
  speech: {
    streamStart: (id: string, lang: string, engine: string) => (calls.push(['start', id, lang, engine]), start()),
    streamAudio: (id: string, pcm: Uint8Array) => (calls.push(['audio', id, pcm.length]), append()),
    streamFinish: (id: string) => (calls.push(['finish', id]), finish()),
    streamCancel: async (id: string) => void calls.push(['cancel', id]),
    onStream: (cb: (e: any) => void) => {
      listener = cb;
      return () => {
        listener = null;
        calls.push(['off']);
      };
    },
  },
});
const { toPcm16, startStream, STREAM_RATE } = await import('../src/components/ui/dictationStream.ts');

let processor: any;
let closed = 0;
class FakeContext {
  sampleRate = 48_000;
  createMediaStreamSource() {
    return { connect() {}, disconnect: () => calls.push(['source off']) };
  }
  createScriptProcessor() {
    processor = { connect() {}, disconnect() {}, onaudioprocess: null as any };
    return processor;
  }
  get destination() {
    return {};
  }
  close() {
    closed++;
    return Promise.resolve();
  }
}
const frame = (samples: number[]) => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(samples) } });

beforeEach(() => {
  calls.length = 0;
  closed = 0;
  start = async () => undefined;
  append = async () => undefined;
  finish = async () => ({ text: 'hello there' });
  (window as any).AudioContext = FakeContext;
});

test('samples become 16 kHz 16-bit PCM, averaged and clamped', () => {
  const pcm = new Int16Array(toPcm16(new Float32Array([0.5, 0.5, 0.5, -1, -1, -1, 2, 2, 2]), 48_000).buffer);
  assert.deepEqual([...pcm], [Math.floor(0.5 * 0x7fff), -0x8000, 0x7fff]);
  assert.equal(new Int16Array(toPcm16(new Float32Array(16), STREAM_RATE).buffer).length, 16);
  assert.equal(toPcm16(new Float32Array(2), 48_000).length, 0);
});

test('a stream sends the microphone, shows each guess, and answers the final text', async () => {
  const captions: string[] = [];
  const s = (await startStream({
    engine: 'local',
    capture: 'c1',
    lang: 'en',
    stream: {} as MediaStream,
    onCaption: (t) => captions.push(t),
  }))!;
  assert.deepEqual(calls[0], ['start', 'c1', 'en', 'local']);
  assert.equal(s.engine, 'local');
  frame(Array(4800).fill(0.1));
  assert.deepEqual(calls.at(-1), ['audio', 'c1', 3200]);
  listener!({ id: 'other', text: 'not mine' });
  listener!({ id: 'c1', text: 'hello' });
  listener!({ id: 'c1' });
  assert.deepEqual(captions, ['hello']);
  assert.equal(await s.finish(), 'hello there');
  assert.equal(closed, 1);
  assert.ok(calls.some((c) => c[0] === 'off'));
  frame([0.1]);
  assert.equal(calls.filter((c) => c[0] === 'audio').length, 1, 'nothing is sent after finish');
});

test('no stream when this Mac cannot: no audio graph, or main refuses the start (its audio graph closes)', async () => {
  delete (window as any).AudioContext;
  assert.equal(await startStream({ engine: 'local', capture: 'c', lang: 'en', stream: {} as MediaStream, onCaption() {} }), null);
  (window as any).AudioContext = FakeContext;
  start = async () => {
    throw new Error('speech recognition permission not granted');
  };
  assert.equal(await startStream({ engine: 'local', capture: 'c', lang: 'en', stream: {} as MediaStream, onCaption() {} }), null);
  assert.equal(closed, 1);
});

test('what is said before the stream is ready is kept and sent first, in order', async () => {
  let ready!: () => void;
  start = () => new Promise<void>((r) => (ready = r));
  const starting = startStream({ engine: 'local', capture: 'early', lang: 'en', stream: {} as MediaStream, onCaption() {} });
  frame(Array(4800).fill(0.1));
  frame(Array(2400).fill(0.1));
  assert.equal(calls.filter((c) => c[0] === 'audio').length, 0, 'nothing is sent before the stream exists');
  ready();
  const s = (await starting)!;
  frame(Array(480).fill(0.1));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'audio').map((c) => c[2]),
    [3200, 1600, 320],
  );
  s.cancel();
});

test('a failed stream answers null so the recording is transcribed instead; cancel ends it once', async () => {
  const captions: string[] = [];
  const failing = (await startStream({
    engine: 'local',
    capture: 'f',
    lang: 'en',
    stream: {} as MediaStream,
    onCaption: (t) => captions.push(t),
  }))!;
  listener!({ id: 'f', text: 'half' });
  listener!({ id: 'f', error: 'stopped' });
  assert.deepEqual(captions, ['half', ''], 'a failed stream takes its caption back');
  frame([0.1, 0.1, 0.1]);
  assert.equal(calls.filter((c) => c[0] === 'audio').length, 0, 'a failed stream sends no more audio');
  assert.equal(await failing.finish(), null);
  assert.deepEqual(calls.at(-1), ['cancel', 'f']);
  append = async () => {
    throw new Error('helper gone');
  };
  const lost = (await startStream({ engine: 'local', capture: 'l', lang: 'en', stream: {} as MediaStream, onCaption() {} }))!;
  frame([0.1, 0.1, 0.1]);
  await new Promise(setImmediate);
  assert.equal(await lost.finish(), null);
  for (const answer of [{ error: 'ended' }, { text: '  ' }, Promise.reject(new Error('no reply'))]) {
    finish = async () => answer;
    const s = (await startStream({ engine: 'local', capture: 'x', lang: 'en', stream: {} as MediaStream, onCaption() {} }))!;
    assert.equal(await s.finish(), null);
  }
  const cancelled = (await startStream({ engine: 'local', capture: 'k', lang: 'en', stream: {} as MediaStream, onCaption() {} }))!;
  calls.length = 0;
  cancelled.cancel();
  cancelled.cancel();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'cancel'),
    [
      ['cancel', 'k'],
      ['cancel', 'k'],
    ],
  );
  assert.equal(calls.filter((c) => c[0] === 'source off').length, 1, 'the audio graph closes once');
});
