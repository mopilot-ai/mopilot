// A machine's live connection tells when it dropped (Remote Run audit chat:C22, seconds-level): linkWatch.cjs keeps the time, the registry's row carries it, and main's list sends it again at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMachines } from './support/hostKeySafe.ts';
import { hostWorld, tick } from './support/host-wire-kit.ts';
const require = createRequire(import.meta.url);
const { createLinkWatch } = require('../electron/host/linkWatch.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

/** A connection that says its state by hand. */
function fakeHost(state: string) {
  const fns = new Set<(s: string) => void>();
  let now = state;
  return {
    state: () => now,
    onState: (fn: (s: string) => void) => (fns.add(fn), () => void fns.delete(fn)),
    set: (s: string) => ((now = s), [...fns].forEach((fn) => fn(s))),
    listeners: () => fns.size,
  };
}

test('a connection that was online and is not says when it dropped; coming back clears it; each change is told once', (t) => {
  const w = hostWorld(t);
  const told: number[] = [];
  const ups: string[] = [];
  const links = createLinkWatch({ onChange: () => told.push(w.clock.now()), onUp: (id: string) => ups.push(id) });
  const host = fakeHost('online');
  const off = links.watch('h1', host);
  assert.equal(links.droppedAt('h1'), null);
  w.clock.advance(5_000);
  host.set('connecting');
  const at = links.droppedAt('h1');
  assert.equal(at, w.clock.now(), 'dated by the moment the connection said so');
  w.clock.advance(2_000);
  host.set('offline');
  assert.equal(links.droppedAt('h1'), at, 'a second state short of online keeps the first time');
  assert.equal(told.length, 1);
  host.set('online');
  assert.equal(links.droppedAt('h1'), null);
  assert.equal(told.length, 2);
  assert.deepEqual(ups, ['h1'], 'a connection that is back has the machine asked now');
  host.set('online');
  assert.equal(told.length, 2, 'an online that was already online says nothing');
  assert.equal(ups.length, 1);
  host.set('offline');
  off();
  assert.equal(links.droppedAt('h1'), undefined, 'ending the watch forgets the machine: the heartbeat is all there is to go by');
  assert.equal(host.listeners(), 0);
});

test('a connection that has not been online yet has not dropped, and one that starts online has', (t) => {
  const w = hostWorld(t);
  const links = createLinkWatch({ onChange: () => undefined });
  const starting = fakeHost('connecting');
  links.watch('h1', starting);
  starting.set('offline');
  assert.equal(links.droppedAt('h1'), undefined, 'a start that failed is not a drop, and says nothing of the link');
  starting.set('online');
  starting.set('offline');
  assert.equal(links.droppedAt('h1'), w.clock.now());
  const already = fakeHost('online');
  links.watch('h2', already);
  already.set('offline');
  assert.equal(links.droppedAt('h2'), w.clock.now());
});

test('the registry row carries the live drop while the machine counts as online, and not once it is offline', async (t) => {
  const w = hostWorld(t);
  let dropped: number | null = null;
  const registry = createRegistry({
    file: path.join(w.dir, 'hosts.json'),
    status: async () => ({ harnesses: [], capabilities: {} }),
    report: () => undefined,
    linkDropped: () => dropped,
  });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  await registry.check();
  assert.equal(registry.list()[0].linkDroppedAt, null);
  dropped = 12_345;
  assert.equal(registry.list()[0].linkDroppedAt, 12_345, 'the connection said it dropped');
  w.clock.advance(120_000);
  assert.equal(registry.list()[0].status, 'offline');
  assert.equal(registry.list()[0].linkDroppedAt, null, 'an offline machine is offline, not reconnecting');
});

test("main's list tells the windows at once when a machine's connection drops", async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'link-watch-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  // the machine is in the file the service reads, so the service makes its own registry (the one that takes the drop time)
  const seed = createRegistry({ file: path.join(d, 'host-registry.json'), report: () => undefined });
  seed.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/run/host.sock' });
  seed.dispose();
  const changes: any[] = [];
  let asked = 0;
  const machines = createMachines({
    dir: d,
    root: d,
    allowed: () => true,
    watch: () => () => undefined,
    call: async () => (asked++, { harnesses: [], capabilities: {} }),
    onChange: (s: any) => changes.push(s),
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    pool: { get: () => tun, closeAll: () => undefined },
    connect: w.net.connect,
  });
  t.after(() => machines.dispose());
  const host = machines.hostFor('h1');
  const up = host.connect();
  await tick();
  await up;
  w.clock.advance(1_000);
  await machines.check?.();
  const before = changes.length;
  tun.fail('the tunnel broke');
  await tick();
  assert.ok(changes.length > before, 'the windows are told as it happens');
  assert.equal(typeof machines.list().machines[0].linkDroppedAt, 'number');
  // the tunnel retries by itself; once the connection is back the machine is asked at once, not at the next heartbeat
  const beforeBack = asked;
  w.clock.advance(60_000);
  await tick();
  await tick();
  assert.equal('linkDroppedAt' in machines.list().machines[0], false, 'the drop is cleared when the connection is back');
  assert.ok(asked > beforeBack, 'the registry asked the machine as the connection came back');
});

