// Sending while a turn runs: the phone sends and stops from one composer, and shows the messages the Mac holds for the turn with Edit and Cancel, as the app's queue does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const queuePath = '../mobile/src/components/MacQueue';
const { Thread } = await import(threadPath);
const { MacQueue, heldOf, WAITING_LINE, HELD_LINE } = await import(queuePath);

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
const named = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label);
const queuedItem = (id: string, text: string, over: object = {}) => ({
  id,
  text,
  mine: true,
  attached: 0,
  ...over,
});

/** A chat the Mac follows, with its turn and the messages it holds. */
function chat(turn: string, queue: object[], answers: (m: string, p: any) => unknown = () => undefined) {
  const s = scripted((m, p) =>
    m === 'chat.follow'
      ? {
          rev: 1,
          feedSeq: 0,
          session: { turn, cards: [], queue },
          itemsShape: 'rows',
          items: [],
        }
      : (answers(m, p) as any),
  );
  const sent: any[] = [];
  s.runtime.send = (chatId: string, text: string) => (sent.push([chatId, text]), 'send-1');
  return { ...s, sent };
}
const view = (s: any, over: Record<string, unknown> = {}) => {
  const { draft, setDraft, ...rest } = over as { draft?: string; setDraft?: (t: string) => void };
  return createElement(Thread, {
    runtime: s.runtime,
    chatId: 'c',
    back: () => {},
    drafts: fakeDraft(typeof draft === 'string' ? draft : '', { set: setDraft }),
    ...rest,
  });
};

test('a turn is running and a follow-up is typed: Send and Stop sit side by side in the composer, each doing its own work', async () => {
  const s = chat('running', []);
  const host = await mount(view(s, { draft: 'also add a test' }));
  const send = named(host, 'Send message')[0];
  const stop = named(host, 'Stop this chat’s turn')[0];
  assert.ok(send && stop, 'both are offered');
  assert.equal(send.hasAttribute('disabled'), false);
  assert.equal(send.parentElement, stop.parentElement, 'in the same row of the box, not Stop above it');
  await click('Send message');
  assert.deepEqual(s.sent, [['c', 'also add a test']]);
  await click('Stop this chat’s turn');
  assert.ok(s.calls.some(([m]: any) => m === 'chat.stop'));
  // nothing typed: only Stop, in the round button
  const empty = await mount(view(s));
  assert.equal(named(empty, 'Send message').length, 0);
  assert.equal(named(empty, 'Stop this chat’s turn').length, 1);
});

test('the messages the Mac holds show under the chat in order, with Edit and Cancel on the user’s own', async () => {
  const queue = [
    queuedItem('queued-1', 'first follow-up'),
    queuedItem('queued-2', 'second follow-up'),
    queuedItem('queued-3', 'with a photo', { attached: 1 }),
    queuedItem('queued-4', 'from another session', { mine: false }),
  ];
  const s = chat('running', queue);
  const host = await mount(view(s));
  const text = host.textContent!;
  assert.ok(
    text.indexOf('first follow-up') < text.indexOf('second follow-up') && text.indexOf('second follow-up') < text.indexOf('with a photo'),
  );
  assert.doesNotMatch(text, /another session/);
  assert.match(text, new RegExp(WAITING_LINE));
  assert.equal(named(host, 'Cancel this message').length, 3);
  assert.equal(named(host, 'Edit this message').length, 2, 'a message with a photo cannot go back to the composer');
  // each one is taken back by its own id
  await act(async () => named(host, 'Cancel this message')[1].click());
  await flush();
  assert.deepEqual(
    s.calls.filter(([m]: any) => m === 'chat.queue.cancel'),
    [['chat.queue.cancel', { chatId: 'c', id: 'queued-2' }]],
  );
});

test('Edit takes the message out of the Mac’s queue and puts its words in front of what is typed; one already sent stays sent', async () => {
  const drafts: string[] = [];
  const answers = (m: string, p: any) => (m === 'chat.queue.cancel' ? { removed: p.id !== 'queued-gone' } : undefined);
  const s = chat('running', [queuedItem('queued-1', 'older words'), queuedItem('queued-gone', 'too late')], answers);
  const host = await mount(view(s, { draft: 'new words', setDraft: (t: string) => drafts.push(t) }));
  await act(async () => named(host, 'Edit this message')[0].click());
  await flush();
  assert.deepEqual(drafts, ['older words\nnew words']);
  await act(async () => named(host, 'Edit this message')[1].click());
  await flush();
  assert.deepEqual(drafts, ['older words\nnew words'], 'the Mac had already sent it: nothing comes back');
  // an empty composer takes the words as they are
  const bare = await mount(view(s, { draft: '  ', setDraft: (t: string) => drafts.push(t) }));
  await act(async () => named(bare, 'Edit this message')[0].click());
  await flush();
  assert.equal(drafts.at(-1), 'older words');
});

