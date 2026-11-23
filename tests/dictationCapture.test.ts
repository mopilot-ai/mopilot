// The dictation button's capture lifetime (src/components/ui/Dictation.tsx): a failed clip frees the microphone at once,
// Retry takes a new capture for it, an audio message keeps its own, and the composer hides the button while every
// dictation service is blocked.
import { speechMock } from './support/speechMock.ts';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, flush, mount } from './support/composer-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[][] = [];
let transcribe: (engine?: string) => Promise<any>;
let saveAudio: () => Promise<any>;
let engineNow: () => Promise<string>;
let chainNow: () => Promise<string[]>;
let begin: () => Promise<string>;
let available: () => Promise<boolean>;
let store: any = { prefs: { dictationLanguage: 'en' }, accounts: {}, claudeAccounts: {}, momoChats: {} };
stubStore({
  getState: () => store,
  useStore: (sel: any) => sel(store),
  toast: (t: string, k?: string) => calls.push(['toast', t, k]),
});
installNativeStub({
  speech: {
    ...speechMock((...a: any[]) => (calls.push(['transcribe', a[3]]), transcribe(a[3]))),
    save: (id: string) => (calls.push(['saveAudio', id]), saveAudio()),
    begin: () => begin(),
    end: async (id: string) => void calls.push(['end', id]),
    available: (...a: any[]) => (calls.push(['available', ...a]), available()),
  },
  dictation: { micAsk: async () => 'granted' },
  recordings: { save: async () => undefined },
});
mock.module('../src/session/voice.ts', {
  namedExports: { currentDictationEngine: async () => engineNow(), currentDictationChain: async () => chainNow() },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: async () => new Uint8Array([1]) } });
mock.module('../src/components/momo/MomoDictation.tsx', { namedExports: { MomoDictation: () => null } });

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
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => new Stream() } });

const { createElement, createRef, act } = await import('react');
const { Dictation } = await import('../src/components/ui/Dictation.tsx');
const { ComposerDictation } = await import('../src/components/momo/ComposerDictation.tsx');

const mic = () => $('button[aria-label="Dictate"]');
const press = () => act(async () => mic().click());
const note = (label: string) =>
  act(async () =>
    $$('.dictation-note button')
      .find((b) => b.textContent === label)!
      .click(),
  );
const ended = () => calls.filter((c) => c[0] === 'end').map((c) => c[1]);
async function render(props: Record<string, unknown> = {}) {
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t), ...props }));
  return { ...m, texts };
}

let captures = 0;
beforeEach(() => {
  calls.length = 0;
  captures = 0;
  begin = async () => `capture-${++captures}`;
  transcribe = async () => ({ error: 'offline' });
  available = async () => true;
  engineNow = async () => 'chatgpt';
  chainNow = async () => [await engineNow()];
  saveAudio = async () => ({ kind: 'audio', path: '/a.wav', name: 'Audio message' });
});

test('a service pinned or turned off while recording decides where the clip goes', async () => {
  const m = await mount(createElement(Dictation, { onText: () => undefined }));
  try {
    transcribe = async () => ({ text: 'ok' });
    await press();
    engineNow = async () => 'credits';
    await press();
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'transcribe'),
      [['transcribe', 'credits']],
    );
    await press();
    engineNow = async () => {
      throw new Error('Dictation is turned off in this app');
    };
    await press();
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'transcribe').length, 1, 'nothing is uploaded once dictation is off');
    assert.deepEqual(calls.at(-1), ['toast', 'Dictation is turned off in this app', 'error']);
  } finally {
    await m.unmount();
  }
  // a surface's own engine and a Retry on a chosen service are not read again
  const control = createRef<any>();
  const local = await mount(createElement(Dictation, { onText: () => undefined, control }));
  try {
    calls.length = 0;
    transcribe = async () => ({ error: 'offline' });
    await act(async () => control.current.dictate('chatgpt'));
    await press();
    await flush();
    transcribe = async () => ({ text: 'ok' });
    await act(async () => control.current.dictate('credits'));
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'transcribe'),
      [
        ['transcribe', 'chatgpt'],
        ['transcribe', 'credits'],
      ],
    );
  } finally {
    await local.unmount();
  }
});

test('a recording given up while its service is read again, or while a Retry is refused, does nothing more', async () => {
  const m = await mount(createElement(Dictation, { onText: () => undefined }));
  try {
    const reading = deferred<string>();
    await press();
    engineNow = () => reading.promise;
    await press(); // stop: the service is read again
    await press(); // give up while it is read
    reading.resolve('chatgpt');
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'transcribe').length, 0);
    engineNow = async () => 'chatgpt';
    await press();
    await press();
    await flush();
    const refused = deferred<string>();
    begin = () => refused.promise;
    await note('Retry');
    await press(); // give up while the retry waits
    refused.reject(new Error('Voice input is already active in another composer'));
    await flush();
    assert.equal($('.dictation-note'), null);
    assert.ok(!calls.some((c) => c[0] === 'toast' && /already active/.test(c[1])), 'a refusal nobody waits for is not shown');
  } finally {
    await m.unmount();
  }
});

