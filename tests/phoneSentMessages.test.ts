// A sent message stays on screen from the tap until the computer's record of it arrives: never a gap, never two bubbles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const sentPath = '../mobile/src/presentation/sentMessages';
const threadPath = '../mobile/src/screens/Thread';
const startingPath = '../mobile/src/screens/Starting';
const { settled, waitingForRecord, withSent, initialSent, unrecordedQueue, linkHeld } = await import(sentPath);
const { Thread } = await import(threadPath);
const { Starting } = await import(startingPath);
const { FRAME_MS } = await import('../mobile/src/presentation/followFeed');
// a patch that follows another within a frame is drawn when the frame ends
const frame = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, FRAME_MS + 4))));

const you = (text: string) => ({ role: 'user', text });

test('a message waits until a user row with its words exceeds what the page had when it was sent', () => {
  const once = withSent([], [], 'hi');
  assert.deepEqual(waitingForRecord(once, []), once);
  assert.deepEqual(waitingForRecord(once, [{ role: 'assistant', text: 'hi' }]), once, 'only your rows count');
  assert.deepEqual(waitingForRecord(once, [you(' hi ')]), [], 'the live copy of it counts, whitespace aside');
  assert.deepEqual(waitingForRecord(once, [{ role: 'liveUser', text: 'hi' }]), []);
  // the same words said before are not this message
  const again = withSent([], [you('hi')], 'hi');
  assert.deepEqual(waitingForRecord(again, [you('hi')]), again);
  assert.deepEqual(waitingForRecord(again, [you('hi'), you('hi')]), []);
});

test('the same words sent twice are matched one record at a time, oldest first', () => {
  const two = withSent(withSent([], [], 'go'), [], 'go');
  assert.deepEqual(
    two.map((s: { base: number }) => s.base),
    [0, 1],
  );
  assert.equal(waitingForRecord(two, []).length, 2);
  assert.equal(waitingForRecord(two, [you('go')]).length, 1);
  assert.equal(waitingForRecord(two, [you('go'), you('go')]).length, 0);
});

test('a message the outbox already draws is not drawn twice', () => {
  const two = withSent(withSent([], [], 'go'), [], 'go');
  assert.equal(waitingForRecord(two, [], [{ text: 'go' }]).length, 1, 'the latest of the same words is the queued one');
  assert.equal(waitingForRecord(two, [], [{ text: 'go' }, { text: 'go' }]).length, 0);
  assert.equal(waitingForRecord(two, [], [{ text: 'other' }]).length, 2);
});

test('settling drops what arrived and keeps the same list when nothing did', () => {
  const sent = withSent(withSent([], [], 'a'), [], 'b');
  assert.equal(settled(sent, []), sent);
  assert.equal(settled(sent, [you('a')])[0].text, 'b');
});

const listen: { fn: (e: any) => void } = { fn: () => {} };
const follow = (history: object[] = []) => ({
  rev: 1,
  feedSeq: 0,
  session: { turn: 'idle', cards: [] },
  itemsShape: 'rows',
  items: history,
});
function mountThread(extra: object, answers: (m: string) => unknown, typed = '', offline = false) {
  // one screen at a time: the click helpers search the whole document
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: any[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: (e: any) => void) => ((listen.fn = f), () => {}),
    request: async (m: string, p: any) => (calls.push([m, p]), answers(m)),
  };
  const box = withOutbox(runtime, { online: () => !offline, notify: () => root.render(render()) });
  let draft = typed;
  const render = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      queued: runtime.snapshot().outbox,
      back: () => {},
      drafts: fakeDraft(draft, { set: (t: string) => ((draft = t), act(async () => root.render(render()))), clear: () => (draft = '') }),
      ...extra,
    });
  return { host, root, render, calls, runtime, box };
}

test('a chat opened from New chat shows your first message and the Mac’s warning before the Mac has said anything', async () => {
  let reply: (v: unknown) => void = () => {};
  const { host, root, render } = mountThread(
    {
      first: {
        text: 'Fix the build',
        warning: 'Started, but the permission could not be set.',
      },
    },
    (m) => (m === 'chat.follow' ? new Promise((r) => (reply = r)) : {}),
  );
  await act(async () => root.render(render()));
  await flush();
  assert.match(host.textContent!, /Fix the build/);
  assert.match(host.textContent!, /Started, but the permission could not be set\./);
  assert.doesNotMatch(host.textContent!, /No messages yet/);
  // the Mac's snapshot has no record of it yet: it stays, once
  await act(async () => reply(follow([{ role: 'step', text: 'Running' }])));
  await flush();
  assert.equal(host.textContent!.split('Fix the build').length - 1, 1);
});

