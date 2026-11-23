// The window of a long thread in the DOM: which turns mount as the transcript reports what is on screen, the heights
// placeholders keep, what stays mounted for a selection or the focus, and the anchor kept while turns swap.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h, useRef } from 'react';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useTurnWindow, KeepAnchor, visibleAnchor } = await import('../src/components/thread/view/turnWindow.tsx');
const { useKeptUnfold, UnfoldedTurns } = await import('../src/components/thread/view/keptUnfold.ts');
const { estimateTurnHeight } = await import('../src/lib/turnWindow.ts');

// what the transcript reports: each observer and the slots it watches
const intersections: any[] = [];
class FakeIntersectionObserver {
  targets = new Set<Element>();
  disconnected = false;
  cb: (entries: any[]) => void;
  options: any;
  constructor(cb: (entries: any[]) => void, options: any) {
    this.cb = cb;
    this.options = options;
    intersections.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}
const resizes: any[] = [];
class FakeResizeObserver {
  targets = new Set<Element>();
  cb: (entries: any[]) => void;
  constructor(cb: (entries: any[]) => void) {
    this.cb = cb;
    resizes.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}
(globalThis as any).IntersectionObserver = FakeIntersectionObserver;
(globalThis as any).ResizeObserver = FakeResizeObserver;

// Layout: the viewport is 0-600; a rendered turn is `real[id]` tall (500 by default), a placeholder its style height.
const real: Record<string, number> = {};
const heightOfSlot = (el: HTMLElement) =>
  el.childElementCount ? (real[el.dataset.turnSlot!] ?? 500) : Number.parseFloat(el.style.height) || 0;
const plainRect = window.HTMLElement.prototype.getBoundingClientRect;
(window.HTMLElement.prototype as any).getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains('thread-scroll')) return { top: 0, bottom: 600, height: 600 };
  const id = this.dataset?.turnSlot;
  if (id === undefined) return plainRect.call(this);
  const scroll = this.closest('.thread-scroll')!;
  let top = 0 - scroll.scrollTop || 0;
  for (
    let el = this.parentElement!.firstElementChild as HTMLElement | null;
    el && el !== this;
    el = el.nextElementSibling as HTMLElement | null
  )
    top += heightOfSlot(el);
  return { top, bottom: top + heightOfSlot(this), height: heightOfSlot(this) };
};

const turn = (id: string, text = 'x'.repeat(900)) =>
  ({
    id,
    status: 'completed',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: id }] },
      { type: 'agentMessage', text },
    ],
  }) as any;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

let current: any = null;
let renders = 0;
let hold = false;
function Harness({ turns, pinned = [], armed = true, scope = 'c' }: { turns: any[]; pinned?: string[]; armed?: boolean; scope?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const w = useTurnWindow({ scope, scrollRef, turns, pinned, armed });
  current = w;
  renders++;
  return h(
    'div',
    { className: 'thread-scroll', ref: scrollRef },
    h(
      'div',
      { className: 'thread-column' },
      h(
        KeepAnchor,
        { scrollRef, mounted: w.mounted, hold: () => hold },
        turns.map((t) =>
          h(
            'div',
            {
              key: t.id,
              'data-turn-slot': t.id,
              ref: w.slotRef(t.id),
              style: w.mounted.has(t.id) ? undefined : { height: w.heightOf(t.id) },
            },
            w.mounted.has(t.id) ? h('p', null, t.id, h('button', null, 'act')) : null,
          ),
        ),
      ),
    ),
  );
}

let root: any = null;
let host: HTMLElement;
async function show(props: Parameters<typeof Harness>[0]) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root.render(h(Harness, props)));
}
const scroll = () => host.querySelector('.thread-scroll') as HTMLElement;
const slot = (id: string) => host.querySelector(`[data-turn-slot="${id}"]`) as HTMLElement;
const rendered = () =>
  [...host.querySelectorAll<HTMLElement>('[data-turn-slot]')].filter((e) => e.childElementCount).map((e) => e.dataset.turnSlot);
const live = () => intersections.filter((o) => !o.disconnected).at(-1);
/** The transcript reports these slots near the viewport (true) or not (false). */
const report = (near: Record<string, boolean>) =>
  act(async () => live().cb(Object.entries(near).map(([id, isIntersecting]) => ({ target: slot(id), isIntersecting }))));

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  host?.remove();
  intersections.length = 0;
  resizes.length = 0;
  hold = false;
  for (const k of Object.keys(real)) delete real[k];
  document.getSelection()!.removeAllRanges();
});

