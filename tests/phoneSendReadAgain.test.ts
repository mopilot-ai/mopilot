// The owner's "the place I read changes while I scroll" (#5686), replayed on the shape ios-audit measured on the iPhone: send a message, scroll up one screen, touch nothing, and the chat is read again over and over while the turn is pending, each answer holding more rows than the one before. Each read must be invisible to the reader: no scroll of ours, the same rows in the same elements, and the list anchoring the row being read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);
const g = globalThis as any;

async function play(serve: (asked: number, reads: number) => number) {
  g.__scrolledTo = [];
  g.__scrolledToEnd = [];
  const asked: number[] = [];
  const listeners = { current: (_e: any) => {} };
  const record = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, role: i % 2 ? 'assistant' : 'user', text: `record ${i} end` }));
  let reads = 0;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listeners.current = f), () => {}),
    request: async (method: string, p: any) => {
      if (method !== 'chat.follow') return {};
      asked.push(p.items);
      // how many rows of the record this answer holds, and the turn is still pending: a live row
      const n = serve(p.items, reads++);
      return {
        rev: 1 + reads,
        feedSeq: 0,
        session: { turn: 'awaitingUser', cards: [] },
        itemsShape: 'items',
        history: record.slice(-n),
        items: [{ id: 'live-1', type: 'agentMessage', text: 'waiting for you' }],
      };
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let draft = '';
  const render = () =>
    act(async () =>
      root.render(
        createElement(Thread, {
          runtime,
          chatId: 'c',
          back: () => {},
          drafts: fakeDraft(draft, { set: (v: string) => (draft = v), clear: () => (draft = '') }),
        }),
      ),
    );
  await render();
  await flush();
  const list = () => document.querySelector('[scrolleventthrottle]')!;
  const ev = () => g.__scrollEvents;
  const report = (y: number, content = 3000) => {
    const event = new Event('scroll');
    Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: 600 } });
    return act(async () => void list().dispatchEvent(event));
  };
  const rowOf = (text: string) => [...host.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent === text) ?? null;
  // send, then flick up one screen and let go
  draft = 'hello there';
  await render();
  await click('Send message');
  await report(2400);
  // the sent bubble lands and the room under it arrives: the pin places the message, and a reserve is kept under it
  await act(async () => ev().onContentSizeChange(0, 3100));
  await act(async () => ev().onContentSizeChange(0, 3600));
  assert.ok(g.__scrolledTo.length >= 1, 'the pin placed the sent message');
  await act(async () => ev().onTouchStart({ nativeEvent: { changedTouches: [{}] } }));
  await act(async () => ev().onScrollBeginDrag());
  await report(1800);
  await act(async () => ev().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  await act(async () => ev().onTouchEnd({ nativeEvent: { changedTouches: [{}] } }));
  const reading = ['record 175 end', 'record 180 end', 'record 190 end'].map((t) => [t, rowOf(t)] as const);
  assert.ok(
    reading.every(([, n]) => n),
    'the rows the reader sees are on screen',
  );
  const calls = g.__scrolledTo.length + g.__scrolledToEnd.length;
  const asksBefore = asked.length;
  // (what each read asks for is tested apart, in phoneReadAgainSize: here the answers grow whatever is asked)
  // the chat is read again four times while the turn stays pending
  for (let again = 0; again < 4; again++) {
    await act(async () =>
      listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: again + 1, live: false, items: [] }),
    );
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    await flush();
    assert.ok(
      list().hasAttribute('maintainvisiblecontentposition'),
      'the list anchors the row being read: rows that join above do not move it',
    );
  }
  assert.ok(asked.length - asksBefore >= 3, `the chat was read again (${asked.length - asksBefore} reads)`);
  assert.equal(g.__scrolledTo.length + g.__scrolledToEnd.length, calls, 'no scroll of ours for any of them');
  for (const [text, node] of reading) assert.equal(rowOf(text), node, `${text} is still the same element, in the same place`);
  await act(async () => root.unmount());
  host.remove();
  return asked;
}

test('after a send, a reader who scrolled up sees nothing change while the chat is read again and each answer holds one more row (whatever is asked)', async () => {
  await play((_asked, reads) => 30 + reads);
});

test('the Mac answers exactly the rows asked for, plus the streaming reply: every read asks for the same number of rows, none for one more', async () => {
  const asked = await play((askedRows) => askedRows);
  assert.ok(asked.length >= 4, `the chat was read again (${asked.length} reads)`);
  assert.deepEqual(
    new Set(asked),
    new Set([30]),
    `the request does not grow while the answer repeats the same record and the same live row: ${asked.join(', ')}`,
  );
});
