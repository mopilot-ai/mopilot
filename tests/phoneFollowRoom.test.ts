// The room under a sent message with the keyboard up or going down (#5686): made for the view with no keyboard, one definition of the end (where the rows end), and the rows' end moving inside the room answered as growth is.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act } from './support/phone/component-kit';
import { probe, unmountProbes } from './support/phone/followProbe';

const followPath = '../mobile/src/remote/useFollowEnd';
const { PIN_INSET } = await import(followPath);
const measurePath = '../mobile/src/remote/useEndMeasure';
const { realContent } = await import(measurePath);
const g = globalThis as any;

afterEach(async () => {
  mock.timers.reset();
  await unmountProbes();
});

/** The offset the native view can reach: its content (at least the room kept under the message) less its height; below the pinned offset the view clamps and the message slides down. */
const reach = (p: { out: () => any }, content: number, view: number) => Math.max(content, p.out().reserve ?? 0) - view;

test('the room under a sent message is made for the view with no keyboard, whichever way the keyboard goes: the view never outgrows it in any frame of a close, and the arrow does not show for the blank it adds', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const frame = (h: number) => ({ screenY: 926 - h, height: h });
  const hide = { duration: 250, startCoordinates: frame(300), endCoordinates: frame(0) };
  const tell = (name: string) => act(async () => g.__keyboardListeners[name]?.(hide));
  const target = 2000 - PIN_INSET; // the pinned offset: the content's height before the send less the inset
  const view = (h: number) => 600 - h; // 600 with no keyboard; the lift is the keyboard's height here
  // (a) keyboard up → send: the room is made while the keyboard is up (a view of 300 and a lift of 300)
  g.__phoneKeyboardHeight = 300;
  const a = await probe();
  await a.layout(300);
  await a.report(1700, 2000, 300);
  await a.pin();
  await a.grow(2100);
  await a.grow(target + 600);
  assert.equal(a.out().reserve, target + 600, '(a) the room is for the view of 600, not the 300 it has now');
  assert.equal(a.out().away, false, '(a) the blank the room adds under the message is not content the reader missed: no arrow');
  await tell('keyboardWillChangeFrame');
  for (const h of [300, 200, 100, 0]) {
    g.__phoneKeyboardHeight = h;
    assert.ok(reach(a, 2100, view(h)) >= target, `(a) keyboard ${h}: the view can still reach the pinned offset`);
  }
  // (b) the announcement comes first, and the sent bubble makes the content grow while the view is half grown
  g.__phoneKeyboardHeight = 300;
  const b = await probe();
  await b.layout(300);
  await b.report(1700, 2000, 300);
  await b.pin();
  await tell('keyboardWillChangeFrame');
  g.__phoneKeyboardHeight = 150;
  await b.layout(450);
  await b.grow(2100);
  await b.grow(target + 600);
  assert.equal(b.out().reserve, target + 600, '(b) the room is for the view of 600 whatever the view is now');
  for (const h of [150, 50, 0]) {
    g.__phoneKeyboardHeight = h;
    assert.ok(reach(b, 2100, view(h)) >= target, `(b) keyboard ${h}: the view can still reach the pinned offset`);
  }
  // after the slide the room is the same one: nothing is made again
  g.__phoneKeyboardHeight = 0;
  await b.layout(600);
  await act(async () => mock.timers.tick(250 + 150 + 1));
  assert.equal(b.out().reserve, target + 600, 'once the keyboard is down the room is what it was: no residual blank');
  delete g.__phoneKeyboardHeight;
});

test('with the keyboard up after a send the arrow reads where the rows end, not the blank the room adds: the reply passing the fold shows it, and a short one does not', async () => {
  const target = 2000 - PIN_INSET;
  g.__phoneKeyboardHeight = 300;
  const a = await probe();
  await a.layout(300);
  await a.report(1700, 2000, 300);
  await a.pin();
  await a.grow(2100);
  await a.grow(target + 600); // the room: target + the view with no keyboard
  const rows = (end: number) => a.out().endMarker.onLayout({ nativeEvent: { layout: { y: end - 16 } } }); // the end marker sits 16 above where the content ends: the container's padding
  await act(async () => rows(target + 100));
  assert.equal(a.out().away, false, 'a short reply: the view is at the end of the rows');
  await act(async () => rows(target + 384));
  assert.equal(a.out().away, true, 'a reply 84 pt past the fold: the arrow shows from the marker alone, though the room still holds it');
  await act(async () => a.out().endMarker.onLayout());
  assert.equal(a.out().away, false, 'a marker that has not said: what the room would have been for the view as it is');
  delete g.__phoneKeyboardHeight;
});

