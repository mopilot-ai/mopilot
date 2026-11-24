// The app's half of the tool relay (electron/host/toolRelay.cjs, package 2.6): the app announces its browser tools to a Host, runs each call a harness on that Host makes through its own registry, and answers within what one message may carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../shared/host/schema.mjs';
import { tick } from './support/host-wire-kit.ts';

const require = createRequire(import.meta.url);
const { createToolRelay, answerOf } = require('../electron/host/toolRelay.cjs');

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Open a page',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    policy: 'act',
  },
  { name: 'browser_read', description: 'Read the page', inputSchema: { type: 'object', properties: {} }, policy: 'observe' },
  { name: 'desktop_click', description: 'Click', inputSchema: { type: 'object', properties: {} }, policy: 'act' },
];
const call = (patch: object = {}) => ({
  event: 'tool',
  chatId: 'c1',
  segmentId: 's1',
  callId: 'call-1',
  name: 'browser_navigate',
  arguments: { url: 'https://shop.test/' },
  epoch: 4,
  ...patch,
});

/** A remote Host as the relay sees it: what it was asked, the events and states it can be given. */
function world(o: { state?: string; owned?: (chatId: string, epoch: number) => boolean } = {}) {
  let state = o.state ?? 'online';
  const events = new Set<(e: any) => void>();
  const states = new Set<(s: string) => void>();
  const sent: { method: string; params: any }[] = [];
  let fail: unknown = null;
  const host = {
    tools: {
      request: async (method: string, params: any) => {
        sent.push({ method, params });
        if (fail) throw fail;
        return {};
      },
      onEvent: (fn: (e: any) => void) => (events.add(fn), () => void events.delete(fn)),
    },
    hostInfo: () => ({ state }),
    onState: (fn: (s: string) => void) => (states.add(fn), () => void states.delete(fn)),
  };
  /** the registry's runs: each call waits for the test to finish it */
  const runs: { args: any[]; finish: (res: any) => void }[] = [];
  const stopped: [string, string][] = [];
  const registry = {
    list: () => TOOLS,
    invoke: (...args: any[]) =>
      new Promise((finish) => {
        runs.push({ args, finish });
      }),
    abortChat: (chatId: string, why: string) => void stopped.push([chatId, why]),
  };
  const reports: [string, unknown][] = [];
  const relay = createToolRelay({
    host,
    registry,
    include: (t: { name: string }) => t.name.startsWith('browser_'),
    owns: o.owned ?? ((chatId: string) => chatId.startsWith('c')),
    report: (what: string, error: unknown) => reports.push([what, error]),
  });
  return {
    relay,
    sent,
    runs,
    stopped,
    reports,
    push: (e: any) => [...events].forEach((fn) => fn(e)),
    go: (s: string) => {
      state = s;
      [...states].forEach((fn) => fn(s));
    },
    failWith: (e: unknown) => (fail = e),
    listeners: () => events.size + states.size,
  };
}
const ok = (content: any[] = [{ type: 'text', text: 'done' }], more: object = {}) => ({ ok: true, content, ...more });
const results = (w: ReturnType<typeof world>) => w.sent.filter((s) => s.method === 'host.toolResult').map((s) => s.params);

test('the app announces the tools a Host can use when the connection is up, again after every reconnect, and on request', async () => {
  const w = world();
  await tick();
  assert.deepEqual(
    w.sent.map((s) => s.method),
    ['host.toolsSync'],
  );
  assert.deepEqual(
    w.sent[0].params.tools.map((t: any) => t.name),
    ['browser_navigate', 'browser_read'],
    'the surfaces a remote Host cannot serve are not offered',
  );
  assert.deepEqual(w.sent[0].params.tools[0], TOOLS[0]);
  w.go('connecting');
  w.go('offline');
  assert.equal(w.sent.length, 1, 'nothing is said to a Host that is not there');
  w.go('online');
  w.relay.resync();
  assert.equal(w.sent.length, 3);
  w.relay.dispose();
  w.relay.resync();
  assert.equal(w.sent.length, 3, 'a connection that ended hears nothing');
  assert.equal(w.listeners(), 0);
  assert.deepEqual(w.reports, []);
});

