// Selection delivery ownership when a mounted composer disappears before its next React commit.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mountComposer, reset, store } from './support/composer-setup.ts';
import { act } from 'react';
beforeEach(() => reset());
test('accepted selection survives immediate unmount before React commits', async () => {
  store.set({ drafts: { t1: { text: 'question', attachments: [] } } });
  const m = await mountComposer({ threadId: 't1' });
  const detail = { threadId: 't1', text: 'quoted passage', handled: false };
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('composer-add-selection', { detail }));
    assert.equal(detail.handled, true);
    await m.unmount();
  });
  assert.deepEqual(
    store.get().drafts.t1.attachments.map((a: any) => a.text),
    ['quoted passage'],
  );
});

test('two selections and a comment edit survive immediate unmount in their accepted order', async () => {
  store.set({ drafts: { t1: { text: 'question', attachments: [] } } });
  const m = await mountComposer({ threadId: 't1' });
  await act(async () => {
    for (const [id, text] of [
      ['a', 'first'],
      ['b', 'second'],
    ]) {
      window.dispatchEvent(
        new window.CustomEvent('composer-add-selection', {
          detail: { threadId: 't1', attachment: { kind: 'selection', path: '', name: 'Annotation', text, annotationId: id } },
        }),
      );
    }
    window.dispatchEvent(
      new window.CustomEvent('composer-update-selection', { detail: { threadId: 't1', annotationId: 'a', annotation: 'explain' } }),
    );
    window.dispatchEvent(
      new window.CustomEvent('composer-update-selection', { detail: { threadId: 'other', annotationId: 'a', annotation: 'wrong' } }),
    );
    await m.unmount();
  });
  assert.deepEqual(
    store.get().drafts.t1.attachments.map((a: any) => [a.text, a.annotation]),
    [
      ['first', 'explain'],
      ['second', undefined],
    ],
  );
  assert.equal(store.get().drafts.t1.text, 'question');
});

for (const switchFirst of [true, false])
  test(`attachment delivery and pending chat switch preserve origin (switch first: ${switchFirst})`, async () => {
    store.set({ drafts: { t1: { text: 'one', attachments: [] }, t2: { text: 'two', attachments: [] } } });
    const { attachToComposer } = await import('../src/session/composerAttach.ts');
    const m = await mountComposer({ threadId: 't1' });
    try {
      await act(async () => {
        let switching: Promise<void> | undefined;
        if (switchFirst) switching = m.rerender({ threadId: 't2' });
        attachToComposer('t1', { kind: 'selection', path: '', name: 'Selection', text: 'owned quote' });
        if (!switchFirst) switching = m.rerender({ threadId: 't2' });
        await switching;
      });
      assert.deepEqual(
        store.get().drafts.t1.attachments.map((a: any) => a.text),
        ['owned quote'],
      );
      assert.deepEqual(store.get().drafts.t2.attachments, []);
      assert.equal(m.text, 'two');
    } finally {
      await m.unmount();
    }
  });

test('stored fallback creates home and chat drafts for uncommitted deliveries', async () => {
  const { retainComposerAttachment, retainComposerAnnotation } = await import('../src/session/composerAttach.ts');
  const quote = { kind: 'selection' as const, path: '', name: 'Annotation', text: 'quote', annotationId: 'id' };
  retainComposerAttachment(null, quote);
  retainComposerAnnotation(null, 'id', 'note');
  assert.equal(store.get().drafts.home.attachments.length, 1);
  assert.equal(store.get().drafts.home.attachments[0].annotation, 'note');
  retainComposerAnnotation('missing', 'id', 'ignored');
  assert.equal(store.get().drafts.missing, undefined);
  store.set({ drafts: { empty: { text: 'keep' } } });
  retainComposerAnnotation('empty', 'missing', 'ignored');
  retainComposerAttachment('empty', quote);
  assert.equal(store.get().drafts.empty.text, 'keep');
  assert.equal(store.get().drafts.empty.attachments.length, 1);
});

test('independent no-listener attachment calls preserve repeated user additions', async () => {
  const { attachToComposer } = await import('../src/session/composerAttach.ts');
  const quote = { kind: 'selection' as const, path: '', name: 'Selection', text: 'again' };
  attachToComposer('closed', quote);
  attachToComposer('closed', quote);
  assert.equal(store.get().drafts.closed.attachments.length, 2);
});

test('deleting an annotation drops it from the open composer and its stored draft, never from another chat', async () => {
  const { deleteComposerAnnotation, removeComposerAnnotation } = await import('../src/session/composerAttach.ts');
  const quote = (annotationId: string) => ({ kind: 'selection' as const, path: '', name: 'Annotation', text: annotationId, annotationId });
  store.set({ drafts: { t1: { text: 'question', attachments: [quote('a'), quote('b')] }, t2: { text: '', attachments: [quote('a')] } } });
  const m = await mountComposer({ threadId: 't1' });
  // outside act, flushSync commits the open composer's removal at once
  window.dispatchEvent(new window.CustomEvent('composer-remove-selection', { detail: { threadId: 'other', annotationId: 'b' } }));
  window.dispatchEvent(new window.CustomEvent('composer-remove-selection', { detail: { threadId: 't1', annotationId: 'a' } }));
  await act(async () => {});
  assert.deepEqual(
    store.get().drafts.t1.attachments.map((a: any) => a.annotationId),
    ['b'],
    'the open composer drops it at once',
  );
  assert.equal(store.get().drafts.t2.attachments.length, 1, 'the same id in another chat stays');
  // a composer switching to another chat before it commits the removal leaves it to the stored draft
  await act(async () => {
    const switching = m.rerender({ threadId: 't2' });
    window.dispatchEvent(new window.CustomEvent('composer-remove-selection', { detail: { threadId: 't1', annotationId: 'b' } }));
    await switching;
  });
  assert.deepEqual(store.get().drafts.t1.attachments, []);
  await m.unmount();
  assert.equal(store.get().drafts.t1.text, 'question');
  // with no composer open, the stored draft alone; a chat without a draft has nothing to remove
  deleteComposerAnnotation('t2', 'a');
  assert.deepEqual(store.get().drafts.t2.attachments, []);
  removeComposerAnnotation('missing', 'a');
  assert.equal(store.get().drafts.missing, undefined);
  store.set({ drafts: { home: { text: '' } } });
  removeComposerAnnotation(null, 'a');
  assert.deepEqual(store.get().drafts.home.attachments, []);
});
