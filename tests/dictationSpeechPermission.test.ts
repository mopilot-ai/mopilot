// Dictate on this Mac's engine while macOS asks for Speech Recognition (#2286), in MoMo's and the coding side's composer
// alike (src/components/ui/Dictation.tsx, src/lib/localSpeech.ts): the composer says it waits for macOS, a second press
// gives up waiting, Deny ends on one short error with the button back to idle, and neither a prompt nor an engine that
// never answers keeps it spinning.
import { speechMock } from './support/speechMock.ts';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, flush, mount } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[][] = [];
let availableAfterGrant = true;
let status: () => Promise<any>;
let request: () => Promise<any>;
let transcribe: () => Promise<any>;
stubStore({
  getState: () => ({ prefs: { dictationLanguage: 'auto' } }),
  toast: (t: string, k?: string) => calls.push(['toast', t, k]),
});
installNativeStub({
  speech: speechMock((...a) => (calls.push(['transcribe', ...a]), transcribe())),
  dictation: {
    transcribe: (...a: any[]) => (calls.push(['transcribe', ...a]), transcribe()),
    localStatus: (lang: string) => (calls.push(['status', lang]), status()),
    localRequest: async (lang: string) => {
      calls.push(['request', lang]);
      const result = await request();
      if (result?.authorization === 'authorized')
        status = availableAfterGrant
          ? auth('authorized')
          : async () => ({ authorization: 'authorized', available: false, onDevice: false });
      return result;
    },
  },
  recordings: { save: () => undefined },
});
mock.module('../src/session/voice.ts', {
  namedExports: { currentDictationEngine: async () => 'local', currentDictationChain: async () => ['local'] },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: async () => new Uint8Array([1]) } });

class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  ondataavailable: any;
  onstop: any;
  stream: any;
  constructor(stream: any) {
    this.stream = stream;
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
const stream = { getTracks: () => [{ stop() {} }] };
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } });

const { act, createElement } = await import('react');
const { Dictation } = await import('../src/components/ui/Dictation.tsx');
const speech = await import('../src/lib/localSpeech.ts');

