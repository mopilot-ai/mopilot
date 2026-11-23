// A chat opens at its newest message, follows a streaming reply while the reader is at the bottom, and lets a reader who scrolled up stay there.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const followPath = '../mobile/src/remote/useFollowEnd';
const { Thread } = await import(threadPath);
const sendPath = '../mobile/src/sendOrigin';
const { reportSentTop } = await import(sendPath);
const { atEnd, BLANK_PAST, clampOffset, NEAR_END, PIN_INSET, reportOf, wentUp } = await import(followPath);

const report = (y: number | undefined, content = 2000, view = 600) => ({
  nativeEvent: {
    ...(y === undefined ? {} : { contentOffset: { y } }),
    contentSize: { height: content },
    layoutMeasurement: { height: view },
  },
});
test('a report is at the end within a short distance of it, and says nothing when it lacks a number', () => {
  const at = (y: number, content = 2000, view = 600) => atEnd(reportOf(report(y, content, view))!);
  assert.equal(at(1400), true, 'exactly at the end');
  assert.equal(at(1400 - NEAR_END), true);
  assert.equal(at(1400 - NEAR_END - 1), false);
  assert.equal(at(0, 500, 600), true, 'a chat shorter than the view is at its end');
  assert.equal(reportOf(report(undefined)), null);
  assert.equal(reportOf({}), null);
  assert.equal(reportOf({ nativeEvent: { contentOffset: { y: 1 }, layoutMeasurement: { height: 1 } } }), null);
  assert.equal(reportOf({ nativeEvent: { contentOffset: { y: 1 }, contentSize: { height: 1 } } }), null);
});

