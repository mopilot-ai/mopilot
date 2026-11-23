// A long thread renders only the turns near the viewport: jumps to a turn outside the window, smooth jumps and the
// way back to the bottom, through the thread view as each harness's chat shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  render,
  settle,
  flush,
  chat,
  view,
  navProps,
  user,
  reply,
  turn,
  callsTo,
  window,
  impl,
  setStore,
  T,
} from './support/thread-view/fixture.ts';

const observers: any[] = [];
(globalThis as any).IntersectionObserver = class {
  targets = new Set<Element>();
  disconnected = false;
  cb: (entries: any[]) => void;
  constructor(cb: (entries: any[]) => void) {
    this.cb = cb;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
};
const live = () => observers.filter((o) => !o.disconnected).at(-1);

const long = 'word '.repeat(180);
const turns = (n: number) => Array.from({ length: n }, (_, i) => turn(`t${i}`, [user(`u${i}`, `Question ${i}`), reply(`r${i}`, long)]));
async function open(n = 20, list = turns(n)) {
  chat(list);
  const v = await render(view());
  await flush();
  const slot = (id: string) => v.$(`[data-turn-slot="${id}"]`)!;
  const rendered = () =>
    v
      .$$('[data-turn-slot]')
      .filter((e) => e.childElementCount)
      .map((e) => e.dataset.turnSlot);
  const report = (near: Record<string, boolean>) =>
    settle(() => live().cb(Object.entries(near).map(([id, isIntersecting]) => ({ target: slot(id), isIntersecting }))));
  const scroller = v.$('.thread-scroll')!;
  const scrolledTo: any[] = [];
  (scroller as any).scrollTo = (o: any) => scrolledTo.push(o);
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 20_000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 });
  return { v, slot, rendered, report, scroller, scrolledTo };
}

test('a long thread renders the turns the transcript reports near, and tells the rail which ones', async () => {
  const t = await open();
  try {
    // armed once the chat scrolled to its bottom: every turn is observed
    assert.equal(live().targets.size, 20);
    await t.report({ t17: true, t18: true, t19: true });
    assert.deepEqual(t.rendered(), ['t17', 't18', 't19']);
    assert.equal(t.slot('t3').childElementCount, 0);
    assert.match(t.slot('t3').style.height, /^\d+px$/);
    // the rail observes the prompts of the rendered turns
    assert.deepEqual([...navProps.rendered].sort(), ['t17', 't18', 't19']);
  } finally {
    await t.v.unmount();
  }
});

test('a placeholder on screen shows its prompt and reply as text, not blank, and loses it once it renders', async () => {
  const t = await open();
  try {
    await t.report({ t18: true, t19: true });
    const placeholder = t.slot('t3');
    // text only, as an attribute the slot draws: no element, so the slot still counts as unrendered and keeps its height
    assert.equal(placeholder.childElementCount, 0);
    assert.equal(placeholder.dataset.prompt, 'Question 3');
    assert.match(placeholder.dataset.reply!, /^word word word/);
    assert.equal(placeholder.getAttribute('aria-hidden'), 'true');
    assert.match(placeholder.style.height, /^\d+px$/);
    // a rendered turn draws itself: no preview over it
    const rendered = t.slot('t19');
    assert.ok(rendered.childElementCount);
    assert.equal(rendered.dataset.prompt, undefined);
    assert.equal(rendered.dataset.reply, undefined);
    assert.equal(rendered.getAttribute('aria-hidden'), null);
    // the window moves: the turn that left shows its preview, the one that arrived drops it
    await t.report({ t3: true, t18: false });
    assert.equal(t.slot('t3').dataset.prompt, undefined);
    assert.equal(t.slot('t18').dataset.prompt, 'Question 18');
    // the latest turn is never a placeholder
    assert.equal(t.slot('t19').dataset.prompt, undefined);
  } finally {
    await t.v.unmount();
  }
});

