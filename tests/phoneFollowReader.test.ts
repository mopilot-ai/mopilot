// A reader who has scrolled away is never moved by the chat (#5279): while a turn runs, nothing but the reader's own scroll to the bottom, the arrow, or sending follows the end again. Growth does not move a view under a finger, a first move up leaves at once however near the end it starts, and a report of the view clamped by shorter content is not the reader returning.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const overlaysPath = '../mobile/src/components/FollowOverlays';
const { Thread } = await import(threadPath);
const { FollowOverlays } = await import(overlaysPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});
const g = globalThis as any;

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
  return {
    scrolls: () => g.__scrolledToEnd as { animated?: boolean }[],
    ev: () => g.__scrollEvents,
    scroll: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    grow: (height?: number) => act(async () => g.__scrollEvents.onContentSizeChange(0, height)),
    down: () => act(async () => g.__scrollEvents.onScrollBeginDrag({ nativeEvent: {} })),
    up: () => act(async () => g.__scrollEvents.onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } })),
    arrow: () => document.querySelector('button[aria-label="Jump to the latest message"]'),
  };
}

test('growth under the reader’s finger does not take the view to the end', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.down();
  await t.grow();
  await t.grow();
  assert.equal(t.scrolls().length, 0, 'the view is the finger’s while it is down');
});

test('a first move up under the finger leaves the end at once, however near the end it starts, and growth then leaves the reader alone', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.down();
  // 30 points up is still within reach of the end; the finger is moving up
  await t.scroll(1370);
  await t.up();
  await t.grow();
  await t.grow();
  assert.equal(t.scrolls().length, 0, 'the reader left, so a reply growing does not pull them back');
});

test('a finger that lifts at the end catches up with what grew meanwhile', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.down();
  await t.grow(2200);
  assert.equal(t.scrolls().length, 0);
  await t.up();
  assert.equal(t.scrolls().length, 1, 'following goes on once the reader let go at the end');
});

test('a finger that lifts at the end with nothing grown has nothing to catch up with, so the list is not asked to scroll (#5351)', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.down();
  await t.up();
  assert.equal(t.scrolls().length, 0);
});

test('a bounce past the end under the finger is not leaving it', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.down();
  await t.scroll(1460);
  await t.scroll(1400);
  await t.up();
  await t.grow(2200);
  assert.equal(t.scrolls().length, 1, 'still following: the lift at the end had nothing to catch up with, and the growth is followed');
});

test('content that gets shorter under a reader who scrolled away is not the reader returning to the end', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.scroll(900);
  assert.ok(t.arrow());
  // a run of steps folded into one row: the view is clamped to the new end
  await t.scroll(850, 1450);
  await t.grow();
  await t.grow();
  assert.equal(t.scrolls().length, 0, 'nothing follows a reader who did not scroll back down');
  // their own scroll to the end follows again
  await t.scroll(1000, 1750);
  await t.scroll(1150, 1750);
  await t.grow();
  assert.equal(t.scrolls().length, 1, 'back at the end by their own move, following goes on');
});

test('after the content got shorter the arrow follows the distance, not the old state', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.scroll(900);
  await t.scroll(850, 1450);
  assert.equal(t.arrow(), null, 'the view stands at the end, so no arrow');
  await act(async () => (g.__scrollEvents.onContentSizeChange(0, 1800), void 0));
  await t.scroll(850, 1800);
  assert.ok(t.arrow(), 'the reply grew below the view: the arrow is back');
  await click('Jump to the latest message');
  assert.equal(t.scrolls().length, 1);
});

test('a reader who is following keeps following when the content gets shorter under them', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.scroll(1100, 1700);
  await t.grow();
  assert.equal(t.scrolls().length, 1, 'still at the end, still followed');
});

test('the arrow says an answer is waiting when a card needs one, and is drawn only while the reader is away and the chat has rows', async () => {
  const draw = async (level: 'none' | 'away' | 'answer', ready = true) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    const away = { get: () => level, subscribe: () => () => undefined };
    await act(async () => root.render(createElement(FollowOverlays, { scroller: { current: null }, away, ready, jump: () => {} })));
    return host;
  };
  const parts = (host: HTMLElement) => host.querySelector('button[aria-label^="Jump to the latest"]')!.querySelectorAll('div').length;
  const plain = await draw('away');
  assert.ok(plain.querySelector('button[aria-label="Jump to the latest message"]'));
  const asks = await draw('answer');
  assert.ok(asks.querySelector('button[aria-label="Jump to the latest message, an answer is waiting"]'), 'a screen reader hears it');
  assert.equal(parts(asks), parts(plain) + 1, 'and the arrow carries a mark');
  const near = await draw('none');
  assert.equal(near.querySelector('button[aria-label^="Jump to the latest"]'), null, 'no arrow at the end');
  const empty = await draw('away', false);
  assert.equal(empty.querySelector('button[aria-label^="Jump to the latest"]'), null, 'no arrow before there are rows');
});