test('the content that counts is the rows’ end while the room dominates, and the content itself once the reply outgrows it', () => {
  const base = { target: 1984, view: 300 };
  assert.equal(realContent({ ...base, content: 2584, room: undefined, natural: null }), 2584, 'no room: the content');
  assert.equal(realContent({ ...base, content: 2700, room: 2584, natural: 2700 }), 2700, 'the reply outgrew the room');
  assert.equal(realContent({ ...base, content: 2584, room: 2584, natural: 2400 }), 2400, 'the room dominates and the rows end at 2400');
  assert.equal(
    realContent({ ...base, content: 2584, room: 2584, natural: null }),
    2284,
    'the marker has not said: the room for the view as it is',
  );
  assert.equal(realContent({ ...base, content: 2100, room: 2584, natural: null }), 2100, 'never more than the content');
});

/** A sent message with the keyboard up: the room is for the view with no keyboard (target + 600), the rows end at target + 100 (a short reply), and the view is 300. */
async function roomed() {
  const target = 2000 - PIN_INSET;
  g.__phoneKeyboardHeight = 300;
  const a = await probe();
  await a.layout(300);
  await a.report(1700, 2000, 300);
  await a.pin();
  await a.grow(2100);
  await a.grow(target + 600);
  await act(async () => a.out().endMarker.onLayout({ nativeEvent: { layout: { y: target + 100 - 16 } } }));
  return Object.assign(a, {
    target,
    release: () => act(async () => a.out().props.onTouchEnd()),
    jump: () => act(async () => a.out().jump()),
  });
}

test('one definition of the end with the keyboard up after a send: a reader in the blank below the rows is at the end, and nothing asks the list to go there', async () => {
  const a = await roomed();
  const beyond = a.target + 100 - 300 + 40; // 40 pt past the last row, in the blank the room adds
  await a.touch(); // a finger ends the pin: the reader is away
  await a.report(beyond, a.target + 600, 300);
  assert.equal(a.out().away, false, 'in the blank: no arrow');
  const asked = a.end.length + a.to.length;
  await a.release();
  assert.equal(a.out().left(), false, 'a reader who comes to rest there follows again');
  assert.equal(a.end.length + a.to.length, asked, 'and the list is not asked to go anywhere: it is at the end');
  delete g.__phoneKeyboardHeight;
});

test('the arrow takes the reader to where the rows end, not into the blank under them, and the room goes after', async () => {
  const a = await roomed();
  await a.touch();
  await a.report(a.target - 400, a.target + 600, 300); // reading above, far from the end
  const asked = a.end.length;
  await a.jump();
  assert.deepEqual(a.to.at(-1), { y: a.target + 100 - 300, animated: true }, 'the end of the rows less the view');
  assert.equal(a.end.length, asked, 'not scrollToEnd, which goes to the padded end');
  assert.equal(a.out().reserve, undefined, 'the room is gone once the reader is on their way');
  // a reply that has outgrown the room: its end is the content's
  const b = await roomed();
  await act(async () => b.out().endMarker.onLayout({ nativeEvent: { layout: { y: b.target + 700 } } }));
  const before = b.end.length;
  await b.jump();
  assert.equal(b.end.length, before + 1, 'scrollToEnd: the content is the rows');
  delete g.__phoneKeyboardHeight;
});

test('a glide that ends in the blank below the rows with the keyboard up is coming back to the end: the reader follows again', async () => {
  const a = await roomed();
  await a.touch();
  await a.report(a.target - 400, a.target + 600, 300); // reading above
  await a.release(); // the finger is up: the reader is away at their place
  assert.equal(a.out().left(), true);
  await a.report(a.target + 100 - 300 + 40, a.target + 600, 300); // no finger: a glide's frame, 40 pt past the last row
  assert.equal(a.out().left(), false, 'arriving at the end, whether in the blank or not, is coming back');
  delete g.__phoneKeyboardHeight;
});

