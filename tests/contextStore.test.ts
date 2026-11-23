// Context snapshots on disk and their wiring (electron/context/store.cjs, index.cjs, ipc/context.cjs, bridge/context.cjs, app/harnessTaps.cjs): kept per owner and bounded, written after a change and at quit, served to the windows, and fed by every harness without one reader's failure costing another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ContextStore, MAX_OWNERS, WRITE_MS } = require('../electron/context/store.cjs');
const { openContextService, appContext } = require('../electron/context/index.cjs');
const ipc = require('../electron/app/ipc/context.cjs');
const bridge = require('../electron/bridge/context.cjs');
const { openHarnessTaps } = require('../electron/app/harnessTaps.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');

const snap = (owner: string, at: number, extra: Record<string, unknown> = {}) => ({ owner, at, used: at, ...extra });
function fakeTimers() {
  const timers: (() => void)[] = [];
  return {
    timers,
    io: {
      setTimer: (fn: () => void, ms: number) => (assert.equal(ms, WRITE_MS), timers.push(fn), timers.length),
      clearTimer: () => {},
    },
  };
}

test('the store loads only well-formed snapshots, newest kept, and writes them once after a change, off the main thread', async () => {
  const writes: [string, string][] = [];
  const async: [string, string, () => boolean][] = [];
  const { timers, io } = fakeTimers();
  const store = new ContextStore({
    file: () => '/tmp/ctx.json',
    io: {
      ...io,
      readFile: (file: string) => (
        assert.equal(file, '/tmp/ctx.json'),
        // c and e have no time: they read as the oldest
        { v: 1, owners: { a: snap('a', 2), b: snap('b', 1), bad: snap('other', 3), nul: null, c: { owner: 'c' }, e: { owner: 'e' } } }
      ),
      write: (file: string, data: string) => writes.push([file, data]),
      writeAsync: async (file: string, data: string, current: () => boolean) => void async.push([file, data, current]),
    },
  });
  assert.equal(store.get('a').at, 2);
  assert.equal(store.get('bad'), null);
  assert.deepEqual([...store.loaded().keys()], ['c', 'e', 'b', 'a']);
  store.put(snap('d', 5));
  store.put(snap('a', 6));
  assert.equal(timers.length, 1);
  timers[0]();
  // the timer's write is the asynchronous one
  assert.equal(writes.length, 0);
  assert.equal(async.length, 1);
  const saved = JSON.parse(async[0][1]);
  assert.equal(saved.v, 1);
  assert.deepEqual(Object.keys(saved.owners), ['c', 'e', 'b', 'd', 'a']);
  assert.equal(async[0][2](), true);
  // a flush with nothing pending still writes what is loaded, in full, and outdates a write still on its way
  store.flush();
  assert.equal(writes.length, 1);
  assert.equal(async[0][2](), false);
  const empty = new ContextStore({ file: () => '/tmp/x', io: { ...io, write: () => assert.fail('no write') } });
  empty.flush();
  empty.save();
});

test('a file of another version or shape loads as empty; the store keeps at most MAX_OWNERS', () => {
  const { io } = fakeTimers();
  for (const saved of [null, { v: 2, owners: { a: snap('a', 1) } }, { v: 1 }, { v: 1, owners: 'x' }]) {
    const store = new ContextStore({ file: () => '/not-written/ctx.json', io: { ...io, readFile: () => saved } });
    assert.equal(store.loaded().size, 0);
  }
  const store = new ContextStore({ file: () => '/not-written/ctx.json', io: { ...io, readFile: () => null } });
  for (let i = 0; i <= MAX_OWNERS; i++) store.put(snap(`o${i}`, i));
  assert.equal(store.loaded().size, MAX_OWNERS);
  assert.equal(store.get('o0'), null);
  assert.ok(store.get(`o${MAX_OWNERS}`));
});

test('a write that fails is noted and the next change writes again', async () => {
  clearIgnored();
  const { timers, io } = fakeTimers();
  let fail = true;
  const store = new ContextStore({
    file: () => '/not-written/ctx.json',
    io: {
      ...io,
      readFile: () => null,
      write: () => {
        if (fail) throw new Error('disk full');
      },
      writeAsync: async () => {
        throw new Error('disk full');
      },
    },
  });
  store.put(snap('a', 1));
  timers[0]();
  await new Promise((r) => setImmediate(r));
  assert.ok(recentIgnored().some((e: any) => /context snapshots/.test(JSON.stringify(e))));
  fail = false;
  store.put(snap('a', 2));
  assert.equal(timers.length, 2);
  // the quit flush fails the same way, and is noted
  clearIgnored();
  fail = true;
  store.flush();
  assert.ok(recentIgnored().some((e: any) => /context snapshots/.test(JSON.stringify(e))));
});

