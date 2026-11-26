// The keyboard lift of a chat (#5686): the arithmetic the UI thread runs in every frame, and the hook that gives it where the view stands. On the device the transcript sat still while the keyboard rose and then moved by its height in one frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';

const mathPath = '../mobile/src/remote/keyboardLift';
const hookPath = '../mobile/src/remote/useChatLift';
const { LIFT_QUIET, LIFT_RECENT, NO_INPUT, NO_MOTION, lifted, liftTarget, stepLift } = await import(mathPath);
const framePath = '../mobile/src/remote/frameLift';
const { FrameLift } = await import(framePath);
const slidePath = '../mobile/src/remote/useSlide';
const { BAND_SLACK, useSlide } = await import(slidePath);
const g = globalThis as any;

/** A reader at the end of 2000 points in a view of 600. */
const atEnd = { ...NO_INPUT, y: 1400, content: 2000, view: 600 };

test('the lift is the keyboard’s height less the home indicator’s, never negative', () => {
  assert.equal(lifted(336, 34), 302);
  assert.equal(lifted(20, 34), 0);
  assert.equal(lifted(0, 0), 0);
});

test('the offset goes to where the end will be: up by the lift, down with it, never past the end the view will have, never below the top', () => {
  assert.equal(liftTarget(1400, 2000, 600, 300), 1700);
  assert.equal(liftTarget(1700, 2000, 300, -300), 1400, 'closing: the view was 300 and will be 600');
  assert.equal(liftTarget(0, 250, 600, 300), 0, 'content that still fits stays at the top');
  assert.equal(liftTarget(0, 500, 600, 300), 200, '500 in a view that will be 300: the end is at 200');
  assert.equal(liftTarget(100, 2000, 300, -300), 0, 'never below the top');
});

test('a lift begun by a reader at the end moves them, goes on through its frames and a candidate bar, and ends when the keyboard has been quiet', () => {
  let m = NO_MOTION;
  let step = stepLift(m, atEnd, 0, 0);
  assert.deepEqual([step.to, step.motion], [null, m], 'a keyboard that is not moving changes nothing');
  m = step.motion;
  step = stepLift(m, atEnd, 100, 16);
  assert.equal(step.to, 1500);
  assert.deepEqual(
    [step.motion.active, step.motion.engaged, step.motion.y0, step.motion.p0, step.motion.view0],
    [true, true, 1400, 0, 600],
  );
  m = step.motion;
  // the view reports where the lift has taken it: the frames go on from where the lift began, not from the report
  step = stepLift(m, { ...atEnd, y: 1480, view: 520 }, 300, 32);
  assert.equal(step.to, 1700);
  m = step.motion;
  step = stepLift(m, atEnd, 327, 48);
  assert.equal(step.to, 1727, 'a candidate bar is the same lift going on');
  m = step.motion;
  step = stepLift(m, atEnd, 327, 48 + LIFT_QUIET);
  assert.deepEqual([step.to, step.motion], [null, m], 'quiet, but not yet for long enough');
  step = stepLift(m, atEnd, 327, 48 + LIFT_QUIET + 1);
  assert.deepEqual([step.to, step.motion.active, step.motion.engaged], [null, false, false], 'over');
  assert.equal(step.motion.p, 327, 'and the next lift counts from where this one left the keyboard');
  m = step.motion;
  step = stepLift(m, { ...atEnd, y: 1727, view: 273 }, 0, 400);
  assert.deepEqual([step.to, step.motion.p0], [1400, 327], 'the keyboard closes: the content comes down by the same');
});

test('nothing moves a reader who is away, held by a finger or a pinned message, or not following; one that is taken by a finger or a pin in the middle of a lift is let go', () => {
  for (const held of [{ y: 900 }, { touching: true }, { pinned: true }, { following: false }]) {
    const step = stepLift(NO_MOTION, { ...atEnd, ...held }, 300, 0);
    assert.equal(step.to, null, JSON.stringify(held));
    assert.equal(step.motion.engaged, false);
  }
  const first = stepLift(NO_MOTION, atEnd, 100, 0);
  assert.equal(first.to, 1500);
  assert.equal(stepLift(first.motion, { ...atEnd, touching: true }, 200, 16).to, null, 'a finger landed');
  assert.equal(stepLift(first.motion, { ...atEnd, pinned: true }, 200, 16).to, null, 'a message was pinned');
  // within the rest zone of the end counts as at the end, short of it does not
  assert.equal(stepLift(NO_MOTION, { ...atEnd, y: 1396 }, 100, 0).to, 1496);
  assert.equal(stepLift(NO_MOTION, { ...atEnd, y: 1395 }, 100, 0).to, null);
});

