// "Not confirmed" instead of success or failure: a stop or answer in flight as the connection went, a send whose fate is unknown, and a queued message edited in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { hello, momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';
import { createOutbox, isUnconfirmed, restoreItems, sendActions, sendLost, UNSURE, WAS_SENDING } from '../mobile/src/outbox';
import { lostInFlight, unconfirmedNotice } from '../mobile/src/remote/unconfirmed';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const queuedPath = '../mobile/src/components/QueuedMessages';
const { Thread } = await import(threadPath);
const { QueuedMessages, queueCalls } = await import(queuedPath);

test('only a request that left the phone and never came back counts as not confirmed', () => {
  for (const message of ['relay disconnected', 'relay acknowledgement timed out', 'Connection closed', 'Request timed out', 'Aborted'])
    assert.equal(lostInFlight(new Error(message)), true, message);
  const abort = new Error('x');
  abort.name = 'AbortError';
  assert.equal(lostInFlight(abort), true);
  for (const other of [new Error('Allow this from your Mac.'), new Error('Computer is offline'), 'relay disconnected', null])
    assert.equal(lostInFlight(other), false);
  // wording replaced by a screen keeps the original as its cause
  assert.equal(lostInFlight(new Error('Your computer is offline or asleep.', { cause: new Error('relay disconnected') })), true);
  assert.equal(lostInFlight(new Error('Your computer is offline or asleep.', { cause: new Error('Computer is offline') })), false);
  // a cause that leads back to itself ends instead of looping
  const loop: any = new Error('looping');
  loop.cause = loop;
  assert.equal(lostInFlight(loop), false);
  assert.deepEqual(unconfirmedNotice('stop'), { lead: 'Stop not confirmed.', text: 'Check the chat before trying again.' });
  assert.deepEqual(unconfirmedNotice('send'), { lead: 'Send not confirmed.', text: 'Check the chat before trying again.' });
  assert.deepEqual(unconfirmedNotice('answer'), { lead: 'Answer not confirmed.', text: 'Check the chat before trying again.' });
});

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}

async function thread(fail: (method: string) => Error | null) {
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'running', cards: [{ id: 'a', rev: 1, title: 'Run it?', choices: [{ key: 'yes', label: 'Yes' }] }] },
          itemsShape: 'rows',
          items: [],
        };
      const error = fail(method);
      if (error) throw error;
      return {};
    },
  };
  withOutbox(runtime);
  let draft = '';
  const render = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(draft, { set: (v: string) => (draft = v), clear: () => (draft = '') }),
    });
  const host = await mount(render());
  return { host, setDraft: (v: string) => (draft = v), render };
}

test('a stop in flight as the connection went says it is not confirmed, in a calm notice, and a later action clears it', async () => {
  let lost = true;
  const t = await thread(() => (lost ? new Error('relay disconnected') : null));
  await click('Stop');
  assert.match(t.host.textContent!, /Stop not confirmed\. Check the chat before trying again\./);
  assert.doesNotMatch(t.host.textContent!, /relay disconnected/, 'no raw error');
  lost = false;
  await click('Stop');
  assert.doesNotMatch(t.host.textContent!, /not confirmed/, 'trying again clears it');
});

test('an answer in flight as the connection went says it is not confirmed, the card stays answerable, and a new message clears the notice', async () => {
  const t = await thread((method) => (method === 'card.answer' ? new Error('relay acknowledgement timed out') : null));
  await click('Yes');
  assert.match(t.host.textContent!, /Answer not confirmed\. Check the chat before trying again\./);
  assert.ok([...t.host.querySelectorAll('button')].some((b) => b.textContent === 'Yes'));
  t.setDraft('Go on');
  await mount(t.render());
  await click('Send');
  assert.doesNotMatch(t.host.textContent!, /not confirmed/);
});

test('a real refusal is still an error, not "not confirmed"', async () => {
  const t = await thread((method) => (method === 'chat.stop' ? new Error('The harness has nothing to stop.') : null));
  await click('Stop');
  assert.match(t.host.textContent!, /The harness has nothing to stop\./);
  assert.doesNotMatch(t.host.textContent!, /not confirmed/);
});

const item = (over: object): any => ({
  id: 'a',
  pairId: 'p2',
  chatId: 'c1',
  text: 'hello',
  attachments: [],
  at: 1,
  status: 'queued',
  error: null,
  ...over,
});

