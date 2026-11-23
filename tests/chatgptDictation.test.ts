// The ChatGPT login's streaming dictation (electron/platform/chatgptDictation.cjs) against a socket that speaks the
// official app's protocol: session.start, audio held until session.started, segments by utterance, session.close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openChatgptDictation, transcriptOf, STREAM_URL } = require('../electron/platform/chatgptDictation.cjs');
const { createSpeechStreams } = require('../electron/platform/speechStream.cjs');

class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  sent: any[] = [];
  closed = 0;
  events = new EventEmitter();
  url: string;
  options: any;
  constructor(url: string, options: any) {
    this.url = url;
    this.options = options;
    FakeSocket.last = this;
  }
  addEventListener(name: string, fn: (e: any) => void) {
    this.events.on(name, fn);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed++;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.events.emit('close', {});
  }
  open() {
    this.readyState = 1;
    this.events.emit('open', {});
  }
  server(event: object | string) {
    this.events.emit('message', { data: typeof event === 'string' ? event : JSON.stringify(event) });
  }
}

/** Timers the test fires by hand. */
function handTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    set: (fn: () => void) => (pending.set(next, fn), next++) as any,
    clear: (id: any) => void pending.delete(id),
    fireAll: () => [...pending.values()].forEach((fn) => fn()),
    count: () => pending.size,
  };
}

async function opened(o: Partial<Parameters<typeof openChatgptDictation>[0]> = {}) {
  const texts: string[] = [];
  const failures: Error[] = [];
  const timers = handTimers();
  const opening = openChatgptDictation({
    headers: async () => ({ Authorization: 'Bearer t', 'ChatGPT-Account-Id': 'acct' }),
    WebSocket: FakeSocket,
    language: 'en',
    onText: (t: string) => texts.push(t),
    onFail: (e: Error) => failures.push(e),
    timers,
    ...o,
  });
  await new Promise(setImmediate);
  const ws = FakeSocket.last;
  ws.open();
  return { stream: await opening, ws, texts, failures, timers };
}

test('it connects as the official app does and holds audio until the session starts', async () => {
  const { stream, ws } = await opened();
  assert.equal(ws.url, STREAM_URL);
  assert.deepEqual(ws.options.protocols, ['chatgpt-dictation', 'codex-desktop']);
  assert.equal(ws.options.headers.Authorization, 'Bearer t');
  const start = ws.sent[0];
  assert.equal(start.type, 'session.start');
  assert.deepEqual(
    [start.config.language, start.config.input_audio_format, start.config.sample_rate_hz, start.config.transcript_delivery_mode],
    ['en', 'pcm16', 16_000, 'segment'],
  );
  assert.ok(start.dictation_session_id && start.attempt_id);
  stream.audio(new Uint8Array([1, 0]));
  assert.equal(ws.sent.length, 1, 'audio waits for session.started');
  ws.server({ type: 'session.started', session: {} });
  stream.audio(new Uint8Array([2, 0]));
  assert.deepEqual(
    ws.sent.slice(1).map((m) => [m.type, m.audio]),
    [
      ['audio.append', 'AQA='],
      ['audio.append', 'AgA='],
    ],
  );
  const noLanguage = await opened({ language: undefined });
  assert.equal('language' in noLanguage.ws.sent[0].config, false);
});

test('segments build the text by utterance and revision; session.close ends with the closed session', async () => {
  const { stream, ws, texts } = await opened();
  ws.server({ type: 'session.started', session: {} });
  ws.server({ type: 'transcript.segment', utterance_id: 'a', revision: 1, text: 'hello' });
  ws.server({ type: 'transcript.delta', utterance_id: 'a', revision: 1, text: ' wor' });
  ws.server({ type: 'transcript.segment', utterance_id: 'a', revision: 0, text: 'stale' });
  ws.server({ type: 'transcript.delta', utterance_id: 'b', text: 'next' });
  ws.server({ type: 'transcript.final', utterance_id: 'a', revision: 2, text: 'Hello world.' });
  ws.server({ type: 'speech.started' });
  ws.server({ type: 'transcript.segment', revision: 0 });
  ws.server({ type: 'session.updated', session: { status: 'open' } });
  assert.deepEqual(texts, ['hello', 'hello wor', 'hello wor next', 'Hello world. next', 'Hello world. next']);
  const finishing = stream.finish();
  assert.deepEqual(ws.sent.at(-1), { type: 'session.close' });
  stream.audio(new Uint8Array([1, 0]));
  assert.deepEqual(ws.sent.at(-1), { type: 'session.close' }, 'no audio after close');
  ws.server({ type: 'session.updated', session: { status: 'closed' } });
  assert.equal(await finishing, 'Hello world. next');
  assert.equal(transcriptOf(new Map([['x', { revision: 0, text: '  ' }]])), '');
});