test('a connection that is not up yet announces when it comes up; a Host without the tools feature is left alone, and any other failure is reported', async () => {
  const w = world({ state: 'connecting' });
  assert.equal(w.sent.length, 0);
  w.failWith(Object.assign(new Error('The Host does not speak tools.'), { missing: ['tools'] }));
  w.go('online');
  await tick();
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.reports, [], 'a Host that cannot relay is not an error');
  const odd = new Error('disk full');
  w.failWith(odd);
  w.relay.resync();
  await tick();
  assert.deepEqual(w.reports, [['announce the app’s tools to a Host', odd]]);
});

test('a call from the Host runs through the registry as the chat’s call, and its answer carries the call’s chat, id and epoch', async () => {
  const w = world();
  w.push(call());
  await tick();
  assert.equal(w.runs.length, 1);
  const [chatId, segmentId, name, args, opts] = w.runs[0].args;
  assert.deepEqual([chatId, segmentId, name, args, opts.callId], ['c1', 's1', 'browser_navigate', { url: 'https://shop.test/' }, 'call-1']);
  assert.equal(opts.signal.aborted, false);
  w.runs[0].finish(ok([{ type: 'text', text: 'Opened' }], { endsTurn: true }));
  await tick();
  assert.deepEqual(results(w), [
    { chatId: 'c1', callId: 'call-1', epoch: 4, ok: true, content: [{ type: 'text', text: 'Opened' }], endsTurn: true },
  ]);
  // a plain success does not end the turn
  w.push(call({ callId: 'call-2' }));
  await tick();
  w.runs[1].finish(ok());
  await tick();
  assert.equal('endsTurn' in results(w)[1], false);
});

test('a failed call is answered with its error: a code of at most 64 characters, a message of at most 16 KB, and a default when it has none', async () => {
  const w = world();
  w.push(call({ callId: 'a' }));
  w.push(call({ callId: 'b' }));
  w.push(call({ callId: 'c' }));
  await tick();
  w.runs[0].finish({ ok: false, content: [], error: { code: 'denied', message: 'The user did not allow this action' } });
  w.runs[1].finish({ ok: false, content: [], error: { code: 'x'.repeat(100), message: 'y'.repeat(20000) } });
  w.runs[2].finish({ ok: false });
  await tick();
  const [denied, long, bare] = results(w);
  assert.deepEqual(denied.error, { code: 'denied', message: 'The user did not allow this action' });
  assert.equal(long.error.code.length, 64);
  assert.equal(long.error.message.length, 16 * 1024);
  assert.deepEqual(bare, {
    chatId: 'c1',
    callId: 'c',
    epoch: 4,
    ok: false,
    content: [],
    error: { code: 'failed', message: 'The tool failed.' },
  });
});

test('B: a call that does not say what it is, in which chat and epoch, is reported and runs nothing; arguments that are not an object become none', async () => {
  const w = world();
  for (const bad of [{ chatId: '' }, { segmentId: undefined }, { callId: 7 }, { name: null }, { epoch: 1.5 }, { epoch: 'x' }])
    w.push(call(bad));
  await tick();
  assert.equal(w.runs.length, 0);
  assert.equal(w.reports.length, 6);
  assert.equal(w.reports[0][0], 'read a tool call from a Host');
  w.push(call({ arguments: 'not an object' }));
  w.push({ event: 'frame' });
  w.push(null);
  await tick();
  assert.deepEqual(w.runs[0].args[3], {});
});

test('A: the same call twice while it runs runs once; the same id in another chat is another call', async () => {
  const w = world();
  w.push(call());
  w.push(call());
  w.push(call({ chatId: 'c2' }));
  await tick();
  assert.equal(w.runs.length, 2);
  w.runs[0].finish(ok());
  await tick();
  // once it is answered the id is free again (the registry answers a repeat from its own record)
  w.push(call());
  await tick();
  assert.equal(w.runs.length, 3);
});