test('the reader has left the end when the offset went up and the content did not shrink', () => {
  const r = (y: number, content = 2000) => ({ y, content, view: 600 });
  assert.equal(wentUp(null, r(100)), false, 'nothing to compare with');
  assert.equal(wentUp(r(1400), r(300)), true, 'scrolled up');
  assert.equal(wentUp(r(1400), r(1399.5)), false, 'a hair of jitter is not a scroll');
  assert.equal(wentUp(r(1400), r(1400, 2400)), false, 'the content grew under a view that has not followed yet');
  assert.equal(wentUp(r(300), r(900)), false, 'going down is never leaving');
  assert.equal(wentUp(r(1400, 2400), r(1000, 2000)), false, 'the content shrank, which clamps the offset');
  assert.equal(wentUp(r(1400, 2000), r(300, 2400)), true, 'up while the content also grew is still up');
});

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});
const g = globalThis as any;
async function open(over: (m: string, p: any) => unknown = () => undefined) {
  g.__scrolledToEnd = [];
  const rig = scripted((m, p) =>
    m === 'chat.follow'
      ? {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i}` })),
        }
      : over(m, p),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let draft = '';
  const render = () =>
    act(async () =>
      root.render(
        createElement(Thread, {
          runtime: rig.runtime,
          chatId: 'c',
          back: () => {},
          drafts: fakeDraft(draft, { set: (v: string) => (draft = v), clear: () => (draft = '') }),
        }),
      ),
    );
  await render();
  await flush();
  const list = () => document.querySelector('[scrolleventthrottle]')!;
  return {
    host,
    list,
    scrolls: () => g.__scrolledToEnd as { animated?: boolean }[],
    ev: () => g.__scrollEvents,
    // the native view reports a scroll; the same event reaches the DOM's scroll handler the screen listens to
    scroll: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    typeAndSend: async (text: string) => {
      draft = text;
      await render();
      await click('Send message');
    },
    refresh: async () => {
      await act(async () =>
        root.render(createElement(Thread, { runtime: rig.runtime, chatId: 'd', back: () => {}, drafts: fakeDraft('') })),
      );
      await flush();
    },
    latest: () => host.querySelector('button[aria-label="Jump to the latest message"]'),
  };
}
const grow = async (t: Awaited<ReturnType<typeof open>>) => act(async () => t.ev().onContentSizeChange());

test('a chat opens at the newest message and follows growth while nothing has been scrolled', async () => {
  const t = await open();
  assert.equal(t.latest(), null);
  await grow(t);
  assert.deepEqual(t.scrolls(), [{ animated: false }]);
  await grow(t);
  assert.equal(t.scrolls().length, 2, 'each growth of a streaming reply is followed');
});

test('a reader who scrolls up is not pulled down, and gets a control to jump to the latest', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.scroll(300);
  assert.ok(t.latest(), 'the jump control shows');
  await grow(t);
  await act(async () => t.ev().onLayout());
  assert.equal(t.scrolls().length, 0, 'neither growth nor a new layout moves a reader who scrolled up');
  await click('Jump to the latest message');
  assert.deepEqual(t.scrolls(), [{ animated: true }]);
  assert.equal(t.latest(), null);
  // the animation reports positions on the way down; they do not end the following
  await t.scroll(500);
  await t.scroll(900);
  assert.equal(t.latest(), null);
  await grow(t);
  assert.equal(t.scrolls().length, 2, 'following again');
});

test('a report taken after the content grew, before the view followed it, does not end the following', async () => {
  const t = await open();
  await t.scroll(1400);
  // the reply grew by 400 points; the view has not scrolled yet
  await t.scroll(1400, 2400);
  assert.equal(t.latest(), null);
  await grow(t);
  assert.equal(t.scrolls().length, 1);
  // the view is moved by the app: the same app-driven scroll, reported at the new end
  await t.scroll(1800, 2400);
  assert.equal(t.latest(), null);
  // a report without numbers, and a first report that is not at the end, change nothing
  await act(async () => void t.list().dispatchEvent(new Event('scroll')));
  assert.equal(t.latest(), null);
});

test('a scroll away from the end of any kind leaves it: a status-bar tap, a screen reader, a scrollbar', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.scroll(0);
  assert.ok(t.latest(), "a jump to the top is the reader's");
  await grow(t);
  assert.equal(t.scrolls().length, 0, 'the earlier page that loads at the top does not pull the reader to the end');
  await t.scroll(1500);
  assert.equal(t.latest(), null, 'back at the end follows again');
});

test('a first report that is not at the end is only a position to compare with', async () => {
  const t = await open();
  await t.scroll(300);
  assert.equal(t.latest(), null);
  await t.scroll(100);
  assert.ok(t.latest(), 'but going up from it leaves the end');
});

test('sending pins the new message and reading the chat again starts at the end', async () => {
  const t = await open();
  await t.scroll(1400);
  await t.scroll(300);
  assert.ok(t.latest());
  await t.typeAndSend('hello');
  assert.equal(t.latest(), null, 'nothing is below the fold yet');
  await t.refresh();
  assert.equal(t.latest(), null, 'another chat starts at its end');
  await grow(t);
  assert.ok(t.scrolls().length >= 1);
});

test('the view keeps its end in sight when it is laid out again, as when the keyboard opens', async () => {
  const t = await open();
  await act(async () => t.ev().onLayout());
  assert.deepEqual(t.scrolls(), [{ animated: false }]);
});

test('a long thread follows without drawing the chat for every report', async () => {
  const t = await open();
  const before = document.querySelectorAll('span').length;
  for (let i = 0; i < 200; i++) await t.scroll(1400);
  assert.equal(t.latest(), null);
  assert.equal(document.querySelectorAll('span').length, before, 'scroll reports at the end change no element');
});

test('the end stays in sight once the keyboard has shown, hidden or changed height, since the view scrolls only after it finished sliding', async () => {
  const t = await open();
  const keyboard = (name: string) => act(async () => g.__keyboardListeners[name]());
  await keyboard('keyboardDidShow');
  await keyboard('keyboardDidHide');
  await keyboard('keyboardDidChangeFrame');
  assert.equal(t.scrolls().length, 3);
  // a reader who scrolled up keeps the place when the keyboard comes
  await t.scroll(1400);
  await t.scroll(300);
  await keyboard('keyboardDidShow');
  assert.equal(t.scrolls().length, 3);
  // the listeners go with the screen
  g.__keyboardRemoved = [];
  await act(async () => mounted[0].root.unmount());
  mounted.shift()!.host.remove();
  assert.deepEqual([...g.__keyboardRemoved].sort(), ['keyboardDidChangeFrame', 'keyboardDidHide', 'keyboardDidShow']);
});

test('on Android the keyboard has no change-of-frame event to listen to', async () => {
  g.__phonePlatform = 'android';
  try {
    await open();
    assert.deepEqual(Object.keys(g.__keyboardListeners).sort(), ['keyboardDidHide', 'keyboardDidShow']);
  } finally {
    delete g.__phonePlatform;
  }
});

const sized = (t: Awaited<ReturnType<typeof open>>, h: number) => act(async () => t.ev().onContentSizeChange(0, h));
const laid = (t: Awaited<ReturnType<typeof open>>, h?: number) =>
  act(async () => t.ev().onLayout(h === undefined ? undefined : { nativeEvent: { layout: { height: h } } }));
const scrolledTo = () => g.__scrolledTo as { y: number; animated: boolean }[];

test('after a send the message is scrolled to the top once and the reply below it is not followed', async () => {
  g.__scrolledTo = [];
  g.__keyboardDismissed = 0;
  const t = await open();
  await t.scroll(1400);
  await laid(t, 600);
  assert.ok(t.list().hasAttribute('maintainvisiblecontentposition'), 'a page joined above keeps the row being read in place');
  await t.typeAndSend('hello');
  // the bubble lands: the content grows by 100
  await sized(t, 2100);
  assert.equal(t.list().hasAttribute('maintainvisiblecontentposition'), false, 'a pinned message is not moved by the rows around it');
  assert.deepEqual(scrolledTo(), [], 'the room under the message is not part of the content yet, so a scroll would be clamped');
  await sized(t, 2000 - PIN_INSET + 600);
  assert.deepEqual(scrolledTo(), [{ y: 2000 - PIN_INSET, animated: false }]);
  assert.equal(g.__keyboardDismissed, 1, 'the keyboard goes down on send');
  const before = t.scrolls().length;
  // the reply streams below the fold: no following, but the down-arrow shows
  await t.scroll(1984, 2600);
  assert.equal(t.latest(), null, 'the reply still fits');
  await sized(t, 2900);
  assert.equal(t.scrolls().length, before);
  assert.equal(scrolledTo().length, 1, 'growth is not followed');
  assert.ok(t.latest(), 'the reply passed the fold');
  // a reader's scroll in a pinned chat keeps their place; reaching the end hides the arrow
  await t.scroll(1000, 2900);
  assert.ok(t.latest());
  await t.scroll(2300, 2900);
  assert.equal(t.latest(), null);
  await t.scroll(100, 2900);
  assert.ok(t.latest());
  // the keyboard drops: the room under the message follows the view's height
  await laid(t, 800);
  await laid(t);
  await laid(t, 800);
  assert.equal(scrolledTo().length, 1, 'not before the content has caught up with the room');
  await sized(t, 2000 - PIN_INSET + 800);
  assert.deepEqual(scrolledTo().at(-1), { y: 2000 - PIN_INSET, animated: false }, 'the message goes back to the top');
  assert.equal(t.scrolls().length, before, 'a pinned chat is not pulled to the end by a layout');
  // the message is back at the top, which is the end of the content: no arrow; a reader who scrolls up again gets it
  assert.equal(t.latest(), null);
  await t.scroll(100, 2800, 800);
  assert.ok(t.latest());
  await click('Jump to the latest message');
  assert.deepEqual(t.scrolls().at(-1), { animated: true });
  assert.equal(t.latest(), null);
});

test('under Reduce Motion the pin and the jump do not animate', async () => {
  g.__scrolledTo = [];
  const original = g.__phoneReduceMotion;
  g.__phoneReduceMotion = true;
  try {
    const t = await open();
    await t.typeAndSend('hi');
    await sized(t, 2100);
    await t.scroll(0, 2900);
    await click('Jump to the latest message');
    assert.deepEqual(t.scrolls().at(-1), { animated: false });
  } finally {
    g.__phoneReduceMotion = original;
  }
});

test("the sent bubble's real place decides where the message is pinned, and only while a send is pinned", async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await act(async () => reportSentTop(900));
  assert.deepEqual(scrolledTo(), [], 'a chat that has not sent anything ignores it');
  await t.scroll(1400);
  await t.typeAndSend('hello');
  // a row above the new bubble changed height after the send: the bubble landed lower than the old content's end
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  assert.deepEqual(scrolledTo(), [{ y: 2042, animated: false }]);
  // the same place reported again changes nothing; a moved place goes back under the nav bar
  await act(async () => reportSentTop(2050));
  assert.equal(scrolledTo().length, 1);
  await act(async () => reportSentTop(2030));
  await sized(t, 2022 + 600);
  assert.deepEqual(scrolledTo().at(-1), { y: 2022, animated: false });
  await act(async () => mounted[0].root.unmount());
  mounted.shift()!.host.remove();
  await act(async () => reportSentTop(100));
  assert.equal(scrolledTo().length, 2, 'the listener goes with the screen');
});

test('a tall reply that grows above the outbox bubble does not drag the pin down to the bubble', async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await t.typeAndSend('hello');
  // the bubble lands and tells where it sits: the message is pinned there
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  assert.deepEqual(scrolledTo(), [{ y: 2042, animated: false }]);
  // the reply (a tall paragraph) arrives above the bubble, which is drawn after the rows until the computer's record replaces it
  await act(async () => reportSentTop(3900));
  await sized(t, 3900 + 700);
  assert.deepEqual(scrolledTo(), [{ y: 2042, animated: false }], 'the pin stays where the message was put');
  // a small correction of the place (a row above changed a little) is still followed
  await act(async () => reportSentTop(2090));
  await sized(t, 2082 + 600);
  assert.deepEqual(scrolledTo().at(-1), { y: 2082, animated: false });
});

test('the viewport always shows content: an offset left past the end by content that shrank or was replaced is put back at the end', async () => {
  g.__scrolledTo = [];
  const t = await open();
  // the reader is near the end of a very long chat and then scrolls up a little: nothing is followed
  await t.scroll(9400, 10000, 600);
  await t.scroll(9000, 10000, 600);
  // the earlier pages are dropped by a read again, or a card is replaced by a receipt: the content is a fraction of what it was and the offset stands where it was
  await sized(t, 2000);
  assert.deepEqual(scrolledTo(), [{ y: 1400, animated: false }], 'back to the last screen of what is drawn');
  // the same when the view reports it
  g.__scrolledTo = [];
  await t.scroll(8000, 2000, 600);
  assert.deepEqual(scrolledTo(), [{ y: 1400, animated: false }]);
  // a finger pulling the list past its end (the bounce) is not put back
  g.__scrolledTo = [];
  await t.scroll(1400 + 120, 2000, 600);
  assert.deepEqual(scrolledTo(), []);
  // a chat shorter than the view has its offset at the top
  await sized(t, 300);
  await t.scroll(900, 300, 600);
  assert.deepEqual(scrolledTo().at(-1), { y: 0, animated: false });
});

test('the clamp is the end of what is drawn, and only when the offset is past it by more than a bounce could be', () => {
  const r = (y: number, content = 2000, view = 600) => ({ y, content, view });
  assert.equal(clampOffset(r(1400)), null, 'at the end');
  assert.equal(clampOffset(r(1400 + 600 * BLANK_PAST)), null, 'a bounce');
  assert.equal(clampOffset(r(1400 + 600 * BLANK_PAST + 1)), 1400, 'blank');
  assert.equal(clampOffset(r(5000, 300)), 0, 'a short chat');
  assert.equal(clampOffset(r(-40)), null, 'pulled down past the top');
});

test('content that gets shorter leaves no blank under the viewport, however little; growth and a bounce keep their room', async () => {
  g.__scrolledTo = [];
  const t = await open();
  await t.scroll(1400, 2000, 600);
  await t.scroll(1350, 2000, 600);
  // a card replaced by its receipt: 100 points shorter, the offset is now 50 past the end
  await sized(t, 1900);
  assert.deepEqual(scrolledTo(), [{ y: 1300, animated: false }]);
  // growth never clamps, and a report a little past the end (a bounce) is left alone
  g.__scrolledTo = [];
  await sized(t, 2500);
  await act(async () => t.ev().onScrollBeginDrag());
  await t.scroll(1900 + 100, 2500, 600);
  assert.deepEqual(scrolledTo(), []);
});

test("the computer's row of the message corrects a place already reported, never sets the first one, and never follows a far-off row", async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await t.typeAndSend('hello');
  // before the queued bubble has said where it is, a row of yours that happens to lay out is not it: the bubble's own report decides
  await act(async () => reportSentTop(300, true));
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  assert.deepEqual(scrolledTo().at(-1), { y: 2042, animated: false });
  // the queued bubble gives way to the computer's row, which sits 80 higher: the pin goes with it
  await act(async () => reportSentTop(1970, true));
  await sized(t, 1962 + 600);
  assert.deepEqual(scrolledTo().at(-1), { y: 1962, animated: false });
  const after = scrolledTo().length;
  // rows above went away (older pages dropped when the chat is read again): the message is far higher, and the pin goes with it
  await act(async () => reportSentTop(300, true));
  await sized(t, 292 + 600);
  assert.ok(scrolledTo().length > after);
  assert.deepEqual(scrolledTo().at(-1), { y: 292, animated: false });
});

const reserveOf = (t: Awaited<ReturnType<typeof open>>) =>
  [t.ev().contentContainerStyle].flat(3).find((x: any) => x && x.minHeight !== undefined)?.minHeight;

test('older rows dropped above a pinned message take the room kept under it with them, and the view goes to where the message now is', async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await t.typeAndSend('hello');
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  assert.equal(reserveOf(t), 2642);
  // the room under the message holds the content up, so the drop above changes no content size: only the bubble's place says it
  await act(async () => reportSentTop(900));
  assert.equal(reserveOf(t), 892 + 600, 'the room follows the message, never reaching past the rows that are left');
  await sized(t, 892 + 600);
  assert.deepEqual(scrolledTo().at(-1), { y: 892, animated: false });
  assert.ok(
    scrolledTo().every((s) => s.y === 2042 || s.y === 892),
    'the view never goes anywhere else',
  );
});

test('a reply growing above the queued bubble still does not drag the pin down, after rows were dropped above it', async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await t.typeAndSend('hello');
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  await act(async () => reportSentTop(900));
  await sized(t, 892 + 600);
  await act(async () => reportSentTop(2900));
  await sized(t, 2900 + 700);
  assert.equal(scrolledTo().at(-1)?.y, 892);
  assert.equal(reserveOf(t), 892 + 600);
});

test('a scroll the pin has just made is not undone by the guard from the offset the view last reported', async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await t.typeAndSend('hello');
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  await t.scroll(2042, 2642, 600);
  // the computer's row sits 80 higher: the pin goes to 1962 at once, before the view has reported that
  await act(async () => reportSentTop(1970, true));
  assert.deepEqual(scrolledTo().at(-1), { y: 1962, animated: false });
  // the content is a little shorter (the receipts replaced the card) with the last report still at 2042
  await sized(t, 2602);
  assert.deepEqual(scrolledTo().at(-1), { y: 1962, animated: false }, 'the guard does not move it to the end of the shorter content');
});

test('while the pin waits for its room under a view that grew (the keyboard went down), the guard does not pull the offset back toward the end', async () => {
  g.__scrolledTo = [];
  const t = await open();
  await laid(t, 600);
  await t.typeAndSend('hello');
  await act(async () => reportSentTop(2050));
  await sized(t, 2042 + 600);
  await t.scroll(2042, 2642, 600);
  const before = scrolledTo().length;
  // the view is much taller now and the room under the message is not yet the new height: the target is past the end of what is drawn
  await laid(t, 1300);
  assert.equal(scrolledTo().length, before, 'no scroll toward the end');
  // once the room is there the message goes back to the top
  await sized(t, 2042 + 1300);
  assert.deepEqual(scrolledTo().at(-1), { y: 2042, animated: false });
});
