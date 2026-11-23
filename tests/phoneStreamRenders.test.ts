// A streamed reply draws the chat screen once per event and the composer not at all (#4986): settling the sends on each event no longer sets state when there is nothing to settle, which had drawn the whole screen a second time per event; the composer's handlers and elements are held still, so it was drawn with the screen 22-27 times a send on the phone; and a send still settles when the Mac's record of it arrives.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
import { fakeMedia } from './support/phone/m3';

const threadPath = '../mobile/src/screens/Thread';
const logPath = '../mobile/src/perfLog';
const { Thread } = await import(threadPath);
const feedPath = '../mobile/src/presentation/followFeed';
const { perf } = await import(logPath);
const { FRAME_MS } = await import(feedPath);
const frame = () => new Promise((resolve) => setTimeout(resolve, FRAME_MS + 4));

afterEach(() => {
  perf.end();
  document.body.replaceChildren();
});

async function stream(gap: (() => Promise<unknown>) | null, withMedia = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let listener: (e: any) => void = () => undefined;
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
            history: [{ role: 'user', text: 'Old' }],
            liveTurn: { id: 'one', status: 'inProgress' },
            items: [{ id: 'reply', type: 'agentMessage', text: 'Reply' }],
          }
        : {},
  };
  withOutbox(runtime);
  await act(async () =>
    root.render(
      createElement(Thread, {
        runtime,
        chatId: 'c',
        back: () => undefined,
        drafts: fakeDraft(''),
        media: withMedia ? fakeMedia().media : undefined,
      }),
    ),
  );
  await flush();
  await flush();
  perf.start();
  const send = (i: number) =>
    listener({ kind: 'event', chatId: 'c', ev: 'items.delta', feedSeq: i, live: true, itemId: 'reply', field: 'text', text: ` w${i}` });
  if (gap) {
    for (let i = 1; i <= 10; i += 1) {
      await act(async () => send(i));
      await gap();
    }
  } else {
    // one burst: all ten arrive in the same moment, as a fast stream's do
    await act(async () => {
      for (let i = 1; i <= 10; i += 1) send(i);
    });
  }
  await frame();
  const r = perf.report();
  await act(async () => root.unmount());
  return r;
}

for (const withMedia of [false, true])
  test(`A: ten streamed events a frame apart draw the chat screen ten times, once each, and the composer not at all${withMedia ? ' (with attachments available)' : ''}`, async () => {
    const r = await stream(frame, withMedia);
    assert.equal(r.events.delta, 10);
    assert.equal(r.renders.Thread, 10, 'one draw of the screen per event');
    assert.equal(r.renders.Composer ?? 0, 0, 'the composer is not drawn for a streamed reply');
  });

test('A: ten streamed events in one burst draw the chat screen twice: the first at once, the rest together', async () => {
  const r = await stream(null);
  assert.equal(r.events.delta, 10);
  assert.equal(r.events['thread-update'], 2, 'two shows of the rows');
  assert.equal(r.renders.Thread, 2, 'two draws of the screen for ten events');
});
