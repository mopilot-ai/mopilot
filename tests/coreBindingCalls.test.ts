// Calls through the built addon (core/crates/node, core/crates/dispatch): routes run on the core's own capped threads, so
// a long route leaves libuv's to fs.promises; a call is cancelled by id; and what a JS environment left behind goes with
// it. The long routes are the test-only ones (feature test-routes), which scripts/rust-coverage.mjs builds with; the
// run is skipped on a build without them unless MOPILOT_CORE_REQUIRED says the run must have them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { corePath, loadCore } = require('../electron/platform/core.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';
const skip = !required && !addon?.routes().includes('test.hold') && 'no Rust core built with its test routes';

const THREADS = 4;
const none = Buffer.alloc(0);
const hold = () => addon.dispatchCancellable('test.hold', none);
const cancelled = { code: 'CORE_CANCELLED', message: 'the core call was cancelled' };

/** A worker running `body`, with `addon` loaded in it and the file's own `post` to speak up. */
function worker(body: string) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const m = { exports: {} };
    process.dlopen(m, workerData);
    const addon = m.exports;
    const none = Buffer.alloc(0);
    ${body}`;
  return new Worker(code, { eval: true, workerData: corePath() });
}

const message = (w: Worker) => new Promise<any>((resolve, reject) => w.once('message', resolve).once('error', reject));

test('a call is answered through its promise, with the id left for cancel', { skip }, async () => {
  const { id, reply } = addon.dispatchCancellable('proc.table', none);
  assert.equal(typeof id, 'number');
  assert.ok(JSON.parse(String(await reply)).length > 0);
});

test('a route that finished first keeps its reply, and cancelling it after does nothing', { skip }, async () => {
  const { id, reply } = addon.dispatchCancellable('proc.table', none);
  const answer = await reply;
  assert.equal(addon.cancel(id), false);
  assert.ok(JSON.parse(String(answer)).length > 0);
});

test('a cancelled route rejects with the distinct error', { skip }, async () => {
  const { id, reply } = hold();
  assert.equal(addon.cancel(id), true);
  await assert.rejects(reply, cancelled);
  assert.equal(addon.cancel(id), false, 'it has ended');
});

test('an id that names no call cancels nothing, and one that is no number throws', { skip }, () => {
  assert.equal(addon.cancel(Number.MAX_SAFE_INTEGER), false);
  assert.throws(() => addon.cancel('x'), /the core binding failed \(Node-API status \d+\)/);
  assert.throws(() => addon.dispatchCancellable(42, none), /the core binding failed \(Node-API status \d+\)/);
});

test("a route's failures stay plain errors", { skip }, async () => {
  const unknown = await addon.dispatch('proc.nowhere', none).catch((e: Error) => e);
  assert.match(unknown.message, /no core route proc\.nowhere/);
  assert.equal(unknown.code, undefined);
});

test('a route that panics on the core threads is an error reply, and they go on working', { skip }, async () => {
  for (let i = 0; i < THREADS * 2; i++) await assert.rejects(addon.dispatch('test.panics', none), /core route test\.panics panicked/);
  assert.ok(JSON.parse(String(await addon.dispatch('proc.table', none))).length > 0);
});

test('long routes on every core thread leave fs.promises its threads, and calls past the cap wait', { skip }, async () => {
  const held = Array.from({ length: THREADS }, hold);
  const finished: string[] = [];
  const waiting = addon.dispatch('proc.table', none).then(() => finished.push('table'));
  const queued = addon.dispatchCancellable('test.panics', none);
  // more reads than libuv has threads: under napi_async_work these would never get one while the routes run
  const self = fileURLToPath(import.meta.url);
  const reads = await Promise.all(Array.from({ length: THREADS * 4 }, () => readFile(self)));
  assert.ok(reads.every((bytes) => bytes.length > 0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(finished, [], 'every core thread is held, so the next call waits for one');
  // cancelled while it waits, it never runs: not its panic but the cancel
  const ended = [queued, ...held].map(({ reply }) => assert.rejects(reply, cancelled));
  assert.equal(addon.cancel(queued.id), true);
  for (const { id } of held) assert.equal(addon.cancel(id), true);
  await waiting;
  assert.deepEqual(finished, ['table']);
  await Promise.all(ended);
});

test('many calls at once all settle, each with its own reply', { skip }, async () => {
  const ids = (await Promise.all(Array.from({ length: 256 }, () => addon.dispatch('framing.open', Buffer.from('8'))))).map(String);
  assert.equal(new Set(ids).size, ids.length);
  const closed = await Promise.all(ids.map((id) => addon.dispatch('framing.close', Buffer.from(id))));
  assert.ok(closed.every((reply) => String(reply) === 'true'));
});

test('handles are bounded: an open past the limit is refused, and closing makes room', { skip }, () => {
  const open = () => String(addon.dispatchSync('framing.open', none));
  const ids: string[] = [];
  try {
    for (;;) ids.push(open());
  } catch (error) {
    assert.match((error as Error).message, /too many framers open \(\d+\)/);
  }
  assert.ok(ids.length >= 256, `${ids.length} open`);
  addon.dispatchSync('framing.close', Buffer.from(ids.pop() ?? ''));
  ids.push(open());
  for (const id of ids) assert.equal(String(addon.dispatchSync('framing.close', Buffer.from(id))), 'true');
});

test('a terminated worker leaves no handle or running call behind', { skip }, async () => {
  const w = worker(`
    const id = String(addon.dispatchSync('framing.open', none));
    for (let i = 0; i < ${THREADS * 2}; i++) addon.dispatch('test.hold', none).catch(() => {});
    parentPort.postMessage(id);`);
  const id = await message(w);
  let pushed: Buffer;
  try {
    pushed = addon.dispatchSync('framing.push', Buffer.from(`${id}\n{}\n`));
  } finally {
    // the worker holds every core thread until it goes: whatever this found, it goes, so nothing after waits on it
    await w.terminate();
  }
  // eight bytes of length, then the line (core/crates/framing)
  assert.equal(String(pushed.subarray(8)), '{}', 'it was open');
  assert.throws(() => addon.dispatchSync('framing.push', Buffer.from(`${id}\nx`)), new RegExp(`no framer ${id}`));
  // the core threads are free again: every one was held until the worker went
  const free = await Promise.all(Array.from({ length: THREADS * 2 }, () => addon.dispatch('proc.table', none)));
  assert.equal(free.length, THREADS * 2);
});

test('a worker that exits with replies undelivered costs nothing: they are dropped with it', { skip }, async () => {
  const w = worker(`
    for (let i = 0; i < 16; i++) addon.dispatch('proc.pressure', none).catch(() => {});
    // the replies come back to this blocked thread, which ends without ever taking them
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    process.exit(0);`);
  assert.equal(await new Promise((resolve) => w.once('exit', resolve)), 0);
  assert.ok(JSON.parse(String(await addon.dispatch('proc.table', none))).length > 0);
});

test('the addon outlives the only environment that loaded it, with a route still running', { skip }, () => {
  // a process of its own: here this file's own load would keep the library open whatever the addon does. Today only Windows can
  // unload it, and pins it instead; Linux and macOS keep it (core/crates/node/src/pin.rs)
  const script = `
    const { Worker } = require('node:worker_threads');
    const code = \`
      const m = { exports: {} };
      process.dlopen(m, require('node:worker_threads').workerData);
      for (let i = 0; i < 8; i++) m.exports.dispatch('test.linger', Buffer.alloc(0)).catch(() => {});
      require('node:worker_threads').parentPort.postMessage('running');\`;
    const w = new Worker(code, { eval: true, workerData: process.argv[1] });
    w.once('message', async () => {
      await w.terminate();
      // the routes go on past the worker's end, in code an unloaded library would no longer have
      setTimeout(() => process.exit(0), 500);
    });`;
  const child = spawnSync(process.execPath, ['-e', script, corePath()], { encoding: 'utf8', timeout: 30_000 });
  assert.deepEqual([child.status, child.signal, child.stderr], [0, null, '']);
});
