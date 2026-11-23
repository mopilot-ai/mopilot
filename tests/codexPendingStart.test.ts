// The Codex app-server started while its binary is still looked up (electron/harness/codexProcess.cjs): writes queue
// in order until it spawns, a stop or a newer start retires the lookup, a failure is reported and retried, and the
// adapter (electron/harness/codexConnection.cjs) ends a pending start whose initialize timed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { AppServer, CodexAdapter, settle } from './support/codex-harness/fixture';
import { deferred } from './support/async-scenarios.ts';
const { guardSend } = createRequire(import.meta.url)('../electron/session/contract/inputGuard.cjs');

function fakeProc() {
  const p: any = new EventEmitter();
  p.pid = 42;
  p.written = [] as string[];
  p.kills = 0;
  p.kill = () => p.kills++;
  p.stdin = Object.assign(new EventEmitter(), { write: (s: string) => p.written.push(s) });
  p.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  p.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  return p;
}

/** An AppServer whose lookups are answered by hand: each start takes the next one queued. */
function pendingServer() {
  const lookups: ReturnType<typeof deferred<string>>[] = [];
  const spawned: { cmd: string; args: string[]; proc: any }[] = [];
  let spawnThrows = false;
  const server = new AppServer({
    findBin: () => {
      const d = deferred();
      lookups.push(d);
      return d.promise;
    },
    env: () => ({}),
    spawn: (cmd: string, args: string[]) => {
      if (spawnThrows) throw new Error('spawn EACCES');
      const proc = fakeProc();
      spawned.push({ cmd, args, proc });
      return proc;
    },
  });
  const events: any[] = [];
  server.listeners.add((e: any) => events.push(e));
  return {
    server,
    lookups,
    spawned,
    events,
    throwOnSpawn: () => {
      spawnThrows = true;
    },
  };
}

test('a start still looking up its binary is starting; writes made meanwhile go out in order once it spawns', async () => {
  const { server, lookups, spawned } = pendingServer();
  server.start();
  assert.equal(server.status, 'starting');
  assert.equal(server.proc, null);
  server.send({ id: 1, method: 'initialize' });
  server.send({ method: 'initialized' });
  server.start();
  assert.equal(lookups.length, 1, 'one lookup for the start and the writes made during it');
  lookups[0].resolve('/x/codex');
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/x/codex');
  assert.deepEqual(spawned[0].args, ['app-server']);
  assert.equal(server.status, 'running');
  assert.equal(server.pending, null);
  server.send({ id: 2, method: 'thread/list' });
  assert.deepEqual(
    spawned[0].proc.written.map((l: string) => JSON.parse(l)),
    [{ id: 1, method: 'initialize' }, { method: 'initialized' }, { id: 2, method: 'thread/list' }],
  );
});

test('a guarded Codex write is refused after binary lookup, freeing its tool session', async () => {
  const { server, lookups, spawned } = pendingServer();
  const prepared = new Set<string>();
  const adapter = new CodexAdapter({
    server,
    tools: {
      outgoing(msg: { id: string; method: string }) {
        if (msg.method === 'thread/fork') prepared.add(msg.id);
        return { ...msg };
      },
      observe(msg: { id: string; error?: unknown }) {
        if (msg.error) prepared.delete(msg.id);
      },
      exited() {
        prepared.clear();
      },
    } as any,
  });
  let current = true;
  const refusal = new Error('The parent no longer owns this request.');
  const params = { threadId: 'parent' };
  guardSend(params, () => {
    if (!current) throw refusal;
  });
  const opening = adapter.call('thread/fork', params);
  const refused = assert.rejects(opening, (error) => error === refusal);
  assert.equal(prepared.size, 1);
  current = false;
  lookups[0].resolve('/x/codex');
  await refused;
  assert.deepEqual(spawned[0].proc.written, []);
  assert.equal(prepared.size, 0);
  assert.equal(adapter.pending.size, 0);

  const listing = adapter.call('thread/list');
  const proc = spawned[0].proc;
  const sent = JSON.parse(proc.written[0]);
  assert.deepEqual(sent.params, {});
  proc.stdout.emit('data', JSON.stringify({ id: sent.id, result: { data: [] } }) + '\n');
  assert.deepEqual(await listing, { data: [] });
  server.stop();
});

test('stop during the lookup spawns nothing and drops the queued writes; the next start looks again', async () => {
  const { server, lookups, spawned, events } = pendingServer();
  server.send({ id: 1, method: 'initialize' });
  server.stop();
  assert.equal(server.status, 'stopped');
  assert.deepEqual(events, [{ kind: 'stopped' }]);
  lookups[0].resolve('/old/codex');
  await settle();
  assert.equal(spawned.length, 0);
  assert.equal(server.status, 'stopped');
  // a stop with nothing running or starting is not news
  server.stop();
  assert.equal(events.length, 1);
  server.start();
  lookups[1].resolve('/new/codex');
  await settle();
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ['/new/codex'],
  );
  assert.deepEqual(spawned[0].proc.written, [], 'the stopped start kept nothing for the new one');
});

