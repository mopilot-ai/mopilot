// A chat that streams never scrolls on its own under a reader (#5686): a nudge up leaves the end whether or not a finger is on the list, a resting finger holds the view, and following resumes only when the reader comes to rest at the very end (or taps the arrow), never because a report landed within reach of it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const followPath = '../mobile/src/remote/useFollowEnd';
const { Thread } = await import(threadPath);
const { REST_END } = await import(followPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});
const g = globalThis as any;

/** A streaming chat of 30 rows, content 2000 tall in a view 600 tall: the end is at offset 1400. */
async function open() {
  g.__scrolledToEnd = [];
  g.__scrolledTo = [];
  const rig = scripted((m) =>
    m === 'chat.follow'
      ? {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'running', cards: [] },
          itemsShape: 'rows',
          items: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i}` })),
        }
      : undefined,
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Thread, { runtime: rig.runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const list = () => document.querySelector('[scrolleventthrottle]')!;
  const ev = () => g.__scrollEvents;
  return {
    scrolls: () => g.__scrolledToEnd as { animated?: boolean }[],
    report: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    grow: (height = 2100) => act(async () => ev().onContentSizeChange(0, height)),
    drag: () => act(async () => ev().onScrollBeginDrag({ nativeEvent: {} })),
    lift: () => act(async () => ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } })),
    coast: () => act(async () => ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 1.2 } } })),
    stop: () => act(async () => ev().onMomentumScrollEnd()),
    touch: () => act(async () => ev().onTouchStart({ nativeEvent: { touches: [{}] } })),
    release: () => act(async () => ev().onTouchEnd({ nativeEvent: { touches: [] } })),
    cancel: () => act(async () => ev().onTouchCancel({ nativeEvent: { touches: [] } })),
    arrow: () => document.querySelector('button[aria-label="Jump to the latest message"]'),
  };
}

test('a reader who nudges up and then moves back down within reach of the end is not pulled down by the next token', async () => {
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.report(1360); // 40 up
  await t.report(1366); // the finger drifts back a little: still short of the end, still within 80
  await t.lift();
  await t.grow();
  await t.grow(2200);
  assert.equal(t.scrolls().length, 0, 'the reader left the end; the report within reach of it did not bring them back');
});

test('an upward move with no finger (an accessibility scroll, the status bar, a scroll bar) leaves the end too', async () => {
  const t = await open();
  await t.report(1400);
  await t.report(1350);
  await t.grow();
  await t.grow(2200);
  assert.equal(t.scrolls().length, 0, 'no finger, no pull back');
});

test('a finger that only rests on the list holds the view: growth does not move it, and the lift catches up', async () => {
  const t = await open();
  await t.report(1400);
  await t.touch();
  await t.grow(2100);
  await t.grow(2200);
  assert.equal(t.scrolls().length, 0, 'a resting finger is the reader’s');
  await t.release();
  assert.equal(t.scrolls().length, 1, 'still following at the end: caught up once, when the finger left');
  // a cancelled touch lets go the same way
  await t.touch();
  await t.grow(2300);
  assert.equal(t.scrolls().length, 1);
  await t.cancel();
  assert.equal(t.scrolls().length, 2);
});

test('a touch that turns into a drag stays the reader’s until the drag or its momentum ends, whatever the touch events say', async () => {
  const t = await open();
  await t.report(1400);
  await t.touch();
  await t.drag();
  await t.cancel(); // the list took the touch: the drag goes on
  await t.grow(2100);
  assert.equal(t.scrolls().length, 0, 'the drag is still going');
  await t.coast();
  await t.grow(2200);
  assert.equal(t.scrolls().length, 0, 'momentum is still going');
  await t.stop();
  assert.equal(t.scrolls().length, 1, 'the glide stopped at the end: following goes on');
});

test('coming back to the end by scrolling follows again only once the reader rests there; a rest short of it does not', async () => {
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.report(1300);
  await t.lift();
  await t.report(1330);
  await t.report(1360);
  await t.grow();
  assert.equal(t.scrolls().length, 0, 'scrolling down to within reach of the end is not coming to rest at it');
  // a rest within the old reach (80) but beyond the rest zone is not the end either
  await t.drag();
  await t.report(1500 - REST_END - 5, 2100);
  await t.lift();
  await t.grow(2200);
  assert.equal(t.scrolls().length, 0, 'just short of the end, at rest');
  // at the end, finger still down: held; lifted: following again
  await t.drag();
  await t.report(1600, 2200);
  await t.grow(2300);
  assert.equal(t.scrolls().length, 0, 'the finger is still down');
  await t.lift();
  assert.equal(t.scrolls().length, 1, 'at rest at the end: following goes on');
});

test('a momentum glide that ends at the end follows again, one that ends short of it does not, and the arrow follows again either way', async () => {
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.report(1000);
  await t.coast();
  await t.report(1370);
  await t.stop();
  await t.grow();
  assert.equal(t.scrolls().length, 0, 'the glide came to rest 30 points short');
  // a glide that ends at the very end
  await t.drag();
  await t.report(1200, 2100);
  await t.coast();
  await t.report(1500, 2100);
  await t.stop();
  assert.equal(t.scrolls().length, 0, 'at rest at the end with nothing grown: nothing to catch up with');
  await t.grow(2200);
  assert.equal(t.scrolls().length, 1, 'and the next growth is followed');
});

test('the arrow follows again from anywhere', async () => {
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.report(1000);
  await t.lift();
  assert.ok(t.arrow());
  await click('Jump to the latest message');
  assert.equal(t.scrolls().length, 1);
  await t.grow(2200);
  assert.equal(t.scrolls().length, 2, 'following goes on after the arrow');
});

test('with no finger, scrolling down to the end follows again', async () => {
  const t = await open();
  await t.report(1400);
  await t.report(1300);
  await t.report(1400);
  await t.grow();
  assert.equal(t.scrolls().length, 1, 'back at the very end by a scroll with no finger');
});

test('a reader left at the end of content that got shorter (the chat clamped the view) follows again when they touch and let go there', async () => {
  const t = await open();
  await t.report(1400);
  await t.report(1000);
  // the content shrinks under the view: the chat puts it back inside, and the next report is of that place
  await t.grow(1500);
  await t.touch();
  await t.release();
  await t.grow(1600);
  assert.equal(t.scrolls().length, 1, 'the view stands at the end of what is drawn, so following goes on');
});
