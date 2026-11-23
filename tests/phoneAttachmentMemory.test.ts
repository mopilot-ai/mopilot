// A chat's attachments survive its screen being rebuilt for a new connection, an upload cut off by the drop comes back failed with a retry, and an attach while the Mac is away shows a failed tile instead of nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted, fakeMedia, chunkReply } from './support/phone/m3';

import { fakeDraft } from './support/phone/drafts';
const hookPath = '../mobile/src/remote/useAttachments';
const memoryPath = '../mobile/src/remote/attachmentMemory';
const clientPath = '../mobile/src/remote/client';
const threadPath = '../mobile/src/screens/Thread';
const { useAttachments } = await import(hookPath);
const { INTERRUPTED } = await import(memoryPath);
const { ownedRequest } = await import(clientPath);
const { Thread } = await import(threadPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
/** A screen that holds attachments under `key`, as a chat does; `api()` is what the screen sees now. */
async function screen(runtime: any, key?: string) {
  let api: any;
  const Probe = () => {
    api = useAttachments(ownedRequest(runtime), key);
    return null;
  };
  const v = await mount(createElement(Probe));
  return { api: () => api, done: v.done };
}
const file = (name: string) => ({ name, mime: 'image/jpeg', base64: 'QUJD' });

test('attachments come back after the screen is rebuilt, with what the Mac confirmed, and later picks do not reuse a key', async () => {
  const { runtime } = scripted(() => undefined);
  const first = await screen(runtime, 'u:p:c1');
  await act(async () => first.api().add(file('a.jpg')));
  await flush();
  assert.equal(first.api().items[0].state, 'done');
  await first.done();

  const again = await screen(runtime, 'u:p:c1');
  assert.deepEqual(
    again.api().items.map((i: any) => [i.file.name, i.state, i.id]),
    [['a.jpg', 'done', '0123456789abcdef']],
  );
  await act(async () => again.api().add(file('b.jpg')));
  await flush();
  const keys = again.api().items.map((i: any) => i.key);
  assert.equal(new Set(keys).size, 2, 'the new file has a key of its own');
  await again.done();

  // another chat has its own
  const other = await screen(runtime, 'u:p:c2');
  assert.deepEqual(other.api().items, []);
  await other.done();
});

test('a removal or a sent message forgets them, and a screen with no key keeps nothing', async () => {
  const { runtime } = scripted(() => undefined);
  const a = await screen(runtime, 'forget');
  await act(async () => a.api().add(file('a.jpg')));
  await flush();
  await act(async () => a.api().add(file('b.jpg')));
  await flush();
  await act(async () => a.api().remove(a.api().items[0].key));
  await a.done();
  const b = await screen(runtime, 'forget');
  assert.deepEqual(
    b.api().items.map((i: any) => i.file.name),
    ['b.jpg'],
  );
  await act(async () => b.api().clear());
  await b.done();
  const c = await screen(runtime, 'forget');
  assert.deepEqual(c.api().items, [], 'a sent message left nothing behind');
  await c.done();

  const loose = await screen(runtime);
  await act(async () => loose.api().add(file('a.jpg')));
  await flush();
  await loose.done();
  const next = await screen(runtime);
  assert.deepEqual(next.api().items, []);
  await next.done();
});

test('an upload cut off by the rebuild comes back failed with its reason, and retry sends it again', async () => {
  const { runtime, calls } = scripted((m, p) => (m === 'chat.attach' ? new Promise(() => {}) : undefined));
  const cut = await screen(runtime, 'cut');
  await act(async () => cut.api().add(file('a.jpg')));
  assert.equal(cut.api().items[0].state, 'sending');
  await cut.done();

  const { runtime: back, calls: backCalls } = scripted((m, p) => (m === 'chat.attach' ? chunkReply(p) : undefined));
  const again = await screen(back, 'cut');
  assert.deepEqual(
    again.api().items.map((i: any) => [i.state, i.error]),
    [['failed', INTERRUPTED]],
  );
  assert.equal(calls.filter((c) => c[0] === 'chat.attach').length, 1);
  await act(async () => again.api().retry(again.api().items[0].key));
  await flush();
  assert.equal(again.api().items[0].state, 'done');
  assert.equal(backCalls.filter((c) => c[0] === 'chat.attach').length, 1);
  await again.done();
});

const follow = { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] };

test('in a chat, a photo attached while the Mac is away shows a failed tile with Retry and Remove, and it is still there after the screen is rebuilt', async () => {
  const { runtime } = scripted((m) => {
    if (m === 'chat.follow') return follow;
    if (m === 'chat.attach') throw new Error('Your computer is offline or asleep.');
    return undefined;
  });
  const chat = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      historyKey: 'u:p:c',
      back: () => {},
      drafts: fakeDraft(''),
      media: fakeMedia().media,
    });
  const v = await mount(chat());
  await click('Add to session');
  await click('Photos');
  assert.ok(document.querySelector('[aria-label="photo.jpg, failed: Your computer is offline or asleep."]'));
  assert.ok(document.querySelector('button[aria-label="Retry upload of photo.jpg"]'));
  assert.ok(document.querySelector('button[aria-label="Remove photo.jpg"]'));
  await v.done();

  // the connection changed: the chat is built again, and the tile is still there
  const rebuilt = await mount(chat());
  assert.ok(document.querySelector('[aria-label^="photo.jpg, failed"]'));
  await click('Remove photo.jpg');
  assert.equal(document.querySelector('[aria-label^="photo.jpg"]'), null);
  await rebuilt.done();
});