test("an older lookup that settles after a newer start began can't spawn, flush or fail into it", async () => {
  const { server, lookups, spawned, events } = pendingServer();
  server.send({ id: 1, method: 'old' });
  server.stop();
  server.send({ id: 2, method: 'new' });
  lookups[0].reject(new Error('old lookup failed'));
  await settle();
  assert.equal(server.status, 'starting', 'the newer start is still on its way');
  assert.deepEqual(events, [{ kind: 'stopped' }]);
  server.stop();
  server.send({ id: 3, method: 'newest' });
  lookups[1].resolve('/second/codex');
  lookups[2].resolve('/third/codex');
  await settle();
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ['/third/codex'],
  );
  assert.deepEqual(
    spawned[0].proc.written.map((l: string) => JSON.parse(l).method),
    ['newest'],
  );
});

test('a failed lookup reports an error, drops the writes and lets the next start retry', async () => {
  const { server, lookups, spawned, events } = pendingServer();
  server.send({ id: 1, method: 'initialize' });
  lookups[0].reject(new Error('no codex'));
  await settle();
  assert.equal(server.status, 'exited');
  assert.equal(server.pending, null);
  assert.deepEqual(events, [{ kind: 'error', error: 'no codex' }]);
  // a rejection that isn't an Error still reads as text
  server.start();
  lookups[1].reject('raw');
  await settle();
  assert.deepEqual(events.at(-1), { kind: 'error', error: 'raw' });
  server.start();
  lookups[2].resolve('/x/codex');
  await settle();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].proc.written, []);
  assert.equal(server.status, 'running');
});

test('a spawn that throws once the lookup answers is given up on as an error', async () => {
  const { server, lookups, events, throwOnSpawn } = pendingServer();
  throwOnSpawn();
  server.start();
  lookups[0].resolve('/x/codex');
  await settle();
  assert.equal(server.status, 'exited');
  assert.equal(server.pending, null);
  assert.equal(server.proc, null);
  assert.deepEqual(events, [{ kind: 'error', error: 'spawn EACCES' }]);
});

test('a spawn that throws part way is ended with its process, so the next start spawns afresh', async () => {
  const procs: any[] = [];
  const lookups: ReturnType<typeof deferred<string>>[] = [];
  const server = new AppServer({
    findBin: () => {
      const d = deferred<string>();
      lookups.push(d);
      return d.promise;
    },
    env: () => ({}),
    spawn: () => {
      const proc = fakeProc();
      if (!procs.length)
        proc.stderr.setEncoding = () => {
          throw new Error('no encoding');
        };
      procs.push(proc);
      return proc;
    },
  });
  server.start();
  lookups[0].resolve('/x/codex');
  await settle();
  assert.equal(server.proc, null);
  assert.equal(server.status, 'exited');
  assert.equal(procs[0].kills, 1);
  server.start();
  lookups[1].resolve('/x/codex');
  await settle();
  assert.equal(server.proc, procs[1]);
  assert.equal(server.status, 'running');
});

test('a binary known now spawns within start(), as before', () => {
  const spawned: string[] = [];
  const server = new AppServer({
    findBin: () => '/known/codex',
    env: () => ({}),
    spawn: (cmd: string) => (spawned.push(cmd), fakeProc()),
  });
  server.start();
  assert.deepEqual(spawned, ['/known/codex']);
  assert.equal(server.status, 'running');
  assert.equal(server.pending, null);
});

/* ---------- the adapter's initialize on a pending start ---------- */
const answer = (proc: any, id: number, result: any) => proc.stdout.emit('data', JSON.stringify({ id, result }) + '\n');

test('initialize on a start still looking up its binary reaches the process once it spawns, and is answered', async () => {
  const { server, lookups, spawned } = pendingServer();
  const a = new CodexAdapter({ server, nativeOf: () => null, probe: null });
  const p = a.initialize();
  assert.equal(server.status, 'starting');
  lookups[0].resolve('/x/codex');
  await settle();
  const proc = spawned[0].proc;
  const init = JSON.parse(proc.written[0]);
  assert.equal(init.method, 'initialize');
  answer(proc, init.id, { userAgent: 'codex_cli_rs/0.50.0' });
  await p;
  assert.equal(JSON.parse(proc.written[1]).method, 'initialized');
  assert.equal(proc.kills, 0);
});

