// A turn the phone joined while it was running still ends with the line that offers Copy reply and Retry; it just gives no time, because the phone did not see the turn start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';

import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

test('a reply with no steps, from a turn joined mid-run, ends with Worked, Copy reply and Retry and no time', async () => {
  let listener: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) =>
      method === 'chat.follow'
        ? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'running', cards: [] },
            itemsShape: 'rows',
            items: [
              { role: 'user', text: 'Write a haiku.' },
              { role: 'assistant', text: 'Quiet morning code.' },
            ],
          }
        : {},
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  assert.equal(host.querySelector('button[aria-label="Retry"]'), null, 'no end line while the turn runs');
  await act(async () => listener({ kind: 'event', chatId: 'c', ev: 'session.patch', rev: 2, patch: { turn: 'idle' } }));
  await flush();
  assert.match(host.textContent!, /Worked/);
  assert.doesNotMatch(host.textContent!, /Worked \d|Worked for/, 'no time: it did not see the turn start');
  assert.ok(host.querySelector('button[aria-label="Copy reply"]'));
  assert.ok(host.querySelector('button[aria-label="Retry"]'), 'Retry is offered');
  await act(async () => root.unmount());
  host.remove();
});

test('a chat opened with its turn already over has no end line to show', async () => {
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) =>
      method === 'chat.follow'
        ? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'idle', cards: [] },
            itemsShape: 'rows',
            items: [
              { role: 'user', text: 'Hi' },
              { role: 'assistant', text: 'Hello.' },
            ],
          }
        : {},
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  assert.equal(host.querySelector('button[aria-label="Retry"]'), null);
  await act(async () => root.unmount());
  host.remove();
});

test('the end line stays in place when the turn ends: it is not taken away for a commit and drawn again (a 44 pt dip of the chat at the end of every reply, #4826)', async () => {
  let listener: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) =>
      method === 'chat.follow'
        ? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'running', cards: [] },
            itemsShape: 'rows',
            items: [
              { role: 'user', text: 'Write a haiku.' },
              { role: 'assistant', text: 'Quiet morning code.' },
            ],
          }
        : {},
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const working = host.querySelector('[aria-label="Responding"]');
  assert.ok(working, 'the working line is drawn while the turn runs');
  // every commit's mutations: the line's element must never leave the page, or the transcript is a line shorter for a frame
  const removed: string[] = [];
  const watch = new MutationObserver((records) => {
    for (const r of records) for (const n of r.removedNodes) if (n === working || (n as Element).contains?.(working)) removed.push('line');
  });
  watch.observe(host, { childList: true, subtree: true });
  await act(async () => listener({ kind: 'event', chatId: 'c', ev: 'session.patch', rev: 2, patch: { turn: 'idle' } }));
  await flush();
  watch.disconnect();
  assert.deepEqual(removed, [], 'the line stays mounted from the turn running to the turn ended');
  assert.match(host.textContent!, /Worked/);
  await act(async () => root.unmount());
  host.remove();
});
