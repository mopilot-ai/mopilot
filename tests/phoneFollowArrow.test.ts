// The jump arrow after a send (#5686): no arrow while the sent message is on its way to its place or the keyboard close is still growing the view, an arrow once a reply really passes the fold, and each decision as a performance-log line.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act } from './support/phone/component-kit';
import { probe, unmountProbes } from './support/phone/followProbe';

const followPath = '../mobile/src/remote/useFollowEnd';
const originPath = '../mobile/src/sendOrigin';
const { PIN_INSET } = await import(followPath);
const { reportSentTop } = await import(originPath);
const g = globalThis as any;

afterEach(async () => {
  mock.timers.reset();
  await unmountProbes();
});

test('a second send whose bubble lands inside the room the first one left: no arrow while the message is on its way to its place, and the arrow when a reply passes the fold after it', async () => {
  const target = 2000 - PIN_INSET;
  g.__phoneKeyboardHeight = 0;
  const p = await probe({ extra: 0 });
  await p.layout(600);
  await p.report(1400, 2000, 600);
  await p.pin();
  await p.grow(2100);
  await p.grow(target + 600); // the first send placed, its room in the content
  const marker = (end: number) => act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: end - 16 } } }));
  await marker(target + 300); // its reply fills part of the room
  g.__phoneKeyboardHeight = 300; // the keyboard is up for the next message
  await p.layout(300);
  await p.report(target, target + 600, 300);
  await p.pin(); // the second send: its bubble lands inside the old room, so the content does not grow
  await marker(target + 400);
  assert.equal(p.out().away, false, 'on its way to its place: no arrow');
  await act(async () => reportSentTop(target + 300 + 8)); // the bubble says where it sits: the pin places it
  await p.grow(target + 300 + 600); // the room under it is part of the content: the view goes there
  await marker(target + 300 + 700);
  await p.grow(target + 300 + 700); // a reply under it passes the fold: the content outgrows the room
  assert.equal(p.out().away, true, 'placed, then a reply past the fold: the arrow');
  delete g.__phoneKeyboardHeight;
});

test('reports from before the pin scroll lands are its echo: a two-line message (taller than the arrow distance) shows no arrow while the view is still at the old end, and a move after the echo is read again', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const target = 2000 - PIN_INSET;
  const p = await probe({ extra: 0 });
  await p.layout(600);
  await p.report(1400, 2000, 600);
  await p.pin();
  await p.grow(2100);
  await p.grow(target + 600); // the room under it is part of the content: the pin scrolls to it
  assert.deepEqual(p.to.at(-1), { y: target, animated: false });
  await act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: 2100 - 16 } } })); // the two-line bubble: the rows end 100 pt past the old view
  await p.report(1400, target + 600, 600); // a report sent before the scroll landed: still the old end
  assert.equal(p.out().away, false, 'the pin scroll has not landed yet: no arrow');
  await p.report(target, target + 600, 600); // it lands
  assert.equal(p.out().away, false, 'placed: no arrow');
  await act(async () => mock.timers.tick(700));
  await p.report(1400, target + 600, 600); // long after the pin: a move up with no finger (a screen reader) is the reader's
  assert.equal(p.out().away, true, 'after the echo the distance counts again');
});

test('a finger in the echo of the pin scroll is the reader: the arrow answers it at once', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const target = 2000 - PIN_INSET;
  const p = await probe({ extra: 0 });
  await p.layout(600);
  await p.report(1400, 2000, 600);
  await p.pin();
  await p.grow(2100);
  await p.grow(target + 600);
  await act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: 2100 - 16 } } }));
  await p.report(target, target + 600, 600);
  await p.touch();
  await p.report(1400, target + 600, 600); // the finger takes the view up, inside the echo window
  assert.equal(p.out().away, true, 'a finger is never the echo');
});