test('a refused cancel says why, and a Stop leaves the messages on hold with Edit to send them', async () => {
  const s = chat('running', [queuedItem('queued-1', 'keep me')], (m) => {
    if (m === 'chat.queue.cancel') throw new Error('Update MoPilot Code on your Mac.');
    if (m === 'plain') return undefined;
  });
  const host = await mount(view(s));
  await act(async () => named(host, 'Cancel this message')[0].click());
  await flush();
  assert.match(host.textContent!, /Update MoPilot Code on your Mac\./);
  const old = chat('running', [queuedItem('queued-1', 'keep me')], (m) => {
    if (m === 'chat.queue.cancel') throw new Error('Unknown request: chat.queue.cancel');
  });
  const oldHost = await mount(view(old));
  await act(async () => named(oldHost, 'Cancel this message')[0].click());
  await flush();
  assert.match(oldHost.textContent!, /Update MoPilot on your Mac to change queued messages\./);
  const failing = scripted((m) => {
    if (m === 'chat.queue.cancel') throw 'plain failure';
    return m === 'chat.follow'
      ? {
          rev: 1,
          feedSeq: 0,
          session: {
            turn: 'idle',
            cards: [],
            queue: [queuedItem('queued-1', 'held')],
          },
          itemsShape: 'rows',
          items: [],
        }
      : undefined;
  });
  const idle = await mount(view(failing));
  assert.match(idle.textContent!, new RegExp(HELD_LINE.replace('.', '\\.')));
  assert.equal(named(idle, 'Stop this chat’s turn').length, 0, 'nothing runs to stop');
  await act(async () => named(idle, 'Edit this message')[0].click());
  await flush();
  assert.match(idle.textContent!, /plain failure/);
});

test('the Mac’s queue is read defensively and an empty one draws nothing', async () => {
  assert.deepEqual(heldOf(undefined), []);
  assert.deepEqual(heldOf({ queue: 'x' }), []);
  assert.deepEqual(
    heldOf({
      queue: [
        null,
        { id: '', text: 'a', mine: true },
        { id: 'x', text: 3, mine: true },
        { id: 'y', text: 'b' },
        { id: 'z', text: 'c', mine: true },
      ],
    }),
    [{ id: 'z', text: 'c', attached: 0 }],
  );
  const s = chat('running', []);
  const host = await mount(
    createElement(MacQueue, {
      runtime: s.runtime,
      chatId: 'c',
      session: { queue: [] },
      running: true,
      draft: () => '',
      setDraft: () => {},
      fail: () => {},
    }),
  );
  assert.equal(host.textContent, '');
});

test('an offline Mac still takes the follow-up: it waits on the phone, says so, and the phone does not guess at the Mac’s queue', async () => {
  const s = chat('running', [queuedItem('queued-1', 'held on the Mac')]);
  const waiting = {
    id: 'out-12345',
    pairId: 'p',
    chatId: 'c',
    text: 'typed offline',
    attachments: [],
    at: 1,
    status: 'queued',
    error: null,
  };
  const host = await mount(view(s, { draft: 'one more', offline: true, queued: [waiting] }));
  assert.match(host.textContent!, /typed offline/);
  assert.match(host.textContent!, /Will send when your computer reconnects/);
  assert.doesNotMatch(host.textContent!, /held on the Mac|Sends when this turn ends/, 'the Mac is away: its queue is not known');
  await click('Send message');
  assert.deepEqual(s.sent, [['c', 'one more']], 'the outbox takes it and waits for the Mac');
  assert.equal(named(host, 'Edit this message').length, 1, 'the phone’s own waiting message keeps its own Edit and Cancel');
});

test('the queue’s props answer for messages the Mac no longer holds: retry does nothing, nothing is taken back, no words are put back', async () => {
  const calls: string[] = [];
  const runtime = { request: async (m: string) => (calls.push(m), { removed: false }) };
  let draft = 'typed';
  const element = MacQueue({
    runtime,
    chatId: 'c1',
    session: { queue: [{ id: 'q1', text: 'held', mine: true, attached: 0 }] },
    running: true,
    draft: () => draft,
    setDraft: (t: string) => (draft = t),
    fail: () => {},
  });
  const props = element.props;
  assert.equal(props.retry('q1'), undefined);
  assert.equal(props.canTakeBack('gone'), false, 'a message the Mac dropped has nothing attached to give back');
  props.takeBack('gone');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['chat.queue.cancel']);
  assert.equal(draft, 'typed', 'the Mac had already dropped it, so nothing is put in front of what is typed');
});
