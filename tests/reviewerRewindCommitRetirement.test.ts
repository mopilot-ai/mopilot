// Sent-message rewind returns input to its original draft when the Composer navigates away while the draft is saved.
import { test, beforeEach } from 'node:test';
import { act, assertOriginRestored, reset, startRewind, store } from './support/user-message-rewind-kit.ts';

beforeEach(() => reset());
test('real Composer rewind recovery after save navigation preserves originating input exactly once', async () => {
  const { composer, view, rewound } = await startRewind();
  await view.unmount();
  // the Composer moves to another chat in the same update that saves the quote into the origin's draft
  let navigation: Promise<void> | undefined;
  let navigated = false;
  const stop = store.subscribe(() => {
    if (navigated || !store.get().drafts.origin.attachments.length) return;
    navigated = true;
    navigation = composer.rerender({ threadId: 'other' });
  });
  await act(async () => {
    rewound();
    await Promise.resolve();
    await navigation;
  });
  stop();
  await composer.unmount();
  assertOriginRestored();
});
