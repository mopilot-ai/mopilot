// Independent adversarial tests for selection receipt during queued ownership changes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mountComposer, reset, store } from './support/composer-setup.ts';
import { act } from 'react';
beforeEach(() => reset());
for (const mode of ['raw-add', 'comment'])
  test(`pending switch preserves ${mode} without caller fallback`, async () => {
    const quote = { kind: 'selection', path: '', name: 'Annotation', text: 'owned', annotationId: 'a' };
    store.set({ drafts: { t1: { text: 'one', attachments: mode === 'comment' ? [quote] : [] }, t2: { text: 'two', attachments: [] } } });
    const m = await mountComposer({ threadId: 't1' });
    try {
      await act(async () => {
        const switching = m.rerender({ threadId: 't2' });
        window.dispatchEvent(
          new window.CustomEvent(mode === 'comment' ? 'composer-update-selection' : 'composer-add-selection', {
            detail:
              mode === 'comment'
                ? { threadId: 't1', annotationId: 'a', annotation: 'new comment' }
                : { threadId: 't1', attachment: quote, focus: false },
          }),
        );
        await switching;
      });
      assert.deepEqual(store.get().drafts.t2.attachments, []);
      assert.equal(store.get().drafts.t1.attachments.length, 1);
      if (mode === 'comment') assert.equal(store.get().drafts.t1.attachments[0].annotation, 'new comment');
    } finally {
      await m.unmount();
    }
  });

test('saved receipt followed by synchronous navigation does not duplicate fallback attachment', async () => {
  store.set({ drafts: { t1: { text: 'one', attachments: [] }, t2: { text: 'two', attachments: [] } } });
  const m = await mountComposer({ threadId: 't1' });
  const { attachToComposer } = await import('../src/session/composerAttach.ts');
  let navigated = false;
  let navigation: Promise<void> | undefined;
  const stop = store.subscribe(() => {
    if (navigated || !store.get().drafts.t1.attachments.length) return;
    navigated = true;
    navigation = m.rerender({ threadId: 't2' });
  });
  try {
    await act(async () => {
      attachToComposer('t1', { kind: 'selection', path: '', name: 'Selection', text: 'exact once' });
      await navigation;
    });
    assert.equal(store.get().drafts.t1.attachments.length, 1);
    assert.deepEqual(store.get().drafts.t2.attachments, []);
  } finally {
    stop();
    await m.unmount();
  }
});