test('an initialize that times out while the lookup is still out gives that start up; its late answer spawns nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { server, lookups, spawned, events } = pendingServer();
  const a = new CodexAdapter({ server, nativeOf: () => null, probe: null });
  const p = a.initialize();
  t.mock.timers.tick(30_000);
  await assert.rejects(p, /did not answer initialize/);
  await settle();
  assert.equal(server.pending, null);
  assert.equal(server.status, 'exited');
  assert.deepEqual(events.at(-1), { kind: 'error', error: 'Codex took too long to start' });
  lookups[0].resolve('/late/codex');
  await settle();
  assert.equal(spawned.length, 0, 'the timed-out initialize never reaches a process');
  // the next connect starts and looks up again
  const next = a.initialize();
  lookups[1].resolve('/x/codex');
  await settle();
  const proc = spawned[0].proc;
  answer(proc, JSON.parse(proc.written[0]).id, {});
  await next;
});

test('an initialize that times out after the pending start spawned ends that process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { server, lookups, spawned } = pendingServer();
  const a = new CodexAdapter({ server, nativeOf: () => null, probe: null });
  const p = a.initialize();
  lookups[0].resolve('/x/codex');
  await settle();
  t.mock.timers.tick(30_000);
  await assert.rejects(p, /did not answer initialize/);
  assert.equal(spawned[0].proc.kills, 1);
});

test("a timed-out initialize leaves alone a newer start's lookup", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { server, lookups, spawned } = pendingServer();
  const a = new CodexAdapter({ server, nativeOf: () => null, probe: null });
  const p = a.initialize();
  // stopped and started again before the old initialize's failure is handled
  server.stop();
  server.start();
  const newer = server.pending;
  await assert.rejects(p, /exited/);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(server.pending, newer);
  assert.equal(server.status, 'starting');
  lookups[0].resolve('/old/codex');
  lookups[1].resolve('/new/codex');
  await settle();
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ['/new/codex'],
  );
});

test('a restart whose initialize times out while the lookup is still out gives it up and tries again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { server, lookups, spawned } = pendingServer();
  const statuses: any[] = [];
  const a = new CodexAdapter({ server, nativeOf: () => null, probe: null, backoff: [1, 1], onStatus: (s: any) => statuses.push(s) });
  const first = a.initialize();
  lookups[0].resolve('/x/codex');
  await settle();
  const proc = spawned[0].proc;
  answer(proc, JSON.parse(proc.written[0]).id, {});
  await first;
  // it crashes: the restart's start waits on a lookup that doesn't answer in time
  proc.emit('exit', 1, null);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(server.status, 'starting');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(server.pending, null);
  assert.deepEqual(
    statuses.filter((s) => s.kind === 'restarting').map((s) => s.attempt),
    [1, 2],
  );
  // the given-up lookup answering late spawns nothing
  lookups[1].resolve('/late/codex');
  await settle();
  assert.equal(spawned.length, 1);
  clearTimeout(a.restartTimer);
});

test('the app-server runs the copy the binary lookup falls back to once the default one quits twice before it answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let using = '/apps/alpha/codex';
  const spawned: { cmd: string; proc: any }[] = [];
  const copy = (path: string) => ({ path, version: null, via: null, from: null });
  const server = new AppServer({
    findBin: () => using,
    env: () => ({}),
    spawn: (cmd: string) => {
      const proc = fakeProc();
      spawned.push({ cmd, proc });
      return proc;
    },
    copies: {
      copyOf: (bin: string | null) => ({ copy: copy(bin ?? 'codex'), pinned: false }),
      fallBack: (bin: string | null) => (bin === '/apps/alpha/codex' ? copy((using = '/usr/bin/codex')) : null),
    },
  });
  const statuses: any[] = [];
  const a = new CodexAdapter({ server, nativeOf: () => null, probe: null, backoff: [1, 1], onStatus: (s: any) => statuses.push(s) });
  a.connect().catch(() => undefined);
  spawned[0].proc.emit('exit', 101, null);
  await settle();
  t.mock.timers.tick(1);
  await settle();
  // the restart ran the same copy, which quit again before it answered
  spawned[1].proc.emit('exit', 101, null);
  await settle();
  assert.deepEqual(
    statuses.find((s) => s.kind === 'switched'),
    { kind: 'switched', from: copy('/apps/alpha/codex'), to: copy('/usr/bin/codex') },
  );
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ['/apps/alpha/codex', '/apps/alpha/codex', '/usr/bin/codex'],
  );
  assert.equal(server.bin, '/usr/bin/codex');
  answer(spawned[2].proc, JSON.parse(spawned[2].proc.written[0]).id, {});
  await settle();
  assert.deepEqual(statuses.at(-1), { kind: 'ready' });
});
