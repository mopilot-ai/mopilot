// A finger's moves keep the silence timer from taking it for a lost end, a timer that fires during a drag looks again once the drag is over, and a lift catches up a view that is a few points short of the end (#5686 follow-up to #5688).
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const followPath = '../mobile/src/remote/useFollowEnd';
const { Thread } = await import(threadPath);
const { TOUCH_SILENCE, MOVE_KEEPALIVE } = await import(followPath);
const g = globalThis as any;

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  mock.timers.reset();
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

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
    ends: () => g.__scrolledToEnd.length as number,
    tos: () => g.__scrolledTo as { y: number }[],
    report: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    grow: (h: number) => act(async () => ev().onContentSizeChange(0, h)),
    drag: () => act(async () => ev().onScrollBeginDrag({ nativeEvent: {} })),
    lift: () => act(async () => ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } })),
    coast: () => act(async () => ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 1.4 } } })),
    stop: () => act(async () => ev().onMomentumScrollEnd()),
    move: () => act(async () => ev().onTouchMove({ nativeEvent: { changedTouches: [{}] } })),
    down: (n = 1) => act(async () => ev().onTouchStart({ nativeEvent: { changedTouches: Array.from({ length: n }, () => ({})) } })),
    up: (n = 1) => act(async () => ev().onTouchEnd({ nativeEvent: { changedTouches: Array.from({ length: n }, () => ({})) } })),
    background: () => act(async () => g.__phoneAppState?.('background')),
  };
}

const tick = (ms: number) => act(async () => mock.timers.tick(ms));

test('a finger that keeps moving is not silent: its moves start the timer again, at most once per MOVE_KEEPALIVE', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.report(1400);
  await t.down();
  await tick(TOUCH_SILENCE - 1000);
  await t.move(); // after MOVE_KEEPALIVE since the timer started: starts it again
  await tick(TOUCH_SILENCE - 1);
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'the finger moved just now: it is still down');
  await tick(2);
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'no move since: its end never came');
  // a move right after the timer started does not start another: the silence is counted from the touch
  const u = await open();
  await u.report(1400);
  await u.down();
  await tick(MOVE_KEEPALIVE - 1);
  await u.move();
  await tick(TOUCH_SILENCE - MOVE_KEEPALIVE + 2);
  await u.grow(2100);
  assert.ok(u.ends() >= 1, 'a move within MOVE_KEEPALIVE of the start is not a new start');
  // a move with no finger counted holds nothing
  const v = await open();
  await v.report(1400);
  await v.move();
  await v.grow(2100);
  assert.ok(v.ends() >= 1, 'a stray move holds nothing');
});

test('the silence timer that fires during a drag looks again later: a finger left resting whose end was lost does not hold the view for good', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.report(1400);
  await t.down(); // rests
  await t.down(); // drags
  await t.drag();
  await tick(TOUCH_SILENCE + 1); // fires during the drag: the finger that moves is not silent
  await t.lift(); // the dragging finger is gone; the one that rests stays counted
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'a finger still rests on the list');
  await tick(TOUCH_SILENCE + 1);
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'its end never came, and the timer looked again after the drag');
});

test('a lift catches up a view a few points short of the end, and asks for nothing from the end itself', async () => {
  const t = await open();
  await t.report(1400);
  await t.down();
  await t.grow(2040); // grew 40 under the finger: within reach of the end, not at it
  assert.equal(t.ends(), 0, 'the finger holds the view');
  await t.up();
  assert.ok(t.ends() >= 1, 'the lift takes the view the rest of the way');
  const u = await open();
  await u.report(1400);
  await u.down();
  await u.up();
  assert.equal(u.ends(), 0, 'from the end itself the list is not asked: its answer would be asked again (#5351)');
});

test('the silence timer that fires after the dragging finger went (its glide goes on) finds no finger and lets go of nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.report(1400);
  await t.down();
  await t.drag();
  await act(async () => g.__scrollEvents.onScrollEndDrag({ nativeEvent: { velocity: { y: 1.4 } } })); // the finger is gone, the glide goes on
  // the glide keeps reporting, as a glide does, for longer than the touch silence
  for (let i = 0; i < 7; i++) {
    await tick(1000);
    await t.report(1400);
  }
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'the glide holds the view');
  await act(async () => g.__scrollEvents.onMomentumScrollEnd());
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'and the glide’s end lets it go');
});
