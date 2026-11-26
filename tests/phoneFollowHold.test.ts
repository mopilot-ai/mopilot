// The view is the reader's while a finger is down or it glides, whatever order the events come in (review of #5688): a finger put down on a glide keeps it held when the glide ends, a touch or a glide that never reports its end lets go after a while or when the app goes away, the clamp waits for the reader under a finger, and the room under a sent message follows the view once the pin is over.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const followPath = '../mobile/src/remote/useFollowEnd';
const { Thread } = await import(threadPath);
const { GLIDE_SILENCE, TOUCH_SILENCE } = await import(followPath);
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
    down: (n = 1) => act(async () => ev().onTouchStart({ nativeEvent: { changedTouches: Array.from({ length: n }, () => ({})) } })),
    up: (n = 1) => act(async () => ev().onTouchEnd({ nativeEvent: { changedTouches: Array.from({ length: n }, () => ({})) } })),
    background: () => act(async () => g.__phoneAppState?.('background')),
  };
}

test('a finger put down on a gliding list holds the view when the glide ends under it, and the lift catches up', async () => {
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.coast();
  // a finger lands on the glide: the list stops, and the end of the glide is reported with the finger still down
  await t.down();
  await t.stop();
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'the finger is the reader’s');
  await t.up();
  assert.equal(t.ends(), 1, 'let go at the end: what grew meanwhile is caught up');
  // two fingers: one lifting leaves the other holding
  const u = await open();
  await u.report(1400);
  await u.down(2);
  await u.up(1); // one of the two lifts
  await u.grow(2100);
  assert.equal(u.ends(), 0, 'one finger is still down');
});

test('a glide that falls silent has ended after GLIDE_SILENCE, one that keeps reporting has not, and a held finger is never cut', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.report(1300);
  await t.coast();
  await t.report(1250);
  mock.timers.tick(GLIDE_SILENCE - 100);
  await t.report(1200);
  mock.timers.tick(GLIDE_SILENCE - 100);
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'it reports still: the glide goes on');
  await act(async () => mock.timers.tick(GLIDE_SILENCE + 1));
  await t.grow(2200);
  assert.equal(t.ends(), 0, 'the reader left the end: nothing follows after it either');
  // a glide that ends at the end and never says so
  const u = await open();
  await u.report(1400);
  await u.drag();
  await u.report(1300);
  await u.coast();
  await u.report(1400);
  await act(async () => mock.timers.tick(GLIDE_SILENCE + 1));
  await u.grow(2100);
  assert.ok(u.ends() >= 1, 'the silent glide let go at the very end: following goes on');
  // a finger that is down is not a glide: the silence does not let go of it
  const v = await open();
  await v.report(1400);
  await v.down();
  await act(async () => mock.timers.tick(GLIDE_SILENCE * 3));
  await v.grow(2100);
  assert.equal(v.ends(), 0);
});

test('going to the background lets go of a touch whose end was never delivered', async () => {
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.down();
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'held');
  await t.background();
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'nothing is held after the app went away');
});

test('the clamp waits for a reader under a finger and puts the view inside the content when they let go', async () => {
  const t = await open();
  await t.report(1400);
  await t.report(1300);
  await t.drag();
  // the content got shorter under the view: no scroll of ours under the finger
  await t.grow(900);
  assert.deepEqual(t.tos(), [], 'a bounce past the end is the reader’s');
  await t.lift();
  assert.deepEqual(t.tos(), [{ y: 300, animated: false }], 'at rest the view is put back inside the content');
});

test('touch events that do not say how many fingers are down are counted one by one', async () => {
  const t = await open();
  const ev = () => g.__scrollEvents;
  await t.report(1400);
  await act(async () => ev().onTouchStart());
  await act(async () => ev().onTouchStart());
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'two fingers');
  await act(async () => ev().onTouchEnd());
  await t.grow(2200);
  assert.equal(t.ends(), 0, 'one is still down');
  await act(async () => ev().onTouchCancel());
  await t.grow(2300);
  assert.ok(t.ends() >= 1, 'the last finger went: what grew is caught up');
  await act(async () => ev().onTouchCancel());
  await t.grow(2400);
  assert.ok(t.ends() >= 2, 'a cancel with none down counts none');
});

test('a glide that falls silent while a finger is on the list does not let go of the finger', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.report(1400);
  await t.drag();
  await t.coast();
  await t.down();
  await act(async () => mock.timers.tick(GLIDE_SILENCE + 1));
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'the finger holds the view');
  await t.up();
  await t.grow(2150);
  assert.equal(t.ends(), 0, 'the finger went, and the glide that was under it has to end or fall silent');
  await act(async () => mock.timers.tick(GLIDE_SILENCE + 1));
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'it fell silent: nothing holds the view');
});

