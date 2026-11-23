// The follow hook against the reader's own moves, from an independent review of #5282: a fling that lifts before it reports, content that shrinks by a hair or is clamped by the chat, a pinned message the reader left, the arrow near the end, and a finger that never lifts. The hook alone, with a stand-in for the list.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';

const followPath = '../mobile/src/remote/useFollowEnd';
const { useFollowEnd } = await import(followPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

async function probe() {
  const calls: { y?: number; end?: boolean }[] = [];
  let out: any;
  const Probe = () => {
    out = useFollowEnd('chat', '');
    out.ref.current = {
      scrollTo: (o: { y: number }) => calls.push({ y: o.y }),
      scrollToEnd: () => calls.push({ end: true }),
      getInnerViewRef: () => (globalThis as any).__phoneInner,
    };
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Probe)));
  return {
    calls,
    out: () => out,
    report: (y: number, content = 2000, view = 600) =>
      act(async () =>
        out.props.onScroll({
          nativeEvent: { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } },
        }),
      ),
    grow: (h?: number) => act(async () => out.props.onContentSizeChange(0, h)),
    layout: (h: number) => act(async () => out.props.onLayout({ nativeEvent: { layout: { height: h } } })),
    down: () => act(async () => out.props.onScrollBeginDrag()),
    lift: (velocity = 0) => act(async () => out.props.onScrollEndDrag({ nativeEvent: { velocity: { y: velocity } } })),
    settled: () => act(async () => out.props.onMomentumScrollEnd()),
    pin: () => act(async () => out.pin()),
    jump: () => act(async () => out.jump()),
  };
}

test('a flick that lifts before it reports is left to its momentum, and followed once it stops', async () => {
  const p = await probe();
  await p.report(1400);
  await p.down();
  await p.lift(-3);
  await p.grow();
  assert.deepEqual(p.calls, [], 'no scroll to the end kills the fling');
  await p.report(900);
  await p.settled();
  assert.deepEqual(p.calls, [], 'the reader left: nothing follows after the momentum either');
  assert.ok(p.out().away);
});

test('a lift with speed that ends at the bottom is followed when its momentum stops', async () => {
  const p = await probe();
  await p.report(1400);
  await p.down();
  await p.lift(2);
  await p.grow(2200);
  await p.report(1400, 2200);
  await p.settled();
  assert.equal(p.calls.length, 1, 'following goes on once the view has stopped');
});

test('a lift with speed that stops at the end with nothing grown has nothing to catch up with (#5351)', async () => {
  const p = await probe();
  await p.report(1400);
  await p.down();
  await p.lift(2);
  await p.report(1400);
  await p.settled();
  assert.equal(p.calls.length, 0, 'the list is not asked to scroll to where it is');
});

test('content that gets shorter by a hair does not stop the reader’s own scroll to the bottom from following again', async () => {
  const p = await probe();
  await p.report(1400);
  await p.report(900);
  assert.equal(p.out().away, true);
  await p.report(1000);
  // the last report: the reader scrolled down to the end, and a reflow made the content 10 points shorter
  await p.report(1390, 1990);
  await p.grow(2100);
  assert.equal(p.calls.length, 1, 'back at the end by their own move: following');
});

test('the chat’s own clamp of a reader who is away is not the reader coming back', async () => {
  const p = await probe();
  await p.report(1400);
  await p.report(900);
  await p.grow(1100);
  assert.deepEqual(p.calls, [{ y: 500 }], 'only the clamp moved the view');
  await p.report(500, 1100);
  await p.grow(1300);
  assert.deepEqual(p.calls, [{ y: 500 }], 'nothing followed after the clamp');
  assert.equal(p.out().away, true, 'the arrow offers the way back once the reply grew past the fold');
});

test('a pinned message the reader scrolled up from does not pull the view back to it', async () => {
  const p = await probe();
  await p.report(1400);
  await p.grow(2000);
  await p.pin();
  await p.grow(2300);
  await p.grow(2900);
  const pinCalls = p.calls.length;
  await p.report(1984, 2900);
  await p.down();
  await p.report(300, 2900);
  await p.lift();
  await p.layout(900);
  await p.grow(3100);
  assert.equal(p.calls.length, pinCalls, 'the keyboard going away and the reply growing leave the reader where they are');
});

test('a small move up near the end leaves, and the arrow follows the distance: none within reach of the end', async () => {
  const p = await probe();
  await p.report(1400);
  await p.down();
  await p.report(1395);
  assert.equal(p.out().away, false, 'five points above the end: no arrow');
  await p.lift();
  await p.grow(2200);
  assert.equal(p.calls.length, 0, 'but the reader left: the growth is not followed');
  assert.equal(p.out().away, true, 'and the arrow shows once the reply is past the fold');
});

