// A send's pin is a one-shot (#5686): it places the sent message when the room under it exists, may place it again only while the send is fresh and untouched (the keyboard going down with it), and ends for good at the first touch, drag, keyboard coming up or after PIN_WINDOW. After that nothing the chat does (a view resized by the composer growing or the keyboard, the sent bubble moving, content growing, a re-read) takes the view back to the message the reader sent earlier.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';

const followPath = '../mobile/src/remote/useFollowEnd';
const originPath = '../mobile/src/sendOrigin';
const { useFollowEnd, PIN_INSET, PIN_WINDOW } = await import(followPath);
const { reportSentTop } = await import(originPath);
const perfPath = '../mobile/src/perfLog';
const { perf } = await import(perfPath);
const g = globalThis as any;

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  mock.timers.reset();
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

/** The hook alone, with the list's calls recorded. */
async function probe() {
  const to: { y?: number; animated?: boolean }[] = [];
  const end: unknown[] = [];
  let out: any;
  const Probe = () => {
    out = useFollowEnd('chat', '');
    out.ref.current = {
      scrollTo: (o: { y: number; animated?: boolean }) => to.push(o),
      scrollToEnd: (o: unknown) => end.push(o),
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
    to,
    end,
    out: () => out,
    report: (y: number, content = 2000, view = 600) =>
      act(async () =>
        out.props.onScroll({
          nativeEvent: { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } },
        }),
      ),
    grow: (h?: number) => act(async () => out.props.onContentSizeChange(0, h)),
    layout: (h: number) => act(async () => out.props.onLayout({ nativeEvent: { layout: { height: h } } })),
    touch: () => act(async () => out.props.onTouchStart()),
    drag: () => act(async () => out.props.onScrollBeginDrag()),
    keyboard: (name: string) => act(async () => g.__keyboardListeners[name]?.()),
    pin: () => act(async () => out.pin()),
    sentTop: (y: number, refine = false) => act(async () => reportSentTop(y, refine)),
  };
}
/** A send pinned and placed: the content was 2000 in a view of 600, the room under the message arrived, and the view went to the message. */
async function sent() {
  const p = await probe();
  await p.layout(600);
  await p.report(1400);
  await p.pin();
  await p.grow(2100);
  await p.grow(2000 - PIN_INSET + 600);
  assert.deepEqual(p.to, [{ y: 2000 - PIN_INSET, animated: false }], 'the first and only placing');
  return Object.assign(p, { base: calls(p) });
}
function calls(p: { to: unknown[]; end: unknown[] }) {
  return p.to.length + p.end.length;
}

test('the pin is live until the reader touches, drags, or the keyboard comes up, and the list keeps its anchor once it ends', async () => {
  const p = await sent();
  assert.equal(p.out().pinArmed, true, 'right after the send: the rows around the message do not move it');
  await p.touch();
  assert.equal(p.out().pinArmed, false, 'a touch ends it');
  const q = await sent();
  await q.drag();
  assert.equal(q.out().pinArmed, false, 'so does a drag');
  const k = await sent();
  await k.keyboard('keyboardWillShow');
  assert.equal(k.out().pinArmed, false, 'and the keyboard coming up (typing the next message)');
  const d = await sent();
  await d.keyboard('keyboardDidShow');
  assert.equal(d.out().pinArmed, false, 'on Android only the did event exists');
});

test('typing the next message does not take the view back to the message sent before: the composer growing and the keyboard resizing the view are not a pin', async () => {
  const p = await sent();
  // the reader reads the reply and then taps the composer: the keyboard comes up and the view is resized, line by line as they type
  await p.report(1900, 2584);
  await p.keyboard('keyboardWillShow');
  await p.layout(300);
  await p.layout(280);
  await p.layout(260);
  await p.grow(2700);
  await p.grow(2800);
  assert.equal(calls(p), p.base, 'nothing scrolled after the first placing');
});