test('a long thread opens on the turns that fill the viewport and the margin above it, the rest placeholders', async () => {
  const turns = ids(20).map((id) => turn(id));
  await show({ turns, armed: false });
  // each turn is estimated at 360px; three screens of the window's 768px take the last seven
  assert.equal(estimateTurnHeight(turns[0]), 360);
  assert.deepEqual(rendered(), ids(20).slice(13));
  assert.equal(slot('t0').style.height, '360px');
  // nothing is observed until the chat has scrolled to where it opens
  assert.equal(intersections.length, 0);
  const first = current.mounted;
  await show({ turns, armed: false });
  assert.equal(current.mounted, first, 'an unchanged window keeps its identity');
});

test('the transcript decides what renders once armed: near turns mount, far ones go, pinned ones stay', async () => {
  const turns = ids(20).map((id) => turn(id));
  await show({ turns, pinned: ['t19'] });
  const io = live();
  assert.equal(io.options.root, scroll());
  assert.equal(io.options.rootMargin, '200% 0px');
  assert.equal(io.targets.size, 20);
  await report({ t4: true, t5: true, t6: true });
  assert.deepEqual(rendered(), ['t4', 't5', 't6', 't19']);
  // scrolling on: t4 leaves, t7 comes near
  await report({ t4: false, t7: true });
  assert.deepEqual(rendered(), ['t5', 't6', 't7', 't19']);
  // a report that changes nothing keeps the window
  const before = current.mounted;
  await report({ t5: true });
  assert.equal(current.mounted, before);
});

test('a placeholder keeps the height its turn last rendered at; one never rendered keeps its estimate', async () => {
  const turns = ids(6).map((id) => turn(id));
  await show({ turns });
  await report({ t1: true, t2: true });
  const ro = resizes.at(-1);
  assert.ok(ro.targets.has(slot('t1')));
  await act(async () =>
    ro.cb([
      { target: slot('t1'), borderBoxSize: [{ blockSize: 777 }], contentRect: { height: 1 } },
      { target: slot('t2'), contentRect: { height: 640 } },
      // a placeholder is not measured: its height is the one it was given
      { target: slot('t4'), borderBoxSize: [{ blockSize: 5 }], contentRect: { height: 5 } },
    ]),
  );
  await report({ t1: false, t2: false, t4: true });
  await report({ t4: false });
  assert.equal(slot('t1').style.height, '777px');
  assert.equal(slot('t2').style.height, '640px');
  assert.equal(slot('t4').style.height, '360px');
  assert.equal(current.heightOf('missing'), 0);
});

test('another chat starts with no measured heights and nothing reported', async () => {
  await show({ turns: [turn('a'), turn('b')] });
  await report({ a: true });
  await act(async () => resizes.at(-1).cb([{ target: slot('a'), borderBoxSize: [{ blockSize: 999 }] }]));
  assert.equal(current.heightOf('a'), 999);
  const old = live();
  await show({ turns: [turn('a'), turn('b')], scope: 'other', armed: false });
  assert.equal(old.disconnected, true);
  assert.equal(current.heightOf('a'), 360);
  // back on the opening window until the new chat arms
  assert.deepEqual(rendered(), ['a', 'b']);
});

test("another chat's first render opens on its own last turns, not on what the last chat reported", async () => {
  await show({ turns: ids(20).map((id) => turn(id)) });
  await report({ t2: true, t3: true });
  // the view switches chats while still armed: the report was the other chat's
  const next = Array.from({ length: 20 }, (_, i) => turn(`n${i}`));
  await show({ turns: next, scope: 'next', pinned: ['n19'] });
  assert.deepEqual(
    rendered(),
    next.slice(13).map((t) => t.id),
  );
  // the new chat's own report then decides
  await report({ n4: true });
  assert.deepEqual(rendered(), ['n4', 'n19']);
});

