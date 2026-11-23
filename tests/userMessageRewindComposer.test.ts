// Sent-message rewind returns input to its original draft after its message view retires.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, assertOriginRestored, reset, startRewind, store } from './support/user-message-rewind-kit.ts';

beforeEach(() => reset());
for (const destination of ['disposed', 'other chat', 'mounted'])
  test(`real Composer rewind recovery after ${destination} preserves originating input exactly once`, async () => {
    const { composer, view, rewound } = await startRewind();
    if (destination === 'disposed') await composer.unmount();
    if (destination === 'other chat') {
      store.set((s: any) => ({ drafts: { ...s.drafts, other: { text: 'other draft', attachments: [] } } }));
      await composer.rerender({ threadId: 'other' });
    }
    await view.unmount();
    await act(async () => rewound());
    if (destination === 'mounted') assert.equal(composer.text, 'draft\nedit me');
    if (destination === 'other chat') assert.equal(composer.text, 'other draft');
    if (destination !== 'disposed') await composer.unmount();
    assertOriginRestored();
  });
