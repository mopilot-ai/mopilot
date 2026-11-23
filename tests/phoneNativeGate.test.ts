// Native text views are mounted when a chat is still and the run is near the screen (#5369): the gate's timing, and a run's own states: not at open, not during a scroll, only near the screen, at once when touched, never after it is gone, and kept once mounted.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
function FakeNative(props: any) {
  (g.__nativeRuns ??= []).push(props);
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}
mock.module(require.resolve('expo'), { namedExports: { requireNativeView: () => FakeNative } });
const nativePath = '../mobile/src/platform/selectableTextNative';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const bubblePath = '../mobile/src/components/MessageBubble';
const gatePath = '../mobile/src/presentation/nativeGate';
await import(nativePath);
const { setInPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const { createNativeGate, isNear, nativeGate, OPEN_SETTLE, SCROLL_IDLE, NEAR_SCREENS, KEEP_SCREENS, MENU_GRACE, MENU_WAIT } = await import(
  gatePath
);
const runPath = '../mobile/src/components/NativeRun';
const { PARITY_SLACK } = await import(runPath);

/** A gate with timers the test turns by hand. */
function manual() {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let id = 0;
  const gate = createNativeGate({
    set: (fn: () => void, ms: number) => (pending.set(++id, { at: now + ms, fn }), id),
    clear: (n: number) => void pending.delete(n),
  });
  return {
    gate,
    tick(ms: number) {
      now += ms;
      for (const [n, p] of [...pending]) {
        if (p.at <= now) {
          pending.delete(n);
          p.fn();
        }
      }
    },
  };
}

test('unconfigured, runs are native at once: the gate is never busy and ignores opens and scrolls', () => {
  const { gate, tick } = manual();
  assert.equal(gate.lazy(), false);
  gate.open();
  gate.activity();
  assert.equal(gate.idle(), true);
  let rested = 0;
  gate.onIdle(() => (rested += 1));
  tick(10_000);
  assert.equal(rested, 0);
});

test('a chat is still OPEN_SETTLE after it opens, and the runs hear it once', () => {
  const { gate, tick } = manual();
  gate.configure(true);
  assert.equal(gate.idle(), true, 'nothing is open yet');
  let rested = 0;
  const off = gate.onIdle(() => (rested += 1));
  gate.open();
  assert.equal(gate.idle(), false);
  tick(OPEN_SETTLE - 1);
  assert.equal(gate.idle(), false);
  tick(1);
  assert.equal(gate.idle(), true);
  assert.equal(rested, 1);
  // a second open restarts the wait instead of adding one
  gate.open();
  tick(OPEN_SETTLE - 10);
  gate.open();
  tick(OPEN_SETTLE - 10);
  assert.equal(gate.idle(), false);
  tick(10);
  assert.equal(rested, 2);
  off();
  gate.open();
  tick(OPEN_SETTLE);
  assert.equal(rested, 2, 'a run that is gone is not told');
});

test('every scroll report holds the gate; it opens SCROLL_IDLE after the last one, so a fling that is interrupted or a pause between flicks cannot leave it stuck', () => {
  const { gate, tick } = manual();
  gate.configure(true);
  let rested = 0;
  gate.onIdle(() => (rested += 1));
  // a fling reports all along, at the list's throttle
  for (let i = 0; i < 40; i++) {
    gate.activity();
    assert.equal(gate.idle(), false);
    tick(SCROLL_IDLE - 100);
  }
  assert.equal(rested, 0);
  // a finger stops it and no end event ever comes: the reports just stop
  tick(SCROLL_IDLE);
  assert.equal(gate.idle(), true);
  assert.equal(rested, 1);
  // a pause shorter than SCROLL_IDLE between two flicks keeps it held
  gate.activity();
  tick(SCROLL_IDLE - 1);
  gate.activity();
  tick(SCROLL_IDLE - 1);
  assert.equal(gate.idle(), false);
  // saying the same thing again changes nothing: the app repeats it on each render, and a wait in progress goes on
  gate.configure(true);
  assert.equal(gate.idle(), false);
  tick(1);
  assert.equal(gate.idle(), true);
  assert.equal(rested, 2);
  // turning it off drops a wait in progress
  gate.activity();
  gate.configure(false);
  tick(OPEN_SETTLE);
  assert.equal(gate.idle(), true);
  assert.equal(rested, 2);
});

test('a long press on a shown native view opens the app’s sheet unless the view answers it: held still it waits MENU_WAIT, and once the finger is up MENU_GRACE (#5369)', () => {
  const { gate, tick } = manual();
  let sheets = 0;
  const open = () => (sheets += 1);
  // the view never answers, the finger stays down
  gate.touch(true);
  gate.awaitMenu(open);
  tick(MENU_WAIT - 1);
  assert.equal(sheets, 0);
  tick(1);
  assert.equal(sheets, 1, 'a blank stretch of the view, or a recogniser that failed: the sheet');
  // the finger lifts with the wait running: MENU_GRACE from the lift, not MENU_WAIT from the press
  gate.touch(true);
  gate.awaitMenu(open);
  tick(MENU_WAIT - 100);
  gate.release();
  tick(MENU_GRACE - 1);
  assert.equal(sheets, 1);
  tick(1);
  assert.equal(sheets, 2);
  // already up when the press fires: the grace alone
  gate.touch(true);
  gate.release();
  gate.awaitMenu(open);
  tick(MENU_GRACE);
  assert.equal(sheets, 3);
  // a release with nothing waiting changes nothing
  gate.release();
  tick(10_000);
  assert.equal(sheets, 3);
});

test('a menu shown or words selected by the view cancel the sheet for that touch, before or after the press fires; an answer to a later touch does not', () => {
  const { gate, tick } = manual();
  let sheets = 0;
  const open = () => (sheets += 1);
  gate.touch(true);
  gate.awaitMenu(open);
  gate.answer();
  tick(10_000);
  assert.equal(sheets, 0, 'answered while waiting');
  // answered before the press fired (the view selected its word first): nothing to wait for
  gate.touch(true);
  gate.answer();
  gate.awaitMenu(open);
  tick(10_000);
  assert.equal(sheets, 0, 'answered before the press fired');
  // two touches: the second is answered, the first press still waits for its own answer and opens the sheet
  gate.touch(true);
  gate.awaitMenu(open);
  gate.touch(true);
  gate.answer();
  tick(MENU_WAIT);
  assert.equal(sheets, 1, 'the first press was never answered');
  // a press that starts waiting again replaces the one before it (one sheet, not two)
  gate.touch(true);
  gate.awaitMenu(open);
  gate.awaitMenu(open);
  tick(10_000);
  assert.equal(sheets, 2);
  gate.touch(true);
  assert.equal(gate.touchedNative(), true);
  gate.touch(false);
  assert.equal(gate.touchedNative(), false, 'a new touch starts with no native view under it');
});

test('a run is near within a screen fraction above and below the window, and kept within more', () => {
  const screen = 900;
  assert.equal(isNear(0, 40, screen), true);
  assert.equal(isNear(-NEAR_SCREENS * screen - 40, 40, screen), true, 'its bottom edge just reaches the margin above');
  assert.equal(isNear(-NEAR_SCREENS * screen - 41, 40, screen), false);
  assert.equal(isNear((1 + NEAR_SCREENS) * screen, 40, screen), true);
  assert.equal(isNear((1 + NEAR_SCREENS) * screen + 1, 40, screen), false);
  assert.equal(isNear((1 + NEAR_SCREENS) * screen + 1, 40, screen, KEEP_SCREENS), true, 'kept further out than it is made native');
  assert.equal(isNear((1 + KEEP_SCREENS) * screen + 1, 40, screen, KEEP_SCREENS), false);
});

// ---- a run in a chat

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  nativeGate.configure(false);
  g.__phoneWindowTop = undefined;
  g.__phoneNoMeasure = undefined;
  g.__phoneContentTop = undefined;
  nativeGate.open();
  mock.timers.reset();
  setInPlaceSelection(false);
});
async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  return { host, root, unmount: () => act(async () => root.unmount()), isNative: () => !!host.querySelector('[data-native-run]') };
}
const bubble = (streaming = false) => createElement(MessageBubble, { role: 'assistant', text: 'Hello world', streaming });
const natives = () => (g.__nativeRuns as any[]).length;
const quiet = async (ms: number) => act(async () => mock.timers.tick(ms));
const lazy = () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  nativeGate.configure(true);
};
/** The run's wrapper (what a finger lands on, and what is measured). */
const wrapperOf = (host: HTMLElement) => [...host.querySelectorAll('div')].find((d: any) => d.__touchStartCapture && d.__onLayout) as any;
/** The screen is 926 high in the test window. */
const SCREEN = 926;