test('A: the Host cancelling a call aborts that call, stops the chat’s tabs as a Stop would, and does not answer it', async () => {
  const w = world();
  w.push(call({ callId: 'a' }));
  w.push(call({ callId: 'b' }));
  await tick();
  w.push({ event: 'toolCancel', chatId: 'c1', callId: 'a', epoch: 3 });
  w.push({ event: 'toolCancel', chatId: 'c1', callId: 'b' });
  assert.equal(w.runs[0].args[4].signal.aborted, false);
  w.push({ event: 'toolCancel', chatId: 'c1', callId: 'a', epoch: 4 });
  w.push({ event: 'toolCancel', chatId: 'other', callId: 'b', epoch: 4 });
  w.push({ event: 'toolCancel', chatId: 'c1', callId: 'unknown', epoch: 4 });
  assert.equal(w.runs[0].args[4].signal.aborted, true);
  assert.equal(w.runs[1].args[4].signal.aborted, false, 'another chat’s cancel is not this call’s');
  assert.deepEqual(
    w.stopped,
    [['c1', 'stopped']],
    'the chat’s tabs are stopped as a Stop here would stop them, and only for a call that was running',
  );
  w.runs[0].finish({ ok: false, content: [], error: { code: 'aborted', message: 'The call was cancelled' } });
  w.runs[1].finish(ok());
  await tick();
  assert.deepEqual(
    results(w).map((r) => r.callId),
    ['b'],
  );
});

test('the relay withholds results and limits cancellation after the call loses its chat or turn', async () => {
  let epoch = 4;
  const w = world({ owned: (_chat, mine) => mine === epoch });
  w.push(call({ callId: 'move' }));
  w.push(call({ callId: 'cancel' }));
  await tick();
  epoch = 5;
  w.push({ event: 'toolCancel', chatId: 'c1', callId: 'cancel', epoch: 4 });
  assert.equal(w.runs[1].args[4].signal.aborted, true);
  assert.deepEqual(w.stopped, []);
  const privateResult = { ok: true, content: [{ type: 'text', text: 'private' }] };
  w.runs[1].finish(privateResult);
  w.runs[0].finish(privateResult);
  w.push(call({ callId: 'turn', epoch: 5 }));
  await tick();
  w.runs[2].finish({ ...privateResult, canDeliver: () => false });
  await tick();
  assert.deepEqual(
    w.sent.slice(1).map(({ params }) => [params.callId, params.ok, params.content]),
    [
      ['move', false, []],
      ['turn', false, []],
    ],
  );
});

test('A: the connection going aborts every call under way and answers none; a connection that ended answers none either', async () => {
  const w = world();
  w.push(call({ callId: 'a' }));
  w.push(call({ callId: 'b' }));
  await tick();
  w.go('offline');
  assert.deepEqual(
    w.runs.map((r) => r.args[4].signal.aborted),
    [true, true],
  );
  w.runs[0].finish(ok());
  w.runs[1].finish(ok());
  await tick();
  assert.deepEqual(results(w), []);
  // a call that finishes after the relay was disposed is not answered
  w.go('online');
  w.push(call({ callId: 'c' }));
  await tick();
  w.relay.dispose();
  w.runs[2].finish(ok());
  await tick();
  assert.deepEqual(results(w), []);
  // and events after that are not heard
  w.push(call({ callId: 'd' }));
  await tick();
  assert.equal(w.runs.length, 3);
});