test('a failed transcript, a fatal error, a bad event or a dropped socket fail the stream once', async () => {
  for (const event of [
    { type: 'transcript.failed', error: { message: 'no audio' } },
    { type: 'transcript.failed' },
    { type: 'session.error', fatal: true, error: { message: 'quota' } },
    { type: 'session.error', fatal: true },
    'not json',
  ]) {
    const { stream, ws, failures } = await opened();
    ws.server({ type: 'session.error', fatal: false, error: { message: 'ignored' } });
    ws.server(event);
    ws.server(event);
    assert.equal(failures.length, 1, JSON.stringify(event));
    await assert.rejects(stream.finish());
  }
  const dropped = await opened();
  dropped.ws.close();
  assert.match(dropped.failures[0].message, /closed/);
  // while closing, a failure rejects the finish instead
  const closing = await opened();
  const finishing = closing.stream.finish();
  closing.ws.server({ type: 'transcript.failed', error: { message: 'lost' } });
  await assert.rejects(finishing, /lost/);
  assert.equal(closing.failures.length, 0);
  // a close that never comes times out
  const slow = await opened();
  const waiting = slow.stream.finish();
  slow.timers.fireAll();
  await assert.rejects(waiting, /did not finish/);
});

test('no login, no connection or no answer to connect fail the start; cancel closes it', async () => {
  await assert.rejects(openChatgptDictation({ headers: async () => null, WebSocket: FakeSocket, onText() {}, onFail() {} }), /Sign in/);
  const timers = handTimers();
  const failures: Error[] = [];
  const refused = openChatgptDictation({
    headers: async () => ({}),
    WebSocket: FakeSocket,
    onText() {},
    onFail: (e: Error) => failures.push(e),
    timers,
  });
  await new Promise(setImmediate);
  FakeSocket.last.events.emit('error', {});
  FakeSocket.last.close();
  await assert.rejects(refused, /could not connect/);
  assert.deepEqual(failures, [], 'a stream that never opened is not reported as stopped');
  const t2 = handTimers();
  const hanging = openChatgptDictation({ headers: async () => ({}), WebSocket: FakeSocket, onText() {}, onFail() {}, timers: t2 });
  await new Promise(setImmediate);
  t2.fireAll();
  await assert.rejects(hanging, /did not connect/);
  // a socket that closes before it opens fails the start at once
  const shut = openChatgptDictation({ headers: async () => ({}), WebSocket: FakeSocket, onText() {}, onFail() {}, timers: handTimers() });
  await new Promise(setImmediate);
  FakeSocket.last.close();
  await assert.rejects(shut, /closed/);
  const { stream, ws, failures: later } = await opened();
  stream.cancel();
  stream.cancel();
  assert.equal(ws.closed, 1);
  assert.deepEqual(later, [], 'a cancelled stream is not reported as stopped');
  await assert.rejects(stream.finish(), /cancelled/);
  // the default timers are real ones
  const real = openChatgptDictation({ headers: async () => ({}), WebSocket: FakeSocket, onText() {}, onFail() {} });
  await new Promise(setImmediate);
  FakeSocket.last.open();
  (await real).cancel();
});

