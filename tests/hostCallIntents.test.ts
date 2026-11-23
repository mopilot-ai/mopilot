// The acting calls a Host has sent and not heard back from (host/src/callIntents.mjs, #4278): written before each is sent by the tool relay, the desktop and the browser protocol, and settled as lost by the next Host in the end of the turn they belonged to, with the turn's open tool cards settled too. Nothing sends one again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBrowserProtocol } from '../host/src/browserProtocol.mjs';
import { createCallIntents, lostCalls, tracked } from '../host/src/callIntents.mjs';
import { acts } from '../host/src/cdpRules.mjs';
import { createDesktopProtocol } from '../host/src/desktopProtocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createRecovery } from '../host/src/recovery.mjs';
import { createToolRelay } from '../host/src/toolRelay.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-calls-'));
const onDisk = (dir: string, name = 'calls.json') => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const call = (chatId: string, name: string, kind = 'tool') => ({ chatId, kind, name }) as any;
/** A Host that holds the data folder: its records are written from here on. */
function armed(dir: string, o: object = {}) {
  const intents = createCallIntents({ dataDir: dir, ...o });
  intents.start([]);
  return intents;
}
/** Timers a test fires itself. */
function clock() {
  const due: (() => void)[] = [];
  return {
    setTimer: ((fn: () => void) => (due.push(fn), { unref: () => undefined })) as any,
    fire: () => due.splice(0).forEach((fn) => fn()),
  };
}

test('A: a call is on disk from before it is sent until it is answered; nothing is written before this Host holds the folder', () => {
  const dir = dirOf();
  const early = createCallIntents({ dataDir: dir });
  early.begin('x', call('c', 'too_early'));
  assert.equal(fs.existsSync(path.join(dir, 'calls.json')), false);
  early.end('x');
  const intents = armed(dir);
  assert.deepEqual(onDisk(dir), []);
  intents.begin('1', call('c', 'send_mail'));
  intents.begin('2', call('c', 'input.click', 'desktop'));
  assert.deepEqual(onDisk(dir), [call('c', 'send_mail'), call('c', 'input.click', 'desktop')]);
  intents.end('1');
  intents.end('never begun');
  assert.deepEqual(onDisk(dir), [call('c', 'input.click', 'desktop')]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['calls-lost.json', 'calls.json'], 'no temporary file is left');
  assert.equal(fs.statSync(path.join(dir, 'calls.json')).mode & 0o777, 0o600);
});

test('B: the same call of a chat many times over is one record and one write, kept until the last of them ends; a burst of browser input is written once', () => {
  const dir = dirOf();
  const writes: string[] = [];
  const io = { ...fs, renameSync: (a: string, b: string) => (writes.push(path.basename(b)), fs.renameSync(a, b)) } as typeof fs;
  const timers = clock();
  const intents = armed(dir, { io, setTimer: timers.setTimer });
  writes.length = 0;
  intents.begin('1', call('c', 'send_mail'));
  intents.begin('2', call('c', 'send_mail'));
  intents.end('1');
  assert.deepEqual(onDisk(dir), [call('c', 'send_mail')], 'one is still under way');
  intents.end('2');
  assert.deepEqual(onDisk(dir), []);
  assert.equal(writes.length, 2);
  // 200 key and button events of a take-over: one record while they come, cleared a moment after the last was answered
  writes.length = 0;
  for (let i = 0; i < 200; i++) {
    intents.begin(`k${i}`, call('c', 'input', 'browser'));
    intents.end(`k${i}`);
  }
  assert.deepEqual(onDisk(dir), [call('c', 'input', 'browser')]);
  assert.equal(writes.length, 1);
  intents.begin('still', call('c', 'input', 'browser'));
  timers.fire();
  assert.deepEqual(onDisk(dir), [call('c', 'input', 'browser')], 'a timer that finds one under way leaves the record');
  intents.end('still');
  timers.fire();
  assert.deepEqual(onDisk(dir), []);
  assert.equal(writes.length, 2);
});

