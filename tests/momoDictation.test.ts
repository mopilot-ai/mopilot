// Dictation into MoMo (src/components/momo/MomoDictation.tsx over src/components/ui/Dictation.tsx, #2139): the app's own Dictate button always on this Mac's recognition, whatever Settings chose, with the text handed to MoMo's composer and the recording kept out of the app's saved recordings; nothing when on-device dictation is switched off. Dictation elsewhere keeps the chosen engine and saves.
import { speechMock } from './support/speechMock.ts';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, flush, mount } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import { SPEECH_WAIT_MS } from '../shared/speech.mjs';

const calls: any[][] = [];
let localOn = true;
stubStore({
  getState: () => ({ prefs: { dictationLanguage: 'auto' } }),
  toast: (t: string, k?: string) => calls.push(['toast', t, k]),
});
installNativeStub({
  speech: speechMock(async (...a) => (calls.push(['transcribe', ...a]), { text: ' pay the water bill ' })),
  dictation: {
    localStatus: async () => ({ authorization: 'authorized', available: true, onDevice: true }),
    transcribe: async (...a: any[]) => (calls.push(['transcribe', ...a]), { text: ' pay the water bill ' }),
  },
  recordings: { save: async (_b: Uint8Array, text: string) => void calls.push(['save', text]) },
});
mock.module('../src/session/voice.ts', {
  namedExports: {
    currentDictationEngine: async () => (calls.push(['settings engine']), 'chatgpt'),
    currentDictationChain: async () => (calls.push(['settings engine']), ['chatgpt']),
  },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: async () => new Uint8Array([7]) } });
mock.module('../src/lib/flags.ts', {
  namedExports: { useFlag: (k: string) => (calls.push(['flag', k]), localOn) },
});

class Stream {
  getTracks() {
    return [{ stop() {} }];
  }
}
class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  ondataavailable: any;
  onstop: any;
  stream = new Stream();
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2])]) });
    this.onstop?.();
  }
}
(globalThis as any).MediaRecorder = FakeRecorder;
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => new Stream() } });

const { createElement, act } = await import('react');
const { MomoDictation } = await import('../src/components/momo/MomoDictation.tsx');
const { Dictation } = await import('../src/components/ui/Dictation.tsx');

const press = () => act(async () => $('button[aria-label="Dictate"]').click());
beforeEach(() => {
  calls.length = 0;
  localOn = true;
});

test('MoMo dictates on this Mac only, hands the text over, and keeps no recording', async () => {
  const texts: string[] = [];
  const m = await mount(createElement(MomoDictation, { onText: (t: string) => texts.push(t) }));
  try {
    await press();
    await press();
    await flush();
    assert.deepEqual(texts, ['pay the water bill']);
    const sent = calls.find((c) => c[0] === 'transcribe')!;
    assert.deepEqual(sent.slice(2), ['audio/wav', 'auto', 'local', SPEECH_WAIT_MS]);
    assert.deepEqual(
      calls.filter((c) => c[0] === 'save' || c[0] === 'settings engine'),
      [],
    );
    assert.deepEqual(calls[0], ['flag', 'shared.dictation.local']);
  } finally {
    await m.unmount();
  }
});

test('with on-device dictation switched off, MoMo shows no Dictate button', async () => {
  localOn = false;
  const m = await mount(createElement(MomoDictation, { onText: () => {} }));
  try {
    assert.equal($('button[aria-label="Dictate"]'), null);
  } finally {
    await m.unmount();
  }
});

test('Dictation elsewhere keeps Settings’ engine and saves the recording', async () => {
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t) }));
  try {
    await press();
    await press();
    await flush();
    assert.deepEqual(texts, ['pay the water bill']);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['settings engine', 'settings engine', 'transcribe', 'save'],
      'Settings’ engine is read when recording starts and again when the clip is sent',
    );
    assert.equal(calls[2][4], 'chatgpt');
  } finally {
    await m.unmount();
  }
});
