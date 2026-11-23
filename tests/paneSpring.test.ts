// The side pane's width spring (src/components/panels/usePaneSpring.ts): it opens from 0 and closes to 0 on the
// Codex app's right-panel spring, and a reversal mid-way starts from the edge's current width and speed instead of
// the far end; a new width mid-open retargets it the same way, the full view and reduced motion play none, and
// returning from full view does not replay the open.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { PANE_SPRING_MS, PANE_SPRING_STEPS, paneCurve } from '../src/lib/paneMotion.ts';

const { createElement: h, act, useLayoutEffect, useRef, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { usePaneSpring } = await import('../src/components/panels/usePaneSpring.ts');

type Played = { frames: number[]; duration: number; fill: string; cancelled: boolean };
let played: Played[] = [];
let now = 0;
let measured = 0;
const realNow = performance.now.bind(performance);
const proto = (globalThis as any).HTMLElement.prototype;
const realAnimate = proto.animate;
const realRect = proto.getBoundingClientRect;
const realMatch = (window as any).matchMedia;

beforeEach(() => {
  played = [];
  now = 1000;
  measured = 0;
  (performance as any).now = () => now;
  proto.animate = function (frames: { width: string }[], opts: { duration: number; fill: string }) {
    const p: Played = { frames: frames.map((f) => Number.parseFloat(f.width)), duration: opts.duration, fill: opts.fill, cancelled: false };
    played.push(p);
    return { cancel: () => void (p.cancelled = true) };
  };
  proto.getBoundingClientRect = () => ({ width: measured });
});
afterEach(() => {
  (performance as any).now = realNow;
  proto.animate = realAnimate;
  proto.getBoundingClientRect = realRect;
  (window as any).matchMedia = realMatch;
});

/** A pane element driven by the hook; `set` re-renders it with new props. */
let settle: () => void = () => undefined;
async function pane(props: { leaving: boolean; width: number; full: boolean }) {
  const Pane = (p: typeof props) => {
    const ref = useRef<HTMLDivElement>(null);
    settle = usePaneSpring(ref, p.leaving, p.width, p.full);
    return h('div', { ref });
  };
  const root = createRoot(document.createElement('div'));
  await act(() => root.render(h(Pane, props)));
  return {
    set: (next: Partial<typeof props>) => act(() => root.render(h(Pane, (props = { ...props, ...next })))),
    unmount: () => act(() => root.unmount()),
  };
}
const close = (a: number, b: number, d = 1e-6) => Math.abs(a - b) < d;

test('it opens from 0 to its width on the spring, then leaves the width to the pane', async () => {
  const v = await pane({ leaving: false, width: 600, full: false });
  assert.equal(played.length, 1);
  const [open] = played;
  assert.equal(open.duration, PANE_SPRING_MS);
  assert.equal(open.fill, 'none');
  assert.equal(open.frames.length, PANE_SPRING_STEPS + 1);
  assert.equal(open.frames[0], 0);
  assert.equal(open.frames.at(-1), 600);
  assert.ok(close(open.frames[12], paneCurve(0, 600).at(200)));
  await v.unmount();
});

test('closed mid-open, it springs shut from where the edge is, as fast as it was moving; reopened, the same', async () => {
  const v = await pane({ leaving: false, width: 600, full: false });
  now += 120;
  await v.set({ leaving: true });
  assert.equal(played.length, 2);
  assert.ok(played[0].cancelled);
  const opening = paneCurve(0, 600);
  const shut = played[1];
  assert.equal(shut.fill, 'forwards', 'it holds 0 until the pane unmounts');
  assert.ok(close(shut.frames[0], opening.at(120)), 'no jump to the far end');
  assert.ok(shut.frames[0] > 300 && shut.frames[0] < 600);
  assert.equal(shut.frames.at(-1), 0);
  // its first step carries on in the direction the edge was moving (still opening), then turns back
  const closing = paneCurve(opening.at(120), 0, opening.velocity(120));
  assert.ok(close(shut.frames[1], closing.at(PANE_SPRING_MS / PANE_SPRING_STEPS)));
  assert.ok(shut.frames[1] > shut.frames[0]);
  // a resize while it closes changes nothing
  await v.set({ width: 640 });
  assert.equal(played.length, 2);
  now += 80;
  await v.set({ leaving: false });
  assert.equal(played.length, 3);
  assert.ok(played[1].cancelled);
  assert.ok(close(played[2].frames[0], closing.at(80)));
  assert.equal(played[2].frames.at(-1), 640);
  assert.equal(played[2].fill, 'none');
  await v.unmount();
});

test('once settled, closing starts from the measured width at rest', async () => {
  const v = await pane({ leaving: false, width: 600, full: false });
  now += PANE_SPRING_MS + 50;
  // a resize after the spring has settled just moves the edge
  await v.set({ width: 580 });
  assert.equal(played.length, 1);
  measured = 580;
  await v.set({ leaving: true });
  assert.equal(played.length, 2);
  assert.deepEqual([played[1].frames[0], played[1].frames.at(-1)], [580, 0]);
  assert.ok(close(played[1].frames[1], paneCurve(580, 0).at(PANE_SPRING_MS / PANE_SPRING_STEPS)), 'from rest');
  await v.unmount();
});

test('a new width while it opens retargets the spring from where the edge is; closing later starts from rest', async () => {
  const v = await pane({ leaving: false, width: 600, full: false });
  now += 100;
  await v.set({ width: 520 });
  assert.equal(played.length, 2);
  assert.ok(played[0].cancelled);
  const opening = paneCurve(0, 600);
  const retarget = paneCurve(opening.at(100), 520, opening.velocity(100));
  assert.ok(close(played[1].frames[0], opening.at(100)));
  assert.ok(close(played[1].frames[1], retarget.at(PANE_SPRING_MS / PANE_SPRING_STEPS)));
  assert.equal(played[1].frames.at(-1), 520);
  assert.equal(played[1].fill, 'none');
  // settled, a re-render plays nothing
  now += PANE_SPRING_MS;
  await v.set({ width: 500 });
  assert.equal(played.length, 2);
  measured = 500;
  await v.set({ leaving: true });
  assert.equal(played.length, 3);
  assert.equal(played[2].frames[0], 500);
  await v.unmount();
});

test('the pane measuring its lane in the commit it mounts in still opens, to the measured width', async () => {
  // SidePane starts from the window's width, then measures its lane in a layout effect before the first paint
  const Pane = () => {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(860);
    usePaneSpring(ref, false, width, false);
    useLayoutEffect(() => setWidth(540), []);
    return h('div', { ref });
  };
  const root = createRoot(document.createElement('div'));
  await act(() => root.render(h(Pane)));
  const last = played.at(-1)!;
  assert.ok(!last.cancelled, 'the open plays');
  assert.equal(last.frames[0], 0);
  assert.equal(last.frames.at(-1), 540);
  assert.ok(played.slice(0, -1).every((p) => p.cancelled));
  await act(() => root.unmount());
});

test('the full view plays none (it fades in CSS) and coming back from it does not replay the open', async () => {
  const v = await pane({ leaving: false, width: 600, full: false });
  await v.set({ full: true });
  assert.ok(played[0].cancelled);
  await v.set({ full: false });
  assert.equal(played.length, 1);
  await v.unmount();
  // mounted in full view, leaving it later plays nothing either
  const w = await pane({ leaving: false, width: 600, full: true });
  await w.set({ full: false });
  assert.equal(played.length, 1);
  await w.unmount();
});

test('a pane that mounts already leaving closes from its measured width', async () => {
  measured = 420;
  const v = await pane({ leaving: true, width: 600, full: false });
  assert.equal(played.length, 1);
  assert.deepEqual([played[0].frames[0], played[0].frames.at(-1), played[0].fill], [420, 0, 'forwards']);
  await v.unmount();
});

test('with reduced motion, or where the element cannot animate, nothing plays', async () => {
  (window as any).matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  const v = await pane({ leaving: false, width: 600, full: false });
  await v.set({ leaving: true });
  assert.equal(played.length, 0);
  await v.unmount();
  (window as any).matchMedia = realMatch;
  proto.animate = undefined;
  const w = await pane({ leaving: false, width: 600, full: false });
  await w.set({ leaving: true });
  await w.unmount();
  assert.equal(played.length, 0);
});

test('a drag of the edge settles an open still under way: the drag width shows and no spring replays (#2049)', async () => {
  const v = await pane({ leaving: false, width: 600, full: false });
  now += 100;
  settle();
  assert.ok(played[0].cancelled, 'the animated width no longer hides the drag');
  await v.set({ width: 700 }); // the drag's width, committed on release while the open would still have run
  assert.equal(played.length, 1, 'no spring toward the released width');
  await v.set({ leaving: true });
  assert.equal(played.length, 2, 'closing still springs');
  settle(); // closing: nothing to settle
  assert.equal(played[1].cancelled, false);
  await v.unmount();
  const reduced = await pane({ leaving: false, width: 600, full: true });
  settle(); // nothing played: nothing to settle
  await reduced.unmount();
});
