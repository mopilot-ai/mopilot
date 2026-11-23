// The preload brackets each unpacked stream:batch with window events (electron/bridge/spec.cjs); the renderer holds its
// store writes between them (src/lib/streamFlush.ts, store/core.ts), so one flush's events are one commit.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

installNative(fakeNative());
const require = createRequire(import.meta.url);
const { unpackStreamBatches, STREAM_BATCH, STREAM_FLUSH_BEGIN, STREAM_FLUSH_END } = require('../electron/bridge/spec.cjs');
const { useStore, beginStoreBatch, endStoreBatch, set, get } = await import('../src/store/core.ts');
const flush = await import('../src/lib/streamFlush.ts');

let commits = 0;
let off: () => void = () => {};
beforeEach(() => {
  off();
  commits = 0;
  off = useStore.subscribe(() => commits++);
});

/** The window: what the preload dispatches on, and the renderer listens to. */
const win = () => {
  const t = new EventTarget();
  return Object.assign(t, { dispatchEvent: t.dispatchEvent.bind(t) });
};

test('the event names the preload and the renderer use are the same', () => {
  assert.equal(flush.STREAM_FLUSH_BEGIN, STREAM_FLUSH_BEGIN);
  assert.equal(flush.STREAM_FLUSH_END, STREAM_FLUSH_END);
});

test('a stream batch is one store commit: many writes between the preload’s two events', () => {
  const w = win();
  const stop = flush.followStreamFlush(w, beginStoreBatch, endStoreBatch);
  const ipc = new EventEmitter();
  unpackStreamBatches(ipc, w);
  ipc.on('acp:event', (_e, n) => set({ flagsRev: n }));
  ipc.emit(STREAM_BATCH, {}, [
    ['acp:event', 1],
    ['acp:event', 2],
    ['acp:event', 3],
  ]);
  assert.equal(commits, 1);
  assert.equal(get().flagsRev, 3);
  // a lone event outside a batch still commits on its own
  set({ flagsRev: 4 });
  assert.equal(commits, 2);
  stop();
  ipc.emit(STREAM_BATCH, {}, [
    ['acp:event', 5],
    ['acp:event', 6],
  ]);
  assert.equal(commits, 4, 'stopped: each event commits again');
});

test('a listener that throws still ends the batch, so what was applied is kept and later writes commit', () => {
  const w = win();
  const stop = flush.followStreamFlush(w, beginStoreBatch, endStoreBatch);
  const ipc = new EventEmitter();
  unpackStreamBatches(ipc, w);
  ipc.on('acp:event', (_e, n) => {
    set({ flagsRev: n });
    if (n >= 2) throw new Error(`listener failed ${n}`);
  });
  assert.throws(
    () =>
      ipc.emit(STREAM_BATCH, {}, [
        ['acp:event', 1],
        ['acp:event', 2],
        ['acp:event', 3],
      ]),
    /listener failed 2/,
    'the first failure is the one thrown',
  );
  assert.equal(get().flagsRev, 3, 'the event behind the failing one was still delivered');
  assert.equal(commits, 1);
  set({ flagsRev: 9 });
  assert.equal(commits, 2);
  stop();
});

test('batches nest and an end without a begin is ignored', () => {
  endStoreBatch();
  beginStoreBatch();
  beginStoreBatch();
  set({ flagsRev: 11 });
  endStoreBatch();
  assert.equal(commits, 0, 'the outer batch is still open');
  endStoreBatch();
  assert.equal(commits, 1);
  assert.equal(get().flagsRev, 11);
});

test('without a window, or for junk, the preload unpacks as before', () => {
  const ipc = new EventEmitter();
  unpackStreamBatches(ipc);
  const heard: number[] = [];
  ipc.on('acp:event', (_e, n) => heard.push(n));
  ipc.emit(STREAM_BATCH, {}, [['acp:event', 1]]);
  ipc.emit(STREAM_BATCH, {}, 'junk');
  assert.deepEqual(heard, [1]);
});
