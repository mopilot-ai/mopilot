// Older rows that join above a reader wait for them to let go (#5686): a page that landed mid-scroll, flick after flick at the top, the spinner, a glide that falls silent, and a finger caught on a glide.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

function rig(pages: any[]) {
  const calls: any[] = [];
  const listeners = { current: (_e: any) => {} };
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listeners.current = f), () => {}),
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [
            { id: 'r10', role: 'user', text: 'newest question' },
            { id: 'r11', role: 'assistant', text: 'newest answer' },
          ],
        };
      if (method === 'chat.read') {
        const next = pages.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return {};
    },
  };
  withOutbox(runtime);
  return { runtime, calls, listeners };
}
const mounted: any[] = [];
const mount = async (runtime: any) => {
  for (const old of mounted.splice(0)) await act(async () => old.unmount());
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  return host;
};

const events = () => (globalThis as any).__scrollEvents;
const scrollTo = (y: number) =>
  act(async () =>
    events().onScroll({ nativeEvent: { contentOffset: { y }, contentSize: { height: 3000 }, layoutMeasurement: { height: 600 } } }),
  );

test('a page that landed while the reader was still scrolling is not added if the chat was read again before they let go', async () => {
  const { runtime, listeners } = rig([{ chatId: 'c', rows: [{ id: 'r8', role: 'user', text: 'held page' }], more: true }]);
  const host = await mount(runtime);
  await act(async () => events().onScrollBeginDrag());
  await scrollTo(60);
  await flush();
  assert.doesNotMatch(host.textContent!, /held page/, 'it waits for the finger');
  // the chat is read again meanwhile: a new snapshot, with nothing paged back
  await act(async () => listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: 1, live: false, items: [] }));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  await flush();
  assert.doesNotMatch(host.textContent!, /held page/, 'a page of the snapshot before is not added to the new one');
});

test('flick after flick at the top asks for the page before the last one that arrived, however many join together: no row twice, in order', async () => {
  const pages = [4, 5, 6, 7, 8].map((n) => ({
    chatId: 'c',
    rows: [{ id: `r${n}`, role: 'user', text: `chain page ${n}` }],
    more: n !== 4,
  }));
  // newest page first: r8 is the page before the snapshot's oldest row (r10), r7 the one before it, and so on
  pages.reverse();
  const { runtime, calls } = rig(pages);
  const host = await mount(runtime);
  for (let flick = 0; flick < 5; flick++) {
    await act(async () => events().onScrollBeginDrag());
    await scrollTo(30);
    await flush();
  }
  const asked = calls.filter(([m]) => m === 'chat.read').map(([, p]) => p.before);
  assert.deepEqual(asked, ['r10', 'r8', 'r7', 'r6', 'r5'], 'each ask starts at the oldest row that arrived, not at the one still shown');
  assert.doesNotMatch(host.textContent!, /chain page/, 'nothing joined while the finger was still down');
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  await flush();
  for (const n of [4, 5, 6, 7, 8]) assert.equal(host.textContent!.split(`chain page ${n}`).length, 2, `page ${n} once`);
  const text = host.textContent!;
  assert.ok(
    text.indexOf('chain page 4') < text.indexOf('chain page 5') && text.indexOf('chain page 8') < text.indexOf('newest question'),
    'in order',
  );
  assert.match(text, /This is the start of the chat\./);
});

test('the spinner stays while a page waits for the reader’s finger to lift, and goes when it joins', async () => {
  const { runtime } = rig([{ chatId: 'c', rows: [{ id: 'r8', role: 'user', text: 'spinner page' }], more: true }]);
  const host = await mount(runtime);
  const loading = () =>
    host.querySelector('[aria-busy="true"], [role="progressbar"]') !== null || /Loading earlier/i.test(host.textContent ?? '');
  await act(async () => events().onScrollBeginDrag());
  await scrollTo(30);
  await flush();
  assert.equal(loading(), true, 'the page has arrived but waits: the reader still sees that something is coming');
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  await flush();
  assert.equal(loading(), false);
  assert.match(host.textContent!, /spinner page/);
});

test('a row a page repeats by id is shown once, and a row with no id is always shown', async () => {
  const { runtime } = rig([
    {
      chatId: 'c',
      rows: [
        { id: 'r8', role: 'user', text: 'first copy' },
        { role: 'assistant', text: 'no id row' },
      ],
      more: true,
    },
    {
      chatId: 'c',
      rows: [
        { id: 'r8', role: 'user', text: 'second copy' },
        { id: 'r7', role: 'user', text: 'a new one' },
      ],
      more: true,
    },
  ]);
  const host = await mount(runtime);
  for (let flick = 0; flick < 2; flick++) {
    await act(async () => events().onScrollBeginDrag());
    await scrollTo(30);
    await flush();
    await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
    await flush();
  }
  assert.match(host.textContent!, /first copy/);
  assert.doesNotMatch(host.textContent!, /second copy/, 'the same id is not added again');
  assert.match(host.textContent!, /no id row/);
  assert.match(host.textContent!, /a new one/);
});

test('a glide that never reports its end lets the pages that waited for it join once it has fallen silent', async () => {
  const { runtime } = rig([{ chatId: 'c', rows: [{ id: 'r8', role: 'user', text: 'silent glide page' }], more: true }]);
  const host = await mount(runtime);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () => events().onScrollBeginDrag());
    await scrollTo(30);
    await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 2 } } }));
    await flush();
    assert.doesNotMatch(host.textContent!, /silent glide page/, 'the glide runs: the page waits');
    await act(async () => mock.timers.tick(1600));
    await flush();
    assert.match(host.textContent!, /silent glide page/, 'it fell silent: nothing holds the rows back');
  } finally {
    mock.timers.reset();
  }
});

test('a finger put down on a glide while older rows wait: the glide ends under it and the rows still wait until it lifts', async () => {
  const { runtime } = rig([{ chatId: 'c', rows: [{ id: 'r8', role: 'user', text: 'caught page' }], more: true }]);
  const host = await mount(runtime);
  const ev = () => events();
  await act(async () => ev().onScrollBeginDrag());
  await scrollTo(30);
  await act(async () => ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 2 } } }));
  await flush();
  assert.doesNotMatch(host.textContent!, /caught page/, 'the glide runs: the page waits');
  await act(async () => ev().onTouchStart({ nativeEvent: { changedTouches: [{}] } }));
  await act(async () => ev().onMomentumScrollEnd()); // the finger stopped the glide
  await flush();
  assert.doesNotMatch(host.textContent!, /caught page/, 'a finger is down: nothing is mounted above it');
  await act(async () => ev().onTouchEnd({ nativeEvent: { changedTouches: [{}] } }));
  await flush();
  assert.match(host.textContent!, /caught page/, 'it lifted: the page joins');
});
