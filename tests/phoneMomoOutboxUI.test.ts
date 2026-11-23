// MoMo queue UI retains local input across slow sends, refusals, offline transitions and navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { hello, momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name);

const base = (extra: Record<string, any> = {}) => ({
  'machine.hello': () => hello(true),
  'momo.brain.get': () => ({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'Sage brain' } }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.chat.follow': () => snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Good morning' }]),
  'momo.chat.unfollow': () => ({}),
  'momo.chat.send': () => ({}),
  'momo.chat.stop': () => ({}),
  'momo.card.answer': () => ({}),
  ...extra,
});
test('a sent message shows at once and clears the draft, waits in the queue while the Mac is slow, and a refusal keeps it with Retry and Cancel', async () => {
  let release: (v?: unknown) => void = () => {};
  let refuse = false;
  const m = momoRuntime(
    base({ 'momo.chat.send': () => (refuse ? Promise.reject(new Error('Mac is busy')) : new Promise((r) => (release = r))) }),
  );
  const view = await mountMomo(m);
  await inputText('Ask MoMo anything', 'plan my day');
  await click('Send');
  // the Mac has not answered: the bubble is there and the field is empty
  assert.match(view.text(), /plan my day/);
  assert.equal((document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement).value, '');
  await act(async () => release({}));
  await flush();
  const once = (word: string) => view.text().split(word).length - 1;
  assert.equal(once('plan my day'), 1, 'taken by the Mac: the line stays, once, until the chat records it (#4821)');
  assert.doesNotMatch(view.text(), /Sends when|Sending…/, 'and it no longer reads as queued');
  await act(async () =>
    m.emit({
      kind: 'event',
      chatId: 'main',
      ev: 'items.append',
      items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'plan my day' }] }],
    }),
  );
  assert.equal(once('plan my day'), 1, 'the Mac recorded it: the chat row replaces the kept line, never twice');
  refuse = true;
  await inputText('Ask MoMo anything', 'second try');
  await click('Send');
  await flush();
  assert.match(view.text(), /second try/);
  assert.match(view.text(), /Not sent: Mac is busy/);
  await click('Cancel');
  assert.doesNotMatch(view.text(), /second try/);
  await view.unmount();
});

test('with the Mac away a message can still be typed and waits for it; a full queue says so and keeps the draft', async () => {
  const m = momoRuntime(base(), { phase: 'offline' });
  const view = await mountMomo(m);
  assert.equal(buttonNamed('Send')!.disabled, true, 'nothing typed yet');
  await inputText('Ask MoMo anything', 'for later');
  assert.equal(buttonNamed('Send')!.disabled, false, 'typing is not held up by the Mac being away');
  m.runtime.send = () => {
    throw new Error('Too many messages are waiting.');
  };
  await click('Send');
  assert.match(view.text(), /Too many messages are waiting/);
  assert.equal((document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement).value, 'for later');
  await view.unmount();
});

test('disconnect retains the original pair’s failed MoMo message beside a newer draft and across navigation', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  await inputText('Ask MoMo anything', 'new draft');
  const failed = {
    id: 'queued-momo-1',
    pairId: 'p',
    chatId: 'momo',
    text: 'original words',
    attachments: [],
    at: 1,
    momo: true,
    status: 'failed',
    error: 'Not accepted',
  };
  await act(async () =>
    m.set({
      phase: 'offline',
      selectedPair: null,
      generation: 2,
      outbox: [failed, { ...failed, id: 'foreign', pairId: 'other', text: 'foreign words' }],
    }),
  );
  assert.match(view.text(), /original words/);
  assert.match(view.text(), /Not accepted/);
  assert.doesNotMatch(view.text(), /foreign words/);
  assert.equal((document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement).value, 'new draft');
  await view.unmount();
  await act(async () => m.set({ selectedPair: 'p', phase: 'online' }));
  const reopened = await mountMomo(m);
  assert.match(reopened.text(), /original words/);
  await click('Cancel');
  assert.doesNotMatch(reopened.text(), /original words/);
  await reopened.unmount();
});

test('a message the Mac holds for a running turn stays on screen, without Cancel, and is not drawn twice while the outbox still has it', async () => {
  let release: (v?: unknown) => void = () => {};
  const queue = [
    { id: 'q1', text: 'second one', mine: true },
    { id: 'q2', text: "someone else's", mine: false },
  ];
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => ({
        ...snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Good morning' }]),
        session: { turn: 'running', cards: [], queue },
      }),
      'momo.chat.send': () => new Promise((r) => (release = r)),
    }),
  );
  const view = await mountMomo(m);
  assert.match(view.text(), /second one/, 'the Mac holds it: it shows');
  assert.match(view.text(), /Sends when this turn ends/);
  assert.doesNotMatch(view.text(), /someone else's/);
  assert.equal(buttonNamed('Cancel this message'), undefined, 'MoMo has no call to take a queued message back');
  await view.unmount();
});

test('after a Stop the Mac keeps its queue on hold, and the same words in the outbox are drawn once', async () => {
  let release: (v?: unknown) => void = () => {};
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => ({
        ...snapshotOf(),
        session: { turn: 'idle', cards: [], queue: [{ id: 'q1', text: 'second one', mine: true }] },
      }),
      'momo.chat.send': () => new Promise((r) => (release = r)),
    }),
  );
  const view = await mountMomo(m);
  assert.match(view.text(), /On hold after Stop/);
  await inputText('Ask MoMo anything', 'second one');
  await click('Send');
  assert.equal(view.text().split('second one').length - 1, 1, 'one bubble, from the outbox');
  await act(async () => release({}));
  await view.unmount();
});

test('a turn that waits for your answer is still open: its queued message says it sends after the turn, not on hold', async () => {
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => ({
        ...snapshotOf(),
        session: { turn: 'awaitingUser', cards: [], queue: [{ id: 'q1', text: 'second one', mine: true }] },
      }),
    }),
  );
  const view = await mountMomo(m);
  assert.match(view.text(), /Sends when this turn ends/);
  assert.doesNotMatch(view.text(), /On hold after Stop/);
  await view.unmount();
});

test('while a turn waits for your answer the composer shows what the main chat shows: Stop with nothing typed, Send plus a smaller Stop with a message typed', async () => {
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => ({ ...snapshotOf(), session: { turn: 'awaitingUser', cards: [], queue: [] } }),
    }),
  );
  const view = await mountMomo(m);
  assert.ok(buttonNamed('Stop'), 'nothing typed: Stop');
  assert.equal(buttonNamed('Send'), undefined, 'and no Send');
  await inputText('Ask MoMo anything', 'a follow-up');
  assert.ok(buttonNamed('Send'), 'a typed message can be sent (it queues behind the turn)');
  assert.ok(buttonNamed('Stop'), 'and Stop stays beside it');
  assert.equal(buttonNamed('Send')!.disabled, false);
  await click('Send');
  assert.equal(m.count('momo.chat.send'), 1);
  await view.unmount();
});
