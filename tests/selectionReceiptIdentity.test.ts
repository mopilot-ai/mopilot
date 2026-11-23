// Distinct selection deliveries must survive retirement even when their payload object is shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import '../tests/support/dom.ts';
import { Composer, reset, mountComposer, settle, store } from '../tests/support/composer-setup.ts';
for (const reusedKey of [false, true])
  test(`independent same-object selection survives pending switch (reused key: ${reusedKey})`, async () => {
    reset();
    const file = { kind: 'file', path: '/q', name: 'q' };
    const { attachToComposer } = await import('../src/session/composerAttach.ts');
    const m = await mountComposer({ threadId: 't1' });
    try {
      await act(async () => attachToComposer('t1', file as any));
      await settle();
      if (reusedKey) {
        await m.rerender({ threadId: 't2' });
        await m.rerender({ threadId: 't1' });
      }
      await act(async () => {
        m.renderInsideAct(createElement(Composer, { threadId: 't2', variant: 'thread' }));
        attachToComposer('t1', file as any);
      });
      await settle();
      assert.deepEqual(store.get().drafts.t1.attachments, [file, file]);
    } finally {
      await m.unmount();
    }
  });
