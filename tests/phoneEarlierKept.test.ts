// A chat read again (back from the background, the Mac reconnecting, the live watch's safety net) must not take the older messages out from under a reader who scrolled up to them (#5686): their pages stay, each message once and in the same element, and a reader at the end still gets the new snapshot as it was.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
import { heldIds, withoutHeld } from '../mobile/src/presentation/heldRows';

const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);
const g = globalThis as any;

const mounted: any[] = [];
afterEach(async () => {
  for (const old of mounted.splice(0)) await act(async () => old.unmount());
});

/** `snapshot()` is what the next read of the chat answers with. */
function rig(snapshot: () => object[]) {
  const listeners = { current: (_e: any) => {} };
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listeners.current = f), () => {}),
    request: async (method: string) => {
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: snapshot() };
      if (method === 'chat.read')
        return {
          chatId: 'c',
          rows: [
            { id: 'r8', role: 'user', text: 'older question' },
            { id: 'r9', role: 'assistant', text: 'older answer' },
          ],
          more: true,
        };
      return {};
    },
  };
  withOutbox(runtime);
  return { runtime, listeners };
}
const newest = [
  { id: 'r10', role: 'user', text: 'newest question' },
  { id: 'r11', role: 'assistant', text: 'newest answer' },
];
const older = [
  { id: 'r8', role: 'user', text: 'older question' },
  { id: 'r9', role: 'assistant', text: 'older answer' },
];
async function open(snapshot: () => object[]) {
  g.__scrolledToEnd = [];
  document.body.replaceChildren();
  const { runtime, listeners } = rig(snapshot);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount() });
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const ev = () => g.__scrollEvents;
  const report = (y: number) =>
    act(async () =>
      ev().onScroll({ nativeEvent: { contentOffset: { y }, contentSize: { height: 3000 }, layoutMeasurement: { height: 600 } } }),
    );
  const node = (text: string) => [...host.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === text) ?? null;
  const count = (text: string) => host.textContent!.split(text).length - 1;
  // the chat is read again: a gap in the live events makes the phone read it from the start
  const readAgain = async () => {
    await act(async () => listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: 1, live: false, items: [] }));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    await flush();
  };
  return { host, ev, report, node, count, readAgain };
}

test('the older rows a reader paged back to stay, once each and in the same elements, when the chat is read again while they are away from the end', async () => {
  let rows: object[] = newest;
  const t = await open(() => rows);
  await click('Load earlier messages');
  assert.ok(t.node('older question'));
  // the reader scrolls up from the end
  await t.report(2400);
  await act(async () => t.ev().onScrollBeginDrag());
  await t.report(1800);
  await act(async () => t.ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  const question = t.node('older question');
  const answer = t.node('older answer');
  // the read again reaches back over the rows they paged (it asks for as many as are on screen)
  rows = [...older, ...newest];
  await t.readAgain();
  assert.equal(t.count('older question'), 1, 'one copy of each message');
  assert.equal(t.count('older answer'), 1);
  assert.equal(t.node('older question'), question, 'the same element: not drawn anew under the reader');
  assert.equal(t.node('older answer'), answer);
  const text = t.host.textContent!;
  assert.ok(text.indexOf('older answer') < text.indexOf('newest question'), 'in order');
  assert.match(text, /Load earlier messages/, 'the page cursor and what is still above are kept');
});

test('a reader at the end gets the new snapshot, with each message once', async () => {
  let rows: object[] = newest;
  const t = await open(() => rows);
  await click('Load earlier messages');
  await t.report(2400);
  rows = [...older, ...newest];
  await t.readAgain();
  assert.equal(t.count('older question'), 1);
  assert.equal(t.count('older answer'), 1);
  assert.equal(t.count('newest answer'), 1);
});

test('the rows of a read again that the held pages already show are the only ones dropped', () => {
  const held = heldIds([{ id: 'a' }, { id: 7 }, { id: '' }, {}]);
  assert.deepEqual([...held].sort(), ['7', 'a']);
  const rows = [{ id: 'a' }, { id: 7 }, { id: 'b' }, {}].map((r) => ({ role: 'user', text: 't', ...r }));
  assert.deepEqual(
    withoutHeld(rows, held).map((r) => r.id),
    ['b', undefined],
  );
  assert.equal(withoutHeld(rows, new Set()), rows, 'nothing held: nothing dropped');
});