test('I: the next Host keeps the unanswered calls for the turn it ends, each named once, and drops the rest with a report', () => {
  const dir = dirOf();
  const first = armed(dir);
  for (const [id, c] of Object.entries({
    1: call('a', 'send_mail'),
    2: call('a', 'navigation', 'browser'),
    3: call('gone', 'input.click', 'desktop'),
  }))
    first.begin(id, c);
  const reports: string[] = [];
  const next = createCallIntents({ dataDir: dir, report: (m: string) => reports.push(m) });
  assert.equal(next.start([['t1', 'a']]).length, 2);
  assert.deepEqual(reports, ['Dropped 1 unanswered call(s) of chats with no turn to end.']);
  assert.deepEqual(lostCalls(dir, 'a', 't1'), [
    { kind: 'tool', name: 'send_mail' },
    { kind: 'browser', name: 'navigation' },
  ]);
  assert.deepEqual(lostCalls(dir, 'a', 'another turn'), []);
  assert.deepEqual(lostCalls(dir, 'gone', 't1'), []);
  assert.deepEqual(onDisk(dir), [], 'the new Host starts with none of its own');
  // a Host that died before it could end the turn: the one after it still has them for that turn
  assert.equal(createCallIntents({ dataDir: dir }).start([['t1', 'a']]).length, 2);
  assert.deepEqual(lostCalls(dir, 'a', 't1').length, 2);
});

test('#4278: calls an earlier restart lost are not told again for a later turn of the same chat', () => {
  const dir = dirOf();
  armed(dir).begin('1', call('a', 'send_mail'));
  createCallIntents({ dataDir: dir }).start([['t1', 'a']]);
  assert.equal(lostCalls(dir, 'a', 't1').length, 1);
  // t1 was ended; the chat ran t2, which had sent nothing when the Host died again
  assert.deepEqual(createCallIntents({ dataDir: dir }).start([['t2', 'a']]), []);
  assert.deepEqual(lostCalls(dir, 'a', 't2'), []);
  assert.deepEqual(lostCalls(dir, 'a', 't1'), []);
  // and one that t2 did send is t2's alone
  armed(dir).begin('2', call('a', 'post_form'));
  assert.deepEqual(createCallIntents({ dataDir: dir }).start([['t3', 'a']]), [{ ...call('a', 'post_form'), turnId: 't3' }]);
});

test('B: at most five are named; a damaged or foreign record is reported as not known, not a crash', () => {
  const dir = dirOf();
  const first = armed(dir);
  for (let i = 0; i < 7; i++) first.begin(String(i), call('a', `tool_${i}`));
  createCallIntents({ dataDir: dir }).start([['t1', 'a']]);
  assert.deepEqual(
    lostCalls(dir, 'a', 't1').map((c) => c.name),
    ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4'],
  );
  fs.writeFileSync(path.join(dir, 'calls.json'), '{broken');
  fs.writeFileSync(
    path.join(dir, 'calls-lost.json'),
    JSON.stringify([
      null,
      5,
      { chatId: 'a' },
      { chatId: 'a', kind: 'other', name: 'x', turnId: 't1' },
      { chatId: 1, kind: 'tool', name: 'x', turnId: 't1' },
      { chatId: 'a', kind: 'tool', name: 7, turnId: 't1' },
    ]),
  );
  assert.deepEqual(lostCalls(dir, 'a', 't1'), []);
  const reports: string[] = [];
  assert.equal(createCallIntents({ dataDir: dir, report: (m: string) => reports.push(m) }).start([['t1', 'a']]).length, 0);
  assert.deepEqual(reports, ['calls.json could not be read, so the calls it held are not known.']);
  // a Host given nowhere to report still starts
  fs.writeFileSync(path.join(dir, 'calls.json'), '{broken');
  assert.deepEqual(createCallIntents({ dataDir: dir }).start([]), []);
  assert.deepEqual(lostCalls(dirOf(), 'a', 't1'), [], 'a folder with no record');
});

