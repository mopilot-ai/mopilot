// Accepted queued delivery remains acknowledged after a save-triggered owner change.
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
for (const retire of ['switch', 'unmount'])
  test(`queued attachment commit followed by save-triggered ${retire} recovers exactly once`, async () => {
    const file = { kind: 'file', path: '/q.txt', name: 'q.txt' };
    let resolve!: (value: boolean) => void;
    fx.removeQueued = () =>
      new Promise<boolean>((r) => {
        resolve = r;
      });
    setSessionState('t1', { queue: [{ id: 'q', text: 'queued', attachments: [file], opts: {}, origin: null, queuedAt: 0 }] });
    store.set({ drafts: { t1: { text: 'draft', attachments: [] }, t2: { text: 'other', attachments: [] } } });
    const m = await mountComposer({ threadId: 't1' });
    let navigation: Promise<void> | undefined;
    let navigated = false;
    const stop = store.subscribe(() => {
      if (navigated || !store.get().drafts.t1.attachments.length) return;
      navigated = true;
      navigation = retire === 'switch' ? m.rerender({ threadId: 't2' }) : m.unmount();
    });
    try {
      await click($('[aria-label="Queued message actions"]'));
      await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('Edit message'))!);
      await act(async () => {
        resolve(true);
        await Promise.resolve();
        await navigation;
      });
      await settle();
      assert.equal(store.get().drafts.t1.text, 'queued\ndraft');
      assert.deepEqual(store.get().drafts.t1.attachments, [file]);
      assert.equal(store.get().drafts.t2.text, 'other');
    } finally {
      stop();
      if (retire === 'switch') await m.unmount();
    }
  });

test('two equal accepted messages have distinct receipts and both survive reverse settlement', async () => {
  const file = { kind: 'file', path: '/q.txt', name: 'q.txt' };
  const pending = new Map<string, (value: boolean) => void>();
  fx.removeQueued = (_id: string, qid: string) => new Promise<boolean>((r) => pending.set(qid, r));
  setSessionState('t1', {
    queue: ['a', 'b'].map((id) => ({ id, text: 'same', attachments: [file], opts: {}, origin: null, queuedAt: 0 })),
  });
  store.set({ drafts: { t1: { text: 'draft', attachments: [] } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const index of [0, 1]) {
      await click(document.querySelectorAll('[aria-label="Queued message actions"]')[index]);
      await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('Edit message'))!);
    }
    await act(async () => {
      pending.get('b')!(true);
      pending.get('a')!(true);
    });
    await settle();
    assert.equal(m.text, 'same\nsame\ndraft');
    await m.unmount();
    assert.deepEqual(store.get().drafts.t1.attachments, [file, file]);
  } catch (e) {
    await m.unmount();
    throw e;
  }
});

test('append delivery commits exactly once before save-triggered navigation', async () => {
  const file = { kind: 'file', path: '/edit.txt', name: 'edit.txt' };
  store.set({ drafts: { t1: { text: 'draft', attachments: [] }, t2: { text: 'other', attachments: [] } } });
  const m = await mountComposer({ threadId: 't1' });
  const { giveBackToComposer } = await import('../src/store/send.ts');
  let navigation: Promise<void> | undefined;
  let navigated = false;
  const stop = store.subscribe(() => {
    if (navigated || !store.get().drafts.t1.attachments.length) return;
    navigated = true;
    navigation = m.rerender({ threadId: 't2' });
  });
  try {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('focus-composer', { detail: { threadId: 't1' } }));
      giveBackToComposer('t1', 'edit me', [file] as any);
      await navigation;
    });
    await settle();
    assert.deepEqual(store.get().drafts.t1, { text: 'draft\nedit me', attachments: [file], goal: false });
    assert.equal(m.text, 'other');
  } finally {
    stop();
    await m.unmount();
  }
});