test('a clip moves on to the next service when one cannot transcribe it, and says so while it waits', async () => {
  chainNow = async () => ['chatgpt', 'credits'];
  const second = deferred<any>();
  transcribe = (engine) => (engine === 'chatgpt' ? Promise.resolve({ error: 'Sign in with ChatGPT to use dictation' }) : second.promise);
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t) }));
  try {
    await press();
    await press();
    await flush();
    assert.equal($('.dictation-note').textContent, 'Trying MoPilot credits…');
    second.resolve({ text: 'from credits' });
    await flush();
    assert.deepEqual(texts, ['from credits']);
    assert.equal($('.dictation-note'), null);
    // a clip given up while the next service is tried leaves no note behind for the next recording
    const held = deferred<any>();
    transcribe = (engine) => (engine === 'chatgpt' ? Promise.resolve({ error: 'offline' }) : held.promise);
    await press();
    await press();
    await flush();
    assert.equal($('.dictation-note').textContent, 'Trying MoPilot credits…');
    await press();
    const first = deferred<any>();
    transcribe = () => first.promise;
    await press();
    await press();
    await flush();
    assert.equal($('.dictation-note'), null, 'the first service of a new clip is not "Trying …"');
    first.resolve({ text: 'fresh' });
    held.resolve({ text: 'given up' }); // the abandoned clip's late answer changes nothing
    await flush();
    assert.ok(!texts.includes('given up'));
    // every one failing keeps the clip, with each service's reason
    transcribe = async (engine) => ({ error: `${engine} down` });
    await press();
    await press();
    await flush();
    assert.deepEqual(calls.at(-1), ['toast', 'ChatGPT account: chatgpt down · MoPilot credits: credits down', 'error']);
    assert.match($('.dictation-note').textContent!, /Recording retained/);
  } finally {
    await m.unmount();
  }
});

test('Esc or × throws a recording away at once; the control stops it to transcribe (hold-to-talk)', async () => {
  const control = createRef<any>();
  const texts: string[] = [];
  transcribe = async () => ({ text: 'kept' });
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t), control }));
  try {
    await press();
    assert.ok($('.dictation-meter'), 'recording shows its level and time');
    assert.equal(control.current.recording(), true);
    await act(async () => void mic().dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flush();
    assert.equal($('.dictation-meter'), null);
    assert.deepEqual(ended(), ['capture-1'], 'the microphone is free at once');
    assert.equal(control.current.recording(), false);
    control.current.stop(); // nothing to stop
    await press();
    await act(async () => ($('.dictation-cancel') as HTMLButtonElement).click());
    await flush();
    await press();
    await act(async () => control.current.stop());
    await flush();
    assert.deepEqual(texts, ['kept']);
    assert.equal(calls.filter((c) => c[0] === 'transcribe').length, 1, 'discarded recordings send nothing');
  } finally {
    await m.unmount();
  }
});

test('hold-to-talk released while the recording is still starting stops it as soon as it starts', async () => {
  const control = createRef<any>();
  const slow = deferred<string>();
  begin = () => slow.promise;
  transcribe = async () => ({ text: 'short' });
  const texts: string[] = [];
  const m = await mount(createElement(Dictation, { onText: (t: string) => texts.push(t), control }));
  try {
    await act(async () => void control.current.dictate());
    control.current.stop(); // released while preparing
    slow.resolve('capture-slow');
    await flush();
    assert.equal(control.current.recording(), false);
    assert.deepEqual(texts, ['short']);
    // a later recording is not stopped by that old release
    begin = async () => `capture-${++captures}`;
    await press();
    assert.equal(control.current.recording(), true);
    await press();
    await flush();
  } finally {
    await m.unmount();
  }
});

test('in a comment form, Enter in its field stops the recording instead of submitting the comment', async () => {
  const submitted: string[] = [];
  transcribe = async () => ({ text: 'said' });
  const texts: string[] = [];
  const form = createElement(
    'form',
    { onSubmit: (e: any) => (e.preventDefault(), submitted.push('submit')) },
    createElement('textarea'),
    createElement(Dictation, { onText: (t: string) => texts.push(t) }),
  );
  const m = await mount(form);
  try {
    await press();
    const field = m.host.querySelector('textarea')!;
    await act(
      async () => void field.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    await flush();
    assert.deepEqual([texts, submitted], [['said'], []]);
  } finally {
    await m.unmount();
  }
});

test('a failed audio message keeps the capture it was recorded under, and Retry saves it there', async () => {
  const control = createRef<any>();
  const attached: any[] = [];
  const m = await mount(createElement(Dictation, { onText: () => undefined, control, onAudio: (a: any) => attached.push(a) }));
  try {
    saveAudio = async () => {
      throw new Error('This voice input belongs to an earlier chat or account');
    };
    await act(async () => control.current.audio());
    await press();
    await flush();
    assert.deepEqual(ended(), [], 'an audio message is bound to its chat and account');
    saveAudio = async () => ({ kind: 'audio', path: '/a.wav', name: 'Audio message' });
    await note('Retry');
    await flush();
    assert.equal(attached.length, 1);
    assert.equal(captures, 1, 'Retry did not take a capture under another chat or account');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'saveAudio').map((c) => c[1]),
      ['capture-1', 'capture-1'],
    );
    assert.deepEqual(ended(), ['capture-1']);
  } finally {
    await m.unmount();
  }
});

