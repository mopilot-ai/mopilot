// The last row travels with the keyboard (#5686): on the device the transcript of a reader at the end stayed still while the keyboard animated and then moved in one frame by its height (about 300 pt opening and closing, about 27 pt when a Pinyin candidate bar came or went). Now the change of the covered height is one scroll that starts with the keyboard's announcement and runs about its time; nothing moves for a reader who left the end or has a finger down, and the settled events correct only what is left.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const followPath = '../mobile/src/remote/useFollowEnd';
const { Thread } = await import(threadPath);
const { KEYBOARD_MARGIN } = await import(followPath);
const perfPath = '../mobile/src/perfLog';
const { perf } = await import(perfPath);
const g = globalThis as any;

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  mock.timers.reset();
  g.__phoneReduceMotion = false;
  g.__phoneKeyboardHeight = 0;
  perf.end();
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

/** The screen is 926 pt tall in the test kit: a keyboard of height h has its top at 926 - h. */
const frame = (h: number) => ({ screenY: 926 - h, height: h || 336 });
const change = (from: number, to: number, duration = 250) => ({ duration, startCoordinates: frame(from), endCoordinates: frame(to) });

async function open() {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  g.__scrolledToEnd = [];
  g.__scrolledTo = [];
  g.__liftedTo = [];
  g.__phoneKeyboardHeight = 0;
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
    to: () => g.__scrolledTo as { y: number; animated?: boolean }[],
    /** What the UI thread scrolled to, frame by frame. */
    lifted: () => g.__liftedTo as { y: number; animated: boolean }[],
    /** The keyboard is `h` tall in this frame (a frame at `ts` ms): what the UI thread does on a change of the lift runs, then the callbacks of the frame. */
    frame: (h: number, ts: number) =>
      act(async () => {
        try {
          mock.timers.enable({ apis: ['Date'], now: ts });
        } catch {
          mock.timers.setTime(ts);
        }
        g.__phoneKeyboardHeight = h;
        for (const slot of [...g.__phoneReactions]) {
          const now = slot.prepare();
          const before = slot.before;
          slot.before = now;
          if (now !== before) slot.react(now, before);
        }
        for (const slot of [...g.__phoneFrames]) slot.fn({ timeSincePreviousFrame: 16, timestamp: ts });
      }),
    end: () => g.__scrolledToEnd as { animated?: boolean }[],
    report: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    layout: (h: number) => act(async () => ev().onLayout({ nativeEvent: { layout: { height: h } } })),
    grow: (h: number) => act(async () => ev().onContentSizeChange(0, h)),
    keyboard: (name: string, event?: object) => act(async () => g.__keyboardListeners[name]?.(event)),
    touch: () => act(async () => ev().onTouchStart({ nativeEvent: {} })),
  };
}

const events = () => perf.report().events as Record<string, number>;
const ys = (t: { lifted: () => { y: number }[] }) => t.lifted().map((s) => s.y);

test('every announcement is counted, and one that moves nothing says why; the view itself is moved from the UI thread, not here', async () => {
  perf.start();
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.keyboard('keyboardWillChangeFrame', change(0, 300));
  assert.deepEqual(t.to(), [], 'no scroll from the JS thread');
  assert.equal(events()['keyboard-announced'], 1);
  await t.keyboard('keyboardWillChangeFrame', change(300, 300));
  await t.keyboard('keyboardWillChangeFrame');
  assert.equal(events()['keyboard-skip-same'], 2);
  await t.touch();
  await t.keyboard('keyboardWillChangeFrame', change(300, 0));
  assert.equal(events()['keyboard-skip-finger'], 1);
  const u = await open();
  await u.layout(600);
  await u.report(1400);
  await u.report(900);
  await u.keyboard('keyboardWillChangeFrame', change(0, 300));
  assert.equal(events()['keyboard-skip-away'], 1, 'a reader scrolled up one screen sees nothing move');
});

test('a reader at the end travels with the keyboard in every frame of its lift, to the end the view will have, in the frame the app lifts', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.frame(0, 0);
  assert.deepEqual(t.lifted(), [], 'a keyboard that has not moved moves nothing');
  await t.frame(100, 16);
  await t.frame(200, 32);
  await t.frame(300, 48);
  assert.deepEqual(ys(t), [1500, 1600, 1700], 'the offset follows the lift by its change, frame by frame');
  assert.ok(
    t.lifted().every((s) => s.animated === false),
    'each frame is its own move: nothing animates under the keyboard',
  );
  // a candidate bar is the same lift going on: its 27 points come on top of where the lift began
  await t.frame(327, 64);
  assert.equal(ys(t).at(-1), 1727);
  // the lift is over once the keyboard has been quiet; the view reports where it stands and a closing keyboard starts from there
  await t.frame(327, 200);
  await t.layout(273);
  await t.report(1727, 2000, 273);
  await t.frame(200, 216);
  await t.frame(0, 232);
  assert.deepEqual(ys(t).slice(-2), [1600, 1400], 'it closes: the content comes down by the same');
});