const record = (text: string, feedSeq: number) => ({
  ev: 'items.append',
  chatId: 'c',
  feedSeq,
  items: [
    {
      id: `u${feedSeq}`,
      type: 'userMessage',
      content: [{ type: 'text', text }],
    },
  ],
});
const times = (host: HTMLElement, text: string) => host.textContent!.split(text).length - 1;

test('the Mac’s user record replaces the optimistic bubble without a second one', async () => {
  const { host, root, render } = mountThread({ first: { text: 'Fix the build' } }, (m) => (m === 'chat.follow' ? follow() : {}));
  await act(async () => root.render(render()));
  await flush();
  assert.equal(times(host, 'Fix the build'), 1);
  await act(async () => listen.fn(record('Fix the build', 1)));
  await flush();
  assert.equal(times(host, 'Fix the build'), 1, 'the record is the bubble now');
});

test('a message typed in the chat is a bubble at once and goes when its record is among the rows', async () => {
  const { host, root, render } = mountThread({}, (m) => (m === 'chat.follow' ? follow() : {}), 'Add a test');
  await act(async () => root.render(render()));
  await flush();
  assert.equal(times(host, 'Add a test'), 0, 'only the field holds it before the tap');
  await click('Send message');
  await flush();
  assert.ok(times(host, 'Add a test') >= 1);
  const bubbles = () => [...host.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent === 'Add a test').length;
  await act(async () => listen.fn(record('Add a test', 1)));
  await flush();
  assert.equal(bubbles(), 1, 'one bubble after the record arrives');
});

test('the starting page shows your message and Back leaves it', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let backs = 0;
  await act(async () => root.render(createElement(Starting, { text: 'Fix the build', back: () => backs++ })));
  assert.match(host.textContent!, /Fix the build/);
  await click('Back');
  assert.equal(backs, 1);
});

test('sending again in the frame of the first record does not count the arrived send twice', () => {
  const pending = withSent([], [], 'go');
  const next = withSent(pending, [you('go')], 'go');
  assert.equal(waitingForRecord(next, [you('go'), you('go')]).length, 0);
});

test('send ids distinguish identical queued words and a record hides the queue even before its ack', () => {
  const first = withSent([], [], 'go', 'one');
  const sent = withSent(first, [], 'go', 'two');
  const queued = [{ id: 'two', text: 'go' }];
  assert.deepEqual(waitingForRecord(sent, [], queued), [sent[0]]);
  assert.deepEqual(unrecordedQueue(queued, sent, [you('go')]), queued);
  assert.deepEqual(unrecordedQueue(queued, sent, [you('go'), you('go')]), []);
});

test('a refused in-chat send can be cancelled without revealing its optimistic copy', async () => {
  const { host, root, render } = mountThread(
    {},
    (m) => {
      if (m === 'chat.follow') return follow();
      if (m === 'chat.send') throw new Error('Not allowed.');
      return {};
    },
    'Cancel me',
  );
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  assert.equal(times(host, 'Cancel me'), 1);
  assert.match(host.textContent!, /Not sent: Not allowed/);
  await click('Cancel this message');
  assert.equal(times(host, 'Cancel me'), 0);
});

test('the record can arrive while the send ack is pending without two user bubbles', async () => {
  let ack: (v: unknown) => void = () => {};
  const { host, root, render } = mountThread(
    {},
    (m) => (m === 'chat.follow' ? follow() : m === 'chat.send' ? new Promise((r) => (ack = r)) : {}),
    'One copy',
  );
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  assert.equal(times(host, 'One copy'), 1);
  await act(async () => listen.fn(record('One copy', 1)));
  await flush();
  assert.equal(times(host, 'One copy'), 1);
  await act(async () => ack({}));
  await flush();
  assert.equal(times(host, 'One copy'), 1);
});

test('pending sends precede subsequent Mac activity and keep their tap order at a shared anchor', async () => {
  const { withPendingRows } = await import('../mobile/src/presentation/thread');
  const rows = [
    { key: 'a', role: 'assistant', text: 'Before' },
    { key: 'b', role: 'step', text: 'Running' },
  ];
  const pending = [
    { id: '1', text: 'first', base: 0, after: 'a' },
    { id: '2', text: 'second', base: 0, after: 'a' },
  ];
  assert.deepEqual(
    withPendingRows(rows, pending).map((r) => r.text),
    ['Before', 'first', 'second', 'Running'],
  );
  assert.deepEqual(
    withPendingRows(rows, [{ text: 'new chat', base: 0 }]).map((r) => r.text),
    ['new chat', 'Before', 'Running'],
  );
});

