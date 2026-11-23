// The working mark on screen (src/components/thread/workingMark): the strips WorkingMark and MarkView step on the
// compositor, the dot under a fresh mark, the crossfade of a cut, and the still mark with reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { animationFrames } from './support/animationFrames.ts';
import { MARK_SHEETS } from '../src/components/thread/workingMark/markSheets.ts';
import { CROSSFADE_MS, TAIL_FRAMES, restFrame, stageDuration } from '../src/components/thread/workingMark/markStages.ts';
import { GHOST_MS, forgetLeftMark, markClock } from '../src/components/thread/workingMark/markPlayer.ts';

const INTRO_MS = stageDuration({ kind: 'grow' });

const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkingMark } = await import('../src/components/thread/workingMark/WorkingMark.tsx');
const { MARK_SIZE, MarkView, canAnimate, frameKeyframes, frameTransform, preloadSheets } = await import(
  '../src/components/thread/workingMark/markView.ts'
);

/** The mark's next looks run only when a test ticks them, inside act. */
let frames: (() => void)[] = [];
let waits: number[] = [];
function manualFrames(t: any) {
  frames = [];
  waits = [];
  t.mock.method(markClock, 'after', (ms: number, fn: () => void) => {
    waits.push(ms);
    frames.push(fn);
    return () => {
      frames = frames.filter((f) => f !== fn);
    };
  });
}
const frameTick = () =>
  act(() => {
    const due = frames.splice(0);
    for (const cb of due) cb();
  });

interface Played {
  el: HTMLElement;
  keyframes: Keyframe[];
  opts: KeyframeAnimationOptions;
  startTime: number | null;
  cancelled: boolean;
}
/** Web Animations, recorded rather than run. */
function recordAnimations(t: any): Played[] {
  const played: Played[] = [];
  const proto = (window as any).Element.prototype;
  const real = proto.animate;
  proto.animate = function (keyframes: Keyframe[], opts: KeyframeAnimationOptions) {
    const p: Played = { el: this, keyframes, opts, startTime: null, cancelled: false };
    played.push(p);
    return {
      set startTime(v: number) {
        p.startTime = v;
      },
      cancel() {
        p.cancelled = true;
      },
    };
  };
  t.after(() => {
    proto.animate = real;
  });
  return played;
}

async function mount(t: any, element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(() => root.render(element));
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(() => root.unmount());
    host.remove();
  };
  t.after(unmount);
  return { host, render: (next: any) => act(() => root.render(next)), unmount };
}

const visible = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.working-mark-layer')].filter((l) => l.style.opacity === '');
const sheetOfLayer = (l: HTMLElement) => (l.firstElementChild as HTMLElement).dataset.sheet;

test('a strip steps through its frames: one keyframe per frame, a frame tall each', () => {
  assert.equal(MARK_SIZE, 20);
  assert.equal(frameTransform(3), 'translateY(-60px)');
  assert.deepEqual(frameKeyframes(2, 5), [
    { transform: 'translateY(-40px)' },
    { transform: 'translateY(-60px)' },
    { transform: 'translateY(-80px)' },
  ]);
  assert.equal(canAnimate(), true);
});