test('a placeholder with only one of the two, or neither, shows just what its turn has, and hides nothing it does not draw', async () => {
  const list = [
    turn('t0', [user('u0', 'Only a prompt')]),
    turn('t1', [reply('r1', 'Only a reply')]),
    turn('t2', [user('u2', '   ')]),
    ...turns(6).slice(3),
  ];
  const t = await open(6, list);
  try {
    await t.report({ t4: true, t5: true });
    assert.deepEqual([t.slot('t0').dataset.prompt, t.slot('t0').dataset.reply], ['Only a prompt', undefined]);
    assert.deepEqual([t.slot('t1').dataset.prompt, t.slot('t1').dataset.reply], [undefined, 'Only a reply']);
    assert.equal(t.slot('t0').getAttribute('aria-hidden'), 'true');
    assert.equal(t.slot('t1').getAttribute('aria-hidden'), 'true');
    // nothing to draw: nothing to hide, and the slot is the blank it was
    assert.deepEqual([t.slot('t2').dataset.prompt, t.slot('t2').dataset.reply], [undefined, undefined]);
    assert.equal(t.slot('t2').getAttribute('aria-hidden'), null);
    assert.equal(t.slot('t2').childElementCount, 0);
  } finally {
    await t.v.unmount();
  }
});

test('a folded run of woken turns is one row: its placeholder previews nothing, since the row shows no turn words', async () => {
  const wake = (id: string, n: number) => ({
    type: 'statusNote',
    id: `w-${id}`,
    kind: 'wake',
    text: 'Monitor event · CI run',
    wake: { by: 'monitor', key: 'mon1', label: 'CI run', detail: `check ${n}`, failed: false },
  });
  const woken = (id: string, n: number) =>
    turn(id, [wake(id, n), reply(`r-${id}`, `Still running (${n}).`)], {
      startedAt: 1000 + n * 60,
      completedAt: 1000 + n * 60 + 5,
      durationMs: 5000,
    });
  const t = await open(7, [...turns(3), woken('a', 1), woken('b', 2), woken('c', 3), woken('d', 4)]);
  try {
    await t.report({ d: true });
    // a, b and c are one row, held by the slot of a; a turn of its own previews as before
    assert.equal(t.slot('a').childElementCount, 0);
    assert.deepEqual(
      [t.slot('a').dataset.prompt, t.slot('a').dataset.reply, t.slot('a').getAttribute('aria-hidden')],
      [undefined, undefined, null],
    );
    assert.equal(t.slot('t0').dataset.prompt, 'Question 0');
  } finally {
    await t.v.unmount();
  }
});

test('a jump to a turn outside the window renders it, then goes to its message at once, and keeps it until the reader scrolls', async () => {
  const t = await open();
  try {
    await t.report({ t18: true, t19: true });
    assert.equal(t.slot('t2').childElementCount, 0);
    // a smooth scroll across placeholders would land where they were: once the turn renders, the jump is instant
    await settle(() => navProps.onNavigate(navProps.items[2].id));
    assert.ok(t.slot('t2').childElementCount);
    assert.deepEqual(
      t.scrolledTo.map((s) => s.behavior),
      ['instant'],
    );
    // the transcript reports it far: the jump keeps it
    await t.report({ t2: false });
    assert.ok(t.slot('t2').childElementCount);
    // the reader scrolls: it goes with the next report
    await settle(() => t.scroller.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -60, bubbles: true }) as any));
    await t.report({ t18: true });
    assert.equal(t.slot('t2').childElementCount, 0);
  } finally {
    await t.v.unmount();
  }
});

test('a smooth jump finishes on its message when the scroll ends, unless the reader took over', async () => {
  const t = await open();
  try {
    await t.report({ t18: true, t19: true });
    const anchor = t.slot('t18').querySelector<HTMLElement>('[data-navigation-id]')!;
    anchor.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;
    await settle(() => navProps.onNavigate(navProps.items[18].id));
    assert.deepEqual(t.scrolledTo, [{ top: 484, behavior: 'smooth' }]);
    // the window changes on the way: the view does not hold its place against the scroll
    await t.report({ t17: true });
    await settle(() => t.scroller.dispatchEvent(new window.Event('scrollend') as any));
    assert.deepEqual(t.scrolledTo[1], { top: 484, behavior: 'instant' });
    // another scroll ending is not the jump's
    await settle(() => t.scroller.dispatchEvent(new window.Event('scrollend') as any));
    assert.equal(t.scrolledTo.length, 2);
    // a jump the reader scrolls away from is not finished
    await settle(() => navProps.onNavigate(navProps.items[18].id));
    await settle(() => t.scroller.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }) as any));
    await settle(() => t.scroller.dispatchEvent(new window.Event('scrollend') as any));
    assert.equal(t.scrolledTo.length, 3);
    // a message already where the jump would put it needs no smooth scroll
    anchor.getBoundingClientRect = () => ({ top: 16 }) as DOMRect;
    await settle(() => navProps.onNavigate(navProps.items[18].id));
    assert.deepEqual(t.scrolledTo.at(-1), { top: 0, behavior: 'instant' });
  } finally {
    await t.v.unmount();
  }
});

