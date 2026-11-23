// Where a slow start went, readable on a store build: each launch and each chat open keeps the ms of its steps (timings only), the last few are kept, and Settings › About lists them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

// through variables, so the desktop typecheck does not follow into React Native's global types
const tracePath = '../mobile/src/launchTrace';
const aboutPath = '../mobile/src/screens/AboutTrace';
const outboxPath = '../mobile/src/outbox';
const appPath = '../mobile/src/MobileApp';
const { mark, markChat, markSend, markSendEvent, traceLine, lineOf, attachTraceStore, loadTrace, resetTrace, KEPT, SAVE_AFTER_MS } =
  await import(tracePath);
const { took } = await import(aboutPath);
const { createOutbox } = await import(outboxPath);
const { MobileApp } = await import(appPath);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeStore(initial: any[] = []) {
  const rows = [...initial];
  const saved: any[] = [];
  return {
    saved,
    store: {
      load: async () => rows,
      save: async (record: any) => void saved.push(JSON.parse(JSON.stringify(record))),
    },
  };
}
/** A clock for the save-later timer that runs only when told. */
function timers() {
  const queued: [() => void, number][] = [];
  return { queued, after: (fn: () => void, ms: number) => (queued.push([fn, ms]), queued.length) };
}

test('a chat open keeps the ms of each step after the tap, saved when the rows are shown; steps after that or repeated are ignored', () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  markChat('follow-sent', 5); // before any open: nothing to add to
  markChat('open', 1000);
  markChat('follow-sent', 1010);
  markChat('follow-answered', 1300);
  assert.equal(saved.length, 0, 'not saved before the rows are shown');
  markChat('rows-shown', 1350);
  markChat('rows-shown', 1999);
  markChat('follow-sent', 2000);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'chat');
  assert.deepEqual(saved[0].steps, [
    ['open', 0],
    ['follow-sent', 10],
    ['follow-answered', 300],
    ['rows-shown', 350],
  ]);
  assert.equal(lineOf(saved[0]), 'open 0 · follow-sent 10 · follow-answered 300 · rows-shown 350');
});

test('an open that never shows rows is saved when its timer runs, with the steps it reached', () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  markChat('open', 50);
  markChat('follow-sent', 60);
  assert.equal(t.queued[0][1], SAVE_AFTER_MS);
  t.queued[0][0]();
  assert.deepEqual(saved[0].steps, [
    ['open', 0],
    ['follow-sent', 10],
  ]);
});

test('a launch notes each step once, saves at the list, the relay token and the answer, and tells its line', () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  assert.equal(traceLine(), '');
  mark('vault');
  mark('account');
  mark('vault');
  mark('list-shown');
  mark('relay-token');
  mark('list-answer');
  assert.equal(saved.length, 3, 'saved at list-shown, relay-token and list-answer');
  assert.deepEqual(
    saved[2].steps.map(([name]: [string]) => name),
    ['vault', 'account', 'list-shown', 'relay-token', 'list-answer'],
  );
  assert.match(traceLine(), /^vault \d+ · account \d+ · list-shown \d+ · relay-token \d+ · list-answer \d+$/);
  assert.ok(
    saved[2].steps.every(([, ms]: [string, number]) => ms >= 0 && ms < 60_000),
    'told from this module’s load, not the device’s boot',
  );
});

test('a store that fails to save loses a record quietly; without a store nothing is kept', async () => {
  resetTrace(timers().after);
  attachTraceStore({ load: async () => [], save: () => Promise.reject(new Error('disk')) });
  markChat('open', 1);
  markChat('rows-shown', 2);
  await flush();
  resetTrace(timers().after);
  markChat('open', 1);
  markChat('rows-shown', 2);
  assert.deepEqual(await loadTrace(), []);
  attachTraceStore({ load: () => Promise.reject(new Error('disk')), save: async () => undefined });
  assert.deepEqual(await loadTrace(), []);
});

test('the last few records of each kind are listed, newest first', async () => {
  resetTrace(timers().after);
  const mine = (kind: string, id: number) => ({ kind, id, at: id, steps: [['x', id]] });
  const rows = [
    ...Array.from({ length: KEPT.launch + 2 }, (_, i) => mine('launch', i + 1)),
    ...Array.from({ length: KEPT.chat + 3 }, (_, i) => mine('chat', i + 1)),
  ];
  attachTraceStore(fakeStore(rows).store);
  const list = await loadTrace();
  assert.deepEqual(
    list.filter((r: any) => r.kind === 'launch').map((r: any) => r.id),
    [7, 6, 5, 4, 3],
  );
  assert.equal(list.filter((r: any) => r.kind === 'chat').length, KEPT.chat);
  assert.equal(list.find((r: any) => r.kind === 'chat').id, KEPT.chat + 3);
});