test('text selected in the transcript keeps the turns it runs through while the reader scrolls, until it ends', async () => {
  const turns = ids(8).map((id) => turn(id));
  await show({ turns });
  await report({ t2: true, t3: true });
  const range = document.createRange();
  range.setStart(slot('t2'), 0);
  range.setEnd(slot('t3'), 1);
  // happy-dom announces a selection change as it happens
  await act(async () => document.getSelection()!.addRange(range));
  await report({ t2: false, t3: false, t6: true });
  assert.deepEqual(rendered(), ['t2', 't3', 't6']);
  // a turn the selection does not run through goes as usual: the window does not grow with the scrolling
  await report({ t6: false, t7: true });
  assert.deepEqual(rendered(), ['t2', 't3', 't7']);
  // a selection elsewhere in the page does not hold the transcript
  await act(async () => document.getSelection()!.removeAllRanges());
  const outside = document.createElement('p');
  outside.textContent = 'elsewhere';
  document.body.append(outside);
  const away = document.createRange();
  away.selectNodeContents(outside);
  await act(async () => document.getSelection()!.addRange(away));
  assert.deepEqual(rendered(), ['t7']);
  // a selection change that changes nothing here (typing in the composer) renders nothing
  const before = renders;
  await act(async () => document.dispatchEvent(new window.Event('selectionchange') as any));
  assert.equal(renders, before);
  outside.remove();
});

test('a selection before the transcript has reported keeps the window the chat opened on', async () => {
  const turns = ids(20).map((id) => turn(id));
  await show({ turns, pinned: ['t19'] });
  const opened = rendered();
  assert.deepEqual(opened, ids(20).slice(13));
  // armed and observing, but the transcript has not reported what is on screen yet, so nothing is near anything
  const range = document.createRange();
  range.setStart(slot('t15'), 0);
  range.setEnd(slot('t15'), 1);
  await act(async () => document.getSelection()!.addRange(range));
  assert.deepEqual(rendered(), opened, 'the selection added to the window; it did not decide it');
  // once the transcript reports, its report decides again, and the selection only holds its own turn
  await report({ t15: true });
  assert.deepEqual(rendered(), ['t15', 't19']);
  await act(async () => document.getSelection()!.removeAllRanges());
});

test('the turn holding the focus stays rendered until the focus leaves it', async () => {
  const turns = ids(8).map((id) => turn(id));
  await show({ turns });
  await report({ t2: true });
  const button = slot('t2').querySelector('button')!;
  await act(async () => button.focus());
  await report({ t2: false, t5: true });
  assert.deepEqual(rendered(), ['t2', 't5']);
  await act(async () => {
    button.blur();
    scroll().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as any);
  });
  assert.deepEqual(rendered(), ['t5']);
});

test('a turn that leaves the thread is near nothing when it comes back', async () => {
  const turns = ids(4).map((id) => turn(id));
  await show({ turns });
  await report({ t1: true });
  await show({ turns: turns.filter((t) => t.id !== 't1') });
  await report({ t2: true });
  await show({ turns });
  assert.deepEqual(rendered(), ['t2']);
  // the returning slot is observed again
  assert.ok(live().targets.has(slot('t1')));
});

test('without IntersectionObserver every turn renders', async () => {
  const saved = (globalThis as any).IntersectionObserver;
  delete (globalThis as any).IntersectionObserver;
  try {
    await show({ turns: ids(30).map((id) => turn(id)) });
    assert.equal(rendered().length, 30);
  } finally {
    (globalThis as any).IntersectionObserver = saved;
  }
});

test('turns that swap above the first turn on screen keep it where it was', async () => {
  const turns = ids(10).map((id) => turn(id));
  await show({ turns });
  await report({ t9: false });
  // all placeholders of 360px: t5 starts at 1800; read from 1900, so t5 straddles the top and t6 starts on screen
  scroll().scrollTop = 1900;
  real.t3 = 900;
  real.t4 = 700;
  await report({ t3: true, t4: true });
  // t3 and t4 grew by 540 + 340 above t6: the view moved by as much
  assert.equal(scroll().scrollTop, 1900 + 540 + 340);
  assert.equal(slot('t6').getBoundingClientRect().top, 260);
  // turns going back to placeholders of their measured height move nothing
  await act(async () =>
    resizes.at(-1).cb([
      { target: slot('t3'), borderBoxSize: [{ blockSize: 900 }] },
      { target: slot('t4'), borderBoxSize: [{ blockSize: 700 }] },
    ]),
  );
  await report({ t3: false, t4: false });
  assert.equal(scroll().scrollTop, 2780);
  // while held (the view follows its bottom, or a smooth scroll is on its way) the view is left alone
  hold = true;
  real.t2 = 1000;
  await report({ t2: true });
  assert.equal(scroll().scrollTop, 2780);
});

