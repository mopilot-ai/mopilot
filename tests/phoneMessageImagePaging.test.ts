// A message's pictures page in the viewer (#4824): the one on screen and its neighbours are read ahead, a swipe finds the next ready, an unreadable one shows progress, an unsent message pages from what the phone holds, and a new owner of the connection reads again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const imagePath = '../mobile/src/remote/messageImage';
const imagesPath = '../mobile/src/components/MessageImages';
const { forgetMessageImages, FULL_SIDE } = await import(imagePath);
const { MessageImages, MessageImageProvider } = await import(imagesPath);

const THUMB = 'data:image/jpeg;base64,/9j/4AAQ';
const FULL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test("a message's pictures page in the viewer: the neighbours of the one on screen are read ahead, a swipe finds the next ready, and an unreadable one shows progress", async () => {
  const g = globalThis as any;
  const asks: [number, number][] = [];
  const pictures: Record<number, string | null> = { 0: `${FULL}A`, 1: `${FULL}B`, 2: null };
  const load = async (_id: string, index: number, side: number) => (asks.push([index, side]), pictures[index]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  forgetMessageImages();
  await act(async () =>
    root.render(createElement(MessageImageProvider, { load }, createElement(MessageImages, { itemId: 'm', count: 3 }))),
  );
  await flush();
  await flush();
  const tiles = () => [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Open picture');
  assert.equal(tiles().length, 2, 'the third could not be read');
  asks.length = 0;
  await act(async () => tiles()[0].click());
  await flush();
  await flush();
  assert.deepEqual(
    asks.filter(([, side]) => side === FULL_SIDE).map(([i]) => i),
    [0, 1],
    'the one opened and the one next to it, not the third',
  );
  assert.ok(document.body.textContent!.includes('1 / 3'));
  const imgs = () => [...document.querySelectorAll('[role=dialog] img')].map((i) => i.getAttribute('src'));
  assert.deepEqual(imgs(), [`${FULL}A`, `${FULL}B`]);
  asks.length = 0;
  await act(async () => g.__scrollViews['image-pager'].onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 390 } } }));
  await flush();
  await flush();
  assert.ok(document.body.textContent!.includes('2 / 3'));
  assert.deepEqual(
    asks.filter(([, side]) => side === FULL_SIDE).map(([i]) => i),
    [2],
    'the next one is read, the others were already',
  );
  assert.equal(document.querySelectorAll('[role=dialog] [role=progressbar]').length, 1, 'the third has no picture to show');
  // landing on a picture that could not be read shows progress, never the thumbnail of the picture opened first
  await act(async () => g.__scrollViews['image-pager'].onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 780 } } }));
  await flush();
  assert.ok(document.body.textContent!.includes('3 / 3'));
  assert.ok(
    ![...document.querySelectorAll('[role=dialog] img')].some((i) => i.getAttribute('src') === THUMB),
    'the first picture is not shown in its place',
  );
  assert.equal(
    document.querySelectorAll('[role=dialog] [role=progressbar]').length,
    2,
    'the unreadable one and the first, which is now two pictures away',
  );
  await act(async () => root.unmount());
  host.remove();
});

test("an unsent message's pictures page from what the phone holds, without asking the computer", async () => {
  const g = globalThis as any;
  const asks: number[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  forgetMessageImages();
  await act(async () =>
    root.render(
      createElement(
        MessageImageProvider,
        { load: async (_i: string, n: number) => (asks.push(n), null) },
        createElement(MessageImages, { count: 2, local: ['file:///1.png', 'file:///2.png'] }),
      ),
    ),
  );
  const tiles = [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Open picture');
  await act(async () => tiles[1].click());
  assert.ok(document.body.textContent!.includes('2 / 2'));
  assert.deepEqual(
    [...document.querySelectorAll('[role=dialog] img')].map((i) => i.getAttribute('src')),
    ['file:///1.png', 'file:///2.png'],
  );
  await act(async () => g.__scrollViews['image-pager'].onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0 } } }));
  assert.ok(document.body.textContent!.includes('1 / 2'));
  assert.deepEqual(asks, []);
  await act(async () => root.unmount());
  host.remove();
});

test('a new owner of the connection starts the full-size reads again, and a read that comes back after the message is gone is dropped', async () => {
  const asks: string[] = [];
  const answer = (name: string) => async (_id: string, index: number, side: number) => (
    asks.push(`${name}:${index}:${side}`), side === FULL_SIDE ? `${FULL}${name}` : THUMB
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  forgetMessageImages();
  const draw = (load: any) =>
    act(async () => root.render(createElement(MessageImageProvider, { load }, createElement(MessageImages, { itemId: 'm', count: 2 }))));
  const tile = () => [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Open picture') as HTMLButtonElement;
  await draw(answer('one'));
  await flush();
  await act(async () => tile().click());
  await flush();
  assert.deepEqual(
    asks.filter((a) => a.endsWith(`:${FULL_SIDE}`)),
    [`one:0:${FULL_SIDE}`, `one:1:${FULL_SIDE}`],
  );
  await act(async () => (document.querySelector('button[aria-label="Close image"]') as HTMLButtonElement).click());
  // the connection came back under a new owner: what was read for the old one is not shown, and the pictures are read again for the new
  await draw(answer('two'));
  await flush();
  await act(async () => tile().click());
  await flush();
  assert.deepEqual(
    asks.filter((a) => a.startsWith('two:') && a.endsWith(`:${FULL_SIDE}`)),
    [`two:0:${FULL_SIDE}`, `two:1:${FULL_SIDE}`],
  );
  assert.ok([...document.querySelectorAll('[role=dialog] img')].some((i) => i.getAttribute('src') === `${FULL}two`));
  assert.ok(![...document.querySelectorAll('[role=dialog] img')].some((i) => i.getAttribute('src') === `${FULL}one`));
  await act(async () => root.unmount());
  host.remove();
  // a read that is still on its way when the message goes away changes nothing
  const late: ((p: string) => void)[] = [];
  const slow = async (_id: string, _i: number, side: number) => (side === FULL_SIDE ? new Promise<string>((r) => late.push(r)) : THUMB);
  const host2 = document.createElement('div');
  document.body.append(host2);
  const root2 = createRoot(host2);
  forgetMessageImages();
  await act(async () =>
    root2.render(createElement(MessageImageProvider, { load: slow }, createElement(MessageImages, { itemId: 'm2', count: 1 }))),
  );
  await flush();
  await act(async () =>
    ([...host2.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Open picture') as HTMLButtonElement).click(),
  );
  await act(async () => root2.unmount());
  host2.remove();
  await act(async () => late.forEach((r) => r(FULL)));
});
