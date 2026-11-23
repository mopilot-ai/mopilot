// A chat open while the phone catches up with the computer shows its whole transcript afterwards: the computer is brought back, the chat is read again from the computer, and the rows that arrived inside the gap are there once each, in order, with none doubled and none missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fakeDraft } from './support/phone/drafts';
import { withOutbox } from './support/phone/outbox-kit';
const threadScreenPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadScreenPath);

const row = (role: string, text: string) => ({ role, text });
const count = (host: HTMLElement, text: string) => host.textContent!.split(text).length - 1;

test('rows that arrived inside the gap are read back once each, in order, after the catch-up', async () => {
  let transcript = [row('user', 'alpha question'), row('assistant', 'beta answer')];
  const reads: number[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method !== 'chat.follow') return {};
      reads.push(transcript.length);
      return { rev: 1, feedSeq: transcript.length, session: { turn: 'completed', cards: [] }, itemsShape: 'rows', items: transcript };
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (offline: boolean) =>
    act(async () =>
      root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, subtitle: 'Codex', drafts: fakeDraft(''), offline })),
    );
  await draw(false);
  await flush();
  assert.equal(count(host, 'alpha question'), 1);
  assert.equal(count(host, 'beta answer'), 1);
  assert.equal(reads.length, 1);
  // the gap: the computer is away from this phone's view while its counters are walked forward; frames inside it are never seen
  await draw(true);
  await flush();
  assert.equal(reads.length, 1, 'nothing is followed while the computer is away');
  transcript = [...transcript, row('user', 'gamma in the gap'), row('assistant', 'delta in the gap')];
  // the catch-up is done: the computer is back and the chat is read again from the start
  await draw(false);
  await flush();
  assert.equal(reads.length, 2, 'read again once');
  for (const text of ['alpha question', 'beta answer', 'gamma in the gap', 'delta in the gap'])
    assert.equal(count(host, text), 1, `${text} once`);
  const order = ['alpha question', 'beta answer', 'gamma in the gap', 'delta in the gap'].map((t) => host.textContent!.indexOf(t));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'in order, with no hole',
  );
  await act(async () => root.unmount());
  host.remove();
});
