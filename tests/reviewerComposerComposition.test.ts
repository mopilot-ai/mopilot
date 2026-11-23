// Independent audit of queued Edit and selection delivery composition.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { fx, mountComposer, reset, setSessionState, settle, store } from './support/composer-setup.ts';

beforeEach(() => {
  reset();
  fx.realQueuedList = true;
});
for (const selectionFirst of [true, false])
  for (const retirement of ['none', 'switch', 'unmount']) {
    test(`queued Edit plus selection preserves ordering: selectionFirst=${selectionFirst}, retirement=${retirement}`, async () => {
      const file = { kind: 'file', path: '/q.txt', name: 'q.txt' };
      const quote = { kind: 'selection', path: '', name: 'Annotation', text: 'quote', annotationId: 'annotation' };
      let resolve!: (value: boolean) => void;
      fx.removeQueued = () =>
        new Promise<boolean>((r) => {
          resolve = r;
        });
      setSessionState('t1', { queue: [{ id: 'q', text: 'queued', attachments: [file], opts: {}, origin: null, queuedAt: 0 }] });
      store.set({ drafts: { t1: { text: 'draft', attachments: [] }, t2: { text: 'other', attachments: [] } } });
      const m = await mountComposer({ threadId: 't1' });
      const { attachToComposer } = await import('../src/session/composerAttach.ts');
      let unmounted = false;
      try {
        await click($('[aria-label="Queued message actions"]'));
        await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('Edit message'))!);
        await m.type('latest typing');
        await act(async () => {
          if (selectionFirst) attachToComposer('t1', quote as any, { focus: false });
          resolve(true);
          await Promise.resolve();
          if (!selectionFirst) attachToComposer('t1', quote as any, { focus: false });
          window.dispatchEvent(
            new CustomEvent('composer-update-selection', { detail: { threadId: 't1', annotationId: 'annotation', annotation: 'comment' } }),
          );
          if (retirement === 'switch') await m.rerender({ threadId: 't2' });
          if (retirement === 'unmount') {
            await m.unmount();
            unmounted = true;
          }
        });
        await settle();
        if (!unmounted) {
          await m.unmount();
          unmounted = true;
        }
        assert.equal(store.get().drafts.t1.text, 'queued\nlatest typing');
        assert.deepEqual(store.get().drafts.t1.attachments, [file, { ...quote, annotation: 'comment' }]);
        assert.equal(store.get().drafts.t2.text, 'other');
        assert.deepEqual(store.get().drafts.t2.attachments, []);
      } finally {
        if (!unmounted) await m.unmount();
      }
    });
  }