test('a time is shown in seconds, with one decimal under ten, and a record with no step has none', () => {
  assert.equal(took({ steps: [['a', 380]] }), '0.4 s');
  assert.equal(took({ steps: [['a', 2140]] }), '2.1 s');
  assert.equal(took({ steps: [['a', 10_400]] }), '10 s');
  assert.equal(took({ steps: [] }), undefined);
});

const state: any = {
  phase: 'ready',
  generation: 1,
  user: { id: 'u', name: 'Dev' },
  pairs: [],
  presence: {},
  outbox: [],
  selectedPair: null,
  pendingPair: false,
  pairingCommit: false,
  pairCleanup: false,
  safetyNumber: null,
  error: null,
};
/** Settings › About; the launch timing tables are developer chrome, so they draw only with the dev endpoints a development build has. */
async function about(dev = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = { snapshot: () => state, subscribe: () => () => {}, start: async () => {}, request: async () => ({}) };
  await act(async () =>
    root.render(
      createElement(MobileApp, {
        runtime,
        version: '1.0.0 (8)',
        ...(dev && { devEndpoints: { relayUrl: 'ws://192.168.1.2:8787/v1/ws', accountOrigin: 'http://192.168.1.2:8787' } }),
      }),
    ),
  );
  await flush();
  await click('Settings');
  await click('About');
  await flush();
  const text = host.textContent!;
  await act(async () => root.unmount());
  host.remove();
  return text;
}

test('About lists the last launches and chat opens with their times and steps; with none it says so', async () => {
  resetTrace(timers().after);
  attachTraceStore(
    fakeStore([
      {
        kind: 'launch',
        id: 2,
        at: Date.UTC(2026, 10, 7, 12, 0),
        steps: [
          ['vault', 12],
          ['relay-hello', 9800],
          ['list-answer', 10_400],
        ],
      },
      {
        kind: 'chat',
        id: 3,
        at: Date.UTC(2026, 10, 7, 12, 1),
        steps: [
          ['open', 0],
          ['rows-shown', 2140],
        ],
      },
    ]).store,
  );
  const text = await about();
  assert.match(text, /No message sent yet\./);
  assert.match(text, /Version 1\.0\.0 \(8\)/);
  assert.match(text, /Last launches/);
  assert.match(text, /10 s/);
  assert.match(text, /vault 12 · relay-hello 9800 · list-answer 10400/);
  assert.match(text, /Last chat opens/);
  assert.match(text, /2\.1 s/);
  assert.match(text, /open 0 · rows-shown 2140/);
  resetTrace(timers().after);
  const none = await about();
  assert.match(none, /No launch recorded yet\./);
  assert.match(none, /No chat opened yet\./);
  // a store build has no dev endpoints, and shows neither table
  const store = await about(false);
  assert.match(store, /Version 1\.0\.0 \(8\)/);
  assert.doesNotMatch(store, /Last launches|Last chat opens|No launch recorded yet/);
});

test('the default save timer does not hold node open, and a timer that is a plain number (React Native) is left alone', () => {
  resetTrace();
  markChat('open', 1); // a real node timer, unref'd: the file ends without waiting 15 s
  const real = globalThis.setTimeout;
  try {
    (globalThis as any).setTimeout = () => 7;
    resetTrace();
    markChat('open', 1);
    assert.equal(traceLine(), '');
  } finally {
    globalThis.setTimeout = real;
    resetTrace();
  }
});

test('a chat left before its rows came is saved as far as it got when the next one opens, and its own timer saves it, not the next', () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  markChat('open', 100);
  markChat('follow-sent', 110);
  markChat('open', 5000);
  assert.deepEqual(saved[0].steps, [
    ['open', 0],
    ['follow-sent', 10],
  ]);
  t.queued[0][0]();
  assert.deepEqual(saved[1].steps, saved[0].steps, 'the first open’s timer writes the first open');
});

test('a send keeps the ms of each step after Send; the Mac’s share rides on its answer; events say when it was echoed, its turn began and its reply came', () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  markSend('dispatched', 5); // no message in flight: nothing
  markSendEvent({ ev: 'items.delta' });
  markSend('tap', 1000);
  markSend('dispatched', 1010);
  markSend('mac-done', 1910);
  markSendEvent({ ev: 'items.append', items: [{ type: 'userMessage' }] });
  markSendEvent({ ev: 'turn.state', status: 'completed' });
  markSendEvent({ ev: 'turn.state', status: 'inProgress' });
  markSendEvent({ ev: 'session.patch' });
  markSendEvent({ ev: 'items.append', items: [{ type: 'commandExecution' }, null] });
  markSendEvent({ ev: 'items.replace', items: 'not a list' });
  markSend('acked', 1950);
  assert.equal(saved.length, 1, 'saved once it was acked');
  markSendEvent({ ev: 'items.append', items: [{ type: 'agentMessage' }] });
  markSendEvent({ ev: 'items.delta' });
  assert.equal(saved.length, 2, 'and once the reply began');
  assert.equal(saved[1].kind, 'send');
  assert.deepEqual(
    saved[1].steps.map(([name]: [string]) => name),
    ['tap', 'dispatched', 'mac-done', 'echoed', 'turn-started', 'acked', 'first-delta'],
  );
  assert.deepEqual(saved[1].steps.slice(0, 3), [
    ['tap', 0],
    ['dispatched', 10],
    ['mac-done', 910],
  ]);
});