async function editText(text: string) {
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Edit this message"]')!;
  assert.ok(field);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('editing an offline send replaces its pending text and cancelling it removes both copies', async () => {
  const { host, root, render } = mountThread({}, (m) => (m === 'chat.follow' ? follow() : {}), 'Original', true);
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  await click('Edit this message');
  await editText('Revised');
  await click('Save this message');
  assert.equal(times(host, 'Original'), 0);
  assert.equal(times(host, 'Revised'), 1);
  await click('Cancel this message');
  assert.equal(times(host, 'Revised'), 0);
});

test('the Mac queue owns its displayed bubble by id until its transcript arrives', () => {
  const sent = withSent(withSent([], [], 'go', 'phone1'), [], 'go', 'phone2');
  const held = [
    { id: 'mac1', text: 'go' },
    { id: 'mac2', text: 'go' },
    { id: 'mac3', text: 'other' },
  ];
  const bound = linkHeld(sent, held);
  assert.deepEqual(
    bound.map((s) => s.remoteId),
    ['mac1', 'mac2'],
  );
  assert.equal(linkHeld(bound, held), bound);
  assert.equal(linkHeld(sent, []), sent);
  assert.deepEqual(waitingForRecord(bound, [], held), []);
  assert.deepEqual(unrecordedQueue(held, bound, [you('go')]), held.slice(1));
});

test('Mac queue Cancel and Edit discard the retained optimistic message', async () => {
  const snap = follow();
  const { host, root, render } = mountThread(
    {},
    (m) => {
      if (m === 'chat.follow') return snap;
      if (m === 'chat.queue.cancel') return { removed: true };
      return {};
    },
    'Wait for me',
  );
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  await act(async () =>
    listen.fn({ ev: 'session.patch', chatId: 'c', rev: 2, patch: { queue: [{ id: 'mac1', mine: true, text: 'Wait for me' }] } }),
  );
  await flush();
  assert.equal(times(host, 'Wait for me'), 1);
  await click('Cancel this message');
  await act(async () => listen.fn({ ev: 'session.patch', chatId: 'c', rev: 3, patch: { queue: [] } }));
  await frame();
  await flush();
  assert.equal(times(host, 'Wait for me'), 0);
});

test('cancelling the earlier identical send leaves the surviving send eligible for its only record', () => {
  const two = withSent(withSent([], [], 'go', 'first'), [], 'go', 'second');
  assert.deepEqual(waitingForRecord(two.slice(1), [you('go')]), []);
  const left = settled(two, [you('go')]);
  assert.equal(waitingForRecord(left, [you('go')]).length, 1, 'a consumed row cannot satisfy another send');
  assert.equal(waitingForRecord(left, [you('go'), you('go')]).length, 0);
});

test('loading an earlier matching row cannot satisfy a message sent after the visible stable anchor', () => {
  const before = [{ ...you('go'), key: 'visible' }];
  const sent = withSent([], before, 'go', 'new');
  const paged = [{ ...you('go'), key: 'older' }, ...before];
  assert.equal(waitingForRecord(sent, paged).length, 1);
  assert.equal(waitingForRecord(sent, [...paged, { ...you('go'), key: 'new-record' }]).length, 0);
});

test('an older Mac-held message with the same words never takes a newly sent message', () => {
  const sent = withSent([], [], 'go', 'phone-new', ['mac-old']);
  assert.equal(linkHeld(sent, [{ id: 'mac-old', text: 'go' }]), sent);
  const next = linkHeld(sent, [
    { id: 'mac-old', text: 'go' },
    { id: 'mac-new', text: 'go' },
  ]);
  assert.equal(next[0].remoteId, 'mac-new');
});

test('an obsolete start cannot clear or mark a newer start as lost', async () => {
  const { startMemory } = await import('../mobile/src/remote/startMemory');
  const runtime = {} as any;
  const old = startMemory.idFor(runtime, 'old', () => 'old-id');
  const current = startMemory.idFor(runtime, 'new', () => 'new-id');
  startMemory.markLost(runtime, old);
  assert.equal(startMemory.lost(runtime), false);
  startMemory.clear(runtime, old);
  assert.equal(
    startMemory.idFor(runtime, 'new', () => 'wrong'),
    current,
  );
  startMemory.markLost(runtime, current);
  assert.equal(startMemory.lost(runtime), true);
  startMemory.clear(runtime, current);
  assert.equal(startMemory.lost(runtime), false);
});

test('archiving the preceding live user record cannot consume an identical new pending send', async () => {
  const { snapshot, update, displayRows, keyedRows } = await import('../mobile/src/presentation/thread');
  const initial = snapshot({
    itemsShape: 'items',
    items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'go' }] }],
    session: { turn: 'running' },
    rev: 1,
    feedSeq: 0,
  });
  const before = keyedRows(displayRows(initial));
  const pending = withSent([], before, 'go', 'new-send');
  const next = update(initial, { ev: 'turn.state', feedSeq: 1, status: 'running', turnId: 'next', started: true });
  assert.equal(waitingForRecord(pending, keyedRows(displayRows(next))).length, 1);
  const recorded = update(next, {
    ev: 'items.append',
    feedSeq: 2,
    items: [{ id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'go' }] }],
  });
  assert.equal(waitingForRecord(pending, keyedRows(displayRows(recorded))).length, 0);
});

