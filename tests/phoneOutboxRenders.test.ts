// A send's progress is not drawn through the app root (#4986): queued, sending, accepted and gone each published the whole snapshot, and every publish drew the root, the home under the chat, the chat screen and its composer (App and Home 5-6 times per send on the phone, 40-55 ms each). A publish that changed only the outbox now reaches the screens that show the messages, and nothing else.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const appPath = '../mobile/src/MobileApp';
const logPath = '../mobile/src/perfLog';
const cachePath = '../mobile/src/presentation/threadCache';
const viewPath = '../mobile/src/outboxView';
const { MobileApp } = await import(appPath);
const { perf } = await import(logPath);
const { forgetRows } = await import(cachePath);
const { onlyOutboxChanged, sameOutbox, withoutOutbox } = await import(viewPath);

afterEach(() => {
  perf.end();
  document.body.replaceChildren();
  (globalThis as any).__phoneKeepStack = false;
});

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
  outbox: [],
};
const item = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'a'.repeat(8),
  pairId: 'p',
  chatId: 'c1',
  text: 'Run the build again',
  attachments: [],
  at: 1,
  status,
  ...over,
});
const wait = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

async function mount(keepHome = true) {
  forgetRows();
  // natively the home stays mounted under the chat
  (globalThis as any).__phoneKeepStack = keepHome;
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c1', title: 'Build' }] }
        : m === 'chat.follow'
          ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [{ role: 'user', text: 'hi' }] }
          : undefined,
    online,
  );
  s.runtime.start = async () => {};
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
  const publish = (patch: Record<string, unknown>) =>
    act(async () => ((s.state.snap = { ...s.state.snap, ...patch }), listeners.forEach((fn) => fn())));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  return { host, root, publish };
}

test('A: the four publishes of one send draw neither the app root nor the home, and the message shows in the open chat while it waits', async () => {
  const { host, root, publish } = await mount();
  await click('Open chat Build');
  for (let i = 0; i < 4; i += 1) await wait();
  perf.start();
  await publish({ outbox: [item('queued')] });
  await wait();
  assert.ok(host.textContent!.includes('Run the build again'), 'the queued message is in the chat');
  await publish({ outbox: [item('sending')] });
  await publish({ outbox: [item('sent')] });
  await publish({ outbox: [] });
  await wait();
  const { renders } = perf.report();
  assert.equal(renders.App ?? 0, 0, "the root is not drawn for a send's progress");
  assert.equal(renders.Home ?? 0, 0, 'nor the home under the chat');
  assert.ok(renders.Thread >= 1, 'the chat screen still draws what changed for it');
  await act(async () => root.unmount());
});

test('A: the home lists the unsent message and takes it off again, though the root does not draw', async () => {
  const { host, root, publish } = await mount();
  perf.start();
  await publish({ outbox: [item('queued')] });
  await wait();
  assert.ok(host.textContent!.includes('Unsent messages'), 'the heading shows');
  assert.ok(host.textContent!.includes('Run the build again'));
  assert.equal(perf.report().renders.App ?? 0, 0);
  await publish({ outbox: [] });
  await wait();
  assert.equal(host.textContent!.includes('Unsent messages'), false, 'gone when the outbox is empty');
  await act(async () => root.unmount());
});

test('B: a publish that changes the connection still draws the root, a message for another chat stays out of this one, and an unchanged publish draws as before', async () => {
  const { host, root, publish } = await mount(false);
  await click('Open chat Build');
  for (let i = 0; i < 4; i += 1) await wait();
  perf.start();
  await publish({ outbox: [item('queued', { id: 'b'.repeat(8), chatId: 'other', text: 'Elsewhere' })] });
  await wait();
  assert.equal(host.textContent!.includes('Elsewhere'), false, 'a message for another chat is not in this one');
  await publish({ phase: 'offline' });
  await wait();
  assert.ok((perf.report().renders.App ?? 0) >= 1, 'a change of phase reaches the root');
  perf.reset();
  await publish({});
  await wait();
  assert.ok((perf.report().renders.App ?? 0) >= 1, 'a publish that says nothing new still draws it, as it always did');
  await act(async () => root.unmount());
});

test('I: the outbox comparison reads what each message says, not its object, and a snapshot is the same but for the outbox only when nothing else differs', () => {
  const a = item('queued', { attachments: ['x'], skills: ['s'] });
  const copy = { ...a, attachments: ['x'], skills: ['s'] };
  assert.equal(sameOutbox([a as any], [copy as any]), true);
  assert.equal(sameOutbox([a as any], [{ ...copy, status: 'sending' } as any]), false, 'another state');
  assert.equal(sameOutbox([a as any], [{ ...copy, attachments: ['y'] } as any]), false, 'another attachment');
  assert.equal(sameOutbox([a as any], [{ ...copy, skills: ['s', 't'] } as any]), false, 'another list length');
  assert.equal(sameOutbox([a as any], [{ ...copy, extra: 1 } as any]), false, 'another set of fields');
  assert.equal(sameOutbox([a as any], []), false);
  const base = { ...online, outbox: [a] } as any;
  const queued = { ...online, outbox: [{ ...a, status: 'sending' }] } as any;
  assert.equal(onlyOutboxChanged(base, queued), true);
  assert.equal(onlyOutboxChanged(base, { ...queued, phase: 'offline' }), false, 'the phase changed too');
  assert.equal(onlyOutboxChanged(base, { ...base, outbox: [{ ...a }] }), false, 'nothing changed');
  assert.deepEqual(withoutOutbox(base).outbox, []);
  // a runtime that holds no outbox at all reads as an empty one, and its other changes are not outbox-only
  const bare = { ...online, outbox: undefined } as any;
  assert.equal(onlyOutboxChanged(bare, { ...bare, phase: 'offline' }), false, 'no outbox on either side');
  assert.equal(onlyOutboxChanged(bare, { ...bare, outbox: [a] }), true, 'a first message into a runtime that had none');
});
