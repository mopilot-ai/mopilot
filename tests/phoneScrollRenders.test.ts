// Scrolling a chat does not draw the chat screen (#4986): the scroll reports move the jump arrow's state, which lives outside the screen, so a layout, a content growth or a scroll costs the screen no render, and the arrow still shows and goes.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const logPath = '../mobile/src/perfLog';
const { Thread } = await import(threadPath);
const { perf } = await import(logPath);

afterEach(() => {
  perf.end();
  document.body.replaceChildren();
});

const report = (y: number, content: number, view: number) => ({
  nativeEvent: { contentOffset: { y }, contentSize: { height: content, width: 400 }, layoutMeasurement: { height: view, width: 400 } },
});

test('A: layout, content growth and scroll reports draw the chat screen no time, and the jump arrow still follows them', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1, outbox: [] }),
    onEvent: () => () => undefined,
    request: async (method: string) =>
      method === 'chat.follow'
        ? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'idle', turnStatus: 'idle', cards: [] },
            itemsShape: 'items',
            history: [{ role: 'user', text: 'Old' }],
            items: [{ id: 'reply', type: 'agentMessage', text: 'Reply' }],
          }
        : {},
  };
  withOutbox(runtime);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => undefined, drafts: fakeDraft('') })));
  await flush();
  await flush();
  const events = () => (globalThis as any).__scrollEvents;
  const arrow = () => host.querySelector('button[aria-label="Jump to the latest message"]');
  perf.start();
  const before = perf.report().renders.Thread ?? 0;
  await act(async () => events().onLayout({ nativeEvent: { layout: { height: 700, width: 400 } } }));
  await act(async () => events().onContentSizeChange(400, 3000));
  await act(async () => events().onContentSizeChange(400, 3400));
  assert.equal(arrow(), null, 'at the end: no arrow');
  await act(async () => events().onScroll(report(2700, 3400, 700)));
  // the reader scrolls up, far from the end: the arrow shows, without the screen drawing
  await act(async () => events().onScroll(report(300, 3400, 700)));
  assert.equal(arrow() !== null, true, 'scrolled far up: the arrow shows');
  await act(async () => events().onScroll(report(2700, 3400, 700)));
  assert.equal(arrow(), null, 'back at the end: the arrow goes');
  assert.equal((perf.report().renders.Thread ?? 0) - before, 0, 'no render of the chat screen for any of those reports');
  await act(async () => root.unmount());
});