test('main streams a recording on the ChatGPT login, says a failure once, and drops one that connects too late', async () => {
  const sent: any[] = [];
  const noted: any[] = [];
  const streams = createSpeechStreams({
    helper: () => ({}),
    noteIgnored: (what: string) => noted.push(what),
    chatgptHeaders: async () => ({ Authorization: 'Bearer t' }),
    WebSocket: FakeSocket,
  });
  const starting = streams.start('w', 'cap', 'auto', (m: any) => sent.push(m), 'chatgpt');
  await new Promise(setImmediate);
  FakeSocket.last.open();
  await starting;
  const ws = FakeSocket.last;
  assert.equal('language' in ws.sent[0].config, false, '"auto" lets the service detect the language');
  ws.server({ type: 'session.started', session: {} });
  streams.audio('cap', new Uint8Array([1, 0]));
  ws.server({ type: 'transcript.segment', utterance_id: 'a', revision: 0, text: 'hi' });
  assert.deepEqual(sent, [{ text: 'hi' }]);
  const finishing = streams.finish('cap');
  ws.server({ type: 'session.updated', session: { status: 'closed' } });
  assert.deepEqual(await finishing, { text: 'hi' });
  // a stream that fails after it connected is said once
  const second = streams.start('w', 'b', 'en', (m: any) => sent.push(m), 'chatgpt');
  await new Promise(setImmediate);
  FakeSocket.last.open();
  await second;
  FakeSocket.last.server({ type: 'session.error', fatal: true, error: { message: 'quota' } });
  assert.deepEqual(sent.at(-1), { error: 'Dictation stopped' });
  assert.deepEqual(noted, ['stream dictation with chatgpt']);
  assert.deepEqual(await streams.finish('b'), { error: 'This dictation stream has ended' });
  // a finish that fails reads as an error
  const third = streams.start('w', 'c', 'en', () => {}, 'chatgpt');
  await new Promise(setImmediate);
  FakeSocket.last.open();
  await third;
  streams.cancel('c');
  // dropped while connecting: closed once it connects; a finish meanwhile has nothing to finish
  const late = streams.start('w', 'd', 'en', () => {}, 'chatgpt');
  await new Promise(setImmediate);
  const lateSocket = FakeSocket.last;
  assert.deepEqual(await streams.finish('d'), { error: 'This dictation stream has ended' });
  streams.close('w');
  lateSocket.open();
  await late;
  assert.equal(lateSocket.closed, 1);
  // a refused start leaves nothing behind
  const refused = streams.start('w', 'e', 'en', () => {}, 'chatgpt');
  await new Promise(setImmediate);
  FakeSocket.last.events.emit('error', {});
  await assert.rejects(refused, /could not connect/);
  assert.deepEqual(await streams.finish('e'), { error: 'This dictation stream has ended' });
  const failing = streams.start('w', 'f', 'en', () => {}, 'chatgpt');
  await new Promise(setImmediate);
  FakeSocket.last.open();
  await failing;
  const f = FakeSocket.last;
  const ending = streams.finish('f');
  f.server({ type: 'transcript.failed', error: { message: 'lost' } });
  assert.deepEqual(await ending, { error: 'Lost.' });
});

test('a frame that cannot go out, or a session that never starts, fails the stream instead of losing words', async () => {
  const lost = await opened();
  lost.ws.server({ type: 'session.started', session: {} });
  lost.ws.readyState = 2;
  lost.stream.audio(new Uint8Array([1, 0]));
  assert.match(lost.failures[0].message, /lost its connection/);
  const stuck = await opened();
  for (let i = 0; i < 240; i++) stuck.stream.audio(new Uint8Array([1, 0]));
  assert.equal(stuck.failures.length, 0);
  stuck.stream.audio(new Uint8Array([1, 0]));
  assert.match(stuck.failures[0].message, /did not start/);
});

test('a ChatGPT stream stays cancellable while it closes; main knows which service each stream is on', async () => {
  const streams = createSpeechStreams({
    helper: () => Object.assign(new EventEmitter(), { start: async () => undefined, call: async () => ({}) }),
    noteIgnored() {},
    chatgptHeaders: async () => ({}),
    WebSocket: FakeSocket,
  });
  const starting = streams.start('w', 'cap', 'en', () => {}, 'chatgpt');
  await new Promise(setImmediate);
  FakeSocket.last.open();
  await starting;
  const ws = FakeSocket.last;
  await streams.start('w', 'mac', 'en', () => {});
  assert.deepEqual([streams.engineOf('cap'), streams.engineOf('mac'), streams.engineOf('none')], ['chatgpt', 'local', null]);
  const finishing = streams.finish('cap');
  streams.close('w');
  assert.equal(ws.closed, 1, 'the retired window closed it at once');
  assert.match((await finishing).error, /cancelled/i);
  assert.equal(streams.engineOf('cap'), null);
});
