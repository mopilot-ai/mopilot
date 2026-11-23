// The pictures of your own messages in the phone's chat: a message row carries how many and the id to read them by (presentation/thread.ts), the bubble draws small tiles above its text read from the Mac on demand and kept (remote/messageImage.ts, components/MessageImages.tsx), and a tap opens one full screen (components/ImageViewer.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

import { fakeDraft } from './support/phone/drafts';
const phoneModule0 = '../mobile/src/presentation/thread';
const phoneModule1 = '../mobile/src/remote/messageImage';
const phoneModule2 = '../mobile/src/components/MessageImages';
const phoneModule3 = '../mobile/src/components/MessageBubble';
const phoneModule4 = '../mobile/src/components/ImageViewer';
const phoneModule5 = '../mobile/src/screens/Thread';

const { row, displayRows } = await import(phoneModule0);
const { readMessageImage, forgetMessageImages, THUMB_SIDE, FULL_SIDE } = await import(phoneModule1);
const { MessageImages, MessageImageProvider } = await import(phoneModule2);
const { MessageBubble } = await import(phoneModule3);
const { ImageViewer } = await import(phoneModule4);

const THUMB = 'data:image/jpeg;base64,/9j/4AAQ';
const FULL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('a message of yours says how many pictures it carries and the id to read them by, saved or live; none without a usable id', () => {
  assert.deepEqual(row({ role: 'user', text: 'look', id: '["s","t","u1"]', images: 2 }, 'rows'), {
    role: 'user',
    text: 'look',
    images: 2,
    messageId: '["s","t","u1"]',
  });
  assert.deepEqual(row({ role: 'user', text: 'plain', id: 'u', images: 0 }, 'rows'), { role: 'user', text: 'plain' });
  assert.deepEqual(row({ role: 'user', text: 'x', images: 1 }, 'rows'), { role: 'user', text: 'x' }, 'no id to ask by');
  assert.deepEqual(row({ role: 'user', text: 'x', id: 'y'.repeat(2049), images: 1 }, 'rows'), { role: 'user', text: 'x' });
  assert.equal((row({ role: 'user', text: 'x', id: 'u', images: 500 }, 'rows') as any).images, 99);
  const live = row(
    {
      type: 'userMessage',
      id: 'u-q',
      content: [
        { type: 'text', text: 'a' },
        { type: 'localImage', path: '/p' },
        { type: 'image', url: 'u' },
      ],
    },
    'items',
  );
  assert.deepEqual(live, {
    role: 'user',
    text: 'a',
    images: 2,
    messageId: 'u-q',
  });
  assert.deepEqual(row({ type: 'userMessage', id: 'u2' }, 'items'), {
    role: 'user',
    text: '',
  });
  // the live row keeps its pictures when it shows under the saved rows
  const shown = displayRows({
    shape: 'items',
    history: [],
    items: [
      {
        type: 'userMessage',
        id: 'u-q',
        content: [{ type: 'localImage', path: '/p' }],
      },
    ],
  } as any);
  assert.equal(shown[0].role, 'liveUser');
  assert.equal(shown[0].images, 1);
});

test('a picture is read once per place and size, kept, and a failure is asked for again', async () => {
  forgetMessageImages();
  const asks: any[] = [];
  const request: any = async (method: string, params: any) => (
    asks.push([method, params]), { data: '/9j/4AAQSkZJRg==', width: 8, height: 5 }
  );
  assert.equal(await readMessageImage(request, 'c', 'u1', 0, THUMB_SIDE), FULL);
  assert.equal(await readMessageImage(request, 'c', 'u1', 0, THUMB_SIDE), FULL);
  assert.deepEqual(asks, [['messages.image', { chatId: 'c', itemId: 'u1', index: 0, maxSide: THUMB_SIDE }]]);
  await readMessageImage(request, 'c', 'u1', 0, FULL_SIDE);
  assert.equal(asks.length, 2, 'the larger one is another read');
  for (let i = 1; i <= 50; i++) await readMessageImage(request, 'c', `m${i}`, 0, THUMB_SIDE);
  const before = asks.length;
  await readMessageImage(request, 'c', 'u1', 0, THUMB_SIDE);
  assert.equal(asks.length, before + 1, 'the oldest left');
  await readMessageImage(request, 'c', 'm50', 0, THUMB_SIDE);
  assert.equal(asks.length, before + 1, 'the newest stayed');
  forgetMessageImages();
  for (const bad of [{}, null, { data: 'not base64!' }, { data: 'A'.repeat(3_000_001) }, { data: 5 }])
    assert.equal(await readMessageImage((async () => bad) as any, 'c', 'x', 0, 360), null);
  assert.equal(await readMessageImage((async () => Promise.reject(new Error('offline'))) as any, 'c', 'x', 0, 360), null);
});

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const srcs = (host: HTMLElement) => [...host.querySelectorAll('img')].map((i) => i.getAttribute('src'));