test('a following reader stays at the reply’s last line while it grows inside the room, where the content does not grow: the rows’ end moving is what carries them', async () => {
  const a = await roomed();
  await a.touch();
  await a.report(a.target - 200, a.target + 600, 300); // the rows end at target + 100: this is their end
  await a.release();
  assert.equal(a.out().left(), false, 'at the end of the rows, so following');
  const marker = (end: number) => act(async () => a.out().endMarker.onLayout({ nativeEvent: { layout: { y: end - 16 } } }));
  await marker(a.target + 100); // the marker says the same again: nothing grew
  const asked = a.to.length + a.end.length;
  await marker(a.target + 100);
  assert.equal(a.to.length + a.end.length, asked, 'no growth, no scroll');
  await marker(a.target + 400); // the reply grew past the fold, still inside the room
  assert.deepEqual(
    a.to.at(-1),
    { y: a.target + 100, animated: false },
    'the view goes to where the rows end, the content not having grown',
  );
  // a reply that has outgrown the room is the content's growth: the growth step carries the reader, not this one
  await a.report(a.target + 100, a.target + 900, 300);
  const grown = a.to.length + a.end.length;
  await marker(a.target + 892);
  assert.equal(a.to.length + a.end.length, grown, 'content past the room: not this step');
  // a reader who is not following is not carried
  const b = await roomed();
  await b.touch();
  await b.report(b.target - 400, b.target + 600, 300);
  await b.release();
  const kept = b.to.length + b.end.length;
  await act(async () => b.out().endMarker.onLayout({ nativeEvent: { layout: { y: b.target + 384 } } }));
  assert.equal(b.to.length + b.end.length, kept, 'reading above: not carried');
  delete g.__phoneKeyboardHeight;
});

test('a following reader at the end of the rows is carried by the keyboard while the room dominates: the lift judges the end by where the rows end', async () => {
  const target = 2000 - PIN_INSET;
  g.__phoneKeyboardHeight = 0;
  g.__liftedTo = [];
  const a = await probe();
  await a.layout(600);
  await a.report(1400, 2000, 600);
  await a.pin();
  await a.grow(2100);
  await a.grow(target + 600); // the room: target + the view with no keyboard
  await act(async () => a.out().endMarker.onLayout({ nativeEvent: { layout: { y: target + 100 - 16 } } })); // the rows end at target + 100
  await a.touch();
  await a.report(target + 100 - 600, target + 600, 600); // the reader is at the end of the rows (500 above the padded end)
  await act(async () => a.out().props.onTouchEnd());
  assert.equal(a.out().left(), false, 'following');
  const step = (h: number) =>
    act(async () => {
      g.__phoneKeyboardHeight = h;
      for (const slot of [...g.__phoneReactions]) {
        const now = slot.prepare();
        const before = slot.before;
        slot.before = now;
        if (now !== before) slot.react(now, before);
      }
    });
  await step(0);
  await step(300);
  assert.deepEqual(
    g.__liftedTo.map((x: { y: number }) => x.y),
    [target + 100 - 600 + 300],
    'carried up by the lift: the end is the rows’ end, not the blank under it',
  );
  delete g.__phoneKeyboardHeight;
  delete g.__liftedTo;
});

test('the end marker reporting where the rows end does nothing where no room is kept under a message: the content’s own growth does what it did', async () => {
  const p = await probe();
  await p.layout(600);
  await p.report(1400);
  const asked = p.to.length + p.end.length;
  await act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: 1500 } } }));
  assert.equal(p.to.length + p.end.length, asked, 'no room, no step of its own');
});

test('the end marker’s props are the same object on every render, whatever the hook is given: the list is not handed a new handler each time', async () => {
  const p = await probe();
  const first = p.out().endMarker;
  await p.layout(600);
  await p.report(1400);
  await p.pin(); // draws the screen again
  assert.equal(p.out().endMarker, first);
});