test('a finger that never lifts does not hold following back for good: the arrow and a send let go of it', async () => {
  const p = await probe();
  await p.report(1400);
  await p.down();
  await p.jump();
  await p.grow();
  assert.equal(p.calls.length, 2, 'the jump scrolled and the growth is followed again');
  const q = await probe();
  await q.report(1400);
  await q.down();
  await q.pin();
  await q.grow(2400);
  await q.grow(2700);
  assert.ok(
    q.calls.some((c) => c.y !== undefined),
    'a send pins its message whatever the last touch was',
  );
});

test('a followed view with no finger on it is not left blank past the end (a cold open of a long reply stood 107 points up); a finger, a sent message and a reader who left keep their room', async () => {
  const p = await probe();
  await p.report(1400);
  // the view moved once more after the last pin, and no content change followed it: put back at the end, still following
  await p.report(1400 + 107);
  assert.deepEqual(p.calls, [{ y: 1400 }]);
  assert.ok(!p.out().away, 'it is still following');
  // rounding and the screen settling are left alone
  p.calls.length = 0;
  await p.report(1400 + 8);
  assert.deepEqual(p.calls, []);
  // a finger's bounce keeps its room
  await p.down();
  await p.report(1400 + 107);
  assert.deepEqual(p.calls, []);
  await p.lift();
  // a message just sent pins its place and keeps the room under it: no clamp to the end of the reply
  await p.pin();
  p.calls.length = 0;
  await p.report(1400 + 107);
  assert.deepEqual(p.calls, []);
  // a reader who left the end is where they left themselves
  const away = await probe();
  await away.report(1400);
  await away.report(300);
  await away.report(1400 + 107);
  assert.deepEqual(away.calls, []);
});

test('the list tells the native-text gate where its window stands, and how to reach its content', async () => {
  const gatePath = '../mobile/src/presentation/nativeGate';
  const { nativeGate } = await import(gatePath);
  const p = await probe();
  const inner = { inner: true };
  (globalThis as any).__phoneInner = inner;
  await p.report(1400, 2000, 600);
  assert.deepEqual(nativeGate.viewport(), { top: 1400, height: 600 });
  assert.equal(nativeGate.content(), inner);
  // a report without numbers says nothing; a list with no way to its content gives none
  nativeGate.open();
  await act(async () => p.out().props.onScroll({ nativeEvent: {} }));
  assert.equal(nativeGate.viewport(), null);
  (globalThis as any).__phoneInner = undefined;
  assert.equal(nativeGate.content(), null, 'a list with no inner view gives none');
});

test('a chat that opens and is followed to its end tells the native-text gate where its window stands with no scroll report at all (#5369: a fresh open on a phone)', async () => {
  const gatePath = '../mobile/src/presentation/nativeGate';
  const { nativeGate } = await import(gatePath);
  nativeGate.open();
  const p = await probe();
  // the list laid out and its content grew, and nothing has scrolled: no report came
  assert.equal(nativeGate.viewport(), null);
  await p.grow(2000);
  assert.equal(nativeGate.viewport(), null, 'the view has not been laid out yet: its size is not known');
  await p.layout(600);
  assert.deepEqual(nativeGate.viewport(), { top: 1400, height: 600 }, 'the end of the content');
  // a later growth of a followed list moves the window to the new end only while no report has said better
  nativeGate.open();
  await p.grow(2300);
  assert.deepEqual(nativeGate.viewport(), { top: 1700, height: 600 });
  // a report is the truth, and a growth afterwards does not replace it
  await p.report(1500, 2300, 600);
  await p.grow(2400);
  assert.deepEqual(nativeGate.viewport(), { top: 1500, height: 600 });
  // a short chat has no scroll: the window is its start
  nativeGate.open();
  await p.grow(300);
  assert.deepEqual(nativeGate.viewport(), { top: 0, height: 600 });
  // jumping to the newest opens the gate again: the window is the end of the content before the list says anything
  await p.grow(2000);
  await p.jump();
  assert.deepEqual(nativeGate.viewport(), { top: 1400, height: 600 });
});

test('a reader who is not following the end gives the gate no guess: it waits for a report', async () => {
  const gatePath = '../mobile/src/presentation/nativeGate';
  const { nativeGate } = await import(gatePath);
  nativeGate.open();
  const p = await probe();
  // a finger moves the view up: the reader leaves the end
  await p.down();
  await p.report(1400);
  await p.report(1000);
  nativeGate.open();
  await p.grow(2100);
  assert.equal(nativeGate.viewport(), null);
});
