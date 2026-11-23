// Messages the computer has not accepted yet: shown under the chat with what is happening to each, typed offline in the waiting chat, cancelled or sent again from the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';
const appPath = '../mobile/src/MobileApp';
const queuedPath = '../mobile/src/components/QueuedMessages';
const threadPath = '../mobile/src/screens/Thread';
const { MobileApp } = await import(appPath);
const { QueuedMessages } = await import(queuedPath);
const { Thread } = await import(threadPath);

const item = (over: object) => ({
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
const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.textContent);

test('each message says what is happening to it and offers what can still be done', async () => {
  const taps: string[] = [];
  const list = [
    item({ id: 'a', text: 'waits' }),
    item({ id: 'b', text: 'goes now', status: 'sending' }),
    item({ id: 'c', text: 'refused', status: 'failed', error: 'The harness did not accept the message.' }),
  ];
  const host = await mount(
    createElement(QueuedMessages, {
      items: list,
      cancel: (id: string) => taps.push(`cancel ${id}`),
      retry: (id: string) => taps.push(`retry ${id}`),
    }),
  );
  assert.match(host.textContent!, /waits◷Will send when your computer reconnects/);
  assert.match(host.textContent!, /Sending…/);
  assert.match(host.textContent!, /Not sent: The harness did not accept the message\./);
  assert.deepEqual(buttons(host), ['Cancel', 'Retry', 'Cancel'], 'a message in flight cannot be taken back');
  const press = async (label: string) => {
    const el = [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label);
    await act(async () => el[0].click());
  };
  await press('Cancel this message');
  await press('Retry sending');
  assert.deepEqual(taps, ['cancel a', 'retry c']);
  const none = await mount(createElement(QueuedMessages, { items: [], cancel: () => {}, retry: () => {} }));
  assert.equal(none.textContent, '');
});

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p2', macId: 'm2', name: 'Mac two' }],
  selectedPair: 'p2',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};

