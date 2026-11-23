// The baseline's spark (twelve rays, spinning only when asked and never under Reduce Motion) and the floating picker sheet (scrim, ✕ or ‹, hardware back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const sparkPath = '../mobile/src/components/Spark';
const sheetPath = '../mobile/src/components/BottomSheet';
const themePath = '../mobile/src/theme';
const motionPath = '../mobile/src/motion';
const { Spark, RAYS } = await import(sparkPath);
const { BottomSheet, DISMISS_AT, DISMISS_VELOCITY, pulled, dismisses } = await import(sheetPath);
const { light, dark } = await import(themePath);
const { spring } = await import(motionPath);

async function render(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    rerender: (next: any) => act(async () => root.render(next)),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const style = (el: Element) => JSON.parse((el as HTMLElement).dataset.style!);
const styled = (host: HTMLElement) => [...host.querySelectorAll('[data-style]')] as HTMLElement[];
// Android is where the hardware back button exists; iOS registers nothing
(globalThis as any).__phonePlatform = 'android';
const listeners = () => ((globalThis as any).__phoneBackListeners ??= []) as Array<() => boolean>;

test('the spark draws twelve orange rays, long and short in turn, scaled to its size and hidden from a screen reader', async () => {
  assert.deepEqual(
    RAYS.map((r: any) => r.reach),
    [9.5, 7, 9.5, 7, 9.5, 7, 9.5, 7, 9.5, 7, 9.5, 7],
  );
  const r = await render(createElement(Spark, { size: 48 }));
  const box = styled(r.host)[0];
  assert.equal(style(box).width, 48);
  const bars = styled(r.host).filter((n) => style(n).backgroundColor);
  assert.equal(bars.length, 12);
  assert.ok(bars.every((b) => style(b).backgroundColor === light.orange));
  // at twice the 24-unit square: a long ray is (9.5 - 2.2 + 2.2) × 2 wide, a short one (7 - 2.2 + 2.2) × 2
  assert.equal(style(bars[0]).width, 19);
  assert.equal(style(bars[1]).width, 14);
  const turns = styled(r.host)
    .filter((n) => style(n).transform)
    .map((n) => style(n).transform[0].rotate);
  assert.deepEqual(
    turns,
    RAYS.map((x: any) => `${x.angle}deg`),
  );
  await r.done();
});

test('the spark spins only when asked, takes a colour, and stays still under Reduce Motion', async () => {
  const spinning = await render(createElement(Spark, { spin: true, color: '#123456' }));
  const box = style(styled(spinning.host)[0]);
  assert.equal(box.animationDuration, 1100);
  assert.equal(box.animationIterationCount, 'infinite');
  assert.equal(box.width, 22, 'the default size');
  assert.ok(
    styled(spinning.host)
      .filter((n) => style(n).backgroundColor)
      .every((b) => style(b).backgroundColor === '#123456'),
  );
  await spinning.done();
  (globalThis as any).__phoneReduceMotion = true;
  try {
    const still = await render(createElement(Spark, { spin: true }));
    assert.equal(style(styled(still.host)[0]).animationName, undefined);
    await still.done();
  } finally {
    delete (globalThis as any).__phoneReduceMotion;
  }
});

const g = globalThis as any;
const timings = () => (g.__phoneTimings ?? []) as { to: number; config: any }[];
const later = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const scrimOf = (host: HTMLElement, colour: string) => styled(host).find((n) => style(n).backgroundColor === colour)!;
const measure = (height: number) => act(async () => g.__phoneOnLayout({ nativeEvent: { layout: { height } } }));
const sheetOf = (open: boolean, props: Record<string, unknown> = {}) =>
  createElement(BottomSheet, { open, title: 'Select model', onClose: () => {}, ...props }, createElement('span', null, 'Opus'));

test('a closed sheet draws nothing and listens for no back button; open, the scrim, ✕ and back close it', async () => {
  let closes = 0;
  const sheet = (open: boolean) => sheetOf(open, { onClose: () => closes++ });
  const before = listeners().length;
  const r = await render(sheet(false));
  assert.equal(r.host.textContent, '');
  assert.equal(listeners().length, before);
  const dismissed = g.__keyboardDismissed ?? 0;
  await r.rerender(sheet(true));
  assert.equal(g.__keyboardDismissed, dismissed + 1, 'opening the sheet puts the keyboard away');
  assert.match(r.host.textContent!, /Select model/);
  assert.match(r.host.textContent!, /Opus/);
  const card = styled(r.host).find((n) => style(n).borderRadius === 40)!;
  assert.equal(style(card).backgroundColor, light.bg);
  assert.equal(style(card).marginHorizontal, 8);
  assert.equal(card.dataset.entering, undefined, 'no spring entering: it overshot by ~110 pt on the iPhone');
  assert.equal(style(card).transform[0].translateY, 10000, 'off screen until measured');
  g.__phoneTimings = [];
  await measure(320);
  await measure(330);
  assert.deepEqual(
    timings(),
    [{ to: 1, config: spring.baseline, spring: true }],
    'one rise on the sheet spring (critical: it does not overshoot), however often the card is measured again',
  );
  assert.equal(style(scrimOf(r.host, 'rgba(0,0,0,0.28)')).backgroundColor, 'rgba(0,0,0,0.28)');
  await act(async () => (r.host.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click());
  await act(async () => (r.host.querySelector('button[aria-label="Close"]') as HTMLElement).click());
  assert.equal(listeners().length, before + 1);
  await act(async () => void listeners().at(-1)!());
  assert.equal(closes, 3);
  await r.done();
});

test('closing a sheet slides it and its scrim away over dur.base on the exit curve, and removes it when that move finishes; reopening mid-exit keeps it', async () => {
  const r = await render(sheetOf(true));
  await measure(300);
  g.__phoneTimings = [];
  g.__phoneHoldTimings = true;
  try {
    await r.rerender(sheetOf(false));
    assert.deepEqual(timings(), [{ to: 0, config: { duration: 200, easing: { bezier: [0.8, 0, 0.4, 1] } } }]);
    assert.match(r.host.textContent!, /Select model/, 'still drawn while it leaves');
    await act(async () => g.__phoneFinishTiming(true));
    assert.equal(r.host.textContent, '', 'gone once the move has finished');
    await r.rerender(sheetOf(true));
    await measure(300);
    g.__phoneTimings = [];
    await r.rerender(sheetOf(false));
    const stale = g.__phoneFinishTiming;
    await r.rerender(sheetOf(true));
    assert.deepEqual(
      timings().map((t) => t.to),
      [0, 1],
      'reopened before it left: it rises from where it is',
    );
    await act(async () => stale(false));
    assert.match(r.host.textContent!, /Select model/, 'the cut-short exit does not remove it');
  } finally {
    delete g.__phoneHoldTimings;
  }
  await r.done();
});

/** A pan on the card: grabbed at `y`, moved through `moves` (translationY), released at the last with `velocityY`. */
const pan = () => g.__phonePan;
const scrolledTo = (y: number) => act(async () => g.__scrollEvents.onScroll({ nativeEvent: { contentOffset: { y } } }));
async function dragCard(y: number, moves: number[], velocityY = 0, canceled = false) {
  await act(async () => pan().onActivate({ y: y + moves[0], translationY: moves[0] }));
  for (const translationY of moves) await act(async () => pan().onUpdate({ translationY }));
  await act(async () => pan().onDeactivate({ translationY: moves.at(-1), velocityY, canceled }));
}
/** What the owner does after a close: shows the sheet again (the test's onClose does not hide it). */
const reopen = async (r: { rerender: (n: any) => Promise<void> }, onClose: () => void) => {
  await r.rerender(sheetOf(false, { onClose }));
  await r.rerender(sheetOf(true, { onClose }));
  await measure(400);
};
const header = (host: HTMLElement) => {
  let el: any = host.querySelector('button[aria-label="Close"]');
  while (el && !el.__onLayout) el = el.parentElement;
  return el;
};

test('a pull down on the header follows the finger on the UI thread, closes past a third of the card or on a quick flick, and otherwise springs back', async () => {
  let closes = 0;
  g.__phonePan = undefined;
  const r = await render(sheetOf(true, { onClose: () => closes++ }));
  await measure(400);
  await act(async () => header(r.host).__onLayout({ nativeEvent: { layout: { y: 14, height: 40 } } }));
  assert.deepEqual(pan().activeOffsetY, [-1e6, 10], 'only downwards');
  assert.deepEqual(pan().failOffsetX, [-10, 10], 'sideways stays with the buttons');
  assert.deepEqual(pan().simultaneousWith, { handlerTag: 7 }, 'it runs beside the scroll view’s own gesture');
  g.__phoneTimings = [];
  await dragCard(30, [100]);
  assert.deepEqual(
    [closes, timings().at(-1)!.to, timings().at(-1)!.config.duration],
    [0, 1, 200],
    'a short pull springs back over dur.base',
  );
  await dragCard(30, [200]);
  assert.equal(closes, 1, 'past a third of the card');
  await reopen(r, () => closes++);
  await dragCard(30, [20], (DISMISS_VELOCITY + 0.2) * 1000);
  assert.equal(closes, 2, 'a quick flick');
  await reopen(r, () => closes++);
  await scrolledTo(80);
  await dragCard(30, [200]);
  assert.equal(closes, 3, 'the header pulls even when the content is scrolled down');
  await reopen(r, () => closes++);
  const before = closes;
  await dragCard(30, [300], 0, true);
  assert.equal(closes, before, 'an interrupted pull does not close');
  assert.equal(timings().at(-1)!.to, 1, 'and comes back');
  await r.done();
});

test('content at its top is pulled by the same pan as the header, with no dead zone, and content with room above it is only scrolled', async () => {
  let closes = 0;
  const r = await render(sheetOf(true, { onClose: () => closes++ }));
  await measure(400);
  await act(async () => header(r.host).__onLayout({ nativeEvent: { layout: { y: 14, height: 40 } } }));
  g.__phoneTimings = [];
  await dragCard(300, [350]);
  assert.equal(closes, 1, 'a long pull on content at its top closes the sheet');
  await reopen(r, () => closes++);
  await dragCard(300, [12], (DISMISS_VELOCITY + 0.2) * 1000);
  assert.equal(closes, 2, 'and so does a quick flick');
  await reopen(r, () => closes++);
  await dragCard(300, [60]);
  assert.deepEqual([closes, timings().at(-1)!.to], [2, 1], 'a short pull springs back');
  // scrolled down: the finger moves 400 pt and the sheet does not move or close, however fast
  await scrolledTo(120);
  await dragCard(300, [150, 400], (DISMISS_VELOCITY + 0.5) * 1000);
  assert.equal(closes, 2, 'content scrolling toward its top never closes the sheet');
  // the content reaches its top in the same touch: the pull counts from there, not from where the touch began
  await act(async () => pan().onActivate({ y: 310, translationY: 10 }));
  await act(async () => pan().onUpdate({ translationY: 100 }));
  await scrolledTo(0);
  await act(async () => pan().onUpdate({ translationY: 160 }));
  await act(async () => pan().onDeactivate({ translationY: 160, velocityY: 0, canceled: false }));
  assert.equal(closes, 2, '60 pt past the content’s top is a short pull (160 pt from the touch would close it)');
  // pulled, then the finger goes back above where the pull began: the touch is the content’s again
  await act(async () => pan().onActivate({ y: 310, translationY: 10 }));
  await act(async () => pan().onUpdate({ translationY: 100 }));
  await act(async () => pan().onUpdate({ translationY: -20 }));
  await act(async () => pan().onUpdate({ translationY: 30 }));
  await act(async () => pan().onDeactivate({ translationY: 30, velocityY: 0, canceled: false }));
  assert.equal(closes, 2, 'the pull restarts from the turning point (50 pt from there, not 130 from the touch)');
  await r.done();
});

test('a sheet that is also a page of choices draws its grabber bar above the header', async () => {
  const r = await render(sheetOf(true, { grabber: true }));
  await measure(300);
  assert.ok(
    styled(r.host).some((n) => style(n).width === 36 && style(n).height === 5),
    'the 36 × 5 bar',
  );
  await r.done();
});

test('the pull maths: the shown fraction stays between away and shown, and the thresholds are the sheet’s', () => {
  assert.equal(pulled(1, 100, 400), 0.75);
  assert.equal(pulled(1, -50, 400), 1, 'it never rises above shown');
  assert.equal(pulled(1, 900, 400), 0, 'nor below away');
  assert.equal(dismisses(1 - DISMISS_AT - 0.01, 0), true);
  assert.equal(dismisses(1 - DISMISS_AT + 0.01, 0), false);
  assert.equal(dismisses(0.95, DISMISS_VELOCITY + 0.1), true);
});

test('a sheet page reached from another goes back with ‹ and the back button, on the dark scrim, and appears without motion under Reduce Motion', async () => {
  let backs = 0;
  let closes = 0;
  g.__phoneDark = true;
  g.__phoneReduceMotion = true;
  g.__phoneTimings = [];
  try {
    const r = await render(
      createElement(
        BottomSheet,
        { open: true, title: 'Effort', onClose: () => closes++, onBack: () => backs++ },
        createElement('span', null, 'High'),
      ),
    );
    assert.equal(r.host.querySelector('button[aria-label="Close"]'), null);
    await act(async () => (r.host.querySelector('button[aria-label="Back"]') as HTMLElement).click());
    await act(async () => void listeners().at(-1)!());
    const card = styled(r.host).find((n) => style(n).borderRadius === 40)!;
    assert.equal(style(card).backgroundColor, dark.bg);
    await measure(200);
    assert.deepEqual(timings(), [], 'Reduce Motion: no rise');
    assert.ok(scrimOf(r.host, 'rgba(0,0,0,0.5)'));
    await act(async () => (r.host.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click());
    assert.deepEqual([backs, closes], [2, 1]);
    await r.done();
  } finally {
    delete g.__phoneDark;
    delete g.__phoneReduceMotion;
  }
});

test('under Reduce Motion a sheet leaves and returns without motion, and a released pull comes back without a timing', async () => {
  g.__phoneReduceMotion = true;
  g.__phoneTimings = [];
  try {
    const r = await render(sheetOf(true));
    await measure(300);
    await act(async () => g.__phonePan.onActivate({ y: 10, translationY: 10 }));
    await act(async () => g.__phonePan.onUpdate({ translationY: 50 }));
    await act(async () => g.__phonePan.onDeactivate({ translationY: 50, velocityY: 0, canceled: false }));
    await r.rerender(sheetOf(false));
    await later(10);
    assert.equal(r.host.textContent, '');
    await r.rerender(sheetOf(true));
    assert.match(r.host.textContent!, /Select model/);
    assert.deepEqual(timings(), []);
    await r.done();
  } finally {
    delete g.__phoneReduceMotion;
  }
});