test('the hook keeps the UI thread told where the view stands and whose it is, and tells it nothing twice', async () => {
  const { useIosLift, useNoLift } = await import(hookPath);
  let lift: any;
  const Probe = () => {
    lift = useIosLift();
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  const first = lift;
  lift.publish({ y: 1400, content: 2000, view: 600 });
  lift.publish({ y: 1400, content: 2000, view: 600 });
  assert.equal(lift.following.current, true);
  lift.touching.current = true;
  lift.pinned.current = true;
  lift.following.current = false;
  assert.deepEqual([lift.touching.current, lift.pinned.current, lift.following.current], [true, true, false]);
  await act(async () => root.render(createElement(Probe)));
  assert.equal(lift.touching, first.touching, 'the flags are the same ones on every render');
  await act(async () => root.unmount());
  host.remove();
  // where the keyboard does not lift the frame the flags are plain
  let plain: any;
  const Plain = () => {
    plain = useNoLift();
    return null;
  };
  const host2 = document.createElement('div');
  document.body.append(host2);
  const root2 = createRoot(host2);
  await act(async () => root2.render(createElement(Plain)));
  plain.publish({ y: 1, content: 2, view: 3 });
  plain.touching.current = true;
  assert.deepEqual([plain.following.current, plain.pinned.current, plain.touching.current], [true, false, true]);
  await act(async () => root2.unmount());
  host2.remove();
});

test('the chat takes the lift on iOS and a plain ref elsewhere', async () => {
  const { useChatLift } = await import(hookPath);
  for (const platform of ['ios', 'android']) {
    g.__phonePlatform = platform;
    let lift: any;
    const Probe = () => {
      lift = useChatLift();
      return null;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    // the animated ref is a function that holds what it was attached to; a plain ref is not
    assert.equal(typeof lift.ref, platform === 'ios' ? 'function' : 'object', platform);
    await act(async () => root.unmount());
    host.remove();
  }
  delete g.__phonePlatform;
});

test('a lift begun before the view has reported where the last one took it starts from there, and one begun after a report starts from the report', () => {
  let m = stepLift(NO_MOTION, { ...atEnd, seq: 1 }, 300, 0).motion; // opens: 1400 → 1700
  m = stepLift(m, { ...atEnd, seq: 1 }, 300, 1).motion;
  const ended = stepLift(m, { ...atEnd, seq: 1 }, 300, LIFT_QUIET + 2);
  assert.deepEqual([ended.motion.active, ended.motion.last, ended.motion.seq], [false, 1700, 1]);
  const closed = { ...atEnd, view: 300, y: 1400, seq: 1 }; // the view has said nothing since: its 1400 is the one from before the lift
  const next = stepLift(ended.motion, closed, 0, LIFT_QUIET + 40);
  assert.equal(next.motion.y0, 1700, 'from where the last lift took the view');
  assert.equal(next.to, 1400, 'and it comes down by the same');
  const reported = stepLift(ended.motion, { ...closed, y: 1700, seq: 2 }, 0, LIFT_QUIET + 40);
  assert.equal(reported.motion.y0, 1700, 'a report heard since is the view’s own');
  const moved = stepLift(ended.motion, { ...closed, y: 900, seq: 3 }, 0, LIFT_QUIET + 40);
  assert.deepEqual(
    [moved.motion.y0, moved.motion.engaged, moved.to],
    [900, false, null],
    'a reader who moved meanwhile is not taken back to it',
  );
  const late = stepLift(ended.motion, { ...closed, y: 1100, seq: 1 }, 0, LIFT_QUIET + 2 + LIFT_RECENT);
  assert.equal(late.motion.y0, 1100, 'after LIFT_RECENT the report is all there is');
});

test('the frame callback is one function for the life of the screen, so Reanimated registers it once', async () => {
  const { useIosLift } = await import(hookPath);
  const seen: unknown[] = [];
  const Probe = ({ n }: { n: number }) => {
    useIosLift();
    seen.push(g.__phoneFrame);
    return createElement('i', null, n);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  for (const n of [1, 2, 3]) await act(async () => root.render(createElement(Probe, { n })));
  assert.equal(new Set(seen).size, 1, 'every render gave the same function');
  await act(async () => root.unmount());
  host.remove();
});

test('the offsets a lift takes the view between are its own, with a little slack, and nothing is its own when no lift is moving the reader', () => {
  let slide: any;
  const Probe = () => {
    slide = useSlide();
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return act(async () => root.render(createElement(Probe))).then(async () => {
    assert.equal(slide.inBand(100), false, 'no band, no lift');
    slide.slide.current.band = [1400, 1700];
    assert.deepEqual([1400, 1550, 1700, 1700 + BAND_SLACK, 1400 - BAND_SLACK].map(slide.inBand), [true, true, true, true, true]);
    assert.deepEqual([0, 1700 + BAND_SLACK + 1, 1400 - BAND_SLACK - 1].map(slide.inBand), [false, false, false]);
    assert.equal(slide.sliding(), false);
    assert.equal(slide.layoutHeld(), false);
    slide.slide.current.until = Date.now() + 1000;
    slide.slide.current.layoutUntil = Date.now() + 1000;
    assert.deepEqual([slide.sliding(), slide.layoutHeld()], [true, true]);
    await act(async () => root.unmount());
    host.remove();
  });
});

test('a chat inside the app frame scrolls by the frame’s own lift, not by a reading of the keyboard of its own', async () => {
  const { useIosLift } = await import(hookPath);
  g.__liftedTo = [];
  g.__phoneKeyboardHeight = 999; // what a reading of its own would say: not used
  const lift = { value: 0 };
  let chat: any;
  const Probe = () => {
    chat = useIosLift();
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(FrameLift.Provider, { value: lift }, createElement(Probe))));
  chat.publish({ y: 1400, content: 2000, view: 600 });
  const run = () =>
    act(async () => {
      for (const slot of [...g.__phoneReactions]) {
        const now = slot.prepare();
        const before = slot.before;
        slot.before = now;
        if (now !== before) slot.react(now, before);
      }
    });
  await run();
  lift.value = 120;
  await run();
  assert.deepEqual(g.__liftedTo, [{ x: 0, y: 1520, animated: false }], 'by the frame’s 120, in the flush that gave the frame its padding');
  await act(async () => root.unmount());
  host.remove();
  delete g.__phoneKeyboardHeight;
  delete g.__liftedTo;
});

test('a view that has not reported its size (a chat that opens with the keyboard already up) is not moved', () => {
  const step = stepLift(NO_MOTION, { ...NO_INPUT, view: 0 }, 300, 0);
  assert.deepEqual([step.to, step.motion.engaged], [null, false]);
});