test('a send whose fate is unknown is "not confirmed", a refused one is "not sent"', async () => {
  assert.equal(isUnconfirmed(item({ status: 'failed', error: UNSURE })), true);
  assert.equal(isUnconfirmed(item({ status: 'failed', error: WAS_SENDING })), true);
  assert.equal(isUnconfirmed(item({ status: 'failed', error: 'no' })), false);
  assert.equal(isUnconfirmed(item({ status: 'queued' })), false);
  const host = await mount(
    createElement(QueuedMessages, {
      items: [item({ id: 'u', status: 'failed', error: UNSURE }), item({ id: 'r', status: 'failed', error: 'no' })],
      cancel: () => {},
      retry: () => {},
    }),
  );
  assert.match(host.textContent!, new RegExp(`Not confirmed: ${UNSURE.replace('.', '\\.')}`));
  assert.match(host.textContent!, /Not sent: no/);
});

test('a waiting message is edited in place: Save keeps the new text, Discard keeps the old, and one that went out cannot be edited', async () => {
  const edits: string[] = [];
  let accept = true;
  const props = (items: any[]) => ({
    items,
    cancel: () => {},
    retry: () => {},
    edit: (id: string, text: string) => (edits.push(`${id}:${text}`), accept),
  });
  const waiting = item({ text: 'Also add a note' });
  const host = await mount(
    createElement(QueuedMessages, props([waiting, item({ id: 'b', status: 'sending' }), item({ id: 'c', status: 'failed', error: 'no' })])),
  );
  assert.equal([...host.querySelectorAll('button')].filter((b) => b.textContent === 'Edit').length, 1, 'only the waiting one');
  await click('Edit');
  assert.equal((host.querySelector('textarea, input') as HTMLInputElement).value, 'Also add a note');
  // the editor is a new field each time it opens
  const type = async (value: string) =>
    act(async () => {
      const field = host.querySelector('textarea, input') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type('   ');
  assert.equal([...host.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.disabled, true, 'nothing to save');
  await type('Also add a note to the changelog');
  await click('Discard');
  assert.match(host.textContent!, /Also add a note(?! to)/, 'the old text stays');
  await click('Edit');
  await type('Also add a note to the changelog');
  accept = false;
  await click('Save');
  assert.deepEqual(edits, ['a:Also add a note to the changelog']);
  assert.ok(host.querySelector('textarea, input'), 'a refused save keeps the editor open');
  accept = true;
  await click('Save');
  assert.equal(host.querySelector('textarea, input'), null);
  // the editor is for the message being edited: when it goes out meanwhile the editor goes
  await click('Edit');
  await act(async () => mounted[0].root.render(createElement(QueuedMessages, props([{ ...waiting, status: 'sending' }]))));
  assert.equal(host.querySelector('textarea, input'), null);
  // without an edit handler there is no Edit button
  const none = await mount(createElement(QueuedMessages, { items: [waiting], cancel: () => {}, retry: () => {} }));
  assert.ok(![...none.querySelectorAll('button')].some((b) => b.textContent === 'Edit'));
});

function outbox(o: { gate?: Promise<boolean> } = {}) {
  const sent: any[] = [];
  let n = 0;
  const box = createOutbox({
    online: () => true,
    send: async (it) => void sent.push(it),
    lost: () => false,
    idempotent: () => true,
    ready: () => o.gate ?? Promise.resolve(true),
    newId: () => `send-${++n}-test`,
    now: () => 1,
    onChange: () => {},
  });
  return { box, sent };
}

test('the outbox edits a waiting message under the same id and refuses every other case', async () => {
  let open!: (v: boolean) => void;
  const gate = new Promise<boolean>((resolve) => (open = resolve));
  const { box, sent } = outbox({ gate });
  const first = box.add({ pairId: 'p', chatId: 'c', text: 'one', attachments: [] });
  const second = box.add({ pairId: 'p', chatId: 'c', text: 'two', attachments: [] });
  assert.equal(box.edit('nope', 'x'), false, 'unknown');
  assert.equal(box.edit(second, '  '), false, 'empty');
  // edited while the computer is still being asked what it can do: the new text is what goes out
  assert.equal(box.edit(first, 'one, edited'), true);
  open(true);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    sent.map((s) => [s.id, s.text]),
    [
      [first, 'one, edited'],
      [second, 'two'],
    ],
  );
  assert.equal(box.edit(first, 'late'), false, 'taken already');
});

test('a message edited and then cancelled while the computer is asked is not sent', async () => {
  let open!: (v: boolean) => void;
  const gate = new Promise<boolean>((resolve) => (open = resolve));
  const { box, sent } = outbox({ gate });
  const id = box.add({ pairId: 'p', chatId: 'c', text: 'one', attachments: [] });
  assert.equal(box.edit(id, 'one more'), true);
  assert.equal(box.cancel(id), true);
  open(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, []);
});

test('a refused message cannot be edited (sending it again is Retry)', () => {
  const box2 = createOutbox({
    online: () => true,
    send: async () => {
      throw new Error('no');
    },
    lost: () => false,
    idempotent: () => true,
    ready: async () => true,
    newId: () => 'send-1-test',
    now: () => 1,
    onChange: () => {},
  });
  const id = box2.add({ pairId: 'p', chatId: 'c', text: 'one', attachments: [] });
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      assert.equal(box2.edit(id, 'two'), false);
      resolve();
    }),
  );
});