test('nothing moves for a reader who is not at the end, one with a finger on the list, or one who is in the middle of something else', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.report(900); // scrolled up
  await t.frame(0, 0);
  await t.frame(300, 16);
  assert.deepEqual(t.lifted(), [], 'a reader scrolled up one screen sees nothing move');
  const u = await open();
  await u.layout(600);
  await u.report(1400);
  await u.touch();
  await u.frame(0, 0);
  await u.frame(300, 16);
  assert.deepEqual(u.lifted(), [], 'a finger holds the view');
  // a finger that lands in the middle of a lift takes the view back from it
  const v = await open();
  await v.layout(600);
  await v.report(1400);
  await v.frame(0, 0);
  await v.frame(100, 16);
  await v.touch();
  await v.frame(200, 32);
  assert.deepEqual(ys(v), [1500], 'only the frame before the finger');
});

test('content that fits in the shrunk view does not scroll, and one that does not goes to the end the view will have, never past it', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(0, 250); // 250 pt of content in a view of 600
  await t.frame(0, 0);
  await t.frame(300, 16);
  assert.deepEqual(ys(t), [0], 'it still fits in what is left: it stays at the top');
  const u = await open();
  await u.layout(600);
  await u.report(0, 500);
  await u.frame(0, 0);
  await u.frame(300, 16);
  assert.deepEqual(ys(u), [200], '500 in a view that will be 300: the end is at 200, not 300');
});

test('a lift begun after a quiet moment starts from where the view stands then', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1000, 2000, 600); // 400 above the end
  await t.report(1400);
  await t.frame(0, 0);
  await t.frame(300, 16);
  await t.frame(300, 300);
  await t.report(1700, 2000, 300);
  await t.frame(300, 316); // quiet and unchanged: a lift is not begun
  assert.deepEqual(ys(t), [1700]);
});

test('the end marker costs no space: it is the list’s last child, no taller than nothing, and takes none of the gap above it, so the content ends where it does on a chat without it', async () => {
  const t = await open();
  await t.layout(600);
  const list = document.querySelector('[scrolleventthrottle]')!;
  const last = list.lastElementChild as HTMLElement;
  const style = JSON.parse(last.getAttribute('data-style')!);
  assert.deepEqual([style.height, style.marginTop], [0, -8], 'no taller than nothing, and the gap of the list cancelled');
  const container = Object.assign({}, ...[g.__scrollEvents.contentContainerStyle].flat(9).filter(Boolean));
  assert.equal(
    container.gap + style.marginTop,
    0,
    'the gap above the marker and its negative margin cancel: rows + the 16 of padding, as on main',
  );
  assert.equal(container.padding, 16);
});

test('a lift ends when the keyboard has been quiet, so the next one begins afresh and moves only a reader who is at the end then', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.frame(0, 0);
  await t.frame(300, 16);
  assert.deepEqual(ys(t), [1700]);
  await t.frame(300, 200); // quiet: the callback of the frame says the lift is over
  await t.layout(300);
  await t.report(1500, 2000, 300); // the reader is no longer at the end (200 short)
  await t.frame(200, 216); // the keyboard goes down a little
  assert.deepEqual(ys(t), [1700], 'a reader who is not at the end is not moved by the next lift');
});

test('while the keyboard slides the clamp and the layout follow stay out of its way, and at its end the residual is settled to the very end', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.keyboard('keyboardWillChangeFrame', change(0, 300, 250));
  const scrolls = t.to().length + t.end().length;
  // the view is resized in every frame of the lift and reports the offset that stands past its end for a moment
  await t.layout(500);
  await t.layout(400);
  await t.layout(300);
  await t.report(1700, 2000, 600);
  await t.grow(2000);
  assert.equal(t.to().length + t.end().length, scrolls, 'no second scroll, no clamp, no layout follow, while the keyboard moves');
  // its end is reported: the layouts that came are caught up and the end is where the reader stands, exactly
  await t.keyboard('keyboardDidChangeFrame');
  assert.deepEqual(t.end().at(-1), { animated: false });
  // a view resized later is followed again
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  const after = t.end().length;
  await t.layout(280);
  assert.equal(t.end().length, after + 1, 'the layout follow is back');
});

