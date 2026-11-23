// The composer's dictation shortcut (src/components/composer/useComposerSpeech.ts): a tap starts or stops dictating, a
// press held in this window talks until it is released, and dictated text lands at the caret.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';
import { createElement, createRef, useRef, act } from 'react';

mock.module('../src/session/voice.ts', {
  namedExports: {
    useVoice: (select: (v: any) => unknown) => select({ phase: 'idle', threadId: null }),
    startVoiceChat: async () => undefined,
    stopVoice: async () => undefined,
  },
});
const { useComposerSpeech } = await import('../src/components/composer/useComposerSpeech.ts');
const { dispatchComposerCommand } = await import('../src/lib/shortcutFocus.ts');

function Harness({ out, setText }: { out: { current: any }; setText: (u: (d: string) => string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<any>(null);
  out.current = useComposerSpeech('chat', 'draft', box, input, setText);
  return createElement('div', { ref: box, 'data-composer-chat': 'chat', 'data-composer-main': true }, createElement('input'));
}

test('a tap of the shortcut toggles dictation; a press held in the window stops it on release', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const out = createRef<any>() as { current: any };
  let draft = 'Note:';
  const m = await mount(createElement(Harness, { out, setText: (u) => (draft = u(draft)) }));
  const calls: string[] = [];
  let recording = false;
  out.current.dictationControl.current = {
    recording: () => recording,
    dictate: async () => {
      calls.push(recording ? 'dictate:stop' : 'dictate:start');
      recording = !recording;
    },
    stop: () => calls.push('stop'),
  };
  const focused = mock.method(document, 'hasFocus', () => true);
  try {
    (m.host.querySelector('input') as HTMLInputElement).focus();
    const up = () => window.dispatchEvent(new (window as any).KeyboardEvent('keyup', { key: 'v' }));
    await act(async () => void dispatchComposerCommand('start-voice'));
    up(); // a tap: still recording
    await act(async () => void dispatchComposerCommand('start-voice'));
    assert.deepEqual(calls, ['dictate:start', 'dictate:stop'], 'the second tap stops it, and arms no hold');
    await act(async () => void dispatchComposerCommand('start-voice'));
    t.mock.timers.tick(400);
    up();
    assert.deepEqual(calls.slice(2), ['dictate:start', 'stop']);
    // a shortcut from outside the window (the global hotkey) never arms a hold
    focused.mock.mockImplementation(() => false);
    recording = false;
    await act(async () => void dispatchComposerCommand('start-voice'));
    t.mock.timers.tick(400);
    up();
    assert.deepEqual(calls.slice(4), ['dictate:start']);
    // no control (dictation not mounted): nothing happens
    out.current.dictationControl.current = null;
    await act(async () => void dispatchComposerCommand('start-voice'));
    // dictated text goes in at the draft's end without an editor
    out.current.insertText('hello');
    assert.equal(draft, 'Note: hello');
  } finally {
    focused.mock.restore();
    await m.unmount();
  }
});
