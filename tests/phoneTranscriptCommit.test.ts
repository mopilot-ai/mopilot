// A streamed delta costs the same in a 1000-row chat as in a short one: the rows around it keep their identity, so their blocks, bubbles and runs are not rendered again (#4986 F4a).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, createRoot } from './support/phone/component-kit';

const renders = { bubble: 0, run: 0 };
const bubblePath = new URL('../mobile/src/components/MessageBubble.tsx', import.meta.url).href;
mock.module(bubblePath, {
  namedExports: {
    MessageBubble: ({ text }: { text: string }) => {
      renders.bubble += 1;
      return createElement('p', null, text);
    },
    ToolRun: ({ summary }: { summary: string }) => {
      renders.run += 1;
      return createElement('p', null, summary);
    },
  },
});
const blocksPath = '../mobile/src/components/TranscriptBlocks';
const threadPath = '../mobile/src/presentation/thread';
const foldPath = '../mobile/src/presentation/toolRuns';
const { TranscriptBlocks } = await import(blocksPath);
const { snapshot, update, displayRows, keyedRows } = await import(threadPath);
const { fold } = await import(foldPath);

/** 1000 saved rows (a user message, two steps and a reply, repeated) and a live reply that grows. */
const chat = (rows = 1000) => {
  const items: any[] = [];
  for (let i = 0; i < rows; i++) {
    const k = i % 4;
    items.push(
      k === 0
        ? { id: `u${i}`, role: 'user', text: `question ${i}` }
        : k === 3
          ? { id: `a${i}`, role: 'assistant', text: `answer ${i}` }
          : { id: `s${i}`, role: 'step', text: `Ran command ${i}`, kind: 'run' },
    );
  }
  const first = snapshot({
    rev: 1,
    feedSeq: 0,
    session: { turn: 'running' },
    itemsShape: 'rows',
    items,
    liveTurn: { id: 't', status: 'running' },
  });
  return update(first, { ev: 'items.append', feedSeq: 1, live: true, items: [{ id: 'live', type: 'agentMessage', text: 'Hello' }] });
};
const delta = (thread: any, seq: number) =>
  update(thread, { ev: 'items.delta', feedSeq: seq, itemId: 'live', field: 'text', text: ' word' });
const blocksOf = (thread: any, running = true) => fold(keyedRows(displayRows(thread)), { running, foldedTurn: null });

test('the rows, keys and blocks of a chat keep their identity when a streamed delta changes only the live reply', () => {
  const before = chat();
  const after = delta(before, 2);
  const [a, b] = [displayRows(before), displayRows(after)];
  assert.equal(a.length, b.length);
  assert.equal(b.filter((row: any, i: number) => row !== a[i]).length, 1, 'only the live reply is a new row');
  const [ka, kb] = [keyedRows(a), keyedRows(b)];
  assert.equal(kb.filter((row: any, i: number) => row !== ka[i]).length, 1);
  const [fa, fb] = [fold(ka, { running: true, foldedTurn: null }), fold(kb, { running: true, foldedTurn: null })];
  assert.equal(fa.blocks.length, fb.blocks.length);
  assert.equal(
    fb.blocks.filter((block: any, i: number) => block !== fa.blocks[i]).length,
    1,
    'every run and row but the live one is the same block',
  );
  // a run that is the same steps but no longer running is a new block (its caret and state change), and one that did not change is not
  const ended = fold(kb, { running: false, foldedTurn: null }).blocks;
  assert.ok(ended.length === fb.blocks.length);
});

test('a delta in a 1000-row chat renders the live reply and nothing else of the transcript', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (thread: any) =>
    act(async () =>
      root.render(
        createElement(TranscriptBlocks, { blocks: blocksOf(thread).blocks, streamingKey: null, request: {} as any, chatId: 'c' }),
      ),
    );
  let thread = chat();
  await show(thread);
  assert.ok(renders.bubble > 500, 'the first show draws the rows');
  for (let seq = 2; seq < 12; seq++) {
    renders.bubble = 0;
    renders.run = 0;
    thread = delta(thread, seq);
    await show(thread);
    assert.equal(renders.bubble, 1, `delta ${seq - 1}: one bubble renders (the live reply), not the whole chat`);
    assert.equal(renders.run, 0, 'no run renders');
  }
  assert.match(host.textContent!, /Hello word word/);
  await act(async () => root.unmount());
  host.remove();
});

test('what the commit draws does not grow with the chat: a short chat and a long one render the same count per delta', async () => {
  const counts: number[] = [];
  for (const rows of [40, 1000]) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const show = (thread: any) =>
      act(async () =>
        root.render(
          createElement(TranscriptBlocks, { blocks: blocksOf(thread).blocks, streamingKey: null, request: {} as any, chatId: 'c' }),
        ),
      );
    let thread = chat(rows);
    await show(thread);
    renders.bubble = 0;
    thread = delta(thread, 2);
    await show(thread);
    counts.push(renders.bubble);
    await act(async () => root.unmount());
    host.remove();
  }
  assert.deepEqual(counts, [1, 1]);
});

test('a row with no id keeps its keyed object while its key stays, and gets a new one when its place among the same words changes', () => {
  const same = { role: 'user', text: 'again' };
  const other = { role: 'user', text: 'again' };
  const [first] = keyedRows([same]);
  assert.equal(keyedRows([same])[0], first, 'the same row at the same place is the same object');
  const moved = keyedRows([other, same])[1];
  assert.notEqual(moved, first, 'the second of two identical messages is a new key, so a new object');
  assert.notEqual(moved.key, first.key);
  assert.equal(keyedRows([other, same])[1], moved);
});

test('a live reply preview with no id is keyed as the preview, and keeps that object while it stays the same row', () => {
  const preview = { role: 'preview', text: 'Hel' };
  const [keyed] = keyedRows([preview]);
  assert.equal(keyed.key, JSON.stringify(['preview']));
  assert.equal(keyedRows([preview])[0], keyed);
});
