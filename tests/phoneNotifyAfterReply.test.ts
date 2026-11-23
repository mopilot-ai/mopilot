// The one question about notifications is asked at the end of a finished reply (#5320): not before the first reply, not while a turn runs, and only while the phone has not been asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const routePath = '../mobile/src/screens/ChatRoute';
const { ChatRoute } = await import(routePath);

const mounted: any[] = [];
async function mount(items: object[], turn: string, push: any, pushUi: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1, outbox: [] }),
    subscribe: () => () => {},
    onEvent: () => () => {},
    request: async (method: string) =>
      method === 'chat.follow' ? { rev: 1, feedSeq: 0, session: { turn, cards: [] }, itemsShape: 'rows', items } : {},
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(createElement(ChatRoute, { pair: 'p', runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(''), push, pushUi })),
  );
  await flush();
  return host;
}
const REPLIED = [
  { role: 'user', text: 'Hello' },
  { role: 'assistant', text: 'Hi there.' },
];
const calls: string[] = [];
const push: any = { accept: async () => void calls.push('accept'), later: async () => void calls.push('later') };
const ask = { step: 'explain', busy: false };
const has = (host: HTMLElement) => /Know when a chat needs you/.test(host.textContent!);

test('after a finished reply the card asks, and Turn on notifications and Not now reach the push controller', async () => {
  calls.length = 0;
  const host = await mount(REPLIED, 'idle', push, ask);
  assert.ok(has(host));
  await click('Turn on notifications');
  await click('Not now');
  assert.deepEqual(calls, ['accept', 'later']);
});

test('not before there is a reply, and not while a turn runs', async () => {
  assert.equal(has(await mount([{ role: 'user', text: 'Hello' }], 'idle', push, ask)), false, 'a message nobody answered yet');
  assert.equal(has(await mount(REPLIED, 'running', push, ask)), false, 'the reply is still being written');
});

test('only while the phone has not been asked: later, granted, blocked, unknown and no push at all stay quiet', async () => {
  for (const step of ['later', 'granted', 'blocked', 'unknown'])
    assert.equal(has(await mount(REPLIED, 'idle', push, { step, busy: false })), false, step);
  assert.equal(has(await mount(REPLIED, 'idle', undefined, undefined)), false, 'a build without push');
  assert.equal(has(await mount(REPLIED, 'idle', push, undefined)), false, 'push whose state has not arrived');
});

test("the card scrolls with the transcript: it is part of the scrolling content, never a fixed block that takes the reader's room (#5351)", async () => {
  const host = await mount(REPLIED, 'idle', push, ask);
  const scrollers = [...host.querySelectorAll('[data-scrollview]')].filter((s) => s.getAttribute('data-horizontal') !== 'true');
  const transcript = scrollers.find((s) => /Hi there\./.test(s.textContent ?? ''));
  assert.ok(transcript, 'the chat has its scrolling transcript');
  assert.match(transcript.textContent!, /Know when a chat needs you/, 'the card is inside it: it scrolls away like a message');
  const turnLine = host.textContent!.indexOf('Hi there.');
  assert.ok(turnLine >= 0 && host.textContent!.indexOf('Know when a chat needs you') > turnLine, 'and it comes after the reply');
});
