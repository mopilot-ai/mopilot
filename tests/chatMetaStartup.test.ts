// Startup metadata subscriptions retain changes around a snapshot and retire failed reads before a retry.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { loadStore, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});

test('a linked session created after the boot snapshot keeps its initial title when the window finishes loading', async () => {
  delete listeners['chats.onChanged'];
  delete listeners['chats.onReset'];
  const chat = { kind: 'codex', segments: null, meta: { initialTitle: 'Title while reloading' } };
  let listeningAtAnnouncement = false;
  bootImpls({
    'codex.used': async () => true,
    'api.threadList': async () => ({ data: [{ id: 'during-boot', name: null, preview: '' }], nextCursor: null }),
    'app.info': async () => {
      listeningAtAnnouncement = typeof listeners['chats.onChanged'] === 'function';
      listeners['chats.onChanged']?.({ id: 'during-boot', chat });
      return { home: '/home/me', dark: false, codexHome: '/home/me/.codex' };
    },
  });
  await S.boot();
  await flush();
  assert.equal(listeningAtAnnouncement, true);
  assert.equal(S.threadTitle(st().threads['during-boot']), 'Title while reloading');
  listeners['chats.onChanged']({ id: 'during-boot', chat: { ...chat, meta: { initialTitle: 'Title after loading' } } });
  assert.equal(S.threadTitle(st().threads['during-boot']), 'Title after loading');
});

test('live metadata and resets received while a boot snapshot waits retain their order over its stale answer', async () => {
  for (const resetLast of [false, true]) {
    resetState();
    delete listeners['chats.onChanged'];
    delete listeners['chats.onReset'];
    const read = deferred<any>();
    const row = (title: string) => ({ kind: 'codex', segments: null, meta: { initialTitle: title } });
    bootImpls({ 'chats.snapshot': () => read.promise });
    const boot = S.boot({ quickChat: true });
    await flush();
    const subscribed = !!listeners['chats.onChanged'] && !!listeners['chats.onReset'];
    const changed = () => listeners['chats.onChanged']?.({ id: 'c', chat: row('Live task') });
    const reset = () => listeners['chats.onReset']?.({ chats: { c: row('Reset task') }, newer: [] });
    if (resetLast) {
      changed();
      reset();
    } else {
      reset();
      changed();
    }
    read.resolve({ chats: { c: row('Stale snapshot') }, newer: [] });
    await boot;
    assert.equal(subscribed, true);
    assert.equal(S.threadTitle({ id: 'c', name: null, preview: '' } as any), resetLast ? 'Reset task' : 'Live task');
  }
});

test('a synchronous subscription catch-up cannot replay older metadata over the requested snapshot', async () => {
  bootImpls({
    'chats.onChanged': (changed: any) => {
      changed({ id: 'c', chat: { kind: 'codex', meta: { initialTitle: 'Before the request' } } });
      return () => {};
    },
    'chats.snapshot': async () => ({ chats: { c: { kind: 'codex', meta: { initialTitle: 'Snapshot title' } } }, newer: [] }),
  });
  await S.boot({ quickChat: true });
  assert.equal(S.threadTitle({ id: 'c', name: null, preview: '' } as any), 'Snapshot title');
});

test('a failed snapshot or app-info read unsubscribes, drops late callbacks, and leaves a successful retry usable', async () => {
  for (const failed of ['chats.snapshot', 'app.info']) {
    resetState();
    let stopped = 0;
    bootImpls({
      'chats.onChanged': () => () => stopped++,
      'chats.onReset': () => () => stopped++,
      [failed]: async () => {
        throw new Error('boot read failed');
      },
    });
    await assert.rejects(S.boot({ quickChat: true }), /boot read failed/);
    assert.equal(stopped, 2);
    const lateChange = listeners['chats.onChanged'];
    const lateReset = listeners['chats.onReset'];
    bootImpls({
      'chats.snapshot': async () => ({ chats: { c: { kind: 'codex', meta: { initialTitle: 'Retry title' } } }, newer: [] }),
    });
    await S.boot({ quickChat: true });
    lateChange({ id: 'c', chat: { kind: 'codex', meta: { initialTitle: 'Retired title' } } });
    lateReset({ chats: {}, newer: [] });
    assert.equal(S.threadTitle({ id: 'c', name: null, preview: '' } as any), 'Retry title');
  }
});