test('back to the bottom: the view follows again where the scroll ends, and is marked as following', async () => {
  const t = await open();
  try {
    // following from the start: the transcript is marked, so the browser's scroll anchoring stays out of the way
    assert.deepEqual(callsTo('scroll:markFollowing').at(-1), [t.scroller, true]);
    await settle(() => navProps.onNavigate(navProps.items[19].id));
    assert.deepEqual(callsTo('scroll:markFollowing').at(-1), [t.scroller, false]);
    Object.defineProperty(t.scroller, 'scrollHeight', { configurable: true, get: () => 5000 });
    await settle(() => t.v.$('.scroll-bottom')!.click());
    assert.deepEqual(t.scrolledTo.at(-1), { top: 5000, behavior: 'smooth' });
    // turns rendered on the way made the transcript taller than where the scroll was headed
    Object.defineProperty(t.scroller, 'scrollHeight', { configurable: true, get: () => 7000 });
    await settle(() => t.scroller.dispatchEvent(new window.Event('scrollend') as any));
    assert.equal(t.scroller.scrollTop, 7000);
    assert.deepEqual(callsTo('scroll:markFollowing').at(-1), [t.scroller, true]);
    const follows = callsTo('scroll:observeBottom').at(-1)![2] as () => boolean;
    assert.equal(follows(), true);
  } finally {
    await t.v.unmount();
  }
});

test('a transcript that mounts after the loading state still finishes smooth jumps; a jump near the end is clamped', async () => {
  // the chat is not in the store yet: the view shows Loading, with no transcript
  setStore({ threads: {}, runtime: {} });
  const v = await render(view());
  try {
    assert.equal(v.$('.thread-scroll'), null);
    chat(turns(6));
    await settle();
    await flush();
    const scroller = v.$('.thread-scroll')!;
    const scrolledTo: any[] = [];
    (scroller as any).scrollTo = (o: any) => scrolledTo.push(o);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 3000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 });
    const anchor = v.$$('[data-navigation-id]')[2];
    anchor.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
    await settle(() => navProps.onNavigate(navProps.items[2].id));
    assert.deepEqual(scrolledTo, [{ top: 884, behavior: 'smooth' }]);
    await settle(() => scroller.dispatchEvent(new window.Event('scrollend') as any));
    assert.deepEqual(scrolledTo[1], { top: 884, behavior: 'instant' });
    // a message near the end cannot reach the top: the scroll goes as far as it can, and smooth only if it moves
    anchor.getBoundingClientRect = () => ({ top: 5000 }) as DOMRect;
    await settle(() => navProps.onNavigate(navProps.items[2].id));
    assert.deepEqual(scrolledTo.at(-1), { top: 2400, behavior: 'smooth' });
    scroller.scrollTop = 2400;
    await settle(() => navProps.onNavigate(navProps.items[2].id));
    assert.deepEqual(scrolledTo.at(-1), { top: 2400, behavior: 'instant' });
    // a scroll that ends long after the view's own smooth scroll (which never moved) does not pull the reader back
    scroller.scrollTop = 0;
    anchor.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
    const now = performance.now;
    await settle(() => navProps.onNavigate(navProps.items[2].id));
    const count = scrolledTo.length;
    performance.now = () => now.call(performance) + 5000;
    try {
      await settle(() => scroller.dispatchEvent(new window.Event('scrollend') as any));
    } finally {
      performance.now = now;
    }
    assert.equal(scrolledTo.length, count);
  } finally {
    await v.unmount();
  }
});

