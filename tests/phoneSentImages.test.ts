// Image previews retain send identity through optimistic rows, duplicate image-only sends and the New chat image-only submit boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click, flush } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, attach, button } from './support/phone/newchat-kit';
import { fakeDraft } from './support/phone/drafts';
const sentPath = '../mobile/src/presentation/sentMessages';
const rowsPath = '../mobile/src/presentation/thread';
const { withSent, waitingForRecord, settled, linkHeld } = await import(sentPath);
const { withPendingRows } = await import(rowsPath);
const picture = 'file:///picked-preview.jpg';

test('optimistic rows carry completed pictures under their send id instead of losing them when the composer clears', () => {
  const pending = withSent([], [], 'look', 'send-image', [], [picture]);
  assert.deepEqual(pending[0].pictures, [picture]);
  const [row] = withPendingRows([], pending);
  assert.deepEqual(row.pictures, [picture]);
  assert.equal(row.key, 'sent:send-image');
});

test('empty user and compaction rows cannot consume an image-only send; duplicate pictures settle one record at a time', () => {
  const first = withSent([], [], '', 'image-one', [], [picture], 'native-one');
  const both = withSent(first, [], '', 'image-two', [], [picture], 'native-two');
  const unrelated = [
    { role: 'user', text: '', images: 0, key: 'empty' },
    { role: 'step', text: '', images: 1, key: 'compact' },
  ];
  assert.equal(waitingForRecord(both, unrelated).length, 2);
  const once = [...unrelated, { role: 'user', text: '', images: 1, key: 'record-one', clientId: 'native-one' }];
  const left = settled(both, once);
  assert.equal(left.length, 1);
  assert.equal(left[0].id, 'image-two');
  assert.deepEqual(left[0].pictures, [picture]);
  assert.equal(waitingForRecord(left, once).length, 1, 'a consumed record cannot satisfy the next identical send');
  assert.equal(settled(left, [...once, { role: 'user', text: '', images: 1, key: 'record-two', clientId: 'native-two' }]).length, 0);
});

test('an unrelated empty Mac queue entry does not steal the image-only send identity', () => {
  const pending = withSent([], [], '', 'phone-image', [], [picture], 'mac-image');
  assert.equal(linkHeld(pending, [{ id: 'unrelated', text: '', attached: 0, images: 0 }])[0].remoteId, undefined);
  assert.equal(linkHeld(pending, [{ id: 'mac-image', text: '', attached: 1, images: 1 }])[0].remoteId, 'mac-image');
});