test('tiles read their picture from the Mac, open full screen on a tap with the larger picture, and close on a tap', async () => {
  const asks: [string, number, number][] = [];
  const load = async (id: string, index: number, side: number) => (asks.push([id, index, side]), side === FULL_SIDE ? FULL : THUMB);
  const v = await mount(createElement(MessageImageProvider, { load }, createElement(MessageImages, { itemId: 'u1', count: 2 })));
  await flush();
  assert.deepEqual(asks, [
    ['u1', 0, THUMB_SIDE],
    ['u1', 1, THUMB_SIDE],
  ]);
  assert.deepEqual(srcs(v.host), [THUMB, THUMB]);
  await click('Open picture');
  await flush();
  assert.equal(document.querySelector('[role=dialog]') != null, true);
  assert.deepEqual(
    asks.filter(([, , side]) => side === FULL_SIDE),
    [
      ['u1', 0, FULL_SIDE],
      ['u1', 1, FULL_SIDE],
    ],
    'the picture opened and the one next to it, read ahead',
  );
  assert.equal(srcs(document.body).includes(FULL), true);
  await click('Close image');
  assert.equal(document.querySelector('[role=dialog]'), null);
  await v.done();
});

test('a picture the Mac could not give shows a tile that asks again on a tap; pictures held here are drawn without asking', async () => {
  let answer: string | null = null;
  const asks: number[] = [];
  const load = async () => (asks.push(1), answer);
  const v = await mount(createElement(MessageImageProvider, { load }, createElement(MessageImages, { itemId: 'u1', count: 1 })));
  await flush();
  assert.equal(asks.length, 1);
  answer = THUMB;
  await click('Picture unavailable, tap to try again');
  await flush();
  assert.equal(asks.length, 2);
  assert.deepEqual(srcs(v.host), [THUMB]);
  await v.done();
  // a tap on a tile still loading does nothing
  const slow = await mount(
    createElement(MessageImageProvider, { load: () => new Promise(() => {}) }, createElement(MessageImages, { itemId: 'u1', count: 1 })),
  );
  await click('Loading picture');
  assert.equal(document.querySelector('[role=dialog]'), null);
  await slow.done();
  // without a way to the Mac or an id: unavailable, and a tap does not ask
  for (const props of [{ itemId: 'u1', count: 1 }, { count: 1 }] as { itemId?: string; count: number }[]) {
    const none = await mount(createElement(MessageImages, props));
    await flush();
    await click('Picture unavailable, tap to try again');
    assert.equal(document.querySelector('[role=dialog]'), null);
    await none.done();
  }
  const noId = await mount(createElement(MessageImageProvider, { load }, createElement(MessageImages, { count: 1 })));
  await flush();
  assert.equal(asks.length, 2);
  await noId.done();
  // an unmounted tile drops a late answer
  let late!: (v: string) => void;
  const gone = await mount(
    createElement(
      MessageImageProvider,
      { load: () => new Promise<string>((r) => (late = r)) },
      createElement(MessageImages, { itemId: 'u1', count: 1 }),
    ),
  );
  await gone.done();
  await act(async () => late(THUMB));
  // a tile for a picture held here is drawn, opens, and never asks the Mac
  const asked: number[] = [];
  const local = await mount(
    createElement(
      MessageImageProvider,
      { load: async () => (asked.push(1), FULL) },
      createElement(MessageImages, { count: 0, local: [THUMB] }),
    ),
  );
  assert.deepEqual(srcs(local.host), [THUMB]);
  await click('Open picture');
  assert.equal(srcs(document.body).includes(THUMB), true);
  assert.deepEqual(asked, []);
  await local.done();
  assert.equal((await mount(createElement(MessageImages, { count: 0 }))).host.innerHTML, '');
});

test('a provider without a loader leaves tiles unavailable, and a failed larger picture keeps the thumbnail', async () => {
  const bare = await mount(createElement(MessageImageProvider, {}, createElement(MessageImages, { itemId: 'u1', count: 1 })));
  await flush();
  assert.equal(srcs(bare.host).length, 0);
  await bare.done();
  const load = async (_id: string, _index: number, side: number) => {
    if (side === FULL_SIDE) throw new Error('gone');
    return THUMB;
  };
  const v = await mount(createElement(MessageImageProvider, { load }, createElement(MessageImages, { itemId: 'u1', count: 1 })));
  await flush();
  await click('Open picture');
  await flush();
  assert.equal(document.querySelector('[role=dialog]') != null, true);
  assert.equal(srcs(document.body).includes(THUMB), true);
  await click('Close image');
  await v.done();
});