test('while an older page goes in, the view does not also hold its place: the page restores it once', async () => {
  // without an IntersectionObserver every turn renders, so the page going in changes what renders
  const saved = (globalThis as any).IntersectionObserver;
  delete (globalThis as any).IntersectionObserver;
  // each turn's slot is 100px, from the top of the transcript
  const plain = window.HTMLElement.prototype.getBoundingClientRect;
  (window.HTMLElement.prototype as any).getBoundingClientRect = function (this: HTMLElement) {
    const scroll = this.closest('.thread-scroll') as HTMLElement | null;
    const slot = this.closest('[data-turn-slot]');
    if (!scroll || this === scroll) return { top: 0, bottom: 600, height: 600 };
    if (!slot) return plain.call(this);
    const top = [...slot.parentElement!.querySelectorAll(':scope > [data-turn-slot]')].indexOf(slot) * 100 - scroll.scrollTop;
    return { top, bottom: top + 100, height: 100 };
  };
  try {
    chat(turns(5), { olderCursor: 'c1' });
    const v = await render(view());
    await flush();
    const scroller = v.$('.thread-scroll')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 5000 });
    scroller.scrollTop = 150;
    let release!: () => void;
    impl['store:loadOlderTurns'] = () => new Promise<void>((r) => (release = r));
    const load = navProps.onLoadOlder();
    // two older turns go in above while the page is loading
    const older = [turn('o1', [user('ou1', 'Older 1'), reply('or1', 'a')]), turn('o2', [user('ou2', 'Older 2'), reply('or2', 'b')])];
    await settle(() => chat([...older, ...turns(5)], { olderCursor: null }));
    assert.equal(scroller.scrollTop, 150);
    await settle(() => release());
    await flush();
    await settle(() => load);
    // the page's own restoration, by the two turns' height, and nothing more
    assert.equal(scroller.scrollTop, 350);
    await v.unmount();
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = plain;
    (globalThis as any).IntersectionObserver = saved;
  }
});

test("a turn's unfolded work stays open while the turn leaves the window, and a new visit to the chat starts folded", async () => {
  // a finished turn with work, among enough turns to window (#1235: Settings and back must show it folded)
  const worked = turn(
    'w',
    [user('uw', 'Do it'), { id: 'cw', type: 'commandExecution', command: 'ls', status: 'completed' }, reply('rw', 'Done')],
    {
      durationMs: 5000,
    },
  );
  chat([...turns(6), worked]);
  let v = await render(view());
  await flush();
  const fold = () => v.$('[data-turn-slot="w"] .worked-for');
  await settle(() => fold()!.click());
  assert.match(fold()!.className, /open/);
  // the turn leaves the window and comes back: as it was left
  const slot = v.$('[data-turn-slot="t0"]')!;
  await settle(() =>
    live().cb([
      { target: v.$('[data-turn-slot="w"]'), isIntersecting: false },
      { target: slot, isIntersecting: true },
    ]),
  );
  chat([...turns(6), worked, turn('later', [user('ul', 'next')])]);
  await settle();
  await settle(() => live().cb([{ target: v.$('[data-turn-slot="later"]'), isIntersecting: false }]));
  assert.equal(fold(), null, 'the turn is a placeholder while it is away');
  await settle(() => live().cb([{ target: v.$('[data-turn-slot="w"]'), isIntersecting: true }]));
  assert.match(fold()!.className, /open/);
  await v.unmount();
  // the reader leaves the chat (Settings) and opens it again: a fresh visit shows the work folded
  v = await render(view());
  await flush();
  assert.doesNotMatch(fold()!.className, /open/);
  await v.unmount();
});

