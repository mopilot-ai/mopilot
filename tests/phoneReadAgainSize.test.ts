// A chat read again asks for as many rows as the record has on screen, not for those plus the reply that is streaming (#5686): on a phone the safety net read the chat every 4 s for ever after a send, each time asking for one more row (the live row was counted), which was taken for new rows and kept the net at its fastest, and every read moved the rows above the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

test('a read again while a reply streams asks for the same number of rows every time', async () => {
  const asked: number[] = [];
  const listeners = { current: (_e: any) => {} };
  const record = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, role: i % 2 ? 'assistant' : 'user', text: `record ${i}` }));
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listeners.current = f), () => {}),
    request: async (method: string, p: any) => {
      if (method !== 'chat.follow') return {};
      asked.push(p.items);
      // the last `items` rows of the record, and the reply that is streaming now (a live item)
      return {
        rev: 1,
        feedSeq: 0,
        session: { turn: 'running', cards: [] },
        itemsShape: 'items',
        history: record.slice(-p.items),
        items: [{ id: 'live-1', type: 'agentMessage', text: 'streaming now' }],
      };
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  for (let again = 0; again < 3; again++) {
    await act(async () =>
      listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: again + 1, live: false, items: [] }),
    );
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    await flush();
  }
  await act(async () => root.unmount());
  host.remove();
  assert.ok(asked.length >= 3, `the chat was read again (${asked.length} reads)`);
  assert.deepEqual(new Set(asked), new Set([30]), `every read asked for the record's 30 rows, none for one more: ${asked.join(', ')}`);
});
