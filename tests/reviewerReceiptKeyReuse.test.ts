// A prior committed receipt cannot acknowledge a distinct delivery after reusing a chat key.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { Composer, mountComposer, reset, settle, store } from './support/composer-setup.ts';
beforeEach(() => reset());
for (const prepend of [false, true])
  test(`reused chat key retains independent identical writes with pending switch prepend=${prepend}`, async () => {
    store.set({ drafts: { t1: { text: 'draft', attachments: [] }, t2: { text: 'other', attachments: [] } } });
    const m = await mountComposer({ threadId: 't1' });
    const { giveBackToComposer } = await import('../src/store/send.ts');
    const file = { kind: 'file', name: 'same', path: '/same' };
    try {
      await act(async () => giveBackToComposer('t1', 'same', [file] as any, prepend));
      await m.rerender({ threadId: 't2' });
      await m.rerender({ threadId: 't1' });
      await act(async () => {
        m.renderInsideAct(createElement(Composer, { threadId: 't2', variant: 'thread' }));
        giveBackToComposer('t1', 'same', [file] as any, prepend);
      });
      await settle();
      assert.equal(store.get().drafts.t1.text, prepend ? 'same\nsame\ndraft' : 'draft\nsame\nsame');
      assert.deepEqual(store.get().drafts.t1.attachments, [file, file]);
      assert.equal(m.text, 'other');
      assert.deepEqual(store.get().drafts.t2.attachments, []);
    } finally {
      await m.unmount();
    }
  });