test('a queue edit or cancel refused by the runtime retains the pending message', async () => {
  const { host, root, render, runtime } = mountThread({}, (m) => (m === 'chat.follow' ? follow() : {}), 'Keep me', true);
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  runtime.cancelSend = () => false;
  await click('Cancel this message');
  assert.equal(times(host, 'Keep me'), 1);
  await click('Edit this message');
  await editText('Rejected edit');
  runtime.editSend = () => false;
  await click('Save this message');
  assert.ok(host.querySelector('input[aria-label="Edit this message"]'));
  await click('Discard changes');
  assert.equal(times(host, 'Keep me'), 1);
});

test('a Mac-held send whose user record arrives remains one bubble until the queue releases it', async () => {
  const { host, root, render } = mountThread({}, (m) => (m === 'chat.follow' ? follow() : {}), 'Queued on Mac');
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  await act(async () =>
    listen.fn({ ev: 'session.patch', chatId: 'c', rev: 2, patch: { queue: [{ id: 'mac1', mine: true, text: 'Queued on Mac' }] } }),
  );
  await flush();
  assert.equal(times(host, 'Queued on Mac'), 1);
  await act(async () => listen.fn(record('Queued on Mac', 1)));
  await flush();
  assert.equal(times(host, 'Queued on Mac'), 1);
  await act(async () => listen.fn({ ev: 'session.patch', chatId: 'c', rev: 3, patch: { queue: [] } }));
  await flush();
  assert.equal(times(host, 'Queued on Mac'), 1);
});

test('a missing first user record survives a later message record and is matched independently', async () => {
  const { host, root, render } = mountThread(
    { first: { text: 'First still pending' } },
    (m) => (m === 'chat.follow' ? follow() : {}),
    'Later delivered first',
  );
  await act(async () => root.render(render()));
  await flush();
  await click('Send message');
  await act(async () => listen.fn(record('Later delivered first', 1)));
  await flush();
  assert.equal(times(host, 'First still pending'), 1);
  assert.equal(times(host, 'Later delivered first'), 1);
  await act(async () => listen.fn(record('First still pending', 2)));
  await flush();
  assert.equal(times(host, 'First still pending'), 1);
  assert.equal(times(host, 'Later delivered first'), 1);
});

test('settling a retained older send reuses a survivor that already excluded its record', () => {
  const first = withSent([], [], 'first', 'one');
  const both = withSent(first, [you('first')], 'second', 'two');
  const left = settled(both, [you('first')]);
  assert.equal(left.length, 1);
  assert.equal(left[0], both[1], 'an already-consumed key does not clone or erase the survivor');
  assert.equal(waitingForRecord(left, [you('first')]).length, 1);
  assert.equal(waitingForRecord(left, [you('first'), you('second')]).length, 0);
});

test('a message of files alone leaves no empty bubble waiting for a record the Mac never writes', () => {
  assert.deepEqual(withSent([], [], '  ', 'id1', [], []), []);
  assert.equal(withSent([], [], '', 'id2', [], ['data:image/png;base64,QUJD']).length, 1, 'pictures alone are a message');
  assert.equal(withSent([], [], 'hello', 'id3').length, 1);
  assert.deepEqual(initialSent({ text: ' ' }, []), []);
  assert.equal(initialSent({ text: '', pictures: ['data:image/png;base64,QUJD'] }, []).length, 1);
  assert.equal(initialSent({ text: 'hi' }, []).length, 1);
  assert.deepEqual(initialSent(undefined, []), []);
});
