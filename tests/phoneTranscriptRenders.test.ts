// A streamed reply draws the transcript's changed block, not every block (#4986): the transcript is built again on every event, and each block's animated wrapper was drawn each time (251 per event in a 250-row chat, about 22 ms of the chat screen's commit on the phone, more the longer the chat). A block is drawn again only when what it shows changed.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const blocksPath = '../mobile/src/components/TranscriptBlocks';
const { Thread } = await import(threadPath);
const { sameBlock } = await import(blocksPath);

afterEach(() => {
  document.body.replaceChildren();
  (globalThis as any).__animatedViews = undefined;
});

/** Animated views drawn per event (the deltas, then one appended message) in a chat of `rows` messages, and the text the chat shows at the end. */
async function perEvent(rows: number, events = 8) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let listener: (e: any) => void = () => undefined;
  const history = Array.from({ length: rows }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `Row ${i} ${'lorem ipsum '.repeat(6)}`,
  }));
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1, outbox: [] }),
    onEvent: (f: any) => ((listener = f), () => undefined),
    request: async (method: string) =>
      method === 'chat.follow'
        ? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'running', turnStatus: 'running', cards: [] },
            itemsShape: 'items',
            history,
            liveTurn: { id: 'one', status: 'inProgress' },
            items: [{ id: 'reply', type: 'agentMessage', text: 'Reply' }],
          }
        : {},
  };
  withOutbox(runtime);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => undefined, drafts: fakeDraft('') })));
  await flush();
  await flush();
  (globalThis as any).__animatedViews = 0;
  for (let i = 1; i <= events; i += 1)
    await act(async () =>
      listener({ kind: 'event', chatId: 'c', ev: 'items.delta', feedSeq: i, live: true, itemId: 'reply', field: 'text', text: ` w${i}` }),
    );
  await act(async () =>
    listener({
      kind: 'event',
      chatId: 'c',
      ev: 'items.append',
      feedSeq: events + 1,
      live: true,
      items: [{ id: 'second', type: 'agentMessage', text: 'Second reply' }],
    }),
  );
  // the feed shows an event that comes right after another when its frame window ends
  await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  await flush();
  const drawn = (globalThis as any).__animatedViews as number;
  const text = host.textContent!;
  await act(async () => root.unmount());
  return { perEvent: drawn / (events + 1), text };
}

test('A: a streamed event draws a few animated views, not one per row, and a message that arrives shows through the blocks that were kept', async () => {
  const short = await perEvent(20);
  const long = await perEvent(250);
  // the block being written waits until it is whole; one appended after the deltas shows through the blocks that were kept
  assert.ok(short.text.includes('Second reply'), 'a message that arrives is on screen');
  assert.ok(long.text.includes('Second reply'));
  // a long chat mounts its newest blocks (the head window); the newest row is there
  assert.ok(long.text.includes('Row 249 '), 'the newest row is drawn');
  // before: 251 per event at 250 rows (one wrapper per row); now what changed, the screen's own chrome, and the extra commits a longer chat's scroll state makes
  assert.ok(long.perEvent < 30, `250 rows drew ${long.perEvent} animated views per event`);
  assert.ok(short.perEvent < 30, `20 rows drew ${short.perEvent} per event`);
});

const row = (over: Record<string, unknown> = {}) => ({ key: 'k1', role: 'assistant', text: 'hi', ...over });
const run = (over: Record<string, unknown> = {}) => ({
  type: 'run',
  key: 'r1',
  steps: [row({ key: 's1', state: 'done' }), row({ key: 's2', state: 'running' })],
  summary: 'Ran 2 commands',
  running: true,
  ...over,
});

test('I: two blocks are the same when they say the same, whether or not they are the same objects', () => {
  const a = { type: 'row', row: row({ pictures: ['p1'] }) };
  assert.equal(sameBlock(a, { type: 'row', row: row({ pictures: ['p1'] }) }), true);
  assert.equal(sameBlock(a, { type: 'row', row: row({ pictures: ['p2'] }) }), false, 'another picture');
  assert.equal(sameBlock(a, { type: 'row', row: row({ pictures: ['p1', 'p2'] }) }), false, 'another number of pictures');
  assert.equal(sameBlock({ type: 'row', row: row() }, { type: 'row', row: row({ text: 'hi there' }) }), false, 'more words');
  assert.equal(sameBlock({ type: 'row', row: row() }, { type: 'row', row: row({ extra: 1 }) }), false, 'another set of fields');
  assert.equal(sameBlock(run() as any, run() as any), true);
  assert.equal(sameBlock(run() as any, run({ summary: 'Ran 3 commands' }) as any), false);
  assert.equal(sameBlock(run() as any, run({ running: false }) as any), false);
  assert.equal(sameBlock(run() as any, run({ key: 'r2' }) as any), false);
  assert.equal(sameBlock(run() as any, run({ steps: [row({ key: 's1', state: 'done' })] }) as any), false, 'a step fewer');
  assert.equal(
    sameBlock(run() as any, run({ steps: [row({ key: 's1', state: 'done' }), row({ key: 's2', state: 'done' })] }) as any),
    false,
    'a step finished',
  );
  assert.equal(sameBlock(run() as any, { type: 'row', row: row() } as any), false, 'a run is not a row');
  assert.equal(sameBlock({ type: 'row', row: row() } as any, run() as any), false, 'a row is not a run');
});
