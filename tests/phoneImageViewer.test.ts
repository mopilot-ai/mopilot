// The rebuilt UI's full-screen image look (#4304); the classic screens keep components/ImageViewer.tsx as it was: closing is iOS's own overscroll (past 100 pt, or a fast flick), a zoomed picture pans instead, and its words follow the language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
const viewerPath = '../mobile/src/ui/cards/ImageViewer';
const i18nPath = '../mobile/src/ui/i18n';
const { pullToDismiss, dismisses, ImageViewer, doubleTapRect, pageAt } = await import(viewerPath);
const classicPath = '../mobile/src/components/ImageViewer';
const classic = await import(classicPath);
const DOUBLE = 300;
const { showLocale } = await import(i18nPath);

test('a pull down far or fast closes the picture; a short pull, a zoomed one or a pull up does not', () => {
  assert.equal(dismisses(120, 0), true);
  assert.equal(dismisses(40, 2), true);
  assert.equal(dismisses(40, 0.2), false);
  assert.equal(dismisses(10, 5), false);
  const drag = { value: 0 } as any;
  let closed = 0;
  const h = pullToDismiss(drag, () => closed++);
  const at = (y: number, extra: object = {}) => ({ nativeEvent: { contentOffset: { y }, ...extra } }) as any;
  h.onScroll(at(-50));
  assert.equal(drag.value, 50);
  h.onScroll(at(30));
  assert.equal(drag.value, 0, 'never pulled up');
  h.onScroll(at(-50, { zoomScale: 2 }));
  assert.equal(drag.value, 0, 'zoomed in, the scroll view pans the picture');
  h.onScrollEndDrag(at(-30, { velocity: { y: 0 } }));
  h.onScrollEndDrag(at(-30));
  h.onScrollEndDrag(at(-150, { zoomScale: 2 }));
  assert.equal(closed, 0);
  h.onScrollEndDrag(at(-150, { velocity: { y: 0 } }));
  assert.equal(closed, 1);
  h.onScrollEndDrag(at(-40, { velocity: { y: -2 } }));
  assert.equal(closed, 2, 'a fast flick closes it');
});

test('the close button is named in the language shown, and closes', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = 0;
  await act(async () => root.render(createElement(ImageViewer, { uri: 'file:///a.png', name: 'a', close: () => closed++ })));
  const button = () => document.querySelector('button[aria-label]') as HTMLButtonElement;
  assert.equal(button().getAttribute('aria-label'), 'Close image');
  await act(async () => showLocale('zh-Hans'));
  assert.equal(button().getAttribute('aria-label'), '关闭图片');
  await act(async () => button().click());
  assert.equal(closed, 1);
  await act(async () => showLocale('en'));
  await act(async () => root.unmount());
  host.remove();
});

test('the classic screens open the same viewer', () => {
  assert.equal(classic.ImageViewer, ImageViewer);
  assert.equal(classic.dismisses, dismisses);
  assert.equal(classic.pullToDismiss, pullToDismiss);
  assert.equal(classic.DISMISS_DISTANCE, 100);
  assert.equal(classic.DISMISS_VELOCITY, 1.2);
});

test('a double tap zooms in on the spot, kept inside the picture, and back out to the whole of it', () => {
  assert.deepEqual(doubleTapRect(false, 195, 400, 390, 800), { x: 117, y: 240, width: 156, height: 320 });
  assert.deepEqual(doubleTapRect(false, 0, 0, 390, 800), { x: 0, y: 0, width: 156, height: 320 }, 'a corner stays inside');
  assert.deepEqual(doubleTapRect(false, 390, 800, 390, 800), { x: 234, y: 480, width: 156, height: 320 });
  assert.deepEqual(doubleTapRect(true, 100, 100, 390, 800), { x: 0, y: 0, width: 390, height: 800 });
});