test('a run opened in a chat that is still starts as React text and becomes native once the first screens are still', async () => {
  lazy();
  nativeGate.open();
  const v = await mount(bubble());
  assert.equal(natives(), 0, 'no native view at open');
  assert.ok(v.host.textContent!.includes('Hello world'), 'the words are there as React text');
  await quiet(OPEN_SETTLE - 1);
  assert.equal(natives(), 0);
  await quiet(1);
  assert.equal(v.isNative(), true, 'native once the chat is still, as the run is near the screen');
});

/** A chat opened and followed to its end, as a phone opens one: the list lays out and its content grows, and no scroll report comes; the window answers a screen too low. */
async function openedWithoutScroll(laidOut: boolean) {
  lazy();
  const followPath = '../mobile/src/remote/useFollowEnd';
  const { useFollowEnd } = await import(followPath);
  g.__phoneInner = { inner: true };
  g.__phoneWindowTop = 5 * SCREEN;
  g.__phoneContentTop = 2400;
  let list: any;
  const Host = () => {
    list = useFollowEnd('chat', '');
    list.ref.current = { getInnerViewRef: () => g.__phoneInner, scrollTo: () => undefined, scrollToEnd: () => undefined };
    return bubble();
  };
  const v = await mount(createElement(Host));
  if (laidOut) {
    await act(async () => list.props.onContentSizeChange(0, 3000));
    await act(async () => list.props.onLayout({ nativeEvent: { layout: { height: SCREEN } } }));
  }
  await quiet(OPEN_SETTLE);
  return v;
}

