// Real Composer and QueuedList must restore an asynchronously removed message without losing current drafts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { Composer, fx, last, mountComposer, reset, setSessionState, settle, store } from './support/composer-setup.ts';
beforeEach(() => {
  reset();
  fx.realQueuedList = true;
});
const queued = { id: 'q', text: 'queued text', attachments: [], opts: {}, origin: null, queuedAt: 0 };
async function beginEdit() {
  let resolve!: (value: boolean) => void;
  fx.removeQueued = () => new Promise<boolean>((r) => (resolve = r));
  setSessionState('t1', { queue: [queued] });
  const m = await mountComposer({ threadId: 't1' });
  await m.type('first draft');
  await click($('[aria-label="Queued message actions"]'));
  await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('Edit message'))!);
  return { m, resolve };
}
test('editing a queued message preserves text typed while removal is pending', async () => {
  const { m, resolve } = await beginEdit();
  try {
    await m.type('new draft while waiting');
    await act(async () => resolve(true));
    await settle();
    assert.equal(m.text, 'queued text\nnew draft while waiting');
  } finally {
    await m.unmount();
  }
});
test('editing a queued message while switching chats preserves the other chat draft', async () => {
  const { m, resolve } = await beginEdit();
  try {
    store.set((s: any) => ({ drafts: { ...s.drafts, t2: { text: 'other chat draft', attachments: [] } } }));
    await m.rerender({ threadId: 't2' });
    await settle();
    assert.equal(m.text, 'other chat draft');
    await act(async () => resolve(true));
    await settle();
    assert.equal(m.text, 'other chat draft');
    assert.equal(store.get().drafts.t1.text, 'queued text\nfirst draft');
  } finally {
    await m.unmount();
  }
});

test('accepted queue edit after composer unmount goes to its saved draft', async () => {
  const { m, resolve } = await beginEdit();
  await m.unmount();
  await act(async () => resolve(true));
  await settle();
  assert.equal(store.get().drafts.t1.text, 'queued text\nfirst draft');
});

test('attachments added while queue removal is pending survive with queued attachments', async () => {
  queued.attachments = [{ kind: 'file', path: '/queued.txt', name: 'queued.txt' }] as any;
  const { m, resolve } = await beginEdit();
  try {
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('composer-insert', {
          detail: { threadId: 't1', text: '', attachments: [{ kind: 'file', path: '/new.txt', name: 'new.txt' }] },
        }),
      ),
    );
    await settle();
    await act(async () => resolve(true));
    await settle();
    assert.deepEqual(
      [...document.querySelectorAll('.attachment-name')].map((e) => e.textContent),
      ['queued.txt', 'new.txt'],
    );
  } finally {
    await m.unmount();
    queued.attachments = [];
  }
});

test('two accepted queue edits settling in reverse preserve both messages and current typing', async () => {
  const pending = new Map<string, (value: boolean) => void>();
  fx.removeQueued = (_id: string, qid: string) => new Promise<boolean>((r) => pending.set(qid, r));
  setSessionState('t1', {
    queue: [
      { ...queued, id: 'a', text: 'A' },
      { ...queued, id: 'b', text: 'B' },
    ],
  });
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const index of [0, 1]) {
      await click(document.querySelectorAll('[aria-label="Queued message actions"]')[index]);
      await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('Edit message'))!);
    }
    await m.type('latest');
    await act(async () => {
      pending.get('b')!(true);
      pending.get('a')!(true);
    });
    await settle();
    assert.equal(m.text, 'A\nB\nlatest');
  } finally {
    await m.unmount();
  }
});

test('missing or rejected queue removal leaves current input unchanged and rejection is reported', async () => {
  for (const fail of [false, true]) {
    reset();
    fx.realQueuedList = true;
    fx.removeQueued = async () => {
      if (fail) throw new Error('offline');
      return false;
    };
    setSessionState('t1', { queue: [queued] });
    const m = await mountComposer({ threadId: 't1' });
    try {
      await m.type('keep me');
      await click($('[aria-label="Queued message actions"]'));
      await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('Edit message'))!);
      await settle();
      assert.equal(m.text, 'keep me');
      if (fail) assert.deepEqual(last('toast'), ['toast', 'Could not remove queued message: Offline.', 'error']);
    } finally {
      await m.unmount();
      queued.attachments = [];
    }
  }
});

test('ordinary composer insertion still appends to empty text and existing trailing newline', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const before of ['', 'existing\n']) {
      await m.type(before);
      await act(async () => window.dispatchEvent(new CustomEvent('composer-insert', { detail: { threadId: 't1', text: 'inserted' } })));
      await settle();
      assert.equal(m.text, before + 'inserted');
    }
  } finally {
    await m.unmount();
  }
});

test('pending Edit does not alter new-chat draft or routing after switching home', async () => {
  const { m, resolve } = await beginEdit();
  try {
    await act(async () =>
      store.set((s: any) => ({
        drafts: { ...s.drafts, home: { text: 'new chat', attachments: [] } },
        newHarness: 'claude',
        newChatCwd: '/other',
      })),
    );
    await m.rerender({ threadId: null, variant: 'home' });
    await act(async () => resolve(true));
    await settle();
    assert.equal(m.text, 'new chat');
    assert.equal(store.get().drafts.t1.text, 'queued text\nfirst draft');
    assert.equal(store.get().newHarness, 'claude');
    assert.equal(store.get().newChatCwd, '/other');
  } finally {
    await m.unmount();
  }
});

test('accepted queue removal stays durable when composer retires before its next React commit', async () => {
  const { m, resolve } = await beginEdit();
  await act(async () => {
    resolve(true);
    await Promise.resolve();
    await m.unmount();
  });
  assert.equal(store.get().drafts.t1.text, 'queued text\nfirst draft');
});

test('queue recovery survives a pending chat-prop switch in either completion order', async () => {
  for (const switchFirst of [false, true]) {
    reset();
    fx.realQueuedList = true;
    const originalAttachment = { kind: 'file', path: '/original.txt', name: 'original.txt' };
    const queuedAttachment = { kind: 'file', path: '/queued.txt', name: 'queued.txt' };
    queued.attachments = [queuedAttachment] as any;
    const { m, resolve } = await beginEdit();
    try {
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent('composer-insert', { detail: { threadId: 't1', text: '', attachments: [originalAttachment] } }),
        ),
      );
      store.set((s: any) => ({ drafts: { ...s.drafts, t2: { text: 'other', attachments: [] } } }));
      await act(async () => {
        if (switchFirst) {
          m.renderInsideAct(createElement(Composer, { threadId: 't2', variant: 'thread' }));
          resolve(true);
          await Promise.resolve();
        } else {
          resolve(true);
          await Promise.resolve();
          m.renderInsideAct(createElement(Composer, { threadId: 't2', variant: 'thread' }));
        }
      });
      await settle();
      assert.equal(m.text, 'other');
      assert.deepEqual(
        store.get().drafts.t1,
        { text: 'queued text\nfirst draft\n', attachments: [queuedAttachment, originalAttachment], goal: false },
        `switchFirst=${switchFirst}`,
      );
    } finally {
      await m.unmount();
      queued.attachments = [];
    }
  }
});