test('in the chat kept open while the computer is away a message can be typed, waits, and can be cancelled', async () => {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Fix the build' }] } : undefined), online);
  s.runtime.start = async () => {};
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const sent: any[] = [];
  const cancelled: string[] = [];
  const retried: string[] = [];
  let queue: any[] = [];
  s.runtime.send = (chatId: string, text: string) => {
    if (text === 'boom') throw new Error('Connect to a computer first');
    if (text === 'plain') throw 'plain failure';
    sent.push([chatId, text]);
    queue = [...queue, item({ id: `q${sent.length}`, chatId, text, pairId: 'p2' })];
    return `q${sent.length}`;
  };
  s.runtime.cancelSend = (id: string) => (cancelled.push(id), true);
  s.runtime.retrySend = (id: string) => (retried.push(id), true);
  const change = async (patch: object) => {
    s.state.snap = { ...s.state.snap, ...patch };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  const host = await mount(createElement(MobileApp, { runtime: s.runtime }));
  await click('Open chat');
  await change({ phase: 'offline', generation: 2, selectedPair: null, reconnect: { pairId: 'p2', attempt: 0, nextAt: null }, outbox: [] });
  assert.ok(host.querySelector('button[aria-label^="Runs on"][aria-label$=", Offline"]'), 'the chat says its Mac is away');
  assert.equal(host.querySelector('button[aria-label="Send message"]')!.hasAttribute('disabled'), true, 'nothing to send yet');
  await inputText('Message this chat', 'boom');
  await click('Send message');
  assert.match(host.textContent!, /Connect to a computer first/);
  await inputText('Message this chat', 'plain');
  await click('Send message');
  assert.match(host.textContent!, /plain failure/);
  await inputText('Message this chat', 'typed offline');
  await click('Send message');
  assert.deepEqual(sent, [['c1', 'typed offline']]);
  assert.equal((host.querySelector('input') as HTMLInputElement).value, '', 'the draft went into the queue');
  await change({ outbox: queue });
  assert.match(host.textContent!, /Will send when your computer reconnects/);
  assert.match(host.textContent!, /typed offline/);
  // another chat's queued message is not shown here
  await change({ outbox: [...queue, item({ id: 'z', chatId: 'c9', text: 'elsewhere' })] });
  assert.doesNotMatch(host.textContent!, /elsewhere/);
  await click('Cancel');
  assert.deepEqual(cancelled, ['q1']);
  // one the computer refused can be sent again from here too
  await change({ outbox: [item({ id: 'r1', text: 'refused one', status: 'failed', error: 'no' })] });
  await click('Retry');
  assert.deepEqual(retried, ['r1']);
  // back online the thread shows the same messages until the computer takes them
  await change({
    phase: 'online',
    generation: 3,
    selectedPair: 'p2',
    reconnect: null,
    outbox: [item({ id: 'q1', text: 'typed offline', status: 'failed', error: 'refused' })],
  });
  assert.match(host.textContent!, /Not sent: refused/);
  assert.doesNotMatch(host.textContent!, /No messages yet/);
  await click('Retry');
  assert.deepEqual(retried, ['r1', 'q1']);
  await click('Cancel');
  assert.deepEqual(cancelled, ['q1', 'q1'], 'the thread cancels too');
});

test('the thread keeps the draft and shows why when the message cannot even be queued', async () => {
  const s = scripted(() => undefined, online);
  s.runtime.send = () => {
    throw new Error('Connect to a computer first');
  };
  let draft = 'unsent';
  let cleared = '';
  const host = await mount(
    createElement(Thread, {
      runtime: s.runtime,
      chatId: 'c1',
      back: () => {},
      drafts: fakeDraft(draft, { set: (t: string) => (draft = t), clear: (t: string) => (cleared = t) }),
    }),
  );
  await click('Send');
  assert.match(host.textContent!, /Connect to a computer first/);
  assert.equal(cleared, '', 'the draft stays');
  const text = (s.runtime.send = () => {
    throw 'plain failure';
  });
  assert.ok(text);
  await click('Send');
  assert.match(host.textContent!, /plain failure/);
});

test('after the app was closed the unsent messages are on the home screen, and one that is too old can only be cancelled', async () => {
  const s = scripted(() => undefined, {
    ...online,
    phase: 'ready',
    selectedPair: null,
    outbox: [
      item({ id: 'a', text: 'typed yesterday' }),
      item({ id: 'b', text: 'a week old', status: 'failed', error: 'This message waited longer than a week.', final: true }),
      item({ id: 'c', text: 'maybe sent', status: 'failed', error: 'The app closed while this was sending.' }),
    ],
  });
  s.runtime.start = async () => {};
  const taps: string[] = [];
  s.runtime.cancelSend = (id: string) => (taps.push(`cancel ${id}`), true);
  s.runtime.retrySend = (id: string) => (taps.push(`retry ${id}`), true);
  const host = await mount(createElement(MobileApp, { runtime: s.runtime }));
  assert.match(host.textContent!, /Unsent messages/);
  assert.match(host.textContent!, /Will send when your computer reconnects\./);
  assert.match(host.textContent!, /typed yesterday/);
  assert.deepEqual(
    buttons(host).filter((b) => b === 'Retry'),
    ['Retry'],
    'Retry only where sending again is safe',
  );
  const press = async (label: string, n: number) =>
    act(async () => [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label)[n].click());
  await press('Cancel this message', 1);
  await press('Retry sending', 0);
  assert.deepEqual(taps, ['cancel b', 'retry c']);
});

test('Edit on a queued message shows without a canTakeBack check, and takes the message back', async () => {
  const taps: string[] = [];
  const host = await mount(
    createElement(QueuedMessages, {
      items: [item({ id: 'a', text: 'waits' })],
      cancel: () => {},
      retry: () => {},
      takeBack: (id: string) => taps.push(`take ${id}`),
    }),
  );
  assert.deepEqual(buttons(host), ['Edit', 'Cancel']);
  await act(async () => (host.querySelector('button[aria-label="Edit this message"]') as HTMLElement).click());
  assert.deepEqual(taps, ['take a']);
});