test('a chat opened and followed to its end is promoted once it is still, with no scroll report at all, though the window answers a screen too low (#5369: a fresh open on a phone)', async () => {
  const v = await openedWithoutScroll(true);
  assert.equal(v.isNative(), true, 'laid out and at rest: native, near the end it is followed to');
  g.__phoneInner = undefined;
});

test('without the layout the gate has no window to place a run by, and the window’s own answer keeps it React text: why a fresh open was never promoted', async () => {
  const v = await openedWithoutScroll(false);
  assert.equal(v.isNative(), false);
  g.__phoneInner = undefined;
});

test('a run far from the screen waits, becomes native when the view rests near it, is kept a screen or two away, and goes back to React text beyond that', async () => {
  lazy();
  g.__phoneWindowTop = 5000;
  const v = await mount(bubble());
  assert.equal(v.isNative(), false, 'still, but far below the screen');
  // the reader scrolls it near: reports come all along, then stop
  g.__phoneWindowTop = 300;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE - 1);
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE - 1);
  assert.equal(v.isNative(), false, 'not while the view moves');
  await quiet(1);
  assert.equal(v.isNative(), true);
  // scrolled a screen away: kept, not swapped out and drawn again
  g.__phoneWindowTop = (1 + NEAR_SCREENS) * SCREEN + 200;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), true, 'further than it is made native, nearer than it is dropped');
  // well away: React text again, so a long session does not collect native views
  g.__phoneWindowTop = (1 + KEEP_SCREENS) * SCREEN + 200;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), false);
  assert.ok(v.host.textContent!.includes('Hello world'));
  // and near again: native again
  g.__phoneWindowTop = 100;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), true);
});

