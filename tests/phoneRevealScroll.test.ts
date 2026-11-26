// Rows the phone holds but has not mounted come back a page at a time as the reader scrolls up, as often as the screen can draw them: they cost no request, so they neither use up the chain of unasked pages nor end the gesture (#5379).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const earlierPath = '../mobile/src/remote/useEarlier';
const windowPath = '../mobile/src/remote/useBlockWindow';
const { Thread } = await import(threadPath);
const { SETTLE_MS } = await import(earlierPath);
const { WINDOW } = await import(windowPath);

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `row-${i}-end` }));
const shownCount = (host: HTMLElement) => (host.textContent!.match(/row-\d+-end/g) ?? []).length;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount(n: number) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: rowsOf(n) };
      if (method === 'chat.read') return { chatId: 'c', rows: [], more: false };
      return {};
    },
  };
  withOutbox(runtime);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const scroll = async (y: number) => {
    const event = new Event('scroll');
    Object.assign(event, { contentOffset: { y }, layoutMeasurement: { height: 800 } });
    await act(async () => void document.querySelector('[scrolleventthrottle]')!.dispatchEvent(event));
    await flush();
    return shownCount(host);
  };
  return {
    host,
    scroll,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('held rows keep coming past four pages in one gesture, one page each time the screen has drawn the last', async () => {
  const t = await mount(1000);
  assert.equal(shownCount(t.host), WINDOW);
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) {
    seen.push(await t.scroll(1200));
    await pause(SETTLE_MS + 30);
  }
  assert.deepEqual(seen, [240, 360, 480, 600, 720, 840, 960, 1000], 'no ceiling at four pages: it goes on to the oldest held row');
  await t.done();
});

/** A clock that moves only when the test says, so that "before the screen drew it" and "after" do not depend on how fast a runner is. */
function frozenClock() {
  const real = Date.now;
  let at = 1_700_000_000_000;
  Date.now = () => at;
  return { advance: (ms: number) => void (at += ms), restore: () => void (Date.now = real) };
}

test('scroll events that arrive before the screen drew a reveal ask for no second page', async () => {
  const clock = frozenClock();
  try {
    const t = await mount(1000);
    const burst = [await t.scroll(1200), await t.scroll(1100), await t.scroll(1000), await t.scroll(900)];
    assert.deepEqual(burst, [240, 240, 240, 240]);
    await t.done();
  } finally {
    clock.restore();
  }
});

test('rows revealed above a reader wait for the finger to lift, and a finger that reaches the top mounts one page, once, when it lifts', async () => {
  const clock = frozenClock();
  try {
    const t = await mount(1000);
    const events = () => (globalThis as any).__scrollEvents;
    const lift = () => act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
    await act(async () => events().onScrollBeginDrag());
    assert.equal(await t.scroll(1200), WINDOW, 'the finger is down: nothing is mounted above the rows being read');
    await lift();
    assert.equal(shownCount(t.host), 2 * WINDOW, 'it lifted: the page joins');
    clock.advance(SETTLE_MS + 30);
    await act(async () => events().onScrollBeginDrag());
    assert.equal(await t.scroll(0), 2 * WINDOW, 'at the top, still down: it waits');
    assert.equal(await t.scroll(0), 2 * WINDOW, 'and one ask at the top, however many scrolls');
    await lift();
    assert.equal(shownCount(t.host), 3 * WINDOW, 'lifted: one page, once');
    await t.done();
  } finally {
    clock.restore();
  }
});