test('two quick taps zoom in at the tap, a slow second tap is a first one, and a tap while zoomed zooms out; a zoomed picture is not pulled closed', async () => {
  const { mock } = await import('node:test');
  const g = globalThis as any;
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = 0;
  try {
    await act(async () => root.render(createElement(ImageViewer, { uri: 'file:///a.png', name: 'a', close: () => closed++ })));
    g.__zoomedTo = [];
    const picture = () => host.querySelector('img')!.closest('button') as HTMLButtonElement;
    const tapAt = (x?: number, y?: number) =>
      act(async () => {
        const event = new MouseEvent('click', { bubbles: true });
        if (x !== undefined) Object.assign(event, { locationX: x, locationY: y });
        picture().dispatchEvent(event);
      });
    await tapAt(100, 200);
    assert.deepEqual(g.__zoomedTo, [], 'one tap does nothing');
    mock.timers.tick(DOUBLE);
    await tapAt(100, 200);
    assert.deepEqual(g.__zoomedTo, [], 'a slow second tap is only a first one');
    mock.timers.tick(100);
    await tapAt(100, 200);
    assert.equal(g.__zoomedTo.length, 1);
    assert.deepEqual(g.__zoomedTo[0], { ...doubleTapRect(false, 100, 200, 390, 800), animated: true });
    // the scroll view reports a zoom: the next double tap goes back out to the whole picture, and a pull does not close it
    await act(async () => g.__scrollEvents.onScroll({ nativeEvent: { contentOffset: { y: -200 }, zoomScale: 2 } }));
    await act(async () => g.__scrollEvents.onScrollEndDrag({ nativeEvent: { contentOffset: { y: -200 }, zoomScale: 2 } }));
    mock.timers.tick(DOUBLE);
    await tapAt();
    mock.timers.tick(100);
    await tapAt();
    assert.deepEqual(g.__zoomedTo[1], { x: 0, y: 0, width: 390, height: 800, animated: true });
    // zoomed back out, with no position given, a double tap zooms in on the middle
    await act(async () => g.__scrollEvents.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }));
    mock.timers.tick(DOUBLE);
    await tapAt();
    mock.timers.tick(100);
    await tapAt();
    assert.deepEqual(g.__zoomedTo[2], { ...doubleTapRect(false, 195, 400, 390, 800), animated: true });
    assert.equal(closed, 0);
  } finally {
    mock.timers.reset();
    await act(async () => root.unmount());
    host.remove();
  }
});

test('the picture is named for VoiceOver: by its name when it has one, else as a picture', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const alt = () => host.querySelector('img')?.getAttribute('alt');
  await act(async () => root.render(createElement(ImageViewer, { uri: 'file:///a.png', name: 'IMG_0042.png', close: () => undefined })));
  assert.equal(alt(), 'IMG_0042.png');
  await act(async () => root.render(createElement(ImageViewer, { uri: 'file:///a.png', name: '', close: () => undefined })));
  assert.equal(alt(), 'Picture');
  await act(async () => showLocale('zh-Hans'));
  assert.equal(alt(), '图片');
  await act(async () => showLocale('en'));
  await act(async () => root.unmount());
  host.remove();
});

const view = (g: any, place: number) => g.__scrollViews[`image-page-${place}`];
async function mountPager(props: Record<string, unknown> = {}) {
  const g = globalThis as any;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const heard: number[] = [];
  const pages = [
    { key: 'a', uri: 'file:///a.png', name: 'A' },
    { key: 'b', uri: 'file:///b.png', name: 'B' },
    { key: 'c', uri: 'file:///c.png', name: 'C' },
  ];
  const draw = (index: number) =>
    act(async () =>
      root.render(
        createElement(ImageViewer, {
          uri: pages[index].uri,
          name: pages[index].name,
          pages,
          index,
          onIndex: (n: number) => heard.push(n),
          close: () => undefined,
          ...props,
        }),
      ),
    );
  await draw(0);
  g.__zoomedTo = [];
  return { g, host, heard, draw, done: () => act(async () => root.unmount()) };
}

test('the page a scroll came to rest on', () => {
  assert.equal(pageAt(0, 390, 3), 0);
  assert.equal(pageAt(400, 390, 3), 1);
  assert.equal(pageAt(780, 390, 3), 2);
  assert.equal(pageAt(5000, 390, 3), 2, 'never past the last');
  assert.equal(pageAt(-40, 390, 3), 0, 'never before the first');
  assert.equal(pageAt(0, 0, 3), 0, 'no width yet');
});