test('a finger on a run that is still React text asks for the native view at once, unless the list is scrolling; where the window cannot say how far a run is, that is the only way it becomes native', async () => {
  lazy();
  g.__phoneNoMeasure = true;
  const v = await mount(bubble());
  const wrapper = wrapperOf(v.host);
  assert.ok(wrapper, 'the run listens for a finger');
  // the list is moving (a drag over runs would mount each of them)
  await act(async () => nativeGate.activity());
  await act(async () => wrapper.__touchStartCapture());
  assert.equal(v.isNative(), false, 'a press during a scroll is a scroll');
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), false, 'the window cannot measure it, so it waits for a finger');
  // at rest, a finger on it
  await act(async () => wrapper.__touchStartCapture());
  assert.equal(v.isNative(), true, 'the next press selects');
  // and it stays, whatever the window says later (it could not say)
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), true);
});

test('a run whose row is dropped before the screen answers is not mounted, and a window that cannot measure leaves it as React text', async () => {
  lazy();
  nativeGate.open();
  // the window answers later than the run lives
  const answers: (() => void)[] = [];
  const v = await mount(bubble());
  wrapperOf(v.host).measureInWindow = (done: any) => answers.push(() => done(0, 100, 300, 40));
  await quiet(OPEN_SETTLE);
  assert.equal(answers.length, 1, 'asked once the chat was still');
  await v.unmount();
  answers[0]();
  assert.equal(natives(), 0, 'nothing is mounted for a run that has gone');
  // a view with no way to measure (nothing to ask) is left as it is
  g.__phoneNoMeasure = true;
  const w = await mount(bubble());
  await act(async () => nativeGate.open());
  await quiet(OPEN_SETTLE);
  assert.equal(w.isNative(), false);
  assert.ok(w.host.textContent!.includes('Hello world'));
});

test('a reply that finishes streaming while the chat is still becomes native when measured; while the list is scrolling (a streaming reply followed to the end keeps reporting) it stays React text', async () => {
  lazy();
  const v = await mount(bubble(true));
  assert.equal(v.isNative(), false, 'streaming words are React, with the fade');
  await act(async () => nativeGate.activity());
  await act(async () => v.root.render(bubble(false)));
  assert.equal(v.isNative(), false, 'the stream ended while the list is still reporting scrolls: not yet');
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), true, 'native once the reports stop');
});

test('unconfigured (a build without selection, or a test), the run is native in its first render', async () => {
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  await mount(bubble());
  assert.equal(natives(), 1);
});

test('becoming native moves nothing: the view takes the React text’s height when its own is within a few points of it, and its own when it is not', async () => {
  const heightNow = () => (g.__nativeRuns as any[]).at(-1).style.height;
  const report = (h: number) => act(async () => (g.__nativeRuns as any[]).at(-1).onContentSize({ nativeEvent: { height: h } }));
  lazy();
  nativeGate.open();
  const v = await mount(bubble());
  // the React text was laid out at 479.67 (a third of a point is a pixel at 3x)
  await act(async () => wrapperOf(v.host).__onLayout({ nativeEvent: { layout: { height: 479.67 } } }));
  await quiet(OPEN_SETTLE);
  // a view that has not laid its text out yet says less than a line: nothing
  await report(10);
  assert.ok(heightNow() < 479, 'still its first guess');
  await report(477);
  assert.equal(heightNow(), 479.67, 'its text is 2.67 shorter: the React height, so nothing below it moves');
  // the same report again changes nothing, and does not give the height back
  await report(477);
  assert.equal(heightNow(), 479.67);
  // a real change (a streamed append that adds a line, a different width) is its own height
  await report(479.67 + PARITY_SLACK + 1);
  assert.equal(heightNow(), 479.67 + PARITY_SLACK + 1);
  // going back to React text forgets the pin: a run that becomes native again is measured again
  g.__phoneWindowTop = (1 + KEEP_SCREENS) * SCREEN + 200;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), false);
  g.__phoneWindowTop = 0;
  await act(async () => wrapperOf(v.host).__onLayout({ nativeEvent: { layout: { height: 100 } } }));
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  await report(300);
  assert.equal(heightNow(), 300, 'more than a few points from the React text: its own height');
  await report(102);
  assert.equal(heightNow(), 100, 'and within a few points of the new React height: that one');
});

