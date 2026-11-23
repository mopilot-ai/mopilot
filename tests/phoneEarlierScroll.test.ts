// Older messages load as the reader scrolls to the top: one page per gesture (a finger down), once at a time, and not after a failure or at the start of the chat; the list keeps the row being read in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

const snapshot = {
  rev: 1,
  feedSeq: 0,
  session: { turn: 'idle', cards: [] },
  itemsShape: 'rows',
  items: [
    { id: 'r10', role: 'user', text: 'newest question' },
    { id: 'r11', role: 'assistant', text: 'newest answer' },
  ],
};
const page = (n: number, more = true) => ({ chatId: 'c', rows: [{ id: `r${n}`, role: 'user', text: `older ${n}` }], more });

async function mount(read: (params: any) => unknown) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const reads: any[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      if (method === 'chat.follow') return snapshot;
      if (method !== 'chat.read') return {};
      reads.push(params);
      return read(params);
    },
  };
  withOutbox(runtime);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const list = () => document.querySelector('[scrolleventthrottle]')!;
  return {
    host,
    reads,
    list,
    scroll: async (y?: number) => {
      const event = new Event('scroll');
      if (y !== undefined) Object.assign(event, { contentOffset: { y } });
      await act(async () => void list().dispatchEvent(event));
      await flush();
    },
    /** A finger goes down on the list: the gesture may ask for one page (#4734). */
    touch: () => act(async () => (globalThis as any).__scrollEvents.onScrollBeginDrag()),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a scroll that ends near the top loads the page before; farther down, or with no position, loads nothing', async () => {
  const t = await mount((p) => page(Number(p.before.slice(1)) - 1));
  await t.scroll(500);
  await t.scroll();
  assert.equal(t.reads.length, 0);
  await t.scroll(100);
  assert.equal(t.reads.length, 0, 'no finger on the list: nothing is asked');
  await t.touch();
  await t.scroll();
  assert.equal(t.reads.length, 0, 'a finger, but a scroll that reports no position: nothing is asked, and the gesture stays');
  await t.scroll(100);
  assert.deepEqual(t.reads, [{ chatId: 'c', before: 'r10', limit: 40 }]);
  assert.match(t.host.textContent!, /older 9/);
  await t.scroll(0);
  assert.equal(t.reads.length, 1, 'one gesture, one page');
  await t.touch();
  await t.scroll(0);
  assert.equal(t.reads[1].before, 'r9', 'the next page starts at the oldest row now shown');
  await t.done();
});

test('scrolling while a page is on its way asks for no second page', async () => {
  let release: (v: unknown) => void = () => {};
  const t = await mount(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.touch();
  await t.scroll(0);
  await t.touch();
  await t.scroll(0);
  assert.equal(t.reads.length, 1);
  await act(async () => release(page(9)));
  await flush();
  assert.match(t.host.textContent!, /older 9/);
  await t.done();
});

test('after a failed page a scroll does not ask again, the button does, and at the start of the chat nothing is asked', async () => {
  let fail = true;
  const t = await mount(() => {
    if (fail) throw new Error('Your computer is offline.');
    return page(9, false);
  });
  await t.touch();
  await t.scroll(0);
  assert.match(t.host.textContent!, /offline/);
  await t.touch();
  await t.scroll(0);
  assert.equal(t.reads.length, 1, 'the person decides when to retry');
  fail = false;
  await click('Load earlier messages');
  assert.equal(t.reads.length, 2);
  assert.match(t.host.textContent!, /This is the start of the chat\./);
  await t.touch();
  await t.scroll(0);
  assert.equal(t.reads.length, 2, 'the start of the chat has nothing before it');
  await t.done();
});

test('the list asks to keep the row being read where it is when a page joins above', async () => {
  const t = await mount(() => page(9));
  // the DOM stand-in for a native list keeps the props it was given, which a test reads back from React
  const el = t.list() as any;
  const props = el[Object.keys(el).find((k) => k.startsWith('__reactProps'))!];
  assert.deepEqual(props.maintainVisibleContentPosition, { minIndexForVisible: 1 });
  await t.done();
});

test('a scroll right after a page lands, before the screen draws it, asks for the page before that one, not the same page again', async () => {
  let release: (v: unknown) => void = () => {};
  const t = await mount(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.touch();
  await t.scroll(0);
  await act(async () => {
    release(page(9));
    await new Promise((resolve) => setImmediate(resolve));
    // the render that shows the page has not happened yet: this scroll, of a new gesture, runs on the old one
    (globalThis as any).__scrollEvents.onScrollBeginDrag();
    t.list().dispatchEvent(Object.assign(new Event('scroll'), { contentOffset: { y: 0 } }));
  });
  await flush();
  assert.deepEqual(
    t.reads.map((r) => r.before),
    ['r10', 'r9'],
  );
  assert.equal(t.host.textContent!.split('older 9').length, 2, 'the page is shown once');
  await t.done();
});

test('a page with a message that repeats one already shown leaves the rows below it mounted, so the list keeps its place', async () => {
  const t = await mount(() => ({ chatId: 'c', rows: [{ id: 'r9', role: 'assistant', text: 'newest answer' }], more: true }));
  const rowOf = (text: string) => [...t.host.querySelectorAll('span')].find((s) => s.textContent === text)!.parentElement;
  const before = rowOf('newest answer');
  await t.touch();
  await t.scroll(0);
  assert.equal(t.host.textContent!.split('newest answer').length, 3, 'shown twice now');
  assert.ok([...t.host.querySelectorAll('span')].filter((s) => s.textContent === 'newest answer').some((s) => s.parentElement === before));
  await t.done();
});

test('the control above the messages is one element with its error inside, so it is never taken for a row to keep in place', async () => {
  const t = await mount(() => {
    throw new Error('Your computer is offline.');
  });
  await t.touch();
  await t.scroll(0);
  const first = t.list().firstElementChild!;
  assert.match(first.textContent!, /offline/);
  assert.ok(first.querySelector('button'), 'the error and the button share the first child');
  assert.ok(first.querySelector('[role="alert"]'));
  await t.done();
});
