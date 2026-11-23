// Keyboard voice commands share composer cancellation, side-chat targeting and opening handover.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act, useRef } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { dispatchComposerCommand } from '../src/lib/shortcutFocus.ts';
import { stubStore } from './support/stubs.ts';
const attempts: { chat: string | null; signal: AbortSignal; opening(): void }[] = [];
let pending = deferred();
mock.module('../src/session/voice.ts', {
  namedExports: {
    startVoiceChat: async (chat: string | null, signal: AbortSignal, opening: () => void) => {
      attempts.push({ chat, signal, opening });
      await pending.promise;
    },
    stopVoice: async () => {},
  },
});
stubStore({ toast: () => {} });
const { useComposerVoice } = await import('../src/components/composer/useComposerVoice.ts');
function Composer({ chat, main }: { chat: string; main: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useComposerVoice(chat, chat, false, ref);
  return createElement('div', { ref, 'data-composer-chat': chat, 'data-composer-main': main }, createElement('input'));
}
test('side voice preparation retires on draft changes and unmount; opening transfers its attempt', async () => {
  const r = await render(
    createElement(
      'div',
      null,
      createElement(Composer, { chat: 'main', main: true }),
      createElement(Composer, { chat: 'side', main: false }),
    ),
  );
  const command = async () => {
    await act(async () => {
      dispatchComposerCommand('start-voice');
    });
  };
  (r.host.querySelectorAll('input')[1] as HTMLInputElement).focus();
  await command();
  assert.equal(attempts.at(-1)!.chat, 'side');
  await r.rerender(createElement(Composer, { chat: 'replacement', main: true }));
  assert.equal(attempts[0].signal.aborted, true);
  await act(async () => {
    pending.resolve(undefined);
    await pending.promise;
  });
  pending = deferred();
  await command();
  const transferred = attempts.at(-1)!;
  transferred.opening();
  await r.rerender(createElement(Composer, { chat: 'opened', main: true }));
  assert.equal(transferred.signal.aborted, false);
  await act(async () => {
    pending.resolve(undefined);
    await pending.promise;
  });
  pending = deferred();
  await command();
  const retired = attempts.at(-1)!;
  await r.unmount();
  assert.equal(retired.signal.aborted, true);
  await act(async () => {
    pending.resolve(undefined);
    await pending.promise;
  });
  const count = attempts.length;
  dispatchComposerCommand('start-voice');
  assert.equal(attempts.length, count);
});