test('the mark steps each stage on the compositor, looks again only when the stage changes, and fades a cut in', async (t) => {
  forgetLeftMark();
  const clock = { now: 0 };
  t.mock.method(markClock, 'now', () => clock.now);
  manualFrames(t);
  const played = recordAnimations(t);
  const m = await mount(t, h(WorkingMark, { activity: 'code' }));
  const mark = m.host.querySelector<HTMLElement>('span.working-mark')!;
  assert.equal(mark.getAttribute('data-activity'), 'code');
  assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(mark.style.width, '20px');
  // the grow stage plays; the sheets wanted next wait unseen but painted
  assert.deepEqual(visible(m.host).map(sheetOfLayer), ['grow']);
  const sheets = [...m.host.querySelectorAll<HTMLElement>('.working-mark-strip')].map((s) => s.dataset.sheet);
  assert.deepEqual(sheets, ['grow', 'code.in', 'code.loop']);
  const warm = m.host.querySelectorAll<HTMLElement>('.working-mark-layer')[1];
  assert.equal(warm.style.opacity, '0.001');
  const strip = m.host.querySelector<HTMLElement>('[data-sheet="grow"]')!;
  assert.equal(strip.style.height, `${10 * 20}px`);
  // the strips' images live in one stylesheet, a rule per sheet, added to the document once
  assert.equal(strip.style.backgroundImage, '', 'no layer carries its own copy of the data URL');
  const sheetsStyle = document.head.querySelectorAll('style[data-working-mark]');
  assert.equal(sheetsStyle.length, 1);
  assert.ok(
    sheetsStyle[0].textContent!.includes(`.working-mark-strip[data-sheet="grow"]{background-image:url("${MARK_SHEETS.grow.url}")}`),
  );
  assert.equal(sheetsStyle[0].textContent!.split('\n').length, Object.keys(MARK_SHEETS).length);
  assert.equal(strip.style.willChange, 'transform');
  assert.equal(played.length, 1);
  assert.equal(played[0].el, strip);
  assert.equal(played[0].keyframes.length, 10);
  assert.deepEqual(played[0].opts, { duration: 10 * 33.3333, iterations: 1, easing: 'steps(10, jump-none)', fill: 'forwards' });
  assert.equal(played[0].startTime, 0, 'on the player’s clock');
  // a dot under the fresh mark for its first two frames
  assert.ok(m.host.querySelector('.working-mark-dot'));
  assert.deepEqual(waits, [INTRO_MS, 0], 'the next look at the end of the stage; the dot’s frame');
  await frameTick();
  assert.equal(played.length, 1, 'nothing changed: the strip goes on stepping by itself');
  assert.ok(m.host.querySelector('.working-mark-dot'), 'one frame in, the dot stays');
  // into code.in, then its loop, which laps on its own
  clock.now = INTRO_MS;
  await frameTick();
  assert.equal(m.host.querySelector('.working-mark-dot'), null, 'two frames in, the strip has painted');
  assert.deepEqual(visible(m.host).map(sheetOfLayer), ['code.in']);
  assert.equal(played[0].cancelled, true);
  assert.equal(played[1].opts.iterations, 1);
  clock.now = INTRO_MS + 16 * 33.3334 + 10 * 33.3334;
  await frameTick();
  const loop = played.at(-1)!;
  assert.equal((loop.el as HTMLElement).dataset.sheet, 'code.loop');
  assert.equal(loop.opts.iterations, Infinity);
  assert.equal(loop.opts.easing, 'steps(75, jump-none)');
  assert.equal(loop.el.style.transform, frameTransform(10), 'the frame due now until the animation takes over');
  assert.equal(frames.length, 0, 'a loop still wanted asks for no look');
  // blocked cuts to the tail: the frame it left stays under the new one, which fades in on the compositor
  const count = played.length;
  clock.now += 5;
  await m.render(h(WorkingMark, { activity: 'blocked' }));
  assert.equal(loop.cancelled, true);
  const [tail, fade] = played.slice(count);
  assert.equal((tail.el as HTMLElement).dataset.sheet, 'code.loop');
  assert.equal(tail.keyframes.length, TAIL_FRAMES);
  assert.equal(tail.keyframes[0].transform, frameTransform(75 - TAIL_FRAMES));
  assert.equal(tail.startTime, clock.now);
  assert.deepEqual(fade.keyframes, [{ opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual(fade.opts, { duration: CROSSFADE_MS, easing: 'ease-in-out', fill: 'backwards' });
  assert.equal(fade.el, tail.el.parentElement);
  const ghost = mark.firstElementChild as HTMLElement;
  assert.equal(sheetOfLayer(ghost), 'code.loop');
  assert.equal((ghost.firstElementChild as HTMLElement).style.transform, frameTransform(10));
  assert.equal(m.host.querySelectorAll('[data-sheet="code.loop"]').length, 2);
  assert.deepEqual(waits.at(-1), GHOST_MS);
  // the same activity again asks nothing new
  await m.render(h(WorkingMark, { activity: 'blocked' }));
  assert.equal(played.length, count + 2);
  clock.now += GHOST_MS;
  await frameTick();
  assert.equal(m.host.querySelectorAll('[data-sheet="code.loop"]').length, 1, 'the old frame goes');
  assert.equal(fade.cancelled, true);
  assert.equal(played.length, count + 2, 'the tail plays on');
  await m.unmount();
  assert.ok(played.every((p) => p.cancelled || p === played[1] || p.opts.iterations === 1));
  // the next line picks up where this one left off
  const next = await mount(t, h(WorkingMark, { activity: 'blocked' }));
  assert.equal(next.host.querySelector('.working-mark-dot'), null, 'a mark picked up starts mid-motion, not from a dot');
  assert.equal(played.at(-1)!.keyframes[0].transform, frameTransform(75 - TAIL_FRAMES));
  await next.unmount();
});

test("with reduced motion, or where nothing can animate, the mark holds its activity's rest frame", async (t) => {
  forgetLeftMark();
  const media = window.matchMedia;
  (window as any).matchMedia = (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    (window as any).matchMedia = media;
  });
  manualFrames(t);
  const played = recordAnimations(t);
  const m = await mount(t, h(WorkingMark, { activity: 'read' }));
  assert.deepEqual(visible(m.host).map(sheetOfLayer), ['read.loop']);
  const strip = () => visible(m.host)[0].firstElementChild as HTMLElement;
  assert.equal(strip().style.transform, frameTransform(restFrame('read')));
  assert.equal(frames.length, 0, 'a still mark asks for no looks');
  assert.equal(played.length, 0);
  await m.render(h(WorkingMark, { activity: 'think' }));
  assert.equal(m.host.querySelector('.working-mark')!.getAttribute('data-activity'), 'think');
  assert.deepEqual(visible(m.host).map(sheetOfLayer), ['think.loop']);
  assert.equal(strip().style.transform, frameTransform(restFrame('think')));
  await m.unmount();
  (window as any).matchMedia = media;
  const proto = (window as any).Element.prototype;
  const real = proto.animate;
  proto.animate = undefined;
  t.after(() => {
    proto.animate = real;
  });
  assert.equal(canAnimate(), false);
  const plain = await mount(t, h(WorkingMark, { activity: 'search' }));
  assert.deepEqual(visible(plain.host).map(sheetOfLayer), ['search.loop']);
  assert.equal(frames.length, 0);
  await plain.unmount();
});

test("the mark's clock waits for the next animation frame after the delay, and can be cancelled", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = animationFrames();
  try {
    let ran = 0;
    markClock.after(1, () => ran++);
    const cancelled = markClock.after(1, () => ran++);
    cancelled();
    t.mock.timers.tick(0);
    assert.equal(ran, 0);
    assert.equal(clock.pending, 0);
    t.mock.timers.tick(1);
    assert.equal(ran, 0, 'The delay alone does not deliver an animation frame');
    assert.equal(clock.pending, 1);
    clock.frame();
    assert.equal(ran, 1);
    const late = markClock.after(0, () => ran++);
    t.mock.timers.tick(0);
    assert.equal(clock.pending, 1);
    late();
    assert.equal(clock.pending, 0);
    clock.frame();
    assert.equal(ran, 1, 'Cancellation after queueing still prevents the callback');
    assert.equal(typeof markClock.now(), 'number');
  } finally {
    clock.restore();
  }
});

test('a line that replaces another in the same render carries its mark on mid-motion', async (t) => {
  forgetLeftMark();
  const clock = { now: 0 };
  t.mock.method(markClock, 'now', () => clock.now);
  manualFrames(t);
  const played = recordAnimations(t);
  const m = await mount(t, h('div', { key: 'placeholder' }, h(WorkingMark, { activity: 'think' })));
  clock.now = INTRO_MS + 16 * 33.3334 + 30 * 33.3334;
  await frameTick();
  await frameTick();
  const loop = played.at(-1)!;
  assert.equal((loop.el as HTMLElement).dataset.sheet, 'think.loop');
  // the step's own line takes over: the same lap, not a fresh entrance
  await m.render(h('section', { key: 'step' }, h(WorkingMark, { activity: 'think' })));
  const after = played.at(-1)!;
  assert.notEqual(after, loop);
  assert.equal(loop.cancelled, true);
  assert.equal((after.el as HTMLElement).dataset.sheet, 'think.loop');
  assert.equal(after.startTime, loop.startTime);
  assert.equal(after.el.style.transform, frameTransform(30));
});

test('the view keeps one layer per sheet, preloads every strip once, and drops a ghost when it holds still', async (t) => {
  const played = recordAnimations(t);
  const decoded: string[] = [];
  const RealImage = (globalThis as any).Image;
  (globalThis as any).Image = class {
    src = '';
    decode() {
      decoded.push(this.src);
      return Promise.reject(new Error('not here'));
    }
  };
  t.after(() => {
    (globalThis as any).Image = RealImage;
  });
  preloadSheets();
  preloadSheets();
  assert.deepEqual(
    decoded,
    Object.values(MARK_SHEETS).map((s) => s.url),
    'each strip once, a failure ignored',
  );
  await new Promise((r) => setTimeout(r, 0));
  const root = document.createElement('span');
  const view = new MarkView(root as any);
  const loop = { kind: 'loop', body: 'think' } as const;
  view.show(
    { stage: loop, sheet: 'think.loop', start: 0, index: 0, looping: false, ghost: { sheet: 'think.loop', index: 3, start: 0 } },
    'blocked',
  );
  assert.equal(root.querySelectorAll('.working-mark-layer').length, 5, 'ghost, think.loop, think.out, blocked.in, blocked.loop');
  // the same stage at another moment, with the same ghost: nothing new plays
  view.show(
    { stage: loop, sheet: 'think.loop', start: 0, index: 4, looping: false, ghost: { sheet: 'think.loop', index: 3, start: 0 } },
    'blocked',
  );
  assert.equal(played.length, 2);
  // a one-frame stage holds its frame (steps(1, jump-none) is not a timing function)
  MARK_SHEETS['one.in'] = { frames: 1, speed: 10, url: '' };
  try {
    view.show(
      { stage: { kind: 'in', body: 'one' as any }, sheet: 'one.in', start: 5, index: 0, looping: false, ghost: null },
      'one' as any,
    );
    assert.equal(played.at(-1)!.opts.easing, 'linear');
    assert.equal(root.querySelectorAll('.working-mark-layer').length, 5, 'the ghost went with the cut');
  } finally {
    delete MARK_SHEETS['one.in'];
  }
  view.still('think.loop', 95);
  assert.equal(root.querySelectorAll('.working-mark-layer').length, 5, 'holding still keeps the layers');
  assert.ok(played.every((p) => p.cancelled));
  view.setDot(false);
  assert.equal(root.querySelector('.working-mark-dot'), null);
  view.setDot(true);
  view.setDot(true);
  assert.equal(root.querySelectorAll('.working-mark-dot').length, 1);
});

test("a cancelled stage's AbortError is expected; any other animation failure is recorded", async (t) => {
  const proto = (window as any).Element.prototype;
  const real = proto.animate;
  const failures = [new window.DOMException('cancelled', 'AbortError'), new Error('compositor gone')];
  proto.animate = () => ({ finished: Promise.reject(failures.shift()), cancel() {}, startTime: null });
  t.after(() => {
    proto.animate = real;
  });
  const debug = t.mock.method(console, 'debug', () => undefined);
  const view = new MarkView(document.createElement('span') as any);
  const stage = { kind: 'in', body: 'think' } as const;
  view.show({ stage, sheet: 'think.in', start: 0, index: 0, looping: false, ghost: null }, 'think');
  view.show({ stage: { kind: 'in', body: 'read' }, sheet: 'read.in', start: 1, index: 0, looping: false, ghost: null }, 'read');
  await new Promise((r) => setTimeout(r, 0));
  const lines = debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(lines.filter((l) => l.includes('play the working mark')).length, 1);
  assert.match(lines.find((l) => l.includes('play the working mark'))!, /compositor gone/);
});