test('a view resized after a touch on the list is the reader’s: no pin again, however it is resized', async () => {
  const p = await sent();
  await p.touch();
  await p.layout(300);
  await p.layout(280);
  await p.grow(2700);
  assert.equal(calls(p), p.base);
});

test('the sent bubble moving after the pin has ended does not take the view back to it', async () => {
  const p = await sent();
  await p.sentTop(2050);
  await p.grow(2042 + 600);
  assert.equal(p.to.length, 2, 'a fresh send still corrects the place (the row above it changed height)');
  await p.drag();
  await p.sentTop(2000);
  await p.grow(2700);
  assert.equal(p.to.length, 2, 'after a drag the bubble is just a row');
});

test('a pin older than its window has had its time: a resize or a moved bubble does not place the message again', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const p = await sent();
  mock.timers.tick(PIN_WINDOW + 1);
  await p.layout(300);
  await p.sentTop(2050);
  await p.grow(2700);
  await p.grow(3300);
  assert.equal(calls(p), p.base, 'a reply that finished, a footer, a re-read: nothing takes the reader back to the message');
  assert.equal(p.out().pinArmed, false);
});

test('while the send is fresh and untouched the keyboard going down still takes the room under the message with it (the first placing is kept)', async () => {
  const p = await sent();
  await p.layout(900);
  await p.grow(1984 + 900);
  assert.deepEqual(p.to.at(-1), { y: 2000 - PIN_INSET, animated: false }, 'the message goes back to the top once');
  assert.equal(p.to.length, 2);
});

test('a moved sent bubble after the window is not a pin: the scroll it asks for is the content’s first growth, which sees the time', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const p = await sent();
  mock.timers.tick(PIN_WINDOW + 1);
  await p.sentTop(2050);
  await p.grow(2700);
  assert.equal(calls(p), p.base);
});

test('a scroll of the view that no finger and no call of ours made, in either direction, is the reader’s and ends the pin; a resize or a clamp is not', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const p = await sent();
  // the view clamped by the keyboard dropping (its height changed): not a reader
  mock.timers.tick(700);
  await p.report(1700, 2584, 900);
  assert.equal(p.out().pinArmed, true, 'the view’s own height changed');
  // a screen reader scrolls it down, then up
  await p.report(1900, 2584, 900);
  assert.equal(p.out().pinArmed, false, 'a scroll with nothing behind it');
  const q = await sent();
  mock.timers.tick(700);
  await q.report(1500, 2584);
  await q.report(1300, 2584);
  assert.equal(q.out().pinArmed, false, 'up as well');
  await q.layout(300);
  await q.grow(2700);
  assert.equal(calls(q), q.base, 'and nothing places the message again');
});

test('a scroll right after the pin’s own is the pin’s echo, not the reader', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const p = await sent();
  await p.report(1984, 2584);
  assert.equal(p.out().pinArmed, true);
});

test('a Thread that is mounted again after a send starts with no pin: nothing it does takes the view to a message sent before', async () => {
  const p = await sent();
  await act(async () => mounted.shift()!.root.unmount());
  const q = await probe();
  assert.equal(q.out().pinArmed, false);
  await q.layout(600);
  const base = calls(q);
  await q.layout(300);
  await q.sentTop(2050);
  await q.grow(2700);
  assert.equal(q.to.length, 0, 'no placing: a chat that follows its end only scrolls to the end');
  assert.ok(calls(q) >= base, 'the ordinary follow of the end goes on');
  void p;
});

test('the Mac answering again after an offline cycle does not take a reader who read the reply back to the message they sent: its row of that message is not a pin', async () => {
  const p = await sent();
  await p.sentTop(2042); // the bubble reported its place once: later corrections are followed while the pin is live
  await p.drag(); // the reader scrolls down to read the reply
  await p.report(2200, 3000);
  await p.layout(600);
  // the Mac goes away and answers again: its last user row reports its top, and the content is replaced under the same keys
  await p.sentTop(2050, true);
  await p.grow(3000);
  await p.sentTop(2060, true);
  await p.grow(3100);
  assert.equal(calls(p), p.base, 'no scroll');
  assert.equal(p.out().pinArmed, false);
});

