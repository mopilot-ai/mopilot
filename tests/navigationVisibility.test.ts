// Which messages the navigation rail marks current: prompts watched by an IntersectionObserver, read only when one
// crosses the transcript's edges, and only as many as a binary search needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h } from 'react';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useVisibleMessages, adjacentMessage } = await import('../src/components/thread/navigationVisibility.ts');

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => (frames.set(++nextFrame, cb), nextFrame);
(globalThis as any).cancelAnimationFrame = (id: number) => frames.delete(id);
const tick = () =>
  act(async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const cb of callbacks) cb(0);
  });
const observers = new Set<any>();
(globalThis as any).IntersectionObserver = class {
  targets = new Set<Element>();
  cb: () => void;
  options: any;
  constructor(cb: () => void, options: any) {
    this.cb = cb;
    this.options = options;
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    observers.delete(this);
  }
};
const latest = () => [...observers].at(-1);

/** A transcript of `n` prompts 300px apart from 100, viewed through 100-300, each prompt counting its reads. */
function transcript(n: number) {
  const scroll = document.createElement('div');
  document.body.append(scroll);
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 100 + n * 300 });
  scroll.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect;
  let reads = 0;
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const anchors = ids.map((id, i) => {
    const el = document.createElement('div');
    el.dataset.navigationId = id;
    el.getBoundingClientRect = () => (reads++, { top: 100 + i * 300 - scroll.scrollTop }) as DOMRect;
    scroll.append(el);
    return el;
  });
  return { scroll, ids, anchors, reads: () => reads, resetReads: () => (reads = 0) };
}

let visible: ReadonlySet<string> = new Set();
const Probe = ({ scrollRef, itemKey, rendered }: any) => {
  visible = useVisibleMessages(scrollRef, itemKey, rendered);
  return null;
};

test('the rail watches the rendered prompts it lists, from the top line down, and reads few of them', async () => {
  const t = transcript(40);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = { current: t.scroll };
  const show = (props: any) => act(async () => root.render(h(Probe, { scrollRef: ref, itemKey: t.ids.join('\n'), ...props })));
  try {
    // a prompt of a turn that is not listed (another chat's leftover) is not watched
    const stray = document.createElement('div');
    stray.dataset.navigationId = 'stray';
    t.scroll.append(stray);
    await show({});
    await tick();
    const first = latest();
    // the transcript's top line, Codex's 16px, and both edges of each prompt
    assert.equal(first.options.root, t.scroll);
    assert.equal(first.options.rootMargin, '-16px 0px 0px 0px');
    assert.deepEqual(first.options.threshold, [0, 1]);
    assert.equal(first.targets.size, 40);
    assert.equal(first.targets.has(stray), false);
    assert.deepEqual([...visible], ['m0']);
    // the transcript renders other turns: their prompts are watched instead, by a new observer
    t.anchors[39].remove();
    await show({ rendered: new Set(['other']) });
    assert.equal(observers.has(first), false);
    assert.equal(latest().targets.size, 39);
    // a prompt crossing an edge: a look reads a handful of positions
    await tick();
    t.scroll.scrollTop = 6000;
    t.resetReads();
    await act(async () => latest().cb());
    await tick();
    assert.deepEqual([...visible], ['m20']);
    assert.ok(t.reads() < 12, `read ${t.reads()} prompts`);
    // a streamed reply growing moves no prompt across an edge: nothing is read, and the same look keeps its set
    t.resetReads();
    const same = visible;
    await tick();
    assert.equal(t.reads(), 0);
    // a jump past every prompt between two frames is read once the scroll ends
    t.scroll.scrollTop = 600;
    await act(async () => t.scroll.dispatchEvent(new window.Event('scrollend') as any));
    await tick();
    assert.deepEqual([...visible], ['m2']);
    assert.notEqual(visible, same);
    // a look that finds the same messages keeps the set it had
    const kept = visible;
    await act(async () => latest().cb());
    await tick();
    assert.equal(visible, kept);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    t.scroll.remove();
  }
});

test('no transcript: nothing is watched or current', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const before = observers.size;
    await act(async () => root.render(h(Probe, { scrollRef: { current: null }, itemKey: 'a' })));
    assert.equal(observers.size, before);
    assert.equal(visible.size, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Alt+Arrow reaches the next or previous message even when its turn is a placeholder', () => {
  // every prompt rendered: the first below the line, the last above it
  const all = [-500, -200, 100, 400];
  assert.equal(adjacentMessage(all, 0, true), 2);
  assert.equal(adjacentMessage(all, 0, false), 1);
  // message 2's turn is a placeholder (the reply of 1 runs past the window's margin): Down goes to it by order
  const gap = [-500, -200, undefined, 900];
  assert.equal(adjacentMessage(gap, 0, true), 2);
  // and Up from below a placeholder goes to the one before the first rendered prompt under the line
  assert.equal(adjacentMessage([undefined, 300, 600], 100, false), 0);
  // no rendered prompt on one side: the nearest rendered one on the other
  assert.equal(adjacentMessage([undefined, 300, 600], 100, true), 1);
  assert.equal(adjacentMessage([-300, -100, undefined], 100, false), 1);
  // nothing further: past the ends
  assert.equal(adjacentMessage([-300, -100], 100, true), 2);
  assert.equal(adjacentMessage([300, 600], 100, false), -1);
  assert.equal(adjacentMessage([], 100, true), -1);
});