const btn = () => $('button[aria-label="Dictate"]') as HTMLButtonElement;
const press = () => act(async () => btn().click());
const note = () => document.querySelector('.dictation-note')?.textContent ?? null;
const auth = (authorization: string) => async () => ({ authorization, locale: 'en', available: true, onDevice: true });
const pending = () => {
  let resolve!: (v: any) => void;
  const p = new Promise((r) => (resolve = r));
  return { p, resolve };
};
/** Settles promises only: with mocked timers, a flush that waits on setTimeout would never end. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
async function dictate(after: () => Promise<void> = flush) {
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t), engine: 'local', keepRecording: false }));
  await press();
  await press();
  await after();
  return { ...m, texts };
}

beforeEach(() => {
  calls.length = 0;
  availableAfterGrant = true;
  status = auth('authorized');
  request = auth('authorized');
  transcribe = async () => ({ text: 'hello' });
});

test('allowed already: no prompt, no note, the clip is transcribed', async () => {
  const m = await dictate();
  try {
    assert.deepEqual(m.texts, ['hello']);
    assert.equal(note(), null);
    assert.ok(!calls.some((c) => c[0] === 'request'));
  } finally {
    await m.unmount();
  }
});

test('macOS asks: the composer says so while it waits; Allow goes on to transcribe', async () => {
  status = auth('notDetermined');
  const answer = pending();
  request = () => answer.p;
  const m = await dictate();
  try {
    assert.equal(note(), 'Allow Speech Recognition to dictate');
    assert.equal(btn().getAttribute('aria-busy'), 'true');
    assert.ok(!calls.some((c) => c[0] === 'transcribe'), 'nothing is transcribed before macOS answers');
    answer.resolve({ authorization: 'authorized' });
    await flush();
    assert.equal(note(), null);
    assert.deepEqual(m.texts, ['hello']);
    assert.equal(btn().getAttribute('aria-busy'), null);
  } finally {
    await m.unmount();
  }
});

test('a second press while macOS asks gives up waiting; its late answer changes nothing', async () => {
  status = auth('notDetermined');
  const answer = pending();
  request = () => answer.p;
  const m = await dictate();
  try {
    assert.equal(note(), 'Allow Speech Recognition to dictate');
    await press();
    assert.equal(note(), null);
    assert.equal(btn().getAttribute('aria-busy'), null);
    answer.resolve({ authorization: 'authorized' });
    await flush();
    assert.deepEqual(m.texts, []);
    assert.ok(!calls.some((c) => c[0] === 'transcribe' || c[0] === 'toast'));
  } finally {
    await m.unmount();
  }
});

test('Deny, or a permission turned off before: retain the recording for explicit retry or discard', async () => {
  for (const [st, req] of [
    ['notDetermined', 'denied'],
    ['denied', null],
    ['restricted', null],
  ] as const) {
    calls.length = 0;
    availableAfterGrant = true;
    status = auth(st);
    request = async () => (req ? { authorization: req } : null);
    const m = await dictate();
    try {
      assert.deepEqual(
        calls.filter((c) => c[0] === 'toast'),
        [['toast', 'Turn on Speech Recognition in System Settings to dictate', 'error']],
        `${st} / ${req}`,
      );
      assert.match(note() ?? '', /Recording retained/);
      await press();
      assert.equal(note(), null);
      assert.equal(btn().getAttribute('aria-busy'), null);
      assert.ok(!calls.some((c) => c[0] === 'transcribe'));
    } finally {
      await m.unmount();
    }
  }
  // main knows why it couldn't be asked (the helper aborted): the composer says that, and the clip stops there
  calls.length = 0;
  availableAfterGrant = true;
  status = auth('notDetermined');
  request = async () => ({ failure: 'The helper stopped. Quit and reopen MoPilot.' });
  const stopped = await dictate();
  try {
    assert.deepEqual(
      calls.filter((c) => c[0] === 'toast'),
      [['toast', 'The helper stopped. Quit and reopen MoPilot.', 'error']],
    );
    assert.deepEqual(await speech.askSpeech('auto'), { answer: 'failed', why: 'The helper stopped. Quit and reopen MoPilot.' });
  } finally {
    await stopped.unmount();
  }
  // a prompt that couldn't be asked (the helper gone) says so, not that permission is off
  for (const fail of [async () => null, async () => Promise.reject(new Error('helper gone'))]) {
    calls.length = 0;
    availableAfterGrant = true;
    status = auth('notDetermined');
    request = fail;
    const m = await dictate();
    try {
      assert.deepEqual(
        calls.filter((c) => c[0] === 'toast'),
        [['toast', 'Couldn’t ask for Speech Recognition', 'error']],
      );
    } finally {
      await m.unmount();
    }
  }
});

test('an unknown local status blocks transcription without uploading elsewhere', async () => {
  status = async () => {
    throw new Error('no helper');
  };
  transcribe = async () => ({ error: 'Local dictation needs macOS' });
  const m = await dictate();
  try {
    assert.deepEqual(calls.at(-1), ['toast', speech.SPEECH_TEXT.unavailable, 'error']);
  } finally {
    await m.unmount();
  }
  status = async () => null;
  assert.equal(await speech.speechGate('auto'), 'unavailable');
});

test('a prompt or an engine that never answers times out', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    request = () => new Promise(() => {});
    const asked = speech.askSpeech('auto');
    mock.timers.tick(speech.SPEECH_ASK_MS);
    assert.deepEqual(await asked, { answer: 'timeout' });
    const late = speech.withTimeout(new Promise(() => {}), 50);
    mock.timers.tick(50);
    assert.equal(speech.timedOut(await late), true);
    assert.equal(await speech.withTimeout(Promise.resolve(7), 50), 7);
  } finally {
    mock.timers.reset();
  }
});

test('the composer gives up on a prompt or a transcription that never answers', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    status = auth('notDetermined');
    request = () => new Promise(() => {});
    let m = await dictate(settle);
    assert.equal(note(), 'Allow Speech Recognition to dictate');
    await act(async () => mock.timers.tick(speech.SPEECH_ASK_MS));
    await settle();
    assert.deepEqual(calls.at(-1), ['toast', 'Dictation timed out', 'error']);
    assert.equal(btn().getAttribute('aria-busy'), null);
    await m.unmount();
    status = auth('authorized');
    transcribe = () => new Promise(() => {});
    m = await dictate(settle);
    assert.equal(btn().getAttribute('aria-busy'), 'true');
    // a press while it transcribes gives up too
    await press();
    assert.equal(btn().getAttribute('aria-busy'), null);
    await m.unmount();
    calls.length = 0;
    availableAfterGrant = true;
    m = await dictate(settle);
    await act(async () => mock.timers.tick(speech.SPEECH_TRANSCRIBE_MS));
    await settle();
    assert.deepEqual(calls.at(-1), ['toast', 'Dictation timed out', 'error']);
    await m.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('a press while the permission is still being read gives the clip up before anything is asked', async () => {
  const read = pending();
  status = () => read.p;
  const m = await dictate();
  try {
    await press();
    assert.equal(btn().getAttribute('aria-busy'), null);
    read.resolve({ authorization: 'notDetermined' });
    await flush();
    assert.equal(note(), null);
    assert.ok(!calls.some((c) => c[0] === 'request' || c[0] === 'transcribe' || c[0] === 'toast'));
  } finally {
    await m.unmount();
  }
});

test('a coding chat’s Dictate on this Mac’s engine (the engine Settings chose) waits for macOS the same way', async () => {
  status = auth('notDetermined');
  const answer = pending();
  request = () => answer.p;
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t) }));
  try {
    await press();
    await press();
    await flush();
    assert.equal(note(), 'Allow Speech Recognition to dictate');
    answer.resolve({ authorization: 'authorized' });
    await flush();
    assert.deepEqual(texts, ['hello']);
  } finally {
    await m.unmount();
  }
});

test('granting permission still rechecks on-device availability before uploading any audio', async () => {
  status = auth('notDetermined');
  availableAfterGrant = false;
  const m = await dictate();
  try {
    assert.deepEqual(m.texts, []);
    assert.equal(
      calls.some((c) => c[0] === 'transcribe'),
      false,
    );
    assert.match(calls.at(-1)![1], /unavailable|not available/i);
  } finally {
    await m.unmount();
  }
});
