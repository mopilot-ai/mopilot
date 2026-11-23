// How long a window waits on main for what it asks (electron/perf/probe.cjs timedIpc): with the probe running, each
// handler's answer is timed per channel and written once a second as an `invoke` sample; with it off, nothing is timed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const probe = require('../electron/perf/probe.cjs');

/** An ipcMain stand-in: the handler each channel got, and a way to invoke it as a window would. */
function fakeIpc() {
  const handlers = new Map<string, Function>();
  const ipc = {
    handle: (channel: string, fn: Function) => handlers.set(channel, fn),
    handleOnce: (channel: string, fn: Function) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
    tag: 'fake',
  };
  return { ipc, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args), handlers };
}

test('with the probe off a handler answers as registered and nothing is timed', async () => {
  const { ipc, invoke, handlers } = fakeIpc();
  let reads = 0;
  const timed = probe.timedIpc(ipc, () => (reads++, 0));
  timed.handle('a:b', (_e: unknown, x: number) => x * 2);
  // the answer as the handler gives it: a value, not a promise
  assert.equal(invoke('a:b', 21), 42);
  // the wrapper names the handler it wraps
  const fn = (_e: unknown, x: number) => x;
  timed.handle('c:d', fn);
  assert.equal((handlers.get('c:d') as Function & { handles: Function }).handles, fn);
  assert.equal(reads, 0);
  // other members pass through, bound to the original
  timed.removeHandler('a:b');
  assert.equal(handlers.has('a:b'), false);
  assert.equal(timed.tag, 'fake');
});

test('with the probe on each answer is timed per channel, a failed one too, and written once a second', async (t) => {
  const pushed: any[] = [];
  const writer = {
    push: (l: string) => (pushed.push(JSON.parse(l)), true),
    takeDropped: () => 0,
    flush: async () => undefined,
    drain: async () => undefined,
  };
  let tick: (() => void) | null = null;
  probe.startProbe({
    dir: '/x',
    id: 'ipc',
    now: () => 1,
    writer,
    monitor: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0, max: 0 }),
    setInterval: ((cb: () => void) => ((tick = cb), { unref: () => undefined })) as any,
    clearInterval: (() => undefined) as any,
    spawns: { take: () => ({ count: 0, commands: {}, sites: {} }), stop: () => undefined },
    marks: () => [],
    onMark: () => () => undefined,
    breakdowns: () => [],
    requires: () => ({ files: 0, ms: 0, slowest: [], packages: [] }),
  });
  t.after(() => probe.stopProbe());
  const { ipc, invoke } = fakeIpc();
  let now = 0;
  const timed = probe.timedIpc(ipc, () => now);
  timed.handle('chats:list', async () => {
    now += 30;
    return ['a'];
  });
  timed.handleOnce('git:info', () => {
    now += 5;
    throw new Error('not a repository');
  });
  assert.deepEqual(await invoke('chats:list'), ['a']);
  assert.deepEqual(await invoke('chats:list'), ['a']);
  await assert.rejects(invoke('git:info'), /not a repository/);
  tick!();
  assert.deepEqual(
    pushed.filter((s) => s.kind === 'invoke'),
    [
      { t: 1, kind: 'invoke', channel: 'chats:list', count: 2, ms: 60, max: 30 },
      { t: 1, kind: 'invoke', channel: 'git:info', count: 1, ms: 5, max: 5 },
    ],
  );
  // the next second starts empty
  pushed.length = 0;
  tick!();
  assert.deepEqual(
    pushed.filter((s) => s.kind === 'invoke'),
    [],
  );
  // by default the process clock times it
  const other = fakeIpc();
  probe.timedIpc(other.ipc).handle('x:y', () => 1);
  assert.equal(await other.invoke('x:y'), 1);
  tick!();
  assert.equal(pushed.filter((s) => s.kind === 'invoke' && s.channel === 'x:y').length, 1);
});