test('a failed clip frees the microphone at once, and Retry transcribes it under a new capture', async () => {
  const m = await render();
  try {
    await press();
    await press();
    await flush();
    assert.deepEqual(ended(), ['capture-1'], 'another composer can dictate while the failed clip waits');
    // the reason stays beside Retry once the toast is gone
    assert.equal($('.dictation-why').textContent, 'Recording retained. offline');
    assert.equal($('.dictation-why').getAttribute('title'), 'offline');
    transcribe = async () => ({ text: 'retried' });
    await note('Retry');
    await flush();
    assert.deepEqual(m.texts, ['retried']);
    assert.deepEqual(ended(), ['capture-1', 'capture-2']);
    assert.equal($('.dictation-note'), null);
  } finally {
    await m.unmount();
  }
});

test('a Retry that cannot take the microphone stays retryable; one given up while it waits releases its late capture', async () => {
  const m = await render();
  try {
    await press();
    await press();
    await flush();
    begin = async () => {
      throw new Error('Voice input is already active in another composer');
    };
    await note('Retry');
    await flush();
    assert.deepEqual(calls.at(-1), ['toast', 'Voice input is already active in another composer', 'error']);
    assert.equal($('.dictation-why').textContent, 'Recording retained. Voice input is already active in another composer');
    const late = deferred<string>();
    begin = () => late.promise;
    await note('Retry');
    await press(); // give up while the retry waits for its capture
    late.resolve('late-capture');
    await flush();
    assert.deepEqual(ended(), ['capture-1', 'late-capture']);
    assert.equal(calls.filter((c) => c[0] === 'transcribe').length, 1, 'the abandoned retry transcribes nothing');
    assert.equal($('.dictation-note'), null);
  } finally {
    await m.unmount();
  }
});

test('the composer hides the button while every service is blocked, and shows it once one may be usable', async () => {
  available = async () => false;
  const m = await mount(createElement(ComposerDictation, { threadId: 'chat', hint: { kind: 'claude' }, onText: () => undefined }));
  try {
    await flush();
    assert.equal(mic(), null);
    assert.deepEqual(
      calls.find((c) => c[0] === 'available'),
      ['available', 'chat', { kind: 'claude' }],
    );
    // signing in or pinning a service in Settings rechecks without a window focus
    available = async () => true;
    store = { ...store, accounts: { active: 'signed-in' } };
    await m.render(createElement(ComposerDictation, { threadId: 'chat', hint: { kind: 'claude' }, onText: () => undefined }));
    await flush();
    assert.ok(mic());
    // the latest check wins: an older answer settling late changes nothing
    const old = deferred<boolean>();
    available = () => old.promise;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    available = async () => true;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    old.resolve(false);
    await flush();
    assert.ok(mic());
    // a check that fails keeps the button: the press then says what is wrong
    available = async () => {
      throw new Error('main busy');
    };
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await flush();
    assert.ok(mic());
  } finally {
    await m.unmount();
  }
  const before = calls.filter((c) => c[0] === 'available').length;
  window.dispatchEvent(new Event('focus'));
  assert.equal(calls.filter((c) => c[0] === 'available').length, before, 'an unmounted composer stops checking');
  store = { ...store, momoChats: { mc: 'main' } };
  const momo = await mount(createElement(ComposerDictation, { threadId: 'mc', onText: () => undefined }));
  try {
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'available').length, before, "MoMo's own engine needs no service check");
  } finally {
    await momo.unmount();
  }
});

test('a hidden button still shows a clip it is working on', async () => {
  let shown = true;
  const props = () => ({ onText: () => undefined, available: shown });
  const m = await mount(createElement(Dictation, props()));
  try {
    await press();
    await press();
    await flush();
    shown = false;
    await m.render(createElement(Dictation, props()));
    assert.match($('.dictation-note').textContent!, /Recording retained/, 'the failed clip keeps its Retry and Discard');
    await note('Discard');
    assert.equal(mic(), null);
  } finally {
    await m.unmount();
  }
});