test('B: an answer the Host cannot take is reported, not thrown; a registry that throws is reported too', async () => {
  const w = world();
  w.push(call());
  await tick();
  const refused = new Error('stale epoch');
  w.failWith(refused);
  w.runs[0].finish(ok());
  await tick();
  assert.deepEqual(w.reports.at(-1), ['answer a tool call from a Host', refused]);
  // the registry never throws, but a bug in it must not become an unhandled rejection
  const boom = new Error('boom');
  const r = world();
  (r.relay as any).dispose();
  const throwing = createToolRelay({
    host: {
      tools: { request: async () => ({}), onEvent: (fn: any) => ((globalThis as any).__relayPush = fn) && (() => undefined) },
      hostInfo: () => ({ state: 'connecting' }),
      onState: () => () => undefined,
    },
    registry: {
      list: () => TOOLS,
      invoke: () => {
        throw boom;
      },
    },
    owns: () => true,
    report: (what: string, e: unknown) => ((globalThis as any).__relayReport = [what, e]),
  });
  (globalThis as any).__relayPush(call());
  await tick();
  assert.deepEqual((globalThis as any).__relayReport, ['run a tool call from a Host', boom]);
  throwing.dispose();
});

test('every answer the relay can make is one the wire takes: the shared parser accepts it', () => {
  const huge = [
    { type: 'text', text: 'x'.repeat(5 * 1024 * 1024) },
    { type: 'image', data: 'A'.repeat(9 * 1024 * 1024), mimeType: 'image/png' },
    { type: 'image', data: 'A'.repeat(3 * 1024 * 1024), mimeType: 'image/jpeg' },
    { type: 'image', data: 'A'.repeat(3 * 1024 * 1024), mimeType: 'image/jpeg' },
    { type: 'resource', uri: 'file:///x' },
    ...Array.from({ length: 80 }, (_, i) => ({ type: 'text', text: String(i) })),
  ];
  for (const res of [
    ok(huge),
    ok(huge, { endsTurn: true }),
    { ok: false, content: huge, error: { code: 'c'.repeat(200), message: 'm'.repeat(50000) } },
    { ok: false },
    ok([]),
  ]) {
    const params = { chatId: 'c1', callId: 'call-1', epoch: 4, ...answerOf(res) };
    assert.doesNotThrow(() => parseParams('host.toolResult', params));
  }
  assert.doesNotThrow(() => parseParams('host.toolsSync', { tools: TOOLS }));
});

test('the defaults: every tool is offered, and a problem nobody asked to hear of is not thrown', async () => {
  const sent: any[] = [];
  let push: (e: any) => void = () => undefined;
  const relay = createToolRelay({
    host: {
      tools: {
        request: async (method: string, params: any) => (sent.push([method, params]), {}),
        onEvent: (fn: (e: any) => void) => ((push = fn), () => undefined),
      },
      hostInfo: () => ({ state: 'online' }),
      onState: () => () => undefined,
    },
    // a registry with no abortChat (a stand-in): a cancel still ends the call
    registry: {
      list: () => TOOLS,
      invoke: (_c: string, _s: string, _n: string, _a: unknown, o: any) =>
        o.callId === 'z' ? new Promise(() => undefined) : Promise.resolve(ok()),
    },
  });
  await tick();
  assert.deepEqual(
    sent[0][1].tools.map((t: any) => t.name),
    ['browser_navigate', 'browser_read', 'desktop_click'],
  );
  push({ event: 'tool', chatId: 'c1', segmentId: 's', callId: 'z', name: 'browser_read', arguments: {}, epoch: 1 });
  await tick();
  assert.doesNotThrow(() => push({ event: 'toolCancel', chatId: 'c1', callId: 'z', epoch: 1 }));
  push({ event: 'tool', chatId: 'c1' });
  await tick();
  // without an ownership check the call for 'z' was refused (and answered as such); a call that names nothing runs nothing and has nothing to answer
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].error.code, 'unavailable');
  relay.dispose();
  // a Host event already on its way when the connection ended is not run
  push(call());
  await tick();
  assert.equal(sent.length, 2);
});

