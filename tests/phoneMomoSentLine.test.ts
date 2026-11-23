// MoMo's page keeps the person's sent line from the tap until the chat records it, retries and cancels it like any outbox message, and never draws it twice (#4821).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { hello, momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const base = (extra: Record<string, any> = {}) => ({
  'machine.hello': () => hello(true),
  'momo.brain.get': () => ({ brain: null }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.chat.follow': () => snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Good morning' }]),
  'momo.chat.unfollow': () => ({}),
  'momo.chat.send': () => ({}),
  ...extra,
});
const once = (view: { text: () => string }, word: string) => view.text().split(word).length - 1;
const record = (text: string) => ({
  kind: 'event',
  chatId: 'main',
  ev: 'items.append',
  items: [{ id: `u-${text}`, type: 'userMessage', content: [{ type: 'text', text }] }],
});

test('the line stays through a refusal, Retry and the Mac taking it, and goes only when the chat records it', async () => {
  let refuse = true;
  const m = momoRuntime(base({ 'momo.chat.send': () => (refuse ? Promise.reject(new Error('Mac is busy')) : {}) }));
  const view = await mountMomo(m);
  await inputText('Ask MoMo anything', 'plan my day');
  await click('Send');
  await flush();
  assert.equal(once(view, 'plan my day'), 1);
  assert.match(view.text(), /Not sent: Mac is busy/);
  refuse = false;
  await click('Retry');
  await flush();
  assert.equal(once(view, 'plan my day'), 1, 'taken after the retry: kept, once');
  assert.doesNotMatch(view.text(), /Not sent/);
  await act(async () => m.emit(record('plan my day')));
  assert.equal(once(view, 'plan my day'), 1, 'recorded: the chat row, once');
  await view.unmount();
});

test('the same words sent twice keep two lines until each has its own record', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  for (let i = 0; i < 2; i++) {
    await inputText('Ask MoMo anything', 'again');
    await click('Send');
    await flush();
  }
  assert.equal(once(view, 'again'), 2);
  await act(async () => m.emit(record('again')));
  assert.equal(once(view, 'again'), 2, 'one recorded, one still waiting for its record');
  await view.unmount();
});

test('cancelling a refused message forgets it, and a cancel the runtime refuses keeps it', async () => {
  const m = momoRuntime(base({ 'momo.chat.send': () => Promise.reject(new Error('Mac is busy')) }));
  const view = await mountMomo(m);
  await inputText('Ask MoMo anything', 'for later');
  await click('Send');
  await flush();
  assert.equal(once(view, 'for later'), 1);
  const cancel = m.runtime.cancelSend;
  m.runtime.cancelSend = () => false;
  await click('Cancel this message');
  assert.equal(once(view, 'for later'), 1, 'the runtime kept it, so does the page');
  m.runtime.cancelSend = cancel;
  await click('Cancel this message');
  assert.equal(once(view, 'for later'), 0, 'no ghost line left behind');
  await view.unmount();
});

test('an edited waiting message is kept under its new words, and an edit the runtime refuses leaves it as it was', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  const waiting = {
    id: 'q-1',
    pairId: 'p',
    chatId: 'momo',
    text: 'first words',
    attachments: [],
    at: 1,
    momo: true,
    status: 'queued',
    error: null,
  };
  await act(async () => m.set({ outbox: [waiting] }));
  await click('Edit this message');
  m.runtime.editSend = () => false;
  await click('Save this message');
  assert.ok(document.querySelector('[aria-label="Save this message"]'), 'refused: still editing');
  m.runtime.editSend = () => true;
  await click('Save this message');
  assert.ok(!document.querySelector('[aria-label="Save this message"]'), 'accepted: the edit closes');
  await view.unmount();
});

test('another computer starts with no kept lines of the first', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  await inputText('Ask MoMo anything', 'to the first');
  await click('Send');
  await flush();
  assert.equal(once(view, 'to the first'), 1);
  await act(async () => m.set({ selectedPair: 'other', pairs: [{ pairId: 'other', macId: 'o' }] }));
  await flush();
  assert.equal(once(view, 'to the first'), 0);
  await view.unmount();
});
