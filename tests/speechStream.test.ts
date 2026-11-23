// This Mac's streaming dictation in main (electron/platform/speechStream.cjs) and the helper notifications it reads
// (electron/capabilities/computerContract.cjs): frames in order, guesses to their own window, failures said once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createSpeechStreams } = require('../electron/platform/speechStream.cjs');
const { attachHelperSocket } = require('../electron/capabilities/computerContract.cjs');

function rig() {
  const helper: any = Object.assign(new EventEmitter(), { started: 0 });
  const calls: any[] = [];
  const answers: Record<string, (p: any) => Promise<any>> = {};
  helper.start = async () => void helper.started++;
  helper.call = (method: string, params: any, opts?: any) => {
    calls.push([method, params, opts]);
    return (answers[method] ?? (async () => ({ ok: true })))(params);
  };
  const ignored: any[] = [];
  const streams = createSpeechStreams({ helper: () => helper, noteIgnored: (what: string, e: unknown) => ignored.push([what, e]) });
  return { helper, calls, answers, streams, ignored };
}

test('a stream starts on the helper, passes frames in order, and its guesses reach only its own window', async () => {
  const r = rig();
  await assert.rejects(
    r.streams.start('w', 'removed', 'en', () => {}, 'claude'),
    /has no stream/,
  );
  assert.equal(r.helper.started, 0, 'an unavailable service starts no local or remote recognizer');
  const sent: any[] = [];
  const other: any[] = [];
  answers(r, 'speech.stream.finish', async () => ({ text: 'final words' }));
  await r.streams.start('w1', 'cap', 'en', (m: any) => sent.push(m));
  await r.streams.start('w2', 'cap2', 'en', (m: any) => other.push(m));
  const session = r.calls[0][1].session;
  assert.deepEqual([r.calls[0][0], r.calls[0][1].language, r.calls[0][2]], ['speech.stream.start', 'en', { timeoutMs: 10_000 }]);
  const slow = deferred<any>();
  const replies = [slow.promise, Promise.resolve({ ok: true })];
  r.answers['speech.stream.append'] = () => replies.shift()!;
  r.streams.audio('cap', new Uint8Array([1, 0]));
  r.streams.audio('cap', new Uint8Array([2, 0]));
  r.streams.audio('missing', new Uint8Array([3, 0]));
  await new Promise(setImmediate);
  assert.equal(r.calls.filter((c) => c[0] === 'speech.stream.append').length, 1, 'the second frame waits for the first');
  slow.resolve({ ok: true });
  r.helper.emit('speech', 'speech.stream.result', { session, text: 'hello' });
  r.helper.emit('speech', 'speech.stream.result', { session: 'unknown', text: 'x' });
  r.helper.emit('speech', 'speech.stream.result', { session });
  assert.deepEqual(sent, [{ text: 'hello' }, { text: '' }]);
  assert.deepEqual(await r.streams.finish('cap'), { text: 'final words' });
  assert.deepEqual(
    r.calls.filter((c) => c[0] === 'speech.stream.append').map((c) => c[1].pcm),
    ['AQA=', 'AgA='],
  );
  assert.deepEqual(await r.streams.finish('cap'), { error: 'This dictation stream has ended' });
  assert.equal(r.helper.listenerCount('speech'), 1, 'one listener for every stream');
  assert.deepEqual(other, []);
});

function answers(r: ReturnType<typeof rig>, method: string, fn: (p: any) => Promise<any>) {
  r.answers[method] = fn;
}

