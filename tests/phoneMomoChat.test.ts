// The MoMo tab's chat, Needs you and brain chip, plus its setup, offline and revoked states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { fakeCache, hello, momoRuntime, mountMomo, snapshotOf, openPart } from './support/phone/momo-kit';

const card = (over: any = {}) => ({
  id: 'k1',
  rev: 1,
  title: 'Send the email?',
  choices: [
    { key: 'allow', label: 'Allow' },
    { key: 'deny', label: 'Deny' },
  ],
  ...over,
});
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
const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name);

test('chat follows MoMo main chat, streams, sends under one id (kept and retried when refused), and stops', async () => {
  let fail = true;
  const m = momoRuntime(base({ 'momo.chat.send': () => (fail ? Promise.reject(new Error('Mac is busy')) : {}) }));
  const view = await mountMomo(m);
  assert.match(view.text(), /Good morning/);
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.chat.follow')![1], { items: 50 });
  await act(async () =>
    m.emit({ kind: 'event', chatId: 'main', ev: 'items.delta', feedSeq: 1, live: true, itemId: 'm1', field: 'text', text: ' friend' }),
  );
  // the shared reply renderer reveals what arrives in paced steps, holding the last word until the reply pauses (1 s), as in every other chat
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1300)));
  assert.match(view.text(), /Good morning friend/);
  await act(async () =>
    m.emit({ kind: 'event', chatId: 'other', ev: 'items.delta', feedSeq: 1, live: true, itemId: 'm1', field: 'text', text: ' STRANGER' }),
  );
  assert.doesNotMatch(view.text(), /STRANGER/);
  assert.equal(buttonNamed('Send')!.disabled, true);
  await inputText('Ask MoMo anything', 'plan my day');
  await click('Send');
  await flush();
  // the message stays in the chat as not sent, and the field is free
  assert.match(view.text(), /Not sent: Mac is busy/);
  assert.equal((document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement).value, '');
  fail = false;
  await click('Retry');
  await flush();
  assert.equal((document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement).value, '');
  const sends = m.calls.filter(([method]) => method === 'momo.chat.send').map(([, p]) => p);
  assert.equal(sends.at(-1).text, 'plan my day');
  assert.equal(sends[0].id, sends.at(-1).id);
  // Stop takes the send's place while MoMo works
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 2, patch: { turn: 'running' } }));
  assert.equal(buttonNamed('Send'), undefined);
  await click('Stop');
  assert.equal(m.count('momo.chat.stop'), 1);
  await click('Back');
  assert.equal(view.seen.back, 1);
  await view.unmount();
  assert.equal(m.count('momo.chat.unfollow'), 1);
});

test('an empty draft is not sent and an empty chat says so', async () => {
  const m = momoRuntime(base({ 'momo.chat.follow': () => snapshotOf() }));
  const view = await mountMomo(m);
  assert.match(view.text(), /No messages yet/);
  await inputText('Ask MoMo anything', '   ');
  assert.equal(buttonNamed('Send')!.disabled, true);
  await view.unmount();
});

test('a follow that fails offers a refresh, and a flood of events while loading reads the chat again', async () => {
  let attempt = 0;
  const m = momoRuntime(base({ 'momo.chat.follow': () => (++attempt === 1 ? Promise.reject(new Error('follow failed')) : snapshotOf()) }));
  const view = await mountMomo(m);
  assert.match(view.text(), /follow failed/);
  await click('Retry');
  assert.doesNotMatch(view.text(), /follow failed/);
  await view.unmount();

  let release: (v: unknown) => void = () => {};
  const flood = momoRuntime(base({ 'momo.chat.follow': () => new Promise((resolve) => (release = resolve)) }));
  const loading = await mountMomo(flood);
  assert.match(loading.text(), /Loading MoMo/);
  await act(async () => {
    for (let i = 0; i < 1001; i++) flood.emit({ kind: 'event', chatId: 'main', ev: 'items.delta', itemId: 'x', field: 'text', text: 'a' });
    flood.emit({ kind: 'event', chatId: 'main', ev: 'items.delta', itemId: 'x', field: 'text', text: 'b' });
  });
  // no notice: the chat is read again from a newer snapshot once the first is back
  assert.doesNotMatch(loading.text(), /changed too quickly|Refresh chat/);
  await act(async () => release(snapshotOf()));
  await flush();
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
  assert.equal(flood.count('momo.chat.follow'), 2);
  await loading.unmount();
});

test('a live event that cannot be applied is shown and the thread stays readable', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'items.delta', itemId: 'm1', field: 'text', text: 7 }));
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', feedSeq: 'x' }));
  assert.match(view.text(), /Good morning/);
  await view.unmount();
});