test('a keyboard whose end is never reported lets go of the view after its time, with the residual settled by the deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.keyboard('keyboardWillChangeFrame', change(0, 300, 250));
  const held = t.end().length;
  await t.grow(2100);
  assert.equal(t.end().length, held, 'held while it slides');
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  assert.deepEqual(t.end().at(-1), { animated: true }, 'a reply that grew meanwhile is brought back over a moment, not in one frame');
  await t.grow(2200);
  assert.ok(t.end().length >= held + 2, 'and it is followed after its time');
  // an announcement that does not say how long the keyboard takes is given the keyboard’s usual time
  const u = await open();
  await u.layout(600);
  await u.report(1400);
  await u.keyboard('keyboardWillChangeFrame', { startCoordinates: frame(0), endCoordinates: frame(300) });
  const before = u.end().length;
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  assert.equal(u.end().length, before + 1);
  assert.deepEqual(u.end().at(-1), { animated: false }, 'the lift left a reader at the end: its residual is closed exactly, in one move');
});

test('the reports of a lift that move the view up are not the reader leaving the end: they follow the keyboard closing, and the reader is at the end after it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  perf.start();
  const t = await open();
  await t.layout(300);
  await t.report(1700, 2000, 300);
  await t.keyboard('keyboardWillChangeFrame', change(300, 0, 250));
  await t.layout(600);
  await t.report(1400, 2000, 600); // the view is taller and the offset came down with it
  assert.equal(events()['scroll-lift'], 1, 'counted as the lift’s, not as a shift nobody made');
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  const before = t.end().length;
  await t.grow(2100);
  assert.equal(t.end().length, before + 1, 'still following: the reports of the lift did not leave the end');
  // a reader's own move up, with a finger, still leaves it, even while the keyboard slides
  const w = await open();
  await w.layout(600);
  await w.report(1400);
  await w.keyboard('keyboardWillChangeFrame', change(0, 300, 250));
  await w.touch();
  await w.report(1300);
  await act(async () => g.__scrollEvents.onTouchEnd({ nativeEvent: {} }));
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  const kept = w.end().length;
  await w.grow(2100);
  assert.equal(w.end().length, kept, 'left the end: the reports under a finger are the reader’s');
  // and the same without the keyboard
  const u = await open();
  await u.layout(600);
  await u.report(1400);
  await u.touch();
  await u.report(1300);
  await act(async () => g.__scrollEvents.onTouchEnd({ nativeEvent: {} }));
  const held = u.end().length;
  await u.grow(2100);
  assert.equal(u.end().length, held, 'left the end');
});

test('a move of the view that is not the lift’s own (the status bar, a screen reader, a scroll bar) leaves the end even while the keyboard slides', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.keyboard('keyboardWillChangeFrame', change(0, 300, 250));
  await t.report(1500); // the lift's own: between where it began and where it goes
  await t.report(0); // the status bar: nowhere near
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  const kept = t.end().length;
  await t.grow(2100);
  assert.equal(t.end().length, kept, 'left the end: nothing pulls the reader back');
});

test('a second announcement in the middle of a slide keeps the offsets of the first as the lift’s own', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.layout(300);
  await t.report(1700, 2000, 300);
  await t.keyboard('keyboardWillChangeFrame', change(300, 0, 250)); // closing: the offset comes down from 1700 to 1400
  await t.report(1600, 2000, 300);
  await t.keyboard('keyboardWillChangeFrame', change(27, 54, 250)); // a candidate bar in the middle of it, announced from where the view is now
  await t.report(1450, 2000, 300); // still the closing: outside the second announcement's own offsets
  await act(async () => mock.timers.tick(250 + KEYBOARD_MARGIN + 1));
  const kept = t.end().length;
  await t.grow(2100);
  assert.equal(t.end().length, kept + 1, 'still following: the first lift’s reports were not the reader leaving the end');
});

test('a keyboard that moves while a finger is on the list is caught up over a moment when the finger lifts, not in one frame', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.touch();
  await t.keyboard('keyboardWillChangeFrame', change(0, 300));
  assert.deepEqual(t.to(), [], 'a finger holds the view');
  await t.layout(300); // the keyboard is up: the view is shorter, and the last row is no longer in sight
  const before = t.end().length;
  await act(async () => g.__scrollEvents.onTouchEnd({ nativeEvent: {} }));
  assert.equal(t.end().length, before + 1);
  assert.deepEqual(t.end().at(-1), { animated: true }, 'the catch-up is animated');
  await act(async () => g.__scrollEvents.onTouchStart({ nativeEvent: {} }));
  await act(async () => g.__scrollEvents.onTouchEnd({ nativeEvent: {} }));
  assert.deepEqual(t.end().at(-1), { animated: false }, 'once caught up the owed catch-up is spent: an ordinary lift is as it was');
});

test('a reader who left the end does not hold the clamp off while the keyboard moves', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.report(1000);
  await t.keyboard('keyboardWillChangeFrame', change(0, 300));
  await t.grow(1200); // the content gets shorter under a view that stands past its end: the chat clamps it at once
  assert.ok(t.to().length >= 1, 'the clamp ran: nothing held it off');
});