test('a settled native run answers its own echoes with no commit: the same layout, the same height report and the same rest of the list, fifty times, render nothing (#5351 class)', async () => {
  lazy();
  nativeGate.open();
  const v = await mount(bubble());
  await act(async () => wrapperOf(v.host).__onLayout({ nativeEvent: { layout: { height: 100 } } }));
  await quiet(OPEN_SETTLE);
  await act(async () => (g.__nativeRuns as any[]).at(-1).onContentSize({ nativeEvent: { height: 100 } }));
  assert.equal(v.isNative(), true);
  const renders = natives();
  for (let i = 0; i < 50; i++) {
    // the wrapper is laid out again at the height it has, the view reports the height it reported, and the list rests again where it was
    await act(async () => wrapperOf(v.host).__onLayout({ nativeEvent: { layout: { height: 100 } } }));
    await act(async () => (g.__nativeRuns as any[]).at(-1).onContentSize({ nativeEvent: { height: 100 } }));
    await act(async () => nativeGate.activity());
    await quiet(SCROLL_IDLE);
  }
  assert.equal(natives(), renders, 'no render came of an echo: nothing here asks the list for anything in answer to its own report');
});

// ---- where a run is: its place in the list's content less where the list's window stands (#5369, the first long press after a scroll)

test('the gate keeps where the list stands and a way to its content; a chat that opens forgets the first, and letting go of the content leaves a newer one', () => {
  const { gate } = manual();
  assert.equal(gate.viewport(), null);
  assert.equal(gate.content(), null);
  gate.view(500, 800);
  assert.deepEqual(gate.viewport(), { top: 500, height: 800 });
  const node = { id: 1 };
  const release = gate.attach(() => node);
  assert.equal(gate.content(), node);
  const newer = gate.attach(() => ({ id: 2 }));
  release();
  assert.deepEqual(gate.content(), { id: 2 }, 'the older owner letting go leaves the newer one');
  newer();
  assert.equal(gate.content(), null);
  assert.equal(gate.attach(() => null) && gate.content(), null, 'a list whose content is not there yet has none');
  gate.open();
  assert.equal(gate.viewport(), null, 'another chat’s window says nothing about this one');
});

test('a run is placed by its place in the content, not by the window’s own answer, which was seen to put every run a screen too low once the list had gone to its end', async () => {
  lazy();
  nativeGate.attach(() => ({}));
  // the reader is at the end: the list's window stands at 5500, and the run is 500 into it (6000 in the content). The window says 1465: a screen too far
  nativeGate.view(5500, SCREEN);
  g.__phoneContentTop = 6000;
  g.__phoneWindowTop = 1465;
  const v = await mount(bubble());
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), true, 'on the screen, so native, whatever the window said');
  // the same run, with the window saying it is on screen while the list says it is far above
  g.__phoneContentTop = 100;
  g.__phoneWindowTop = 300;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), false, 'far above the window: React text again, whatever the window said');
});

test('scroll a little, rest, and the run under the finger is native, with nothing the reader has to do first; a content that cannot be measured is asked of the window', async () => {
  lazy();
  nativeGate.attach(() => ({}));
  nativeGate.view(5500, SCREEN);
  g.__phoneContentTop = 5500 + 540;
  // the chat has just been opened and scrolled to its end: the runs are drawn while it is still moving
  nativeGate.activity();
  const v = await mount(bubble());
  assert.equal(v.isNative(), false);
  // a drag of twenty points: one report, then the list rests
  nativeGate.view(5520, SCREEN);
  g.__phoneContentTop = 5500 + 540;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE - 1);
  assert.equal(v.isNative(), false, 'not while the list moves');
  await quiet(1);
  assert.equal(v.isNative(), true, 'at rest, the run at 540 is native');
  // the content cannot say (its measure fails): the window is asked, as before
  g.__phoneContentTop = undefined;
  g.__phoneWindowTop = (1 + KEEP_SCREENS) * SCREEN + 200;
  await act(async () => nativeGate.activity());
  await quiet(SCROLL_IDLE);
  assert.equal(v.isNative(), false);
});