test('Needs you answers a card by key, marks answered-on-Mac ones and sends desktop-only ones to the Mac', async () => {
  const m = momoRuntime(
    base({
      'momo.chat.follow': () =>
        snapshotOf([
          card(),
          card({ id: 'k2', title: 'Pick a time', choices: [{ key: 'ok', label: 'OK' }] }),
          card({ id: 'k3', title: 'Allow calendar', inApp: true }),
        ]),
    }),
  );
  const view = await mountMomo(m);
  // the pill counts what can be answered here; a card only the Mac can finish is in the chat but not counted
  assert.match(view.text(), /2 need you/);
  await click('2 need you');
  assert.match(view.text(), /Send the email\?/);
  assert.match(view.text(), /Allow calendar[\s\S]*Finish on your Mac/);
  await click('Allow');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.card.answer')![1], { cardId: 'k1', rev: 1, key: 'allow' });
  // the Mac closes the other card (someone answered it there) while this phone's answer is not what closed it
  await act(async () =>
    m.emit({
      kind: 'event',
      chatId: 'main',
      ev: 'session.patch',
      rev: 2,
      feedSeq: 1,
      patch: { cards: [card({ id: 'k3', title: 'Allow calendar', inApp: true })] },
    }),
  );
  assert.match(view.text(), /Pick a time[\s\S]*Answered on your Mac/);
  assert.doesNotMatch(view.text(), /Send the email\?[\s\S]*Answered on your Mac/);
  await view.unmount();
});

test('an answer the Mac refuses stays on the card and nothing is claimed answered', async () => {
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => snapshotOf([card()]),
      'momo.card.answer': () => Promise.reject(new Error('That request was already answered.')),
    }),
  );
  const view = await mountMomo(m);
  await openPart('Needs you');
  await click('Deny');
  assert.match(view.text(), /already answered/);
  assert.doesNotMatch(view.text(), /Answered on your Mac/);
  await view.unmount();
});

test('with nothing waiting there is no needs-you pill', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  assert.doesNotMatch(view.text(), /needs? you/);
  await view.unmount();
});

test('a failed follow is one state: the Mac’s message and Retry, never loading or a hint beside them, and Retry recovers', async () => {
  let attempt = 0;
  const m = momoRuntime(
    base({
      'momo.sources.status': () => ({ calendar: false, reminders: false }),
      'momo.chat.follow': () => (++attempt === 1 ? Promise.reject(new Error('No harness can run MoMo now.')) : snapshotOf()),
    }),
  );
  const view = await mountMomo(m);
  assert.match(view.text(), /No harness can run MoMo now\./);
  assert.ok(buttonNamed('Retry'));
  assert.doesNotMatch(view.text(), /Loading MoMo|finish setup|Connect Calendar/);
  await click('Retry');
  assert.doesNotMatch(view.text(), /No harness can run MoMo now|Loading MoMo/);
  assert.equal(buttonNamed('Retry'), undefined);
  assert.match(view.text(), /No messages yet/);
  assert.match(view.text(), /Connect Calendar and Reminders/);
  await view.unmount();
});

test('the Brain sheet names the chosen model, is absent when none is chosen, and is read-only', async () => {
  const none = momoRuntime(base({ 'momo.brain.get': () => ({ brain: null }) }));
  const empty = await mountMomo(none);
  await click('More');
  assert.equal(buttonNamed('Brain'), undefined);
  await empty.unmount();

  let label = 'Sage brain';
  const m = momoRuntime(base({ 'momo.brain.get': () => ({ brain: { harness: 'claude', model: 'm', modelLabel: label } }) }));
  const view = await mountMomo(m);
  await openPart('Brain');
  assert.match(view.text(), /ModelSage brain/);
  assert.equal(buttonNamed('Brain: Sage brain'), undefined);
  assert.equal(buttonNamed('Use this brain'), undefined, 'this Mac does not let the phone change it');
  label = 'Other brain';
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'brain' }));
  await flush();
  assert.match(view.text(), /ModelOther brain/);
  await view.unmount();
});

test('with the Mac away the composer says so and keeps the draft; Send still queues it for the Mac', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  await inputText('Ask MoMo anything', 'later');
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await flush();
  assert.match(view.text(), /asleep or offline/);
  assert.equal((document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement).value, 'later');
  assert.equal(buttonNamed('Send')!.disabled, false);
  await view.unmount();
});