test("a turn's unfolded work is folded again when the view is pointed at another chat and back", async () => {
  // the same mounted view re-pointed at another chat: App.tsx keys the chat's ErrorBoundary, but the side pane and
  // Quick Chat render ThreadView with no key of their own, so the view itself owns the reset
  const worked = (id: string, prompt: string) =>
    turn(
      id,
      [user(`u${id}`, prompt), { id: `c${id}`, type: 'commandExecution', command: 'ls', status: 'completed' }, reply(`r${id}`, 'Done')],
      {
        durationMs: 5000,
      },
    );
  // the other chat's own turn carries the same id: turn ids are the harness's, unique within a chat, so only the
  // chat a fold was made in may show it (the view keys each slot by [chat, turn])
  setStore({
    threads: { [T]: { id: T, cwd: '/repo' }, other: { id: 'other', cwd: '/repo' } },
    runtime: {
      [T]: { loaded: true, turns: [...turns(6), worked('w', 'Do it'), turn('last', [user('ul', 'And this'), reply('rl', long)])] },
      other: { loaded: true, turns: [worked('w', 'Another chat')] },
    },
  });
  const v = await render(view());
  await flush();
  const fold = () => v.$('[data-turn-slot="w"] .worked-for');
  await settle(() => fold()!.click());
  assert.match(fold()!.className, /open/);
  // a turn that only left the window comes back as the reader left it
  await settle(() =>
    live().cb([
      { target: v.$('[data-turn-slot="w"]'), isIntersecting: false },
      { target: v.$('[data-turn-slot="last"]'), isIntersecting: false },
      { target: v.$('[data-turn-slot="t0"]'), isIntersecting: true },
    ]),
  );
  assert.equal(fold(), null, 'the turn is a placeholder while it is away');
  await settle(() => live().cb([{ target: v.$('[data-turn-slot="w"]'), isIntersecting: true }]));
  assert.match(fold()!.className, /open/);
  // another chat on the same view, then this one again: the folds went with the chat the view shows
  await v.rerender(view({ threadId: 'other' }));
  await flush();
  assert.doesNotMatch(fold()!.className, /open/, "another chat's turn of the same id has its own fold");
  await v.rerender(view());
  await flush();
  assert.doesNotMatch(fold()!.className, /open/, 'the chat shown again starts folded');
  await settle(() => fold()!.click());
  assert.match(fold()!.className, /open/, 'one click opens the work');
  await v.unmount();
});

test('the work unfolds out of "Worked for" and folds back into it: the blocks stay rendered while the accordion closes (#1511)', async () => {
  const worked = turn(
    'w',
    [user('uw', 'Do it'), { id: 'cw', type: 'commandExecution', command: 'ls', status: 'completed' }, reply('rw', 'Done')],
    { durationMs: 5000 },
  );
  chat([worked]);
  const v = await render(view());
  await flush();
  const fold = () => v.$('[data-turn-slot="w"] .worked-for')!;
  const work = () => v.$('[data-turn-slot="w"] .work');
  assert.equal(work(), null, 'a folded turn has nothing mounted');
  await settle(() => fold().click());
  assert.ok(work(), 'the work opens in the accordion');
  const blocks = work()!.childElementCount;
  assert.ok(blocks > 0);
  // folding: the accordion closes, and its blocks are still rendered until it has collapsed
  impl['presence:usePresence'] = () => ({ mounted: true, leaving: true });
  await settle(() => fold().click());
  assert.equal(work(), null, 'the accordion has closed');
  delete impl['presence:usePresence'];
  await v.unmount();
});

test('scroll events in one frame re-measure the response room once, and turn slots are keyed by plain strings', async () => {
  const t = await open(3);
  const queued: FrameRequestCallback[] = [];
  const real = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => queued.push(cb);
  const frames = async (events: number) => {
    queued.length = 0;
    await settle(() => {
      for (let i = 0; i < events; i++) t.scroller.dispatchEvent(new Event('scroll'));
    });
    const asked = queued.length;
    await settle(() => queued.splice(0).forEach((cb) => cb(0)));
    return asked;
  };
  try {
    const one = await frames(1);
    assert.ok(one >= 1, 'a scroll asks for the measuring frame');
    assert.equal(await frames(12), one, 'twelve events ask for no more frames than one');
    // after a frame ran, the next scroll schedules again
    assert.equal(await frames(1), one);
    assert.deepEqual(
      t.v.$$('[data-turn-slot]').map((e) => e.dataset.turnSlot),
      ['t0', 't1', 't2'],
    );
  } finally {
    globalThis.requestAnimationFrame = real;
    await t.v.unmount();
  }
});