test('B: a record that cannot be written is reported and the call still runs; the next write that works carries what the failed one missed', async () => {
  const dir = dirOf();
  const reports: string[] = [];
  let full = true;
  const io = { ...fs, renameSync: (a: string, b: string) => (full ? assert.fail('disk full') : fs.renameSync(a, b)) } as typeof fs;
  const intents = createCallIntents({ dataDir: dir, io, report: (m: string) => reports.push(m) });
  // what the last Host left is not wiped when it could not be moved: the Host after this one still finds it
  fs.writeFileSync(path.join(dir, 'calls.json'), JSON.stringify([call('a', 'send_mail')]));
  assert.deepEqual(intents.start([['t1', 'a']]), [{ ...call('a', 'send_mail'), turnId: 't1' }]);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^calls-lost\.json: /);
  assert.deepEqual(onDisk(dir), [call('a', 'send_mail')]);
  assert.equal(await tracked(intents, call('c', 'input.click', 'desktop'), async () => 'ran'), 'ran');
  assert.equal(reports.length, 3, 'the begin and the end each said so');
  intents.begin('1', call('c', 'send_mail'));
  full = false;
  // the same call again would not write by itself: it does, because the file does not hold the record yet
  intents.begin('2', call('c', 'send_mail'));
  assert.deepEqual(onDisk(dir), [call('c', 'send_mail')]);
});

test('A: tracked records an acting call around its run, whether it answers or fails; a read and a Host without records run bare', async () => {
  const seen: string[] = [];
  const intents = { begin: (_id: string, c: any) => seen.push(`begin ${c.name}`), end: () => seen.push('end') };
  assert.equal(await tracked(intents, call('c', 'a'), async () => 1), 1);
  await assert.rejects(
    tracked(intents, call('c', 'b'), async () => Promise.reject(new Error('no'))),
    /no/,
  );
  assert.deepEqual(seen, ['begin a', 'end', 'begin b', 'end']);
  assert.equal(await tracked(intents, null, async () => 2), 2);
  assert.equal(await tracked(undefined, call('c', 'c'), async () => 3), 3);
  assert.equal(seen.length, 4);
});