test('the real store round-trips through its file in userData, and timers default to the real ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-store-'));
  try {
    const store = new ContextStore({ file: () => path.join(dir, 'c.json') });
    store.put(snap('a', 1));
    store.flush();
    // the timer's write goes through the real asynchronous writer
    // saving with no timer waiting is the same write
    store.save();
    store.put(snap('b', 2));
    store.save();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(new ContextStore({ file: () => path.join(dir, 'c.json') }).get('b').used, 2);
    const again = new ContextStore({ file: () => path.join(dir, 'c.json') });
    assert.equal(again.get('a').used, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main's service publishes to every window, reads Claude Code through its control request, and serves the IPC", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-svc-'));
  try {
    const sent: any[] = [];
    const controls: any[] = [];
    let observer: ((e: any) => void) | null = null;
    const opened = openContextService({
      app: { getPath: (n: string) => (assert.equal(n, 'userData'), dir) },
      broadcastAll: (channel: string, payload: unknown) => sent.push([channel, payload]),
      chatOf: (id: string) => `chat:${id}`,
      claude: {
        observe: (fn: (e: any) => void) => (observer = fn),
        turnApi: { control: async (...a: unknown[]) => (controls.push(a), { totalTokens: 4, rawMaxTokens: 8 }) },
      },
    });
    assert.equal(appContext(), opened);
    observer!({ key: 'claude:k', kind: 'message', msg: { type: 'result', usage: { input_tokens: 3 } } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(controls[0], ['claude:k', 'contextUsage', { detail: 'summary' }]);
    assert.equal(sent.at(-1)[0], 'context:snapshot');
    assert.equal(sent.at(-1)[1].chatId, 'chat:claude:k');
    // the IPC
    const handlers: Record<string, (...a: any[]) => any> = {};
    ipc.register({ handle: (ch: string, fn: any) => (handlers[ch] = fn) }, {});
    const owner = JSON.stringify(['chat:claude:k', 'claude', 'claude:k']);
    assert.equal((await handlers['context:get']({}, owner)).used, 4);
    await handlers['context:refresh']({}, owner, 'full');
    assert.deepEqual(controls.at(-1)[2], { detail: 'full' });
    await handlers['context:refresh']({}, owner, 'other');
    assert.deepEqual(controls.at(-1)[2], { detail: 'summary' });
    // before the service opens there is nothing to answer
    const none: Record<string, (...a: any[]) => any> = {};
    ipc.register({ handle: (ch: string, fn: any) => (none[ch] = fn) }, {}, () => null);
    assert.equal(await none['context:get']({}, owner), null);
    assert.equal(await none['context:refresh']({}, owner), null);
    opened.store.flush();
    assert.ok(fs.existsSync(path.join(dir, 'context-snapshots.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bridge exposes the get, refresh and push channels', () => {
  assert.deepEqual(bridge.get, { kind: 'invoke', channel: 'context:get', params: 1 });
  assert.deepEqual(bridge.refresh, { kind: 'invoke', channel: 'context:refresh', params: 2 });
  assert.deepEqual(bridge.onSnapshot, { kind: 'on', channel: 'context:snapshot' });
});

test('the harness taps feed the ledger and the context service, each on its own, and flush both at quit', () => {
  clearIgnored();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-taps-'));
  try {
    const taps = openHarnessTaps({
      app: { getPath: () => dir },
      readState: () => ({ prefs: {} }),
      claude: { observe: () => {}, ledgerAccount: () => null, turnApi: { control: async () => null } },
      live: {},
      broadcastAll: () => {},
      chatOf: (id: string) => id,
    });
    const seen: string[] = [];
    taps.ledger.codex.emitted = () => seen.push('emitted');
    taps.ledger.codex.message = () => {
      throw new Error('ledger broke');
    };
    taps.context.service.codexMessage = () => seen.push('context codex');
    taps.ledger.acp.event = () => seen.push('ledger acp');
    taps.context.service.acpEvent = () => {
      throw new Error('context broke');
    };
    taps.codexEmitted({});
    taps.codexMessage({});
    taps.acpEvent({});
    assert.deepEqual(seen, ['emitted', 'context codex', 'ledger acp']);
    assert.equal(recentIgnored().length, 2);
    taps.ledger.codex.emitted = () => {
      throw new Error('x');
    };
    taps.codexEmitted({});
    assert.equal(recentIgnored().length, 3);
    taps.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