test('with the performance log on, each decision of the arrow is a line: where the view stands, where the rows end, and the pin state it rests on', async () => {
  const { perf } = await import('../mobile/src/perfLog');
  const lines: string[] = [];
  const log = mock.method(console, 'log', (line: string) => lines.push(line));
  const target = 2000 - PIN_INSET;
  const p = await probe({ extra: 0 });
  await p.layout(600);
  await p.report(1400, 2000, 600);
  await p.pin();
  assert.equal(lines.length, 0, 'off: nothing');
  perf.start();
  try {
    await p.grow(2100);
    await p.grow(target + 600);
    await act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: 2100 - 16 } } }));
    await p.report(1400, target + 600, 600);
  } finally {
    perf.end();
    log.mock.restore();
  }
  const arrow = lines.filter((l) => l.startsWith('[perf-arrow] ')).map((l) => JSON.parse(l.slice('[perf-arrow] '.length)));
  assert.deepEqual(
    { ...arrow.at(-1), t: 0 },
    {
      t: 0,
      y: 1400,
      end: 2100,
      content: target + 600,
      view: 600,
      judged: 600,
      room: target + 600,
      natural: 2100,
      away: false,
      pinned: true,
      pending: null,
      scrollPending: false,
      landing: true,
      target,
      from: 1400,
    },
  );
});

test('the device numbers of a chip-less send (#5693, ec1a29b61): the native content is the room rounded to the pixel grid, a hair over the room the JS made from a float view, and that is not a reply outgrowing it: no arrow through the close', async () => {
  // view 346.67 (a float from the native layout) with the keyboard's lift of 309 makes a room of 655.67 under the pin at 659; the list reports its content on the pixel grid
  const view = Math.fround(346 + 2 / 3);
  g.__phoneKeyboardHeight = 309;
  const p = await probe({ extra: 0 });
  await p.layout(view);
  await p.report(322 + 1 / 3, 675, view);
  await p.pin();
  await p.grow(760);
  const target = 675 - PIN_INSET;
  assert.equal(target, 659);
  const content = 1314 + 2 / 3;
  assert.ok(content > p.out().reserve && content - p.out().reserve < 0.001, 'the reported content is a hair over the room');
  await p.grow(content);
  await act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: 790 - 16 } } })); // the rows end under the new bubble
  await p.report(659, content, view);
  assert.equal(p.out().away, false, 'note 1 (view 346.67): the blank under the pin is the room');
  await p.report(659, content, 447 + 2 / 3);
  assert.equal(p.out().away, false, 'note 2 (view 447.67)');
  await p.report(659, content + 200, 447 + 2 / 3);
  assert.equal(p.out().away, true, 'a reply that really outgrows the room still shows it');
  delete g.__phoneKeyboardHeight;
});

test('a pinned reader is judged against the view the keyboard close ends at while it slides: a rows end past the shrunken view but inside the full one shows no arrow, and once the slide is over the view as it is decides again', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const frame = (h: number) => ({ screenY: 926 - h, height: h });
  const hide = { duration: 250, startCoordinates: frame(300), endCoordinates: frame(0) };
  g.__phoneKeyboardHeight = 300;
  const p = await probe({ extra: 0 });
  await p.layout(300);
  await p.report(1700, 2000, 300);
  await p.pin();
  await p.grow(2100);
  const target = 2000 - PIN_INSET;
  await p.grow(target + 600);
  await p.report(target, target + 600, 300);
  await act(async () => g.__keyboardListeners.keyboardWillChangeFrame?.(hide)); // the close begins: the view will be 600
  const marker = (end: number) => act(async () => p.out().endMarker.onLayout({ nativeEvent: { layout: { y: end - 16 } } }));
  await marker(target + 500); // past the 300 the view has now, inside the 600 it will have
  assert.equal(p.out().away, false, 'inside the view the close ends at: no arrow');
  await act(async () => mock.timers.tick(250 + 150 + 1)); // the slide is over
  await marker(target + 500);
  assert.equal(p.out().away, true, 'after the slide the view as it is decides again (the layout never grew here)');
  delete g.__phoneKeyboardHeight;
});

test('a reader who scrolled up is judged against the view as it is during a keyboard close: the arrow stays for them', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const frame = (h: number) => ({ screenY: 926 - h, height: h });
  g.__phoneKeyboardHeight = 300;
  const p = await probe({ extra: 0 });
  await p.layout(300);
  await p.report(1700, 2000, 300);
  await p.touch();
  await p.report(1500, 2000, 300); // a finger takes the view up 200: the arrow
  assert.equal(p.out().away, true);
  const hide = { duration: 250, startCoordinates: frame(300), endCoordinates: frame(0) };
  await act(async () => g.__keyboardListeners.keyboardWillChangeFrame?.(hide)); // the close begins: the view will be 600
  await p.grow(2050); // a reply grows meanwhile: the arrow is judged again
  assert.equal(p.out().away, true, '250 short of the end of the view as it is: still away, whatever the view grows into');
  delete g.__phoneKeyboardHeight;
});
