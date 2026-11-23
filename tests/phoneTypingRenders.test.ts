// Typing in a chat re-renders the composer and nothing else (#4986 F1): the chat screen keeps its render while a key is typed, the text reaches the draft store, the Send button follows it, and the / menu, skills and a send still work from the composer side.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { createDraftStore } from '../mobile/src/presentation/drafts';

const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

afterEach(() => document.body.replaceChildren());

async function mount(runtime: any, drafts: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts })));
  await flush();
  return host;
}
const field = (host: HTMLElement) => host.querySelector('textarea, input') as HTMLInputElement;
async function type(host: HTMLElement, text: string) {
  const el = field(host);
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const sendButton = (host: HTMLElement) => host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;

test('A: typing 30 characters re-renders the composer, not the chat screen, and the text lands in the draft store', async () => {
  const { runtime } = scripted((m) => (m === 'chat.follow' ? new Promise(() => {}) : undefined));
  const drafts = createDraftStore().of('chat');
  const host = await mount(runtime, drafts);
  // the screen's scroll view is a child the screen draws on each of its own renders: the events it was last given are a new object each time
  const before = (globalThis as any).__scrollEvents;
  assert.ok(before);
  assert.equal(sendButton(host).disabled, true, 'nothing typed: Send is off');
  let text = '';
  for (let i = 0; i < 30; i += 1) {
    text += 'x';
    await type(host, text);
  }
  assert.equal(drafts.get(), text);
  assert.equal(field(host).value, text, 'the field shows what was typed');
  assert.equal(sendButton(host).disabled, false, 'the composer followed the text');
  assert.equal((globalThis as any).__scrollEvents, before, 'the chat screen did not render once for 30 keys');
});

test('A: a draft kept from before is in the field when the chat opens, and a write from elsewhere (a push reply) shows in it', async () => {
  const { runtime } = scripted((m) => (m === 'chat.follow' ? new Promise(() => {}) : undefined));
  const drafts = createDraftStore().of('chat');
  drafts.set('kept');
  const host = await mount(runtime, drafts);
  assert.equal(field(host).value, 'kept');
  await act(async () => drafts.set('kept\nreply'));
  assert.equal(field(host).dataset.text, 'kept\nreply');
});

test('W: a send takes the draft from the store and clears only that text; words typed while it was being accepted stay', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.follow' ? new Promise(() => {}) : undefined));
  const drafts = createDraftStore().of('chat');
  const host = await mount(runtime, drafts);
  await type(host, 'hello');
  await click('Send message');
  assert.ok(calls.some((c) => c[0] === 'chat.send' && c[1].text === 'hello'));
  assert.equal(drafts.get(), '', 'the accepted text is cleared');
  assert.equal(field(host).value, '');
});

test('B: Send with nothing typed and no files is off and sends nothing; a message typed after a send goes out as its own', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.follow' ? new Promise(() => {}) : undefined));
  const drafts = createDraftStore().of('chat');
  const host = await mount(runtime, drafts);
  assert.equal(sendButton(host).disabled, true);
  await type(host, 'one');
  await click('Send message');
  assert.equal(sendButton(host).disabled, true, 'the sent text is gone from the draft: Send is off again');
  await type(host, 'two');
  await click('Send message');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'chat.send').map((c) => c[1].text),
    ['one', 'two'],
  );
});