test('a message that was in flight when the connection went cannot be edited, not even once it waits again', async () => {
  let n = 0;
  const sent: any[] = [];
  const box = createOutbox({
    online: () => true,
    send: async (it) => {
      sent.push(it);
      if (++n === 1) throw new Error('Connection closed');
    },
    lost: (e) => e instanceof Error && e.message === 'Connection closed',
    idempotent: () => true,
    ready: async () => true,
    newId: () => 'send-1-test',
    now: () => 1,
    onChange: (items) => void (last = items),
  });
  let last: any[] = [];
  const id = box.add({ pairId: 'p', chatId: 'c', text: 'one', attachments: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(last[0].status, 'queued', 'waits again, under the same id');
  assert.equal(last[0].attempted, true);
  assert.equal(box.edit(id, 'changed'), false, 'the computer may hold it already');
  const host = await mount(createElement(QueuedMessages, { items: last, cancel: () => {}, retry: () => {}, edit: () => true }));
  assert.ok(![...host.querySelectorAll('button')].some((b) => b.textContent === 'Edit'));
  // saved and read back, it stays so
  const [back] = restoreItems([{ ...last[0], status: 'queued' }], { now: 2, pairs: new Set(['p']) });
  assert.equal(back.attempted, true);
  assert.equal(restoreItems([{ ...last[0], attempted: 'yes' }], { now: 2, pairs: new Set(['p']) })[0].attempted, undefined);
});

test('the notice for a stop that could not be read back goes when the turn ends', async () => {
  let turn = 'running';
  let follow: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((follow = f), () => {}),
    request: async (method: string) => {
      if (method === 'chat.follow') return { rev: 1, feedSeq: 0, session: { turn, cards: [] }, itemsShape: 'rows', items: [] };
      if (method === 'chat.stop') throw new Error('Request timed out');
      return {};
    },
  };
  withOutbox(runtime);
  const host = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }));
  await click('Stop');
  assert.match(host.textContent!, /Stop not confirmed/);
  await act(async () => follow({ kind: 'event', chatId: 'c', ev: 'session.patch', rev: 2, patch: { turn: 'idle' } }));
  assert.doesNotMatch(host.textContent!, /not confirmed/);
  assert.ok(turn);
});

const momoBase = (extra: Record<string, any>) => ({
  'machine.hello': () => hello(true),
  'momo.brain.get': () => ({ brain: null }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.chat.follow': () =>
    snapshotOf(
      [{ id: 'k1', rev: 1, title: 'Send the email?', choices: [{ key: 'allow', label: 'Allow' }] }],
      [{ id: 'm1', type: 'agentMessage', text: 'Hi' }],
    ),
  'momo.chat.unfollow': () => ({}),
  ...extra,
});

test('MoMo\'s stop and answer say "not confirmed" when they were in flight as the connection went, and a refusal is still an error', async () => {
  let reason = 'relay disconnected';
  const lost = () => Promise.reject(new Error(reason));
  const m = momoRuntime(momoBase({ 'momo.chat.send': lost, 'momo.chat.stop': lost, 'momo.card.answer': lost }));
  const view = await mountMomo(m);
  // Stop takes the send's place while MoMo works
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 2, patch: { turn: 'running' } }));
  await click('Stop');
  assert.match(view.text(), /Stop not confirmed/);
  // MoMo's request waits in the chat itself
  await click('Allow');
  assert.match(view.text(), /Answer not confirmed/);
  reason = 'MoMo is busy.';
  await click('Allow');
  assert.match(view.text(), /MoMo is busy\./);
  assert.doesNotMatch(view.text(), /not confirmed/);
  await view.unmount();
});