test('New chat enables and sends an uploaded image without text, carrying the same local preview to its first bubble', async () => {
  const { runtime, calls } = scripted((method) => (method === 'chat.start' ? { chatId: 'claude:new-image' } : undefined));
  const view = await mount(runtime, fakeMedia({ library: { name: 'picked.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: picture } }).media);
  await attach('Photo library');
  await flush();
  assert.equal(button(view.host, 'Start chat')!.disabled, false);
  await click('Start chat');
  const request = calls.find(([method]) => method === 'chat.start')![1];
  assert.equal(request.text, '');
  assert.deepEqual(request.attachments, ['0123456789abcdef']);
  assert.deepEqual((view.sents[0] as any).pictures, [picture]);
});

test('readiness requires every attachment to finish, uses the shared URI conversion and sends a finished file without words, as the app’s composer does', async () => {
  const path = '../mobile/src/presentation/messagePictures';
  const { messageReady, messagePictures, pictureSource, startReady } = await import(path);
  const image: any = { key: 1, id: 'image', state: 'done', file: { name: 'photo.jpg', mime: 'image/jpeg', uri: picture, base64: 'QUJD' } };
  assert.equal(messageReady('', []), false);
  assert.equal(messageReady('hello', []), true);
  assert.equal(messageReady('', [image]), true);
  assert.deepEqual(messagePictures([image]), [picture]);
  assert.equal(pictureSource({ name: 'x', mime: 'image/png', base64: 'QUJD' }), 'data:image/png;base64,QUJD');
  for (const state of ['sending', 'failed', 'cancelled']) assert.equal(messageReady('hello', [{ ...image, state }]), false);
  assert.equal(messageReady('hello', [{ ...image, id: null }]), false);
  const doc = { ...image, file: { name: 'notes.txt', mime: 'text/plain', base64: 'QUJD' } };
  assert.equal(messageReady('', [doc]), true, 'files without words are a message');
  assert.equal(messageReady('', [{ ...doc, state: 'sending' }]), false);
  assert.equal(messageReady('read this', [doc]), true);
  assert.deepEqual(messagePictures([doc]), []);
  assert.equal(startReady('', [doc], false), true);
  assert.equal(startReady('', [doc], true), false, 'a machine has none of this Mac’s files');
  assert.equal(startReady('', [image], true), true);
  assert.equal(startReady('words', [doc], true), true);
});

test('a refused image-only start restores the same uploaded tile, and retry keeps the start id and picture', async () => {
  let refused = true;
  const { runtime, calls } = scripted((method) => {
    if (method !== 'chat.start') return undefined;
    if (refused) throw new Error('The Host refused this image.');
    return { chatId: 'claude:retry-image' };
  });
  const view = await mount(runtime, fakeMedia({ library: { name: 'picked.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: picture } }).media);
  await attach('Photo library');
  await click('Start chat');
  await flush();
  assert.match(view.host.textContent!, /The Host refused this image/);
  assert(view.host.querySelector('img[src="file:///picked-preview.jpg"]'));
  assert.equal(button(view.host, 'Start chat')!.disabled, false);
  refused = false;
  await click('Start chat');
  const requests = calls.filter(([method]) => method === 'chat.start').map(([, params]) => params);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].startId, requests[1].startId);
  assert.deepEqual(requests[0].attachments, requests[1].attachments);
  assert.deepEqual((view.sents[0] as any).pictures, [picture]);
});

test('Mac queue projection keeps only an image count and the original send identity, never paths or bytes', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { viewOf } = require('../electron/remote/sessionView.cjs');
  const projected = viewOf({
    queue: [
      {
        id: 'image-send',
        text: '',
        attachments: [
          { kind: 'image', path: '/private/image.png', data: 'secret-bytes' },
          { kind: 'file', path: '/private/doc' },
        ],
      },
    ],
  });
  assert.deepEqual(projected.queue, [{ id: 'image-send', text: '', mine: true, attached: 2, images: 1 }]);
  assert.equal(JSON.stringify(projected).includes('/private'), false);
  assert.equal(JSON.stringify(projected).includes('secret-bytes'), false);
});

test('live outbox previews survive screen replacement, stay out of requests and disk, and leave with their exact pair', async () => {
  const path = '../mobile/src/outbox';
  const { createOutbox, savedItems, sendParams, restoreItems } = await import(path);
  let items: any[] = [],
    sequence = 0;
  const box = createOutbox({
    online: () => false,
    ready: async () => true,
    idempotent: () => true,
    lost: () => false,
    send: async () => {},
    newId: () => `image-send-${++sequence}`,
    now: () => 1,
    identity: () => 'd7f37c3d-7828-59d4-af24-c05881aac92c',
    onChange: (next: any[]) => (items = next),
  });
  const input = { pairId: 'pair-one', chatId: 'chat', text: '', attachments: ['opaque-upload'] };
  const first = box.add(input, [picture]);
  const second = box.add(input, [picture]);
  box.add({ ...input, pairId: 'pair-two' }, [picture]);
  assert.notEqual(first, second);
  assert.deepEqual(items[0].pictures, [picture]);
  assert.equal(items[0].nativeId, 'd7f37c3d-7828-59d4-af24-c05881aac92c', 'identity exists in the first published state');
  assert.equal(JSON.stringify(sendParams(items[0])).includes(picture), false);
  const saved = savedItems(items);
  assert.equal(JSON.stringify(saved).includes(picture), false);
  const restored = restoreItems(saved, { now: 1, pairs: new Set(['pair-one', 'pair-two']) })[0];
  assert.equal(restored.pictures, undefined);
  assert.equal(restored.nativeId, items[0].nativeId);
  assert.equal(restored.images, 1);
  box.drop('pair-one');
  assert.equal(items.length, 1);
  assert.equal(items[0].pairId, 'pair-two');
  box.clear();
  assert.deepEqual(items, []);
});

async function chat() {
  const threadPath = '../mobile/src/screens/Thread';
  const { Thread } = await import(threadPath);
  const { withOutbox } = await import('./support/phone/outbox-kit');
  const scriptedRuntime = scripted((method) => (method === 'messages.image' ? { data: 'eA==', width: 1, height: 1 } : undefined));
  const runtime = scriptedRuntime.runtime;
  const base = runtime.snapshot;
  runtime.snapshot = () => {
    const { outbox: _outbox, ...rest } = base();
    return rest;
  };
  let event: (value: any) => void = () => {};
  runtime.onEvent = (fn: any) => {
    event = fn;
    return () => {};
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let key = 'first';
  const box = withOutbox(runtime, { online: () => false, notify: () => root.render(render()) });
  const media = fakeMedia({ library: { name: 'picked.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: picture } }).media;
  const render = () =>
    createElement(Thread, {
      key,
      runtime,
      chatId: 'image-chat',
      queued: runtime.snapshot().outbox,
      media,
      back() {},
      drafts: fakeDraft(''),
    });
  await act(async () => root.render(render()));
  await flush();
  return {
    host,
    runtime,
    box,
    record: async (items: any[], feedSeq: number) => {
      await act(async () => event({ ev: 'items.append', chatId: 'image-chat', feedSeq, items }));
      await frameWindow();
      await flush();
    },
    patch: async (patch: any) => {
      await act(async () => event({ ev: 'session.patch', chatId: 'image-chat', rev: 2, patch }));
      await frameWindow();
      await flush();
    },
    remount: async () => {
      key = 'replacement';
      await act(async () => root.render(render()));
      await flush();
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
/** An event right after another is shown when the feed's frame window ends (followFeed's FRAME_MS): the test waits that out. */
const frameWindow = () => act(async () => new Promise((resolve) => setTimeout(resolve, 24)));
const previewImages = (host: HTMLElement) => host.querySelectorAll(`img[src="${picture}"]`).length;

test('image-only Thread sends survive clear, repeated taps keep separate previews, and one record replaces exactly one queue bubble', async () => {
  // New chat test helpers own earlier mounts; starting a fresh one releases those roots before this chat.
  const blank = await mount(scripted(() => undefined).runtime, fakeMedia().media);
  await act(async () => blank.root.unmount());
  blank.host.remove();
  const view = await chat();
  try {
    for (let i = 0; i < 2; i++) {
      await attach('Photo library');
      await flush();
      await click('Send message');
      await flush();
    }
    const queued = view.runtime.snapshot().outbox;
    assert.equal(queued.length, 2);
    assert.notEqual(queued[0].id, queued[1].id);
    assert.deepEqual(
      queued.map((item: any) => item.pictures),
      [[picture], [picture]],
    );
    assert.equal(previewImages(view.host), 2);
    await view.record(
      [
        { type: 'userMessage', content: [], id: 'unrelated-empty' },
        { type: 'contextCompaction', id: 'compacted' },
      ],
      1,
    );
    assert.equal(previewImages(view.host), 2);
    await view.record([{ type: 'userMessage', content: [{ type: 'image' }], id: 'record-image', clientId: queued[0].nativeId }], 2);
    assert.equal(previewImages(view.host), 2, 'the record retains its local preview while its thumbnail would load');
    assert.equal(
      view.host.querySelectorAll('button[aria-label="Cancel this message"]').length,
      1,
      'only the second image still has queue actions',
    );
  } finally {
    await view.done();
  }
});

test('a waiting image keeps its preview when its Thread is replaced before acknowledgment', async () => {
  const view = await chat();
  try {
    await attach('Photo library');
    await click('Send message');
    await flush();
    assert.equal(previewImages(view.host), 1);
    await view.remount();
    assert.equal(previewImages(view.host), 1);
    assert.equal(view.runtime.snapshot().outbox.length, 1);
    const nativeId = view.runtime.snapshot().outbox[0].nativeId;
    await view.record([{ type: 'userMessage', id: 'remounted-record', clientId: nativeId, content: [{ type: 'image' }] }], 1);
    assert.equal(previewImages(view.host), 1);
    assert.equal(
      view.host.querySelectorAll('button[aria-label="Cancel this message"]').length,
      0,
      'the remounted send settles by native id before acknowledgment',
    );
  } finally {
    await view.done();
  }
});

test('another writer’s equally-sized image-only message cannot consume this phone send', () => {
  const pending = withSent([], [], '', 'phone-image', [], [picture], 'expected-native-id');
  const unrelated = [{ role: 'user', text: '', images: 1, key: 'other-image', clientId: 'another-native-id' }];
  assert.equal(waitingForRecord(pending, unrelated).length, 1);
  assert.equal(
    settled(pending, [...unrelated, { role: 'user', text: '', images: 1, key: 'own-image', clientId: 'expected-native-id' }]).length,
    0,
  );
});

test('a remounted image send collapses into its own Mac queue entry before acknowledgment with the same preview', async () => {
  const view = await chat();
  try {
    await attach('Photo library');
    await click('Send message');
    await flush();
    const nativeId = view.runtime.snapshot().outbox[0].nativeId;
    await view.remount();
    await view.patch({ queue: [{ id: nativeId, mine: true, text: '', attached: 1, images: 1 }] });
    assert.equal(previewImages(view.host), 1);
    assert.equal(view.host.querySelectorAll('button[aria-label="Cancel this message"]').length, 1);
  } finally {
    await view.done();
  }
});

test('an older Mac cannot accept image-only start silently and the uploaded tile remains available', async () => {
  const { runtime, calls } = scripted((method) =>
    method === 'machine.hello' ? { ...menus.hello, capabilities: { ...menus.hello.capabilities, messageIdentity: undefined } } : undefined,
  );
  const view = await mount(runtime, fakeMedia({ library: { name: 'picked.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: picture } }).media);
  await attach('Photo library');
  await click('Start chat');
  await flush();
  assert.match(view.host.textContent!, /Update MoPilot.*attachment is kept/);
  assert(view.host.querySelector('img[src="file:///picked-preview.jpg"]'));
  assert.equal(calls.filter(([method]) => method === 'chat.start').length, 0);
  assert.equal(button(view.host, 'Start chat')!.disabled, false);
});

test('a message with pictures lands without the rise of its words (the words sit under the pictures, not where a words-only bubble lands); words alone still rise', async () => {
  const originPath = '../mobile/src/sendOrigin';
  const { watchLaunch } = await import(originPath);
  const blank = await mount(scripted(() => undefined).runtime, fakeMedia().media);
  await act(async () => blank.root.unmount());
  blank.host.remove();
  const view = await chat();
  const launches: { text: string }[] = [];
  const stop = watchLaunch((launch: { text: string }) => launches.push(launch));
  try {
    await attach('Photo library');
    await flush();
    await click('Send message');
    await flush();
    assert.deepEqual(launches, [], 'pictures: no rise');
  } finally {
    stop();
    await view.done();
  }
});
