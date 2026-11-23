// Independent review of initial-send receipts through the real Codex adapter and controller state owner.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as controller, tick } from './support/controller/fixture.ts';
import { setup as codex, thread } from './support/codex-harness/fixture.ts';

function gate<T = any>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function until(test: () => boolean) {
  await waitFor(test, 'the mock boundary').catch(() => {});
  assert.ok(test(), 'mock boundary reached');
}
function wire(handlers: any) {
  const fx = controller({ auto: false });
  const native = codex(handlers, { backoff: [] });
  fx.c.codex = native.a;
  native.a.state = fx.state;
  native.a.observe = (msg: any) => fx.c.onCodexMessage(msg);
  native.a.onExit = () => fx.c.onCodexExit();
  return { ...fx, ...native, state: fx.state };
}

test('review: native events may finish and drain before the first send receipt settles', async () => {
  const firstReply = gate();
  const fx = wire({ 'turn/start': (_: any, n: number) => (n === 1 ? firstReply.promise : { turn: { id: 'native-2' } }) });
  let firstSettled = false;
  const first = Promise.resolve(fx.c.send('chat', { id: 'one', text: 'first' }, 7, true)).then((r) => ((firstSettled = true), r));
  await until(() => fx.server.params('turn/start').length === 1);
  fx.server.notify('turn/started', { threadId: 'chat', turn: { id: 'native-1' } });
  assert.equal(firstSettled, false);
  assert.equal((await fx.c.send('chat', { id: 'two', text: 'second' }, 7, true)).action, 'queued');
  fx.server.notify('turn/completed', { threadId: 'chat', turn: { id: 'native-1', status: 'completed' } });
  await until(() => fx.server.params('turn/start').length === 2);
  await tick();
  firstReply.resolve({ turn: { id: 'native-1' } });
  assert.equal((await first).action, 'started');
  await tick();
  assert.equal(fx.s('chat').activeTurn.id, 'native-2');
  assert.equal(fx.s('chat').crashed, null);
  assert.equal(fx.s('chat').queue.length, 0);
  assert.equal(fx.server.params('turn/start').length, 2);
});

test('review: stopped native resume failure preserves one retry and leaves replacement state untouched', async () => {
  const resume = gate();
  const fx = wire({ 'thread/resume': (p: any, n: number) => (n === 1 ? resume.promise : { thread: thread(p.threadId) }) });
  const first = Promise.resolve(fx.c.send('chat', { id: 'one', text: 'first' }, 7, true));
  await until(() => fx.server.params('thread/resume').length === 1);
  fx.c.noteStop('chat');
  fx.c.end('chat', { drain: false });
  const replacement = Promise.resolve(fx.c.send('other', { id: 'two', text: 'replacement' }, 7, true));
  assert.equal((await replacement).action, 'started');
  resume.reject(new Error('list_turns is not supported yet'));
  assert.deepEqual(await first, { action: 'queued', id: 'one', error: 'list_turns is not supported yet' });
  assert.equal(fx.s('chat').crashed, null);
  assert.equal(fx.s('chat').queue.length, 1);
  assert.equal(fx.s('other').turn, 'running');
  assert.equal(fx.s('other').crashed, null);
  assert.equal(fx.server.params('turn/start').length, 1);
});

test('review: adapter reset retires a pending send and an explicit retry still sends once', async () => {
  const resume = gate();
  const fx = wire({ 'thread/resume': (p: any, n: number) => (n === 1 ? resume.promise : { thread: thread(p.threadId) }) });
  const first = Promise.resolve(fx.c.send('chat', { id: 'one', text: 'first' }, 7, true));
  await until(() => fx.server.params('thread/resume').length === 1);
  fx.server.emit({ kind: 'stopped' });
  const receipt = await first;
  assert.equal(receipt.action, 'queued');
  assert.equal(fx.s('chat').queue.length, 1);
  const retry = fx.c.sendNow('chat', 'one', 7, true);
  assert.deepEqual(await retry, { status: 'sent' });
  resume.resolve({ thread: thread('chat') });
  await tick();
  assert.equal(fx.s('chat').queue.length, 0);
  assert.equal(fx.s('chat').crashed, null);
  assert.equal(fx.server.params('turn/start').length, 1);
});

test('review: no-window background intent remains synchronous and retains its rejected input', async () => {
  const fx = wire({
    'thread/resume': () => {
      throw new Error('list_turns is not supported yet');
    },
  });
  const receipt = fx.c.send('chat', { id: 'background', text: 'scheduled work', opts: { human: false } }, null);
  assert.equal(typeof receipt.then, 'undefined');
  assert.deepEqual(receipt, { action: 'started', id: 'background' });
  await until(() => fx.s('chat').queue.length === 1);
  assert.equal(fx.s('chat').turn, 'crashed');
  assert.equal(fx.s('chat').crashed, 'list_turns is not supported yet');
  assert.equal(fx.server.params('turn/start').length, 0);
});