test('a helper failure, a failed frame or a failed finish is an error the window falls back on', async () => {
  const r = rig();
  const sent: any[] = [];
  await r.streams.start('w', 'a', 'en', (m: any) => sent.push(m));
  r.helper.emit('speech', 'speech.stream.error', { session: r.calls[0][1].session, message: 'stopped' });
  r.helper.emit('speech', 'speech.stream.error', { session: r.calls[0][1].session });
  assert.deepEqual(sent, [{ error: 'On-device recognition stopped' }]);
  assert.deepEqual(await r.streams.finish('a'), { error: 'This dictation stream has ended' });
  await r.streams.start('w', 'b', 'en', (m: any) => sent.push(m));
  r.helper.emit('speech', 'speech.stream.error', { session: r.calls.at(-1)[1].session });
  assert.deepEqual(sent.at(-1), { error: 'On-device recognition stopped' });
  await r.streams.start('w', 'c', 'en', () => {});
  r.answers['speech.stream.append'] = async () => {
    throw new Error('no_session');
  };
  r.streams.audio('c', new Uint8Array([1, 0]));
  r.streams.audio('c', new Uint8Array([1, 0]));
  assert.deepEqual(await r.streams.finish('c'), { error: 'No_session.' });
  assert.equal(r.calls.filter((c) => c[0] === 'speech.stream.append').length, 1, 'no frame after a failed one');
  assert.equal(r.calls.at(-1)[0], 'speech.stream.cancel');
  await r.streams.start('w', 'd', 'en', () => {});
  r.answers['speech.stream.finish'] = async () => {
    throw new Error('helper exited');
  };
  assert.deepEqual(await r.streams.finish('d'), { error: 'Helper exited.' });
  await r.streams.start('w', 'e', 'en', () => {});
  r.answers['speech.stream.finish'] = async () => null;
  assert.deepEqual(await r.streams.finish('e'), { text: '' });
});

test('starting twice replaces the stream; a refused start, cancel and a closed window leave nothing behind', async () => {
  const r = rig();
  await r.streams.start('w', 'cap', 'en', () => {});
  await r.streams.start('w', 'cap', 'en', () => {});
  assert.equal(r.calls.filter((c) => c[0] === 'speech.stream.cancel').length, 1);
  r.answers['speech.stream.start'] = async () => {
    throw new Error('speech_unavailable');
  };
  await assert.rejects(
    r.streams.start('w', 'no', 'xx', () => {}),
    /speech_unavailable/,
  );
  assert.deepEqual(await r.streams.finish('no'), { error: 'This dictation stream has ended' });
  r.answers['speech.stream.start'] = async () => ({ ok: true });
  // a finish that waits on a frame while the stream is cancelled answers that it ended
  const frame = deferred<any>();
  r.answers['speech.stream.append'] = () => frame.promise;
  r.streams.audio('cap', new Uint8Array([1, 0]));
  const finishing = r.streams.finish('cap');
  r.streams.cancel('cap');
  frame.resolve({ ok: true });
  assert.deepEqual(await finishing, { error: 'This dictation stream has ended' });
  r.answers['speech.stream.cancel'] = async () => {
    throw new Error('helper gone');
  };
  await r.streams.start('w1', 'x', 'en', () => {});
  await r.streams.start('w2', 'y', 'en', () => {});
  r.streams.close('w1');
  r.streams.cancel('nothing');
  await new Promise(setImmediate);
  assert.equal(r.ignored.length, 1, 'a failed cancel is noted, not thrown');
  assert.deepEqual(await r.streams.finish('x'), { error: 'This dictation stream has ended' });
  assert.notDeepEqual(await r.streams.finish('y'), { error: 'This dictation stream has ended' });
});

test('stream notifications go out as the helper’s speech event; replies and other notifications go on as before', () => {
  const owner: any = Object.assign(new EventEmitter(), { pending: new Map() });
  const sock: any = Object.assign(new EventEmitter(), { destroy() {} });
  const messages: any[] = [];
  const speech: any[] = [];
  owner.on('speech', (...a: any[]) => speech.push(a));
  attachHelperSocket(
    owner,
    sock,
    (m: any) => messages.push(m),
    () => {},
  );
  sock.emit(
    'data',
    Buffer.from(
      [
        { jsonrpc: '2.0', method: 'speech.stream.result', params: { session: 's', text: 'hi' } },
        { jsonrpc: '2.0', method: 'speech.stream.error' },
        { jsonrpc: '2.0', method: 'record.event', params: {} },
        { jsonrpc: '2.0', id: 1, result: {} },
      ]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n',
    ),
  );
  assert.deepEqual(speech, [
    ['speech.stream.result', { session: 's', text: 'hi' }],
    ['speech.stream.error', {}],
  ]);
  assert.deepEqual(
    messages.map((m) => m.method ?? m.id),
    ['record.event', 1],
  );
});