test('keyboard up, a 4-line draft, Send: the room is for the view the chat will have with the keyboard down and the composer back to one line, so neither giving back its height can make the view outreach the pin, in either order, and nothing is left blank at rest', async () => {
  const target = 2000 - PIN_INSET;
  const full = 300 + 300 + 92; // the view with the keyboard up and a 4-line composer, plus the keyboard's lift and the composer's 92 pt over one line
  const reach = (p: { out: () => any }, view: number) => Math.max(target + 100, p.out().reserve ?? 0) - view;
  for (const order of ['composer first', 'keyboard first']) {
    const growth = { extra: 92 };
    g.__phoneKeyboardHeight = 300;
    const p = await probe(growth);
    await p.layout(300);
    await p.report(1700, 2000, 300);
    await p.pin();
    growth.extra = 0; // the send empties the composer (it may report before or after the content grows)
    await p.grow(2100);
    await p.grow(target + full);
    assert.equal(p.out().reserve, target + full, `${order}: the room is made at the send, for ${full}`);
    const views = order === 'composer first' ? [392, 492, 592, 692] : [400, 500, 600, 692];
    for (const view of views) {
      if (order === 'keyboard first') g.__phoneKeyboardHeight = Math.max(0, 692 - 92 - view);
      assert.ok(reach(p, view) >= target, `${order}: a view of ${view} can still reach the pinned offset`);
    }
    assert.equal(reach(p, 692), target, `${order}: at rest the view reaches exactly the pin: no blank beyond the one-line composer`);
    delete g.__phoneKeyboardHeight;
  }
  // a one-line send is as it was: nothing for the composer to give back
  g.__phoneKeyboardHeight = 300;
  const one = await probe({ extra: 0 });
  await one.layout(300);
  await one.report(1700, 2000, 300);
  await one.pin();
  await one.grow(2100);
  await one.grow(target + 600);
  assert.equal(one.out().reserve, target + 600);
  delete g.__phoneKeyboardHeight;
});

test('the composer gives back its height before the list grows and a slide begins after the send: the room under the pinned message stays the one made at the send through the slide', async () => {
  const target = 2000 - PIN_INSET;
  const growth = { extra: 92 };
  g.__phoneKeyboardHeight = 300;
  const p = await probe(growth);
  await p.layout(300);
  await p.report(1700, 2000, 300);
  await p.pin(); // measured at the send: 300 + 300 + 92
  growth.extra = 0; // the composer reports its collapse before the list's view has grown
  const frame = (h: number) => ({ screenY: 926 - h, height: h });
  await act(async () =>
    g.__keyboardListeners.keyboardWillChangeFrame?.({ duration: 250, startCoordinates: frame(300), endCoordinates: frame(0) }),
  ); // the slide's own measure: 300 + 300 + 0, short by the composer
  await p.grow(2100);
  await p.grow(target + 692); // the room arrives in the middle of the slide: the pin is placed again
  assert.equal(p.out().reserve, target + 692, 'the send’s measure, not the slide’s');
  for (const view of [392, 500, 600, 692])
    assert.ok(Math.max(target + 100, p.out().reserve) - view >= target, `a view of ${view} still reaches the pin`);
  delete g.__phoneKeyboardHeight;
});

test('the view grows after the send by more than the keyboard and the composer give back (the Changes chip goes away): the room follows it, and the pinned message rests at its place, not short of it', async () => {
  const target = 2000 - PIN_INSET;
  const growth = { extra: 0 };
  const p = await probe(growth);
  await p.layout(552); // a Changes chip of 48 sits above the composer: the view is 600 − 48
  await p.report(1448, 2000, 552);
  await p.pin(); // measured at the send: 552
  await p.grow(2100);
  await p.grow(target + 552);
  assert.equal(p.out().reserve, target + 552);
  await p.layout(600); // the send hides the chip: the view grows by 48
  assert.equal(p.out().reserve, target + 600, 'the room follows the view, the send’s measure is only its floor');
  assert.equal(Math.max(target + 100, p.out().reserve) - 600, target, 'at rest the view reaches exactly the pin');
});

test('the Changes chip above the composer is part of what a send gives back: the room made at the send already holds it, so its going away cannot clamp the pin', async () => {
  const target = 2000 - PIN_INSET;
  const growth = { extra: 0, chip: 48 };
  const p = await probe(growth);
  await p.layout(552);
  await p.report(1448, 2000, 552);
  await p.pin(); // measured at the send: 552 + the chip's 48
  growth.chip = 0; // the send starts the turn: the chip goes
  await p.grow(2100);
  await p.grow(target + 600);
  assert.equal(p.out().reserve, target + 600, 'made for the view the chip gives back to, before the view has grown');
});
