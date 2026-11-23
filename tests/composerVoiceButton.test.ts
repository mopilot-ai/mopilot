// The composer's voice conversation button (only where the chat declares native voice; a disabled Send otherwise) and
// saved audio messages' playback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, mockTsx, flush } from './support/composer-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { createElement, act } from 'react';
let read: (path: string) => Promise<string>;
installNativeStub({ speech: { read: (p: string) => read(p) } });
mockTsx(new URL('../src/components/ui/Popover.tsx', import.meta.url), { Tooltip: ({ children }: any) => children });
const { ComposerVoice } = await import('../src/components/composer/ComposerVoice.tsx');
const { AudioMessage } = await import('../src/components/composer/AudioMessage.tsx');

test('voice conversation is a direct button where the chat declares it, never a menu; elsewhere Send waits disabled', async () => {
  const calls: any[] = [];
  const speech: any = { voiceBusy: false, toggleVoice: (...a: any[]) => calls.push(a) };
  const props = (o: any) => ({ speech, available: true, pending: false, compact: false, morph: 'voice', ...o });
  const m = await mount(createElement(ComposerVoice, props({})));
  try {
    const voice = () => m.host.querySelector('button')!;
    assert.equal(voice().getAttribute('aria-label'), 'Voice conversation');
    assert.equal(voice().getAttribute('aria-haspopup'), null);
    assert.match(voice().className, /send-btn voice/);
    assert.equal(voice().dataset.morph, 'voice');
    await act(async () => voice().click());
    assert.deepEqual(calls, [[true]]);
    await m.render(createElement(ComposerVoice, props({ compact: true })));
    assert.match(voice().className, /composer-icon-btn voice/);
    assert.equal(voice().dataset.morph, undefined);
    await m.render(createElement(ComposerVoice, props({ pending: true })));
    assert.equal(voice().disabled, true, 'voice waits for the chat to open');
    // no native voice: an empty composer keeps a disabled Send; beside Send or Stop nothing
    await m.render(createElement(ComposerVoice, props({ available: false })));
    assert.deepEqual([voice().getAttribute('aria-label'), voice().disabled], ['Send', true]);
    await m.render(createElement(ComposerVoice, props({ available: false, compact: true })));
    assert.equal(m.host.querySelector('button'), null);
    // a running conversation can always be ended
    speech.voiceBusy = true;
    await m.render(createElement(ComposerVoice, props({ available: false, pending: true })));
    assert.deepEqual([voice().getAttribute('aria-label'), voice().disabled, /\bon\b/.test(voice().className)], ['End voice', false, true]);
  } finally {
    await m.unmount();
  }
});

test('audio playback loads immutable saved bytes and ignores replaced/unmounted reads and their errors', async () => {
  const late = deferred<string>();
  read = () => late.promise;
  const m = await mount(createElement(AudioMessage, { path: '/first.wav' }));
  assert.match(m.host.textContent ?? '', /Loading/);
  read = async () => 'data:audio/wav;base64,AA';
  await m.render(createElement(AudioMessage, { path: '/second.wav' }));
  assert.equal(m.host.querySelector('audio')!.getAttribute('src'), 'data:audio/wav;base64,AA');
  late.resolve('old');
  await flush();
  assert.equal(m.host.querySelector('audio')!.getAttribute('src'), 'data:audio/wav;base64,AA');
  read = async () => {
    throw new Error('missing file');
  };
  await m.render(createElement(AudioMessage, { path: '/missing.wav' }));
  assert.match(m.host.textContent ?? '', /Audio message unavailable: missing file/);
  const gone = deferred<string>();
  read = () => gone.promise;
  await m.render(createElement(AudioMessage, { path: '/gone.wav' }));
  await m.unmount();
  gone.reject(new Error('gone'));
  await flush();
});