test("a message's pictures page: the position shows, a swipe to rest on another picture is heard once, and a swipe back to the same one is not", async () => {
  const v = await mountPager();
  assert.ok(v.host.textContent!.includes('1 / 3'));
  const swipe = (x: number) =>
    act(async () => v.g.__scrollViews['image-pager'].onMomentumScrollEnd({ nativeEvent: { contentOffset: { x } } }));
  await swipe(390);
  await swipe(5);
  assert.deepEqual(v.heard, [1], 'a swipe that came back to the same page is nothing');
  await v.draw(1);
  assert.ok(v.host.textContent!.includes('2 / 3'));
  assert.deepEqual(
    [...v.host.querySelectorAll('img')].map((i) => i.getAttribute('alt')),
    ['A', 'B', 'C'],
  );
  await v.done();
});

test('only the pictures next to the one on screen are drawn, the others wait', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ key: `p${i}`, uri: `file:///${i}.png`, name: `P${i}` }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(ImageViewer, { uri: pages[0].uri, name: 'P0', pages, index: 0, close: () => undefined })),
  );
  assert.deepEqual(
    [...host.querySelectorAll('img')].map((i) => i.getAttribute('alt')),
    ['P0', 'P1'],
  );
  assert.equal(host.querySelectorAll('[role="progressbar"]').length, 3, 'the far pictures show progress, not their pixels');
  await act(async () =>
    root.render(createElement(ImageViewer, { uri: pages[2].uri, name: 'P2', pages, index: 2, close: () => undefined })),
  );
  assert.deepEqual(
    [...host.querySelectorAll('img')].map((i) => i.getAttribute('alt')),
    ['P1', 'P2', 'P3'],
  );
  await act(async () => root.unmount());
  host.remove();
});

test('VoiceOver moves between the pictures: the position is adjustable, increment and decrement go to the next and the one before, and stop at the ends', async () => {
  const v = await mountPager();
  const adjustable = v.host.querySelector('[role="adjustable"]') as any;
  assert.equal(adjustable.getAttribute('aria-label'), '1 / 3');
  const act1 = (name: string) => act(async () => adjustable.__onAccessibilityAction({ nativeEvent: { actionName: name } }));
  await act1('increment');
  assert.deepEqual(v.heard, [1]);
  await v.draw(2);
  await act1('increment');
  assert.deepEqual(v.heard, [1], 'no page after the last');
  await act1('decrement');
  assert.deepEqual(v.heard, [1, 1]);
  await v.done();
});

test('a picture zoomed in comes back to its whole size when it is swiped away, and one that was not zoomed is left alone', async () => {
  const v = await mountPager();
  await act(async () => view(v.g, 0).onScroll({ nativeEvent: { contentOffset: { y: 0 }, zoomScale: 2.4 } }));
  await v.draw(1);
  assert.deepEqual(v.g.__zoomedTo, [{ x: 0, y: 0, width: 390, height: 800, animated: false }]);
  v.g.__zoomedTo = [];
  await v.draw(2);
  assert.deepEqual(v.g.__zoomedTo, [], 'page 1 was never zoomed');
  await v.done();
});

test('pages that have no picture yet show progress, and a message with one picture is not a pager', async () => {
  const v = await mountPager({
    pages: [
      { uri: 'file:///a.png', name: 'A' },
      { uri: null, name: 'B' },
    ],
  });
  await v.draw(0);
  assert.equal(v.host.querySelectorAll('[role="progressbar"]').length, 1);
  await v.done();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ImageViewer, {
        uri: 'file:///a.png',
        name: 'A',
        pages: [{ key: 'a', uri: 'file:///a.png', name: 'A' }],
        close: () => undefined,
      }),
    ),
  );
  assert.equal(host.querySelector('[role="adjustable"]'), null);
  await act(async () => root.unmount());
  host.remove();
});