test('a failed request that finds MoMo no longer allowed clears the saved memory and leaves the tab', async () => {
  let allowed = true;
  const cache = fakeCache();
  await cache.save(JSON.stringify(['u', 'p']), { facts: [{ id: '1', text: 'x' }], docs: null });
  const m = momoRuntime(
    base({
      'machine.hello': () => hello(allowed),
      'momo.chat.send': () => Promise.reject(new Error('MoMo is not available for this account.')),
    }),
  );
  const view = await mountMomo(m, Promise.resolve(cache));
  allowed = false;
  await inputText('Ask MoMo anything', 'hi');
  await click('Send');
  await flush();
  assert.equal(view.seen.back, 1);
  assert.equal(cache.raw(), null);
  await view.unmount();
});

test('a failure while MoMo is still allowed keeps the tab and the copy, and a check that fails changes nothing', async () => {
  const cache = fakeCache();
  await cache.save('s', { facts: [], docs: null });
  const m = momoRuntime(base({ 'momo.chat.send': () => Promise.reject(new Error('boom')) }));
  const view = await mountMomo(m, Promise.resolve(cache));
  await inputText('Ask MoMo anything', 'hi');
  await click('Send');
  await flush();
  assert.equal(view.seen.back, 0);
  assert.notEqual(cache.raw(), null);
  await view.unmount();

  const n = momoRuntime(base({ 'momo.chat.send': () => Promise.reject(new Error('boom')) }));
  const second = await mountMomo(n, Promise.resolve(cache));
  n.set({ generation: 9 });
  await inputText('Ask MoMo anything', 'hi');
  let recheck = 0;
  n.runtime.request = async (method: string) => {
    if (method === 'machine.hello') recheck++;
    throw new Error('down');
  };
  await click('Send');
  await flush();
  assert.equal(recheck, 1);
  assert.equal(second.seen.back, 0);
  await second.unmount();

  // allowed turns false only after the computer changed: that answer is about another computer and is dropped
  let allowed = true;
  const o = momoRuntime(
    base({
      'machine.hello': () => new Promise((resolve) => setImmediate(() => resolve(hello(allowed)))),
      'momo.chat.send': () => Promise.reject(new Error('boom')),
    }),
  );
  const third = await mountMomo(o, Promise.resolve(cache));
  await inputText('Ask MoMo anything', 'hi');
  await click('Send');
  allowed = false;
  o.set({ generation: 4 });
  await flush();
  assert.equal(third.seen.back, 0);
  await third.unmount();
});

test('events that arrive while the snapshot loads are applied to it, and a follow that fails late or with plain text is handled', async () => {
  let release: (v: unknown) => void = () => {};
  const m = momoRuntime(base({ 'momo.chat.follow': () => new Promise((resolve) => (release = resolve)) }));
  const view = await mountMomo(m);
  await act(async () =>
    m.emit({ kind: 'event', chatId: 'main', ev: 'items.delta', feedSeq: 1, live: true, itemId: 'm1', field: 'text', text: ' early' }),
  );
  await act(async () => release(snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Hello' }])));
  await flush();
  assert.match(view.text(), /Hello early/);
  await view.unmount();

  let reject: (e: unknown) => void = () => {};
  const late = momoRuntime(base({ 'momo.chat.follow': () => new Promise((_, r) => (reject = r)) }));
  const gone = await mountMomo(late);
  await gone.unmount();
  await act(async () => reject(new Error('after close')));

  const plain = momoRuntime(base({ 'momo.chat.follow': () => Promise.reject('plain text failure') }));
  const text = await mountMomo(plain);
  assert.match(text.text(), /plain text failure/);
  await text.unmount();
});

test('a message sent from the Mac while the phone is open shows as live, and a failure that is plain text is shown', async () => {
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => snapshotOf([], [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'From the Mac' }] }]),
      'momo.chat.stop': () => Promise.reject('stop refused'),
    }),
  );
  const view = await mountMomo(m);
  assert.match(view.text(), /You[\s\S]*From the Mac|From the Mac/);
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 2, patch: { turn: 'running' } }));
  await click('Stop');
  assert.match(view.text(), /stop refused/);
  await view.unmount();
});

test('typing a draft does not read the brain or routines again', async () => {
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  const before = [m.count('momo.brain.get'), m.count('momo.routines.list')];
  for (const text of ['a', 'ab', 'abc']) await inputText('Ask MoMo anything', text);
  await flush();
  assert.deepEqual([m.count('momo.brain.get'), m.count('momo.routines.list')], before);
  await view.unmount();
});

test('a card the Mac closes while another tab is open is still noted when Needs you opens', async () => {
  const m = momoRuntime(base({ 'momo.chat.follow': () => snapshotOf([card()]) }));
  const view = await mountMomo(m);
  await openPart('Memory');
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 2, feedSeq: 1, patch: { cards: [] } }));
  await openPart('Needs you');
  assert.match(view.text(), /Send the email\?[\s\S]*Answered on your Mac/);
  await view.unmount();
});