test('a bubble draws its pictures above its text; pictures alone are the message; a plain one draws none', async () => {
  const load = async () => THUMB;
  const v = await mount(
    createElement(
      MessageImageProvider,
      { load },
      createElement(MessageBubble, {
        role: 'user',
        text: 'look',
        images: 1,
        messageId: 'u1',
      }),
      createElement(MessageBubble, {
        role: 'user',
        text: '',
        images: 1,
        messageId: 'u2',
      }),
      createElement(MessageBubble, {
        role: 'liveUser',
        text: 'sending',
        pictures: [FULL],
      }),
      createElement(MessageBubble, { role: 'user', text: 'plain' }),
      createElement(MessageBubble, {
        role: 'assistant',
        text: 'reply',
        images: 3,
      }),
    ),
  );
  await flush();
  assert.equal(v.host.querySelectorAll('img').length, 3);
  assert.equal(v.host.textContent?.includes('look'), true);
  assert.equal(v.host.textContent?.includes('plain'), true);
  await v.done();
});

test('the shared viewer shows nothing without a picture and shows the thumbnail while the larger one comes', async () => {
  const closed: number[] = [];
  const v = await mount(createElement(ImageViewer, { uri: null, name: 'Picture', close: () => closed.push(1) }));
  assert.equal(document.querySelector('[role=dialog]'), null);
  await v.done();
  const open = await mount(
    createElement(ImageViewer, {
      uri: THUMB,
      name: 'Picture',
      close: () => closed.push(1),
    }),
  );
  assert.equal(document.querySelector('[role=progressbar], [role=dialog]') != null, true);
  await click('Close image');
  assert.deepEqual(closed, [1]);
  await open.done();
});

test('image caches belong to the connected request owner, including after a reset with an old read pending', async () => {
  forgetMessageImages();
  const first = async () => ({ data: 'Zmlyc3Q=' });
  const second = async () => ({ data: 'c2Vjb25k' });
  assert.notEqual(
    await readMessageImage(first as any, 'same', 'same', 0, 360),
    await readMessageImage(second as any, 'same', 'same', 0, 360),
  );
  let finish!: (v: unknown) => void;
  let calls = 0;
  const pending = (() =>
    ++calls === 1
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve({ data: 'bmV3' })) as any;
  const old = readMessageImage(pending, 'same', 'same', 0, 360);
  forgetMessageImages();
  await readMessageImage(pending, 'same', 'same', 0, 360);
  finish({ data: 'b2xk' });
  await old;
  assert.equal(await readMessageImage(pending, 'same', 'same', 0, 360), 'data:image/jpeg;base64,bmV3');
});

test('the full phone thread follows saved image references, fetches thumbnails through RPC, and opens the larger viewer', async () => {
  const { rig } = await import('./support/remote-kit.ts');
  const { Thread } = await import(phoneModule5);
  const { withOutbox } = await import('./support/phone/outbox-kit');
  const asks: any[] = [];
  const r = rig({
    ops: {
      items: async () => ({
        itemsShape: 'rows',
        items: [{ role: 'user', id: '["native","turn","u"]', text: 'Look at this picture', images: 1 }],
      }),
      userImage: async (...params: any[]) => {
        asks.push(params);
        return { data: params[3] === FULL_SIDE ? '/9j/4AAQSkZJRg==' : '/9j/4AAQ', width: 8, height: 4 };
      },
    },
  });
  const endpoint = r.link.phone('p1');
  let sequence = 0;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p1', generation: 1 }),
    onEvent: () => () => {},
    request: (method: string, params: any) =>
      new Promise((resolve, reject) => {
        const id = `thread-${++sequence}`;
        const off = endpoint.onMessage((reply: any) => {
          if (reply.inReplyTo !== id) return;
          off();
          if (reply.ok) resolve(reply.result);
          else reject(new Error(reply.error?.message ?? 'No reply'));
        });
        void endpoint.send({ id, t: 1, kind: 'request', method, params }).catch(reject);
      }),
  };
  withOutbox(runtime);
  const v = await mount(createElement(Thread, { runtime, chatId: 'c1', back: () => {}, drafts: fakeDraft('') }));
  await flush();
  await flush();
  assert.deepEqual(srcs(v.host), [THUMB]);
  await click('Open picture');
  await flush();
  assert.ok(document.querySelector('[role=dialog]'));
  assert.ok(srcs(document.body).includes(FULL));
  assert.equal(
    document.querySelector('[role=dialog] img')?.getAttribute('alt'),
    'Picture 1 of 1',
    'the viewer names the picture by its place',
  );
  assert.deepEqual(
    asks.map((args: any[]) => args.slice(0, 4)),
    [
      ['c1', '["native","turn","u"]', 0, THUMB_SIDE],
      ['c1', '["native","turn","u"]', 0, FULL_SIDE],
    ],
  );
  assert(asks.every((args: any[]) => typeof args[4] === 'function'));
  await click('Close image');
  await v.done();
});

test('the shared viewer closes on a pull down past the top and stays for a short one', async () => {
  let closed = 0;
  const v = await mount(createElement(ImageViewer, { uri: THUMB, name: 'Picture', close: () => closed++ }));
  const end = (y: number) => act(async () => (globalThis as any).__scrollEvents.onScrollEndDrag({ nativeEvent: { contentOffset: { y } } }));
  await end(-30);
  assert.equal(closed, 0);
  await end(-150);
  assert.equal(closed, 1);
  await v.done();
});