test('a Host can call only the tools it was announced, and only for a chat that runs on it', async () => {
  const w = world({ owned: (chatId) => chatId === 'c1' });
  // tools the app keeps from this Host (desktop_*, or one nobody registered), a chat of this Mac's own, and a chat of another machine
  w.push(call({ callId: 'a', name: 'desktop_click' }));
  w.push(call({ callId: 'b', name: 'desktop_screenshot' }));
  w.push(call({ callId: 'c', name: 'list_sidebar' }));
  w.push(call({ callId: 'd', chatId: 'local-chat' }));
  w.push(call({ callId: 'e', chatId: 'c2' }));
  await tick();
  assert.equal(w.runs.length, 0, 'nothing ran');
  assert.deepEqual(
    w.reports.map(([what]) => what),
    Array(5).fill('refuse a tool call from a Host'),
  );
  assert.deepEqual(
    results(w).map((r: any) => [r.callId, r.ok, r.error.code]),
    ['a', 'b', 'c', 'd', 'e'].map((id) => [id, false, 'unavailable']),
    'a refused call is answered with a refusal, so the Host does not wait out its timeout',
  );
  // the same call for its own chat and an announced tool still runs
  w.push(call({ callId: 'f' }));
  await tick();
  assert.equal(w.runs.length, 1);
});

test('a relay made without an ownership check runs no call', async () => {
  const events = new Set<(e: any) => void>();
  const runs: unknown[] = [];
  const reports: unknown[] = [];
  createToolRelay({
    host: {
      tools: { request: async () => ({}), onEvent: (fn: (e: any) => void) => (events.add(fn), () => void events.delete(fn)) },
      hostInfo: () => ({ state: 'offline' }),
      onState: () => () => undefined,
    },
    registry: { list: () => TOOLS, invoke: async (...a: unknown[]) => runs.push(a) },
    report: (...a: unknown[]) => reports.push(a),
  });
  [...events].forEach((fn) => fn(call()));
  await tick();
  assert.equal(runs.length, 0);
  assert.equal(reports.length, 1);
});

test("an answer too big in bytes for one message (multi-byte text is under the character budget) is told as too large, not lost to the Host's timeout", async () => {
  const w = world();
  w.push(call({ callId: 'wide' }));
  await tick();
  const wide = { type: 'text', text: '界'.repeat(1024 * 1024) };
  w.runs[0].finish(ok([wide, wide, wide]));
  await tick();
  assert.deepEqual(
    results(w).map((r: any) => [r.callId, r.ok, r.error?.code]),
    [['wide', false, 'too_large']],
  );
});

test('a refusal the Host cannot be told of (the connection is going) is reported, not thrown', async () => {
  const w = world({ owned: () => false });
  const down = new Error('The connection closed.');
  await tick();
  w.failWith(down);
  w.push(call({ callId: 'gone' }));
  await tick();
  assert.deepEqual(
    w.reports.map(([what]) => what),
    ['refuse a tool call from a Host', 'answer a refused tool call from a Host'],
  );
  assert.equal(w.reports[1][1], down);
});

test('a harness on a Host is told about the browser and the desktop tools only: not the user’s Chrome, the older Mac-only computer tools, or the app’s own tools', () => {
  const { hostToolFamily } = require('../electron/host/toolRelay.cjs');
  for (const name of ['browser_navigate', 'desktop_screenshot', 'desktop_app_click', 'desktop_request_access'])
    assert.equal(hostToolFamily({ name }), true, name);
  for (const name of ['chrome_tabs', 'computer_click', 'sage_send_message', 'list_chats', 'mybrowser_x', 'desktop'])
    assert.equal(hostToolFamily({ name }), false, name);
});

test('the desktop tools are announced only to a Host that has a desktop; the browser’s always; the list is sent again when that flips', () => {
  const { hostToolsFor } = require('../electron/host/toolRelay.cjs');
  let has = false;
  const include = hostToolsFor(() => has);
  assert.equal(include({ name: 'browser_navigate' }), true);
  assert.equal(include({ name: 'desktop_screenshot' }), false, 'a Host with no desktop is not shown tools that only fail');
  assert.equal(include({ name: 'list_chats' }), false);
  has = true;
  assert.equal(include({ name: 'desktop_screenshot' }), true);
});