test('a drag or a glide ends with the finger that made it when no touch end came: the count does not stay above zero', async () => {
  const t = await open();
  await t.report(1400);
  await t.down();
  await t.drag();
  await t.lift(); // iOS took the touch for the scroll and delivered no touch end
  await t.grow(2100);
  assert.equal(t.ends(), 1, 'the lift is a lift: what grew is caught up');
  const u = await open();
  await u.report(1400);
  await u.down();
  await u.drag();
  await u.coast();
  await u.stop();
  await u.grow(2100);
  assert.equal(u.ends(), 1, 'the glide ended with no touch end: nothing is held');
});

test('a finger that landed after the drag began is still down when the drag ends; and only fingers that began on the list are counted, not every finger on the screen', async () => {
  const t = await open();
  await t.report(1400);
  await t.down();
  await t.drag();
  await t.down(); // a second finger
  await t.lift();
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'one finger is still on the list');
  // a finger on the composer is in `touches` but is not a touch of the list
  const u = await open();
  await u.report(1400);
  const ev = () => g.__scrollEvents;
  await act(async () => ev().onTouchStart({ nativeEvent: { touches: [{}, {}], changedTouches: [{}] } }));
  await act(async () => ev().onTouchEnd({ nativeEvent: { touches: [{}], changedTouches: [{}] } }));
  await u.grow(2100);
  assert.equal(u.ends(), 1, 'the composer’s finger does not hold the list');
});

test('a cancel names the fingers it ends: one of two cancelled leaves the other holding the view', async () => {
  const t = await open();
  await t.report(1400);
  await t.down(2);
  await act(async () => g.__scrollEvents.onTouchCancel({ nativeEvent: { changedTouches: [{}] } }));
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'one finger is still down');
  await act(async () => g.__scrollEvents.onTouchCancel({ nativeEvent: { changedTouches: [{}] } }));
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'the last one went');
});

test('a finger that only rests stays counted when a second finger drags and lifts: the drag ends with the finger that made it', async () => {
  const t = await open();
  await t.report(1400);
  await t.down(); // the first finger rests
  await t.down(); // the second one drags
  await t.drag();
  await t.lift();
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'the resting finger still holds the view');
  await t.up();
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'it lifts: following goes on');
  // a drag by a finger that began with two (a two-finger scroll) ends with both
  const u = await open();
  await u.report(1400);
  await u.down(2);
  await u.drag();
  await u.lift();
  await u.grow(2100);
  assert.ok(u.ends() >= 1, 'both fingers began the drag');
});

test('a touch whose end never came (its view unmounted under it) cannot stay counted: the next touch is bounded by the fingers on the screen, and the count heals', async () => {
  const t = await open();
  const ev = () => g.__scrollEvents;
  const start = (onScreen: number) =>
    act(async () => ev().onTouchStart({ nativeEvent: { changedTouches: [{}], touches: Array.from({ length: onScreen }, () => ({})) } }));
  await t.report(1400);
  await start(1); // a finger on a reply that was re-keyed at the end of the turn: its end is never delivered
  await start(1); // a new finger: the screen has one finger, so the count cannot be two
  await t.up();
  await t.grow(2100);
  assert.equal(t.ends(), 1, 'one finger lifted, none is left: what grew is caught up');
  // and the drag arithmetic does not keep a phantom
  const u = await open();
  await u.report(1400);
  const begin = (onScreen: number) =>
    act(async () =>
      g.__scrollEvents.onTouchStart({ nativeEvent: { changedTouches: [{}], touches: Array.from({ length: onScreen }, () => ({})) } }),
    );
  await begin(1); // the phantom
  await begin(1); // a real finger
  await u.drag();
  await u.lift();
  await u.grow(2100);
  assert.equal(u.ends(), 1, 'the drag ended with its finger and nothing else is held');
});

test('a finger that has sent no touch event for TOUCH_SILENCE is gone, one that moves or has just landed is not', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.report(1400);
  await t.down();
  await act(async () => mock.timers.tick(TOUCH_SILENCE - 1));
  await t.grow(2100);
  assert.equal(t.ends(), 0, 'a finger that rests a moment holds the view');
  await act(async () => mock.timers.tick(2));
  await t.grow(2200);
  assert.ok(t.ends() >= 1, 'its end never came: nothing holds the view');
  // a drag in progress is not cut by the silence of touch events
  const u = await open();
  await u.report(1400);
  await u.down();
  await u.drag();
  await act(async () => mock.timers.tick(TOUCH_SILENCE * 2));
  await u.grow(2100);
  assert.equal(u.ends(), 0, 'it is moving');
  // two fingers, one lifts: the other is watched again
  const v = await open();
  await v.report(1400);
  await v.down(2);
  await v.up(1);
  await act(async () => mock.timers.tick(TOUCH_SILENCE + 1));
  await v.grow(2100);
  assert.ok(v.ends() >= 1, 'the one that stayed sent nothing either');
});
