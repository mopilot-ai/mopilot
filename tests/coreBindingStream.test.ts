// The core's ordered stream through the built addon (core/crates/node/src/stream.rs, core/crates/dispatch/src/stream.rs):
// an environment's events reach its listener in order, a call's reply comes behind them, and a handler under
// orderedReplies answers a window after its deltas, for each harness family through its real contract. The emitting
// routes are the test-only ones (feature test-routes); the run is skipped on a build without them unless
// MOPILOT_CORE_REQUIRED says the run must have them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { corePath, coreCall, coreEvents, loadCore } = require('../electron/platform/core.cjs');
const { CoreBatcher, orderedReplies } = require('../electron/harness/coreBatcher.cjs');
const { familyChats } = require('../electron/harness/coreBatcher.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';
const skip = !required && !addon?.routes().includes('test.emits') && 'no Rust core built with its test routes';

/** Run `body` in a node of its own with `addon` loaded, and what it printed: for what ends or takes over a process. */
function alone(body: string) {
  const code = `
    const m = { exports: {} };
    process.dlopen(m, ${JSON.stringify(corePath())});
    const addon = m.exports;
    ${body}`;
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 30_000 });
}

/** A worker running `body`, with `addon` loaded in it and `parentPort` to speak up. */
function worker(body: string) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const m = { exports: {} };
    process.dlopen(m, workerData);
    const addon = m.exports;
    ${body}`;
  return new Worker(code, { eval: true, workerData: corePath() });
}

test('a call’s events arrive in order, and its reply behind them, every time', { skip }, async () => {
  const heard: string[] = [];
  const stop = coreEvents((event: Buffer) => heard.push(String(event)), addon);
  try {
    for (let round = 0; round < 50; round++) {
      heard.length = 0;
      assert.equal(await coreCall('test.emits', addon, `${round}:200`), round);
      assert.deepEqual(
        heard,
        Array.from({ length: 200 }, (_, i) => `${round}-${i}`),
      );
    }
  } finally {
    stop();
  }
});

test('calls at once each keep their own order, and each reply follows its own events', { skip }, async () => {
  const heard = new Map<number, number>();
  const stop = coreEvents((event: Buffer) => {
    const [name, i] = String(event).split('-').map(Number);
    assert.equal(heard.get(name) ?? 0, i, `call ${name} out of order`);
    heard.set(name, i + 1);
  }, addon);
  try {
    const calls = Array.from({ length: 32 }, (_, name) =>
      coreCall('test.emits', addon, `${name}:300`).then((reply: number) => [reply, heard.get(name)]),
    );
    const replies = await Promise.all(calls);
    assert.deepEqual(
      replies,
      Array.from({ length: 32 }, (_, name) => [name, 300]),
    );
  } finally {
    stop();
  }
});

test('a failed call’s error follows its events too', { skip }, async () => {
  const heard: string[] = [];
  const stop = coreEvents((event: Buffer) => heard.push(String(event)), addon);
  try {
    await assert.rejects(addon.dispatch('test.emitsThenFails', Buffer.alloc(0)), /failed after an event/);
    assert.deepEqual(heard, ['before']);
    await assert.rejects(coreCall('test.emitsThenFails', addon), /failed after an event/);
  } finally {
    stop();
  }
});

test('events only need a subscriber to be heard: a plain call’s are dropped without one, and it still answers', { skip }, async () => {
  const quiet = alone(`
    addon.dispatch('test.emits', Buffer.from('7:5')).then((reply) => console.log(String(reply)));`);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim(), '7');
});

test('an environment has one listener, and it must be a function', { skip }, () => {
  const run = alone(`
    const said = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
    console.log(said(() => addon.subscribe('not a function')));
    addon.subscribe(() => {});
    console.log(said(() => addon.subscribe(() => {})));`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'subscribe takes a function',
    "this environment already has a listener on the core's stream",
  ]);
});

test('a stream that is idle lets the process end; a running call holds it open until its reply', { skip }, () => {
  const idle = alone(`addon.subscribe(() => {});`);
  assert.equal(idle.status, 0, idle.stderr);
  const running = alone(`
    addon.subscribe(() => {});
    addon.dispatch('test.linger', Buffer.alloc(0)).then(() => console.log('answered'));`);
  assert.equal(running.status, 0, running.stderr);
  assert.equal(running.stdout.trim(), 'answered');
});

test('a listener that throws goes to the process’s handler, and the next event still comes', { skip }, () => {
  const run = alone(`
    process.on('uncaughtException', (e) => console.log('caught', e.message));
    const heard = [];
    addon.subscribe((event) => {
      heard.push(String(event));
      if (heard.length === 1) throw new Error('a listener bug');
    });
    addon.dispatch('test.emits', Buffer.from('3:2')).then(() => console.log(heard.join()));`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), ['caught a listener bug', '3-0,3-1']);
});

test('core.cjs: a listener that throws costs the others nothing, and one that stopped hears no more', { skip }, async () => {
  const heard: string[] = [];
  const noisy = coreEvents(() => {
    throw new Error('a listener bug');
  }, addon);
  const late = coreEvents((event: Buffer) => heard.push(String(event)), addon);
  assert.equal(await coreCall('test.emits', addon, '5:1'), 5);
  assert.deepEqual(heard, ['5-0']);
  late();
  noisy();
  assert.equal(await coreCall('test.emits', addon, '6:1'), 6);
  assert.deepEqual(heard, ['5-0']);
});

test('each worker’s stream is its own, and one ending mid-stream costs the others nothing', { skip }, async () => {
  const heard: string[] = [];
  const stop = coreEvents((event: Buffer) => heard.push(String(event)), addon);
  const w = worker(`
    let count = 0;
    addon.subscribe(() => { if (++count === 1) parentPort.postMessage('streaming'); });
    addon.dispatchCancellable('test.hold', Buffer.alloc(0));
    const again = () => addon.dispatch('test.emits', Buffer.from('9:500')).then(again);
    again();`);
  try {
    await new Promise((resolve, reject) => w.once('message', resolve).once('error', reject));
    await w.terminate();
    assert.equal(await coreCall('test.emits', addon, '1:3'), 1);
    assert.deepEqual(heard, ['1-0', '1-1', '1-2']);
  } finally {
    stop();
  }
});

test('an environment that ends with its stream full, and still being written to, costs nothing', { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    const w = worker(`
      let started = false;
      addon.subscribe(() => {
        if (!started) parentPort.postMessage('flooding');
        started = true;
        // a slow listener, so the queue is behind when the end comes
        for (const end = Date.now() + 1; Date.now() < end; );
      });
      for (let i = 0; i < 3; i++) addon.dispatchCancellable('test.floods', Buffer.alloc(0));`);
    await new Promise((resolve, reject) => w.once('message', resolve).once('error', reject));
    await w.terminate();
  }
  // the threads the floods held are free, and a stream that never ended still works
  assert.equal(await coreCall('test.emits', addon, '8:2'), 8);
});

test('a core thread still writing when its environment ends costs nothing, and the reply is dropped with it', { skip }, async () => {
  for (let round = 0; round < 8; round++) {
    const w = worker(`
      addon.subscribe(() => {});
      for (let i = 0; i < 3; i++) addon.dispatch('test.emitsPastTheEnd', Buffer.alloc(0));
      parentPort.postMessage('writing');`);
    await new Promise((resolve, reject) => w.once('message', resolve).once('error', reject));
    await w.terminate();
  }
  // long enough for those routes to run on, past their environments, and end
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await coreCall('test.emits', addon, '8:2'), 8);
});

test('a listener may call back in: dispatch and dispatchSync work, and subscribe is refused', { skip }, () => {
  const run = alone(`
    process.on('uncaughtException', (e) => console.log('refused:', e.message));
    let first = true;
    addon.subscribe((event) => {
      if (!first) return;
      first = false;
      console.log('sync', JSON.parse(String(addon.dispatchSync('proc.table', Buffer.alloc(0)))).length > 0);
      addon.dispatch('test.emits', Buffer.from('2:1')).then((reply) => console.log('async', String(reply)));
      addon.subscribe(() => {});
    });
    addon.dispatch('test.emits', Buffer.from('1:1'));`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.stdout.trim().split('\n').sort(),
    ['async 2', "refused: this environment already has a listener on the core's stream", 'sync true'].sort(),
  );
});

test('what dispatchSync emits comes after it returns, and holds nothing open', { skip }, () => {
  const run = alone(`
    const heard = [];
    addon.subscribe((event) => heard.push(String(event)));
    console.log('reply', String(addon.dispatchSync('test.emits', Buffer.from('1:2'))), heard.length);
    addon.dispatch('test.emits', Buffer.from('2:0')).then(() => console.log(heard.join()));`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), ['reply 1 0', '1-0,1-1']);
});

test('a failed or cancelled call lets go of the process, as an answered one does', { skip }, () => {
  const run = alone(`
    const { id, reply } = addon.dispatchCancellable('test.hold', Buffer.alloc(0));
    reply.catch((e) => console.log(e.code));
    addon.cancel(id);
    addon.dispatch('test.panics', Buffer.alloc(0)).catch((e) => console.log(e.message));
    addon.dispatch('no.such.route', Buffer.alloc(0)).catch((e) => console.log(e.message));`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.stdout.trim().split('\n').sort(),
    ['CORE_CANCELLED', 'core route test.panics panicked', 'no core route no.such.route'].sort(),
  );
});

const delta = {
  codex: (chat: string, text: string) => ({
    kind: 'notification',
    chatId: chat,
    method: 'item/agentMessage/delta',
    params: { threadId: chat, turnId: 't', itemId: 'm', delta: text },
  }),
  claude: (chat: string, text: string) => ({
    kind: 'message',
    key: chat,
    msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  }),
  acp: (chat: string, text: string) => ({
    kind: 'update',
    key: chat,
    turnId: 't',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  }),
};
const textOf = (e: any) => e.params?.delta ?? e.msg?.event?.delta?.text ?? e.update?.content?.text;

const CHATS = 12;
const DELTAS = 300;

for (const family of Object.keys(delta) as (keyof typeof delta)[]) {
  test(`${family}: a window’s reply comes after the deltas its call emitted, with other chats streaming`, { skip }, async () => {
    /** what each chat's window was sent, in order */
    const seen = new Map<string, string[]>();
    const chatOf = (key: string) => key;
    const batcher = new CoreBatcher({
      send: (_family: string, event: any) => {
        const chat = event.chatId ?? event.key;
        seen.set(chat, [...(seen.get(chat) ?? []), textOf(event)]);
        return true;
      },
    });
    for (const [name, contract] of Object.entries(familyChats({ chatOf }))) batcher.register(name, contract);
    const stop = coreEvents((event: Buffer) => {
      const name = String(event).split('-')[0];
      batcher.push(family, delta[family](`chat-${name}`, `${event} `));
    }, addon);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => void handlers.set(channel, fn) };
    orderedReplies(ipcMain, (fn: () => unknown, args: unknown[]) => batcher.ordered(fn, args)).handle(
      `${family}:turns`,
      (_e: unknown, _chat: string, name: number) => coreCall('test.emits', addon, `${name}:${DELTAS}`),
    );
    try {
      const asked = Array.from({ length: CHATS }, async (_, name) => {
        const chat = `chat-${name}`;
        const reply = await handlers.get(`${family}:turns`)!({}, chat, name);
        seen.set(chat, [...(seen.get(chat) ?? []), `reply ${reply}`]);
      });
      await Promise.all(asked);
      for (let name = 0; name < CHATS; name++) {
        const deltas = Array.from({ length: DELTAS }, (_, i) => `${name}-${i} `).join('');
        assert.equal(seen.get(`chat-${name}`)?.join(''), `${deltas}reply ${name}`);
      }
    } finally {
      stop();
      batcher.flushAll();
      clearTimeout(batcher.timer);
      clearTimeout(batcher.backgroundTimer);
    }
  });
}