test('the last sends are listed after the chat opens, newest first', async () => {
  resetTrace(timers().after);
  const mine = (id: number) => ({ kind: 'send', id, at: id, steps: [['tap', 0]] });
  attachTraceStore(fakeStore(Array.from({ length: KEPT.send + 2 }, (_, i) => mine(i + 1))).store);
  const list = await loadTrace();
  assert.equal(list.filter((r: any) => r.kind === 'send').length, KEPT.send);
  assert.equal(list.find((r: any) => r.kind === 'send').id, KEPT.send + 2);
});

test('the outbox notes a message’s tap, its dispatch, the Mac’s share when the answer says it, and its ack', async () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  for (const answer of [{ sent: true, tookMs: 40 }, { sent: true }, null]) {
    saved.length = 0;
    const box = createOutbox({
      online: () => true,
      send: async () => answer,
      lost: () => false,
      idempotent: () => true,
      ready: async () => true,
      newId: () => 'send-1',
      now: () => 1,
      onChange: () => undefined,
    });
    box.add({ pairId: 'p1', chatId: 'c1', text: 'hi', attachments: [] });
    await sleep(5);
    const names = saved.at(-1).steps.map(([n]: [string]) => n);
    assert.deepEqual(
      names,
      answer?.tookMs === undefined
        ? ['tap', 'ready-sent', 'ready-answered', 'dispatched', 'acked']
        : ['tap', 'ready-sent', 'ready-answered', 'dispatched', 'mac-done', 'acked'],
    );
  }
});

test('a send is over once it is acked and its reply began, or when its timer runs: a later event is not one of its steps', () => {
  const t = timers();
  resetTrace(t.after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  markSend('tap', 100);
  markSendEvent({ ev: 'items.delta' });
  markSend('acked', 150);
  markSendEvent({ ev: 'turn.state', status: 'running' });
  markSend('echoed', 9_000_000);
  assert.deepEqual(
    saved.at(-1).steps.map(([name]: [string]) => name),
    ['tap', 'first-delta', 'acked'],
    'the reply came before the ack; nothing after both is added',
  );
  // one that is never answered is kept by its timer and closed
  markSend('tap', 200);
  markSend('dispatched', 210);
  t.queued.at(-1)![0]();
  assert.deepEqual(
    saved.at(-1).steps.map(([name]: [string]) => name),
    ['tap', 'dispatched'],
  );
  markSendEvent({ ev: 'items.delta' });
  assert.equal(saved.at(-1).steps.length, 2, 'a later reply row is not added to the closed record');
  // a timer of a send that the next one replaced leaves the newer one open
  markSend('tap', 300);
  const stale = t.queued.at(-1)![0];
  markSend('tap', 400);
  stale();
  markSend('dispatched', 410);
  assert.ok(saved.length >= 1);
});

test('overlapping sends cannot put an older acknowledgment or another chat’s reply in the newest trace', () => {
  resetTrace(timers().after);
  const { store, saved } = fakeStore();
  attachTraceStore(store);
  const a = { id: 'a', pairId: 'p', chatId: 'same' };
  const b = { id: 'b', pairId: 'p', chatId: 'same', momo: true };
  markSend('tap', 100, a);
  markSend('dispatched', 110, a);
  markSend('tap', 200, b);
  markSend('acked', 300, a);
  markSendEvent({ ev: 'items.delta' }, a);
  markSendEvent({ ev: 'items.delta' }, { ...b, pairId: 'other' });
  markSendEvent({ ev: 'items.delta' }, { ...b, chatId: 'other' });
  markSendEvent({ ev: 'items.delta' });
  markSend('dispatched', 210, b);
  markSend('acked', 250, b);
  assert.deepEqual(saved.at(-1).steps, [
    ['tap', 0],
    ['dispatched', 10],
    ['acked', 50],
  ]);
  markSendEvent({ ev: 'items.delta' }, b);
  assert.equal(saved.at(-1).steps.at(-1)[0], 'first-delta');
  assert.equal(JSON.stringify(saved).includes('pairId'), false, 'ownership stays in memory, never in saved traces');
  resetTrace(timers().after);
  markSend('acked', 500, b);
  markSendEvent({ ev: 'items.delta' }, b);
});