test('only the chat the snapshot names is MoMo, whether its events come before or after the snapshot', async () => {
  let release: (v: unknown) => void = () => {};
  const m = momoRuntime(base({ 'momo.chat.follow': () => new Promise((resolve) => (release = resolve)) }));
  const view = await mountMomo(m);
  await act(async () =>
    m.emit({ kind: 'event', chatId: 'other', ev: 'items.delta', feedSeq: 1, live: true, itemId: 'm1', field: 'text', text: ' STRANGER' }),
  );
  await act(async () =>
    m.emit({ kind: 'event', chatId: 'main', ev: 'items.delta', feedSeq: 1, live: true, itemId: 'm1', field: 'text', text: ' mine' }),
  );
  await act(async () => release(snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Hi' }])));
  await flush();
  assert.match(view.text(), /Hi mine/);
  assert.doesNotMatch(view.text(), /STRANGER/);
  await act(async () =>
    m.emit({ kind: 'event', chatId: 'other', ev: 'items.delta', feedSeq: 2, live: true, itemId: 'm1', field: 'text', text: ' LATER' }),
  );
  assert.doesNotMatch(view.text(), /LATER/);
  await view.unmount();
});

test('a snapshot that does not name its chat is refused', async () => {
  for (const chatId of [null, '', 7]) {
    const n = momoRuntime(base({ 'momo.chat.follow': () => snapshotOf([], [], chatId) }));
    const v = await mountMomo(n);
    assert.match(v.text(), /Couldn't read MoMo's chat/);
    await v.unmount();
  }
  const none = momoRuntime(base({ 'momo.chat.follow': () => null }));
  const empty = await mountMomo(none);
  assert.match(empty.text(), /Couldn't read MoMo's chat/);
  await empty.unmount();
});

/** An event right after another is shown when the feed's frame window ends: the test waits that out (see followFeed's FRAME_MS). */
const frameWindow = () => act(async () => new Promise((resolve) => setTimeout(resolve, 24)));

test('a card this phone answered is not called "answered on your Mac" when the Mac takes it away before the reply arrives; a refused answer leaves it unmarked', async () => {
  let release: (v: unknown) => void = () => {};
  let refuse = false;
  const m = momoRuntime(
    base({
      'momo.chat.follow': () => snapshotOf([card(), card({ id: 'k2', title: 'Pick a time', choices: [{ key: 'ok', label: 'OK' }] })]),
      'momo.card.answer': () =>
        refuse ? Promise.reject(new Error('That request was already answered.')) : new Promise((r) => (release = r)),
    }),
  );
  const view = await mountMomo(m);
  await click('2 need you');
  await click('Allow');
  // the Mac's update removes the answered card first; the reply is still on its way
  await act(async () =>
    m.emit({
      kind: 'event',
      chatId: 'main',
      ev: 'session.patch',
      rev: 2,
      feedSeq: 1,
      patch: { cards: [card({ id: 'k2', title: 'Pick a time', choices: [{ key: 'ok', label: 'OK' }] })] },
    }),
  );
  await frameWindow();
  await act(async () => release({}));
  await flush();
  assert.doesNotMatch(view.text(), /Answered on your Mac/);
  // a refused answer: the card stays, and when the Mac later closes it, that is the Mac's doing
  refuse = true;
  await click('OK');
  assert.match(view.text(), /already answered/);
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 3, feedSeq: 2, patch: { cards: [] } }));
  await frameWindow();
  assert.match(view.text(), /Pick a time · Answered on your Mac/);
  await view.unmount();
});

test('the chat opens at the newest message, follows growth, and a send keeps it in sight', async () => {
  const g = globalThis as any;
  g.__scrolledToEnd = [];
  const m = momoRuntime(base());
  const view = await mountMomo(m);
  // the native view reports the loaded content growing: it is followed to the end
  await act(async () => g.__scrollEvents.onContentSizeChange(0, 500));
  assert.ok(g.__scrolledToEnd.length > 0, 'opened at the end, not at the oldest message');
  const before = g.__scrolledToEnd.length;
  g.__scrolledTo = [];
  await inputText('Ask MoMo anything', 'hello');
  await click('Send');
  await act(async () => g.__scrollEvents.onContentSizeChange(0, 600));
  assert.equal(g.__scrolledToEnd.length, before, 'the reply is not followed');
  assert.equal(g.__scrolledTo.length, 1, 'the sent message is pinned under the top bar');
  await view.unmount();
});