test('the anchor is the first turn starting on screen, else the one filling it', () => {
  const box = document.createElement('div');
  box.className = 'thread-scroll';
  const column = document.createElement('div');
  column.className = 'thread-column';
  box.append(column);
  document.body.append(box);
  try {
    assert.equal(visibleAnchor(box), null);
    const add = (id: string, height: number) => {
      const el = document.createElement('div');
      el.dataset.turnSlot = id;
      el.style.height = `${height}px`;
      column.append(el);
      return el;
    };
    const a = add('a', 1000);
    const b = add('b', 100);
    box.scrollTop = 0;
    assert.deepEqual(visibleAnchor(box), { slot: a, top: 0 });
    // a starts above the screen and b on it
    box.scrollTop = 950;
    assert.deepEqual(visibleAnchor(box), { slot: b, top: 50 });
    // a fills the screen: nothing starts on it
    box.scrollTop = 200;
    assert.deepEqual(visibleAnchor(box), { slot: a, top: -200 });
    // past every turn's start, the last one
    box.scrollTop = 1050;
    assert.deepEqual(visibleAnchor(box), { slot: b, top: -50 });
  } finally {
    box.remove();
  }
});

test('the anchor is left alone when it went away or the transcript is gone', async () => {
  const ref = { current: null as HTMLElement | null };
  const el = document.createElement('div');
  const shown = document.createElement('div');
  document.body.append(shown);
  const r = createRoot(shown);
  try {
    // no transcript: nothing to read
    await act(async () => r.render(h(KeepAnchor, { scrollRef: ref, mounted: new Set(['a']), hold: () => false }, null)));
    await act(async () => r.render(h(KeepAnchor, { scrollRef: ref, mounted: new Set(['b']), hold: () => false }, null)));
    // an anchor removed by the update is not followed
    ref.current = scrollWith(el);
    const slotEl = el.querySelector('[data-turn-slot]')!;
    const mounted = new Set(['c']);
    await act(async () => r.render(h(KeepAnchor, { scrollRef: ref, mounted, hold: () => false }, null)));
    const before = ref.current!.scrollTop;
    await act(async () => {
      r.render(h(KeepAnchor, { scrollRef: ref, mounted: new Set(['d']), hold: () => false }, null));
      slotEl.remove();
    });
    assert.equal(ref.current!.scrollTop, before);
  } finally {
    await act(async () => r.unmount());
    shown.remove();
    el.remove();
  }
});

function scrollWith(box: HTMLElement) {
  box.className = 'thread-scroll';
  const column = document.createElement('div');
  column.className = 'thread-column';
  const s = document.createElement('div');
  s.dataset.turnSlot = 's';
  s.style.height = '100px';
  column.append(s);
  box.append(column);
  document.body.append(box);
  return box;
}

test("a turn's work fold is kept within one visit of the chat, and not without one", async () => {
  let fold: any = null;
  const Fold = ({ id }: { id: string }) => {
    fold = useKeptUnfold(id);
    return null;
  };
  const shown = document.createElement('div');
  document.body.append(shown);
  const r = createRoot(shown);
  const visit = new Set<string>();
  const inVisit = (set: Set<string>, id = 't1') => h(UnfoldedTurns.Provider, { value: set }, h(Fold, { id }));
  try {
    await act(async () => r.render(inVisit(visit)));
    assert.equal(fold[0], false);
    await act(async () => fold[1]((open: boolean) => !open));
    assert.equal(fold[0], true);
    // unmounted and mounted again in the same visit, as a turn leaving the window and coming back
    await act(async () => r.render(null));
    await act(async () => r.render(inVisit(visit)));
    assert.equal(fold[0], true);
    // folded again, it comes back folded
    await act(async () => fold[1]((open: boolean) => !open));
    await act(async () => r.render(null));
    await act(async () => r.render(inVisit(visit)));
    assert.equal(fold[0], false);
    // another visit (the chat opened again) starts folded
    await act(async () => fold[1]((open: boolean) => !open));
    await act(async () => r.render(null));
    await act(async () => r.render(inVisit(new Set())));
    assert.equal(fold[0], false);
    // outside a thread view the fold is the turn's own
    await act(async () => r.render(null));
    await act(async () => r.render(h(Fold, { id: 't1' })));
    await act(async () => fold[1]((open: boolean) => !open));
    assert.equal(fold[0], true);
    await act(async () => r.render(null));
    await act(async () => r.render(h(Fold, { id: 't1' })));
    assert.equal(fold[0], false);
  } finally {
    await act(async () => r.unmount());
    shown.remove();
  }
});