test("queueCalls hands the list the runtime's three calls", () => {
  const calls: string[] = [];
  const runtime: any = {
    cancelSend: (id: string) => (calls.push(`cancel ${id}`), true),
    retrySend: (id: string) => (calls.push(`retry ${id}`), true),
    editSend: (id: string, text: string) => (calls.push(`edit ${id} ${text}`), true),
  };
  const c = queueCalls(runtime);
  assert.deepEqual([c.cancel('a'), c.retry('b'), c.edit('c', 'x')], [true, true, true]);
  assert.deepEqual(calls, ['cancel a', 'retry b', 'edit c x']);
});

test("sendActions maps the runtime's calls on the queue, and sendLost is a request cut off or made too early", () => {
  const seen: string[] = [];
  const box = {
    cancel: (id: string) => (seen.push(`cancel ${id}`), true),
    edit: (id: string, text: string) => (seen.push(`edit ${id} ${text}`), true),
    retry: (id: string) => (seen.push(`retry ${id}`), true),
  };
  const a = sendActions(box);
  assert.deepEqual([a.cancelSend('1'), a.editSend('2', 'y'), a.retrySend('3')], [true, true, true]);
  assert.deepEqual(seen, ['cancel 1', 'edit 2 y', 'retry 3']);
  assert.equal(sendLost(new Error('Connection closed')), true);
  assert.equal(sendLost(new Error('relay disconnected')), true);
  assert.equal(sendLost(new Error('Connect to a computer first')), true);
  // a timeout leaves the connection up, so nothing would send the message again: it is not "lost" but not confirmed (see below)
  assert.equal(sendLost(new Error('Request timed out')), false);
  assert.equal(sendLost(new Error('The harness did not accept the message.')), false);
  assert.equal(sendLost('relay disconnected'), false);
});

test('a stop refused with something that is not an Error shows it as text, not as "not confirmed"', async () => {
  const t = await thread((method) => (method === 'chat.stop' ? ('plain failure' as unknown as Error) : null));
  await click('Stop');
  assert.match(t.host.textContent!, /plain failure/);
  assert.doesNotMatch(t.host.textContent!, /not confirmed/);
});

test('a send that timed out with the connection still up is not confirmed and can be sent again, not left waiting for a reconnect that never comes', async () => {
  let n = 0;
  const sent: string[] = [];
  let last: any[] = [];
  const box = createOutbox({
    online: () => true,
    send: async (it) => {
      sent.push(it.text);
      if (++n === 1) throw new Error('Request timed out');
    },
    lost: sendLost,
    idempotent: () => true,
    ready: async () => true,
    newId: () => 'send-1-test',
    now: () => 1,
    onChange: (items) => void (last = items),
  });
  const id = box.add({ pairId: 'p', chatId: 'c', text: 'one', attachments: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(last[0].status, 'failed');
  assert.equal(last[0].error, UNSURE);
  assert.equal(isUnconfirmed(last[0]), true);
  assert.equal(box.retry(id), true, 'the person decides, under the same send id');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['one', 'one']);
  assert.deepEqual(last, [], 'delivered');
});

test('a stop whose result is already on screen when the failure comes is not called unconfirmed', async () => {
  let fail: (e: Error) => void = () => {};
  let follow: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((follow = f), () => {}),
    request: (method: string) =>
      method === 'chat.follow'
        ? Promise.resolve({ rev: 1, feedSeq: 0, session: { turn: 'running', cards: [] }, itemsShape: 'rows', items: [] })
        : method === 'chat.stop'
          ? new Promise((_, reject) => (fail = reject))
          : Promise.resolve({}),
  };
  withOutbox(runtime);
  const host = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }));
  await click('Stop');
  // the Mac took the stop and said so, then the connection dropped before the reply
  await act(async () => follow({ kind: 'event', chatId: 'c', ev: 'session.patch', rev: 2, patch: { turn: 'idle' } }));
  await act(async () => fail(new Error('relay disconnected')));
  assert.doesNotMatch(host.textContent!, /not confirmed/);
});

test("MoMo's notice goes when its chat moves on", async () => {
  let reason = 'relay disconnected';
  const m = momoRuntime(
    momoBase({
      'momo.chat.stop': () => Promise.reject(new Error(reason)),
      'momo.chat.follow': () => ({
        ...snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Hi' }]),
        session: { turn: 'running', cards: [] },
      }),
    }),
  );
  const view = await mountMomo(m);
  await click('Stop');
  assert.match(view.text(), /Stop not confirmed/);
  await act(async () => m.emit({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 2, feedSeq: 1, patch: { turn: 'idle' } }));
  assert.doesNotMatch(view.text(), /not confirmed/);
  assert.ok(reason);
  await view.unmount();
});