test('a failed heartbeat on a busy Host is not a reconnect while the live connection is up; a drop is, and being back clears it at once', async (t) => {
  const w = hostWorld(t);
  const host = fakeHost('online');
  let beatFails = false;
  let links: any;
  const registry = createRegistry({
    file: path.join(w.dir, 'hosts.json'),
    status: async () => {
      if (beatFails) throw new Error('no answer');
      return { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
    },
    report: () => undefined,
    linkDropped: (id: string) => links.droppedAt(id),
  });
  links = createLinkWatch({ onChange: () => undefined });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  await registry.check();
  // a machine with no connection followed: a failed last ask is all there is to go by (the heartbeat's own reading)
  beatFails = true;
  w.clock.advance(30_000);
  await registry.check();
  assert.equal(registry.list()[0].status, 'online');
  assert.equal(typeof registry.list()[0].linkDroppedAt, 'number', 'no live connection: the failed ask says the link dropped');
  // the app's connection to it is up (a turn runs): the same failed beat is a busy Host, not a reconnect
  links.watch('h1', host);
  assert.equal(registry.list()[0].linkDroppedAt, null, 'a failed beat while the connection is up says nothing');
  // a turn long enough to miss beats, none failed: nothing either
  beatFails = false;
  await registry.check();
  w.clock.advance(60_000);
  assert.equal(registry.list()[0].linkDroppedAt, null);
  // the connection drops: Reconnecting from then; back: clear at once, whatever the last beat said
  beatFails = true;
  await registry.check();
  host.set('offline');
  assert.equal(registry.list()[0].linkDroppedAt, w.clock.now());
  host.set('online');
  assert.equal(registry.list()[0].linkDroppedAt, null, 'a failed beat does not keep a connection that is back reconnecting');
});

test('evidence of life wins: heartbeats that time out under a busy Host never make a machine offline while its live connection is up; total silence still does', async (t) => {
  const w = hostWorld(t);
  const host = fakeHost('online');
  let links: any;
  let busy = false;
  const registry = createRegistry({
    file: path.join(w.dir, 'hosts.json'),
    status: async () => {
      if (busy) throw new Error('The machine did not answer.');
      return { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
    },
    report: () => undefined,
    linkDropped: (id: string) => links.droppedAt(id),
  });
  links = createLinkWatch({ onChange: () => undefined });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  await registry.check();
  busy = true;
  links.watch('h1', host);
  for (let i = 0; i < 6; i++) {
    w.clock.advance(30_000);
    await registry.check();
  }
  const [timedOut] = registry.list();
  assert.equal(timedOut.status, 'online', 'three minutes of beats that time out, the connection up the whole time');
  assert.equal(timedOut.linkDroppedAt, null);
  // the connection drops: no evidence left but the old answer, long past the window
  host.set('offline');
  assert.equal(registry.list()[0].status, 'offline');
  // total silence with no connection (a failed ask, then Offline at the window) is hostRegistry.test.ts's A6 and chat C22 tests
});

test('#5135: a connection down for 30 s tells the list again (it is offline now), and coming back or ending the watch cancels that', (t) => {
  const w = hostWorld(t);
  const told: number[] = [];
  const links = createLinkWatch({ onChange: () => told.push(w.clock.now()) });
  const host = fakeHost('online');
  links.watch('h1', host);
  host.set('offline');
  assert.equal(told.length, 1);
  w.clock.advance(29_999);
  assert.equal(told.length, 1);
  w.clock.advance(1);
  assert.equal(told.length, 2, 'the list is read again when the drop has lasted 30 s');
  // back in time: no second reading is owed
  host.set('online');
  assert.equal(told.length, 3);
  host.set('offline');
  w.clock.advance(10_000);
  host.set('online');
  w.clock.advance(60_000);
  assert.equal(told.length, 5, 'a drop that ended inside the window leaves no timer');
  const other = fakeHost('online');
  const off = links.watch('h2', other);
  other.set('offline');
  off();
  const before = told.length;
  w.clock.advance(60_000);
  assert.equal(told.length, before, 'ending the watch cancels the timer');
});

test('#5135: a machine whose connection dropped is offline 30 s later, not 60 to 90 s after its last good heartbeat; being back, or a heartbeat answered since the drop, keeps it online', async (t) => {
  const w = hostWorld(t);
  const host = fakeHost('online');
  let beatFails = false;
  let links: any;
  const registry = createRegistry({
    file: path.join(w.dir, 'hosts.json'),
    status: async () => {
      if (beatFails) throw new Error('no answer');
      return { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
    },
    report: () => undefined,
    linkDropped: (id: string) => links.droppedAt(id),
  });
  links = createLinkWatch({ onChange: () => undefined });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  await registry.check();
  links.watch('h1', host);
  w.clock.advance(10_000);
  beatFails = true;
  host.set('offline');
  assert.equal(registry.list()[0].status, 'online', 'inside the window the machine is only reconnecting');
  assert.equal(typeof registry.list()[0].linkDroppedAt, 'number');
  w.clock.advance(29_999);
  assert.equal(registry.list()[0].status, 'online');
  w.clock.advance(1);
  const [gone] = registry.list();
  assert.equal(gone.status, 'offline', 'offline 30 s after the drop, the last good heartbeat only 40 s old');
  assert.equal(gone.linkDroppedAt, null);
  host.set('online');
  assert.equal(registry.list()[0].status, 'online', 'the connection is back: online at once');
  // the connection flaps but the heartbeat still answers: not offline
  beatFails = false;
  host.set('offline');
  w.clock.advance(31_000);
  await registry.check();
  assert.equal(registry.list()[0].status, 'online', 'a heartbeat answered since the drop is evidence of life');
});