test('a reader who only read, for longer than the window, is not taken back when the Mac’s row of the message reports its place: the room is not recomputed either', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const p = await sent();
  await p.sentTop(2042);
  const room = p.out().reserve;
  mock.timers.tick(PIN_WINDOW + 1);
  await p.sentTop(2050, true);
  await p.grow(2900);
  assert.equal(calls(p), p.base, 'no scroll');
  assert.equal(p.out().reserve, room, 'the room under the message is left as it was');
  assert.equal(p.out().pinArmed, false);
});

test('once the pin is over the room under the sent message follows the view’s height without scrolling, so a keyboard that goes down later does not clamp the reader’s place', async () => {
  const p = await sent();
  const room = p.out().reserve;
  assert.equal(room, 2000 - PIN_INSET + 600);
  await p.touch(); // the reader took the view before the keyboard finished going down
  await p.layout(900); // the keyboard has gone down: the view is taller
  assert.equal(p.out().reserve, 2000 - PIN_INSET + 900, 'the content keeps the room the taller view needs');
  assert.equal(calls(p), p.base, 'and nothing scrolled');
  await p.layout(900); // the same height again changes nothing
  assert.equal(p.out().reserve, 2000 - PIN_INSET + 900);
});

test('a growth, keyboard or clamp scroll just before does not hide the reader’s scroll from the pin: only the pin’s own scroll is an echo', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const p = await sent();
  mock.timers.tick(700); // the pin’s own scroll is old now
  await p.report(2900, 2584); // the content is shorter than where the view stands: the chat clamps it (a scroll of ours, but not the pin's)
  await p.report(1990, 2584);
  assert.equal(p.out().pinArmed, true, 'our own clamp is not the reader');
  await p.report(1700, 2584); // the reader scrolls by some means we do not see, just after our clamp
  assert.equal(p.out().pinArmed, false, 'the reader’s scroll ends the pin whatever else we scrolled a moment ago');
});

test('a keyboard that moves while a message is pinned moves nothing of the pinned view, and the lift says why', async () => {
  perf.start();
  try {
    const p = await sent();
    const frame = (h: number) => ({ screenY: 926 - h, height: h });
    await act(async () =>
      g.__keyboardListeners.keyboardWillChangeFrame?.({ duration: 250, startCoordinates: frame(0), endCoordinates: frame(300) }),
    );
    assert.equal(perf.report().events['keyboard-skip-pinned'], 1);
    assert.equal(p.out().pinArmed, true);
  } finally {
    perf.end();
  }
});

test('the layouts that come in every frame of a keyboard slide change nothing until its end, for a pinned reader and for one who has left, and then once', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const frame = (h: number) => ({ screenY: 926 - h, height: h });
  const slide = () =>
    act(async () =>
      g.__keyboardListeners.keyboardWillChangeFrame?.({ duration: 250, startCoordinates: frame(0), endCoordinates: frame(300) }),
    );
  for (const reader of ['pinned', 'left']) {
    const p = await sent();
    if (reader === 'left') await p.drag(); // a finger ends the pin: the reader is away, the room under the message is kept
    const room = p.out().reserve;
    const before = calls(p);
    await slide();
    for (const h of [500, 400, 300]) await p.layout(h);
    assert.equal(p.out().reserve, room, `${reader}: the room under the message is not redrawn in every frame`);
    assert.equal(calls(p), before, `${reader}: and nothing is scrolled`);
    await act(async () => mock.timers.tick(250 + 150 + 1));
    // a pinned message keeps the room made at the send (for the view with no keyboard); one the reader left follows the view as it is now (the test's keyboard lifts nothing)
    assert.equal(p.out().reserve, reader === 'pinned' ? room : room - 300, `${reader}: the end of the slide settles the room, once`);
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  }
});