test('A: the relay records a call that acts before it reaches the app and clears it on every ending; a call that only looks is not recorded', async () => {
  const dir = dirOf();
  const intents = armed(dir);
  const registry = new Registry();
  let n = 0;
  const relay = createToolRelay({ registry, intents, newId: () => `call-${++n}` });
  const sent: any[] = [];
  const app = relay.attach(
    (m: object) => sent.push(m),
    () => 1,
  );
  app.sync([
    { name: 'send_mail', description: 'd', inputSchema: { type: 'object' }, policy: 'act' },
    { name: 'read_page', description: 'd', inputSchema: { type: 'object' }, policy: 'observe' },
  ]);
  app.send('c');
  const acting = registry.invoke('c', 's', 'send_mail', {});
  const looking = registry.invoke('c', 's', 'read_page', {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(onDisk(dir), [call('c', 'send_mail')], 'on disk when the app was told');
  assert.deepEqual(
    sent.map((m) => m.name),
    ['send_mail', 'read_page'],
  );
  app.result({ chatId: 'c', callId: 'call-1', ok: true, content: [] });
  app.result({ chatId: 'c', callId: 'call-2', ok: true, content: [] });
  await Promise.all([acting, looking]);
  assert.deepEqual(onDisk(dir), []);
  // an app that goes away ends the call, and the record with it
  const waiting = registry.invoke('c', 's', 'send_mail', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(onDisk(dir).length, 1);
  app.detach();
  await waiting;
  assert.deepEqual(onDisk(dir), []);
});

test('A: the desktop records an action and not a reading; the browser records input and navigation and not a hover, a script or a read', async () => {
  const dir = dirOf();
  const timers = clock();
  const intents = armed(dir, { setTimer: timers.setTimer });
  const epochs: any = { admit: () => undefined };
  const during: any[] = [];
  const desktop: any = { call: async (...a: any[]) => (during.push(onDisk(dir)), a[4]) };
  const seat = createDesktopProtocol({ desktop, epochs, intents }).connection();
  const act = (method: string) => seat.call('desktop.call', { chatId: 'c', epoch: 1, callId: 'k', method, params: {} });
  assert.equal(await act('input.click'), 'input.click');
  assert.equal(await act('screenshot'), 'screenshot');
  assert.deepEqual(during, [[call('c', 'input.click', 'desktop')], []]);
  const browser: any = { command: async (_c: string, r: any) => (during.push(onDisk(dir).map((c: any) => c.name)), { method: r.method }) };
  const tabs = createBrowserProtocol({ browser, epochs, intents }).connection(() => undefined);
  const send = async (method: string, params: object = {}) => {
    const result = await tabs.call('browser.command', { chatId: 'c', epoch: 1, targetId: 't', sessionId: '', method, params });
    timers.fire();
    return result;
  };
  during.length = 0;
  assert.deepEqual(await send('Input.dispatchMouseEvent', { type: 'mousePressed' }), { method: 'Input.dispatchMouseEvent' });
  await send('Page.navigate');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved' });
  await send('Runtime.evaluate');
  await send('Page.captureScreenshot');
  assert.deepEqual(during, [['input'], ['navigation'], [], [], []]);
  assert.deepEqual(onDisk(dir), []);
  assert.deepEqual(
    ['DOM.setFileInputFiles', 'Page.handleJavaScriptDialog', 'Page.reload', 'Input.insertText', 'DOM.getDocument'].map((m) => acts(m)),
    ['input', 'input', 'navigation', 'input', null],
  );
  assert.equal(acts('Input.dispatchMouseEvent', { type: 'mouseWheel' }), null);
});

test('#4278: calls in flight when a Host dies are settled by the next one: the turn ends naming them as lost, its open cards are closed, and none is sent again', async () => {
  const dir = dirOf();
  const quiet = { report: () => undefined };
  const chat = 'acp:kimi:w';
  /** One Host on the data folder, with a client that subscribed to the chat. */
  const boot = async () => {
    const host: any = new EventEmitter();
    host.cancel = () => undefined;
    const recovery = createRecovery({ dataDir: dir });
    const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
    const protocol = createProtocol({
      dataDir: dir,
      runtime: { host, send: async () => ({ turnId: 't' }), permit: () => true } as any,
      epochs,
      guard: createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) }),
      status: () => ({ running: true }),
      journal: recovery.journal,
    });
    const done = await recovery.run(protocol);
    const registry = new Registry();
    const relay = createToolRelay({ registry, intents: recovery.intents, newId: () => 'relay-1' });
    const sent: any[] = [];
    const app = relay.attach(
      (m: object) => sent.push(m),
      () => 1,
    );
    app.sync([{ name: 'send_mail', description: 'd', inputSchema: { type: 'object' }, policy: 'act' }]);
    app.send(chat);
    return { host, protocol, recovery, registry, sent, done };
  };
  const first = await boot();
  first.host.emit('event', { kind: 'turnStart', key: chat, turnId: 't1' });
  first.host.emit('event', {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'send_mail', status: 'in_progress' },
  });
  void first.registry.invoke(chat, 's', 'send_mail', {});
  await new Promise((r) => setImmediate(r));
  first.recovery.intents.begin('d1', call(chat, 'input.click', 'desktop'));
  assert.equal(first.sent.filter((m) => m.event === 'tool').length, 1);
  // the Host dies here: nothing ends the turn or the calls. The next one starts on the same folder
  const next = await boot();
  assert.equal(next.done.interrupted, 1);
  const out: any[] = [];
  const conn = next.protocol.connection((m: object) => out.push(m));
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', { chatId: chat, epoch: 1 });
  const events = out
    .find((m) => m.frame?.t === 'hello')
    .frame.snapshot.items.map((i: any) => i.event)
    .filter(Boolean);
  const end = events.find((e: any) => e.kind === 'turnEnd');
  assert.deepEqual(end.interrupted, {
    by: 'host_restart',
    running: ['send_mail'],
    lost: [
      { kind: 'tool', name: 'send_mail' },
      { kind: 'desktop', name: 'input.click' },
    ],
  });
  assert.deepEqual(
    events.filter((e: any) => e.kind === 'update').map((e: any) => [e.update.toolCallId, e.update.status]),
    [
      ['c1', 'in_progress'],
      ['c1', 'failed'],
    ],
    'the card is closed before the turn ends',
  );
  assert.ok(events.indexOf(end) > events.findIndex((e: any) => e.update?.status === 'failed'));
  assert.deepEqual(events.find((e: any) => e.update?.status === 'failed').update._meta, { mopilot: { settled: 'host_restart' } });
  assert.equal(next.sent.length, 0, 'the new Host sends none of them to the app again');
  assert.deepEqual(onDisk(dir), []);
});
