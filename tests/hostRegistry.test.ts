// The Host registry (electron/host/registry.cjs): a record per machine persisted atomically (W3), liveness on a mocked clock (A6), an address only from the record (B1), malformed status replies (B1), overlapping beats and a machine removed mid-call (A1, A3), a failed write (W2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createRegistry, setupReason } = require('../electron/host/registry.cjs');

const ready = {
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  capabilities: { iab: false, cu: false, bu: false, shell: true },
};
const dir = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'hosts.json');
};
const world = (t: any, status: (r: any) => Promise<unknown> = async () => ready) => {
  const clock = installFakeClock(t, 1_000_000);
  const file = dir(t);
  const reports: Error[] = [];
  const make = (s = status) => createRegistry({ file, status: s, report: (e: Error) => reports.push(e) });
  const registry = make();
  t.after(() => registry.dispose());
  return { clock, file, reports, registry, make };
};
const box = { id: 'h1', name: 'Build box', address: 'me@build.example' };

test('a heartbeat every 30 s keeps a machine online for 90 s after its last answer, then it is offline (A6)', async (t) => {
  let up = true;
  const w = world(t, async () => {
    if (!up) throw new Error('tunnel down');
    return ready;
  });
  w.registry.add(box);
  assert.equal(w.registry.list()[0].status, 'offline');
  assert.equal(w.registry.resolved(), false);
  w.registry.start();
  w.registry.start();
  await w.registry.check();
  assert.equal(w.registry.list()[0].status, 'online');
  assert.equal(w.registry.resolved(), true);
  up = false;
  w.clock.advance(30_000);
  await new Promise((r) => setImmediate(r));
  w.clock.advance(59_999);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.registry.list()[0].status, 'online', 'inside the window');
  w.clock.advance(1);
  await new Promise((r) => setImmediate(r));
  const [r] = w.registry.list();
  assert.equal(r.status, 'offline', 'at the end of the window');
  assert.match(r.reason, /Unreachable: tunnel down/);
  up = true;
  await w.registry.check();
  assert.equal(w.registry.list()[0].status, 'online', 'an answer after a failure restores it');
});

test('a machine that never answered says so, and one that went quiet says for how long', async (t) => {
  const w = world(t, async () => {
    throw 'refused';
  });
  w.registry.add(box);
  assert.equal(w.registry.list()[0].reason, 'Not reached yet.');
  await w.registry.check();
  assert.equal(w.registry.list()[0].reason, 'Unreachable: refused');
  assert.equal(w.registry.resolved(), true, 'a failure is also an answer');
  const quiet = createRegistry({ file: dir(t), status: async () => ready });
  t.after(() => quiet.dispose());
  quiet.add(box);
  await quiet.check();
  w.clock.advance(120_000);
  assert.equal(quiet.list()[0].reason, 'No answer for 90 seconds.');
});

test('needs-setup when status reports a missing harness or sign-in, and the reason is one line', async (t) => {
  let reply: unknown = { harnesses: [], capabilities: {} };
  const w = world(t, async () => reply);
  w.registry.add(box);
  await w.registry.check();
  assert.deepEqual([w.registry.list()[0].status, w.registry.list()[0].reason], ['needs-setup', 'No agent is installed on this machine.']);
  reply = { harnesses: [{ id: 'codex', detected: false, signedIn: false }], capabilities: {} };
  await w.registry.check();
  assert.equal(w.registry.list()[0].reason, 'codex is not installed on this machine.');
  reply = { harnesses: [{ id: 'codex', detected: true, signedIn: false }], capabilities: {} };
  await w.registry.check();
  assert.equal(w.registry.list()[0].reason, 'codex is not signed in on this machine.');
  // a Host lists every harness it knows: one that is ready is enough, the absent ones are not a setup the machine waits for
  reply = {
    harnesses: [
      { id: 'claude', detected: true, signedIn: true },
      { id: 'codex', detected: true, signedIn: false },
      { id: 'gemini', detected: false, signedIn: false },
    ],
    capabilities: {},
  };
  await w.registry.check();
  assert.deepEqual([w.registry.list()[0].status, w.registry.list()[0].reason], ['online', '']);
  // none ready: a harness that is installed but signed out is what to fix first, then one that is not installed
  reply = {
    harnesses: [
      { id: 'gemini', detected: false, signedIn: false },
      { id: 'codex', detected: true, signedIn: false },
    ],
    capabilities: {},
  };
  await w.registry.check();
  assert.equal(w.registry.list()[0].reason, 'codex is not signed in on this machine.');
  reply = ready;
  await w.registry.check();
  assert.equal(w.registry.list()[0].status, 'online');
  assert.equal(setupReason(ready), '');
});

test('a status that is not a status never counts as a heartbeat (B1)', async (t) => {
  for (const bad of [
    null,
    'ok',
    [],
    { harnesses: 'x', capabilities: {} },
    { harnesses: [{ id: 1 }], capabilities: {} },
    { harnesses: [], capabilities: [] },
  ]) {
    const w = world(t, async () => bad);
    w.registry.add(box);
    await w.registry.check();
    const [r] = w.registry.list();
    assert.equal(r.status, 'offline');
    assert.equal(r.lastHeartbeat, null);
    assert.match(r.reason, /cannot read/);
    w.registry.dispose();
  }
});

test('an address comes from the record only: an unknown machine or a record without one is refused, never guessed (B1)', (t) => {
  const w = world(t);
  assert.throws(() => w.registry.address('nope'), /not in the registry/);
  assert.throws(() => w.registry.add({ id: 'x', name: 'x' }), /needs an address/);
  assert.throws(() => w.registry.add({ id: 'x', address: '  ' }), /needs an address/);
  assert.throws(() => w.registry.add({ address: 'a@b' }), /needs an id/);
  assert.throws(() => w.registry.add(null as any), /needs an id/);
  assert.throws(() => w.registry.remove('nope'), /not in the registry/);
  w.registry.add({ id: 'h3', address: 'me@h3', capabilities: { shell: true }, harnesses: ready.harnesses });
  assert.deepEqual(w.registry.list()[0].harnesses, ready.harnesses);
  w.registry.remove('h3');
  w.registry.add({ id: 'h2', address: 'me@h2', capabilities: 3 as any, harnesses: 3 as any });
  assert.equal(w.registry.address('h2'), 'me@h2');
  assert.equal(w.registry.list()[0].name, 'h2', 'the id names a machine that has no name');
  assert.deepEqual(w.registry.list()[0].harnesses, []);
  assert.deepEqual(fs.readdirSync(path.dirname(w.file)), ['hosts.json'], 'no temporary file is left behind');
});

test('records survive a restart, and a record without an address or with a bad field is skipped, not guessed (B1)', async (t) => {
  const w = world(t);
  w.registry.add(box);
  await w.registry.check();
  const saved = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  saved.hosts.push({ id: 'noaddr', name: 'x' }, 'junk', {
    id: 'h3',
    name: 'h3',
    address: 'me@h3',
    capabilities: [],
    harnesses: [{ id: 1 }, ...ready.harnesses],
    lastHeartbeat: 'soon',
    setup: 5,
  });
  saved.hosts.push({ id: 'h4', name: 'h4', address: 'me@h4', harnesses: 'x' });
  fs.writeFileSync(w.file, JSON.stringify(saved));
  const again = w.make();
  t.after(() => again.dispose());
  assert.deepEqual(
    again.list().map((r: any) => r.id),
    ['h1', 'h3', 'h4'],
  );
  assert.equal(again.list()[0].status, 'online', 'still inside the 90 s window after a restart');
  assert.equal(again.list()[1].lastHeartbeat, null);
  assert.deepEqual(again.list()[1].harnesses, ready.harnesses);
  assert.equal(again.resolved(), false, 'a restarted app has not asked yet');
});

test('a corrupt registry file keeps the prior data, is copied aside and reported (W3)', (t) => {
  const w = world(t);
  w.registry.add(box);
  let changes = 0;
  w.registry.onChange(() => changes++);
  fs.writeFileSync(w.file, '{not json');
  w.registry.reload();
  assert.equal(w.registry.list().length, 1, 'the prior data stays');
  assert.equal(changes, 0, 'no false change notification');
  assert.equal(w.reports.length, 1);
  assert.ok(w.registry.loadError());
  assert.equal(fs.readFileSync(`${w.file}.unreadable`, 'utf8'), '{not json');
  // a fresh process over the same file starts empty but reports it, and loses nothing it could not read
  const fresh = w.make();
  t.after(() => fresh.dispose());
  assert.equal(fresh.list().length, 0);
  assert.equal(w.reports.length, 2);
  fs.writeFileSync(w.file, '[]');
  w.registry.reload();
  assert.match(String(w.registry.loadError()), /Invalid saved state/);
  fs.writeFileSync(w.file, JSON.stringify({ hosts: [] }));
  w.registry.reload();
  assert.equal(w.registry.loadError(), null);
  assert.equal(w.registry.list().length, 0);
  assert.equal(changes, 1);
});

test('a failed write changes nothing and reaches the caller (W2); a failed write after an answer is reported, not lost', async (t) => {
  const w = world(t);
  w.registry.add(box);
  fs.rmSync(w.file);
  fs.mkdirSync(w.file);
  assert.throws(() => w.registry.add({ id: 'h2', address: 'me@h2' }));
  assert.throws(() => w.registry.remove('h1'));
  assert.deepEqual(
    w.registry.list().map((r: any) => r.id),
    ['h1'],
  );
  await w.registry.check();
  assert.equal(w.registry.list()[0].status, 'online', 'the answer holds for this run');
  assert.equal(w.reports.length, 1);
});

test('overlapping beats for one machine join the call in flight (A1), and a machine removed mid-call is not revived (A3, A4)', async (t) => {
  let calls = 0;
  let release: (v: unknown) => void = () => {};
  const w = world(t, () => {
    calls++;
    return new Promise((r) => (release = r));
  });
  w.registry.add(box);
  const a = w.registry.check();
  const b = w.registry.check();
  assert.equal(calls, 1);
  w.registry.remove('h1');
  release(ready);
  await Promise.all([a, b]);
  assert.equal(w.registry.list().length, 0);
  assert.equal(w.registry.resolved(), true);
  // replaced under a pending failure: the old failure does not mark the new record
  let fail: (e: Error) => void = () => {};
  const x = world(t, () => new Promise((_, rej) => (fail = rej)));
  x.registry.add(box);
  const p = x.registry.check();
  x.registry.add({ ...box, address: 'me@other' });
  fail(new Error('late'));
  await p;
  assert.equal(x.registry.list()[0].reason, 'Not reached yet.');
  // disposed mid-call
  const y = world(t, () => new Promise((r) => (release = r)));
  y.registry.add(box);
  const q = y.registry.check();
  y.registry.dispose();
  release(ready);
  await q;
  assert.equal(y.registry.list()[0].lastHeartbeat, null);
  y.registry.start();
  assert.equal(y.clock.pending, 0, 'a disposed registry starts no heartbeat');
});

test('a late failure for a removed machine is ignored too (A2)', async (t) => {
  let fail: (e: Error) => void = () => {};
  const w = world(t, () => new Promise((_, rej) => (fail = rej)));
  w.registry.add(box);
  const p = w.registry.check();
  w.registry.remove('h1');
  fail(new Error('late'));
  await p;
  const y = world(t, () => new Promise((_, rej) => (fail = rej)));
  y.registry.add(box);
  const q = y.registry.check();
  y.registry.dispose();
  fail(new Error('late'));
  await q;
  assert.equal(y.registry.list()[0].reason, 'Not reached yet.');
});

test('a registry with the default status asks nothing of the machine and never counts it online (B1)', async (t) => {
  const r = createRegistry({ file: dir(t) });
  r.add(box);
  await r.check();
  assert.equal(r.list()[0].status, 'offline');
  r.dispose();
});

test('a corrupt file is reported without a reporter too', (t) => {
  const file = dir(t);
  fs.writeFileSync(file, 'x');
  const r = createRegistry({ file });
  assert.equal(r.list().length, 0);
  r.dispose();
});

test('onChange tells a listener once per change and stops after it is removed', (t) => {
  const w = world(t);
  let n = 0;
  const off = w.registry.onChange(() => n++);
  w.registry.add(box);
  off();
  w.registry.remove('h1');
  assert.equal(n, 1);
});

test('a status call that never settles times out and the next beat asks again; a heartbeat from the future is stale (A6)', async (t) => {
  let calls = 0;
  const w = world(t, () => {
    calls++;
    return calls === 1 ? new Promise(() => {}) : Promise.resolve(ready);
  });
  w.registry.add(box);
  const first = w.registry.check();
  w.clock.advance(30_000);
  await first;
  assert.equal(w.registry.list()[0].reason, 'Unreachable: no answer');
  await w.registry.check();
  assert.equal(calls, 2);
  assert.equal(w.registry.list()[0].status, 'online');
  w.clock.advance(-200_000);
  assert.equal(w.registry.list()[0].status, 'offline');
});

test("a replaced record is asked afresh, not given the old record's call (A4)", async (t) => {
  const asked: string[] = [];
  const w = world(t, (r: any) => {
    asked.push(r.address);
    return new Promise(() => {});
  });
  w.registry.add(box);
  void w.registry.check();
  w.registry.add({ ...box, address: 'me@other' });
  void w.registry.check();
  assert.deepEqual(asked, ['me@build.example', 'me@other']);
});

test('a record keeps the socket its Host listens on, from the record only; a machine without one has none (B1)', (t) => {
  const w = world(t);
  w.registry.add({ ...box, socketPath: '/home/u/host.sock' });
  assert.equal(w.registry.socketPath('h1'), '/home/u/host.sock');
  w.registry.add({ id: 'h2', address: 'me@h2' });
  assert.equal(w.registry.socketPath('h2'), '');
  assert.throws(() => w.registry.socketPath('nope'), /not in the registry/);
  const again = w.make();
  t.after(() => again.dispose());
  assert.equal(again.socketPath('h1'), '/home/u/host.sock');
  assert.equal(again.socketPath('h2'), '');
});

test('stop ends the heartbeat and start begins it again (A5)', async (t) => {
  let calls = 0;
  const w = world(t, async () => (calls++, ready));
  w.registry.add(box);
  w.registry.start();
  await w.registry.check();
  const before = calls;
  w.registry.stop();
  w.clock.advance(120_000);
  assert.equal(calls, before, 'no beat while stopped');
  w.registry.stop();
  w.registry.start();
  w.clock.advance(30_000);
  assert.ok(calls > before, 'a beat after start again');
});

test('M6: a socket path or capability flag a Host reports is kept only when it is well formed (a path with a colon would turn ssh -L into a socket-to-TCP forward)', async (t) => {
  const w = world(t, async () => ({
    ...ready,
    capabilities: { iab: true, cu: 'yes', bu: 1, Shell: true, shell: false, toolong_name_for_a_flag: true, nested: { a: true } },
  }));
  for (const bad of [
    'x:10.0.0.5:6379',
    '/h/host.sock:10.0.0.5:6379',
    'relative/host.sock',
    '/h/[::1]/host.sock',
    '/h/ho\nst.sock',
    `/${'a'.repeat(250)}`,
    7,
    null,
  ]) {
    w.registry.add({ ...box, socketPath: bad as any });
    assert.equal(w.registry.socketPath('h1'), '', `refused: ${String(bad).slice(0, 20)}`);
  }
  // a macOS Host's path holds a space
  w.registry.add({
    ...box,
    socketPath: '/Users/u/Library/Application Support/mopilot-host/host.sock',
    capabilities: { iab: true, cu: 'yes', Bad: true } as any,
  });
  assert.equal(w.registry.socketPath('h1'), '/Users/u/Library/Application Support/mopilot-host/host.sock');
  assert.deepEqual(w.registry.list()[0].capabilities, { iab: true });
  await w.registry.check();
  assert.deepEqual(w.registry.list()[0].capabilities, { iab: true, shell: false }, 'the heartbeat keeps booleans under plain names only');
  // read back from the file: the same checks apply to what is on disk
  fs.writeFileSync(
    w.file,
    JSON.stringify({
      version: 1,
      hosts: [{ ...box, socketPath: 'a:b', capabilities: [true], harnesses: [], lastHeartbeat: null, setup: '' }],
    }),
  );
  const again = w.make();
  t.after(() => again.dispose());
  assert.equal(again.socketPath('h1'), '');
  assert.deepEqual(again.list()[0].capabilities, {});
  fs.writeFileSync(
    w.file,
    JSON.stringify({
      version: 1,
      hosts: [{ ...box, socketPath: '/h/host.sock', capabilities: null, harnesses: [], lastHeartbeat: null, setup: '' }],
    }),
  );
  const third = w.make();
  t.after(() => third.dispose());
  assert.deepEqual(third.list()[0].capabilities, {});
});

test('L: a machine keeps the name its Host gave at pairing, once; a name that is not one is not kept; it is read back from the file', async (t) => {
  const w = world(t);
  w.registry.add(box);
  assert.equal(w.registry.hostKey('h1'), '');
  const name = 'ab'.repeat(16);
  w.registry.pin('h1', name);
  assert.equal(w.registry.hostKey('h1'), name);
  for (const bad of ['', 'short', 'AB'.repeat(16), 7 as any, null as any]) {
    w.registry.pin('h1', bad);
    assert.equal(w.registry.hostKey('h1'), name, String(bad));
  }
  // the same name again writes nothing; a new pairing may give another
  const written = fs.statSync(w.file).mtimeMs;
  w.registry.pin('h1', name);
  assert.equal(fs.statSync(w.file).mtimeMs, written);
  w.registry.pin('h1', 'cd'.repeat(16));
  assert.equal(w.registry.hostKey('h1'), 'cd'.repeat(16));
  assert.equal(w.make().hostKey('h1'), 'cd'.repeat(16), 'read back');
  // a heartbeat keeps it, and a record added with a bad one has none
  await w.registry.check();
  assert.equal(w.registry.hostKey('h1'), 'cd'.repeat(16));
  w.registry.add({ ...box, hostKey: 'nope' } as any);
  assert.equal(w.registry.hostKey('h1'), '');
  w.registry.add({ ...box, hostKey: name } as any);
  assert.equal(w.registry.hostKey('h1'), name, 'a well formed one is kept');
  assert.throws(() => w.registry.pin('nope', name), /not in the registry/);
});

test('the build a Host says is kept across a restart, and a reply without one leaves it empty', async (t) => {
  const w = world(t, async () => ({ ...ready, build: 'b1' }));
  w.registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  assert.equal(w.registry.list()[0].hostBuild, '');
  await w.registry.check();
  assert.equal(w.registry.list()[0].hostBuild, 'b1');
  const again = w.make(async () => ready);
  t.after(() => again.dispose());
  assert.equal(again.list()[0].hostBuild, 'b1', 'it is on disk');
  await again.check();
  assert.equal(again.list()[0].hostBuild, '', 'an older Host that names no build is not the app’s');
});

test('#4923: the app version a Host reports is kept across a restart, and a Host that names none leaves it empty', async (t) => {
  const w = world(t, async () => ({ ...ready, build: 'b1', appVersion: '0.4.27' }));
  w.registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  assert.equal(w.registry.list()[0].hostAppVersion, '');
  await w.registry.check();
  assert.equal(w.registry.list()[0].hostAppVersion, '0.4.27');
  const again = w.make(async () => ({ ...ready, build: 'b1', appVersion: 7 }));
  t.after(() => again.dispose());
  assert.equal(again.list()[0].hostAppVersion, '0.4.27', 'it is on disk');
  await again.check();
  assert.equal(again.list()[0].hostAppVersion, '', 'a version that is not text is none');
});

test('W2: the machine row keeps the managed policy its Host reports, and drops it when the Host stops saying it', async (t) => {
  let policy: unknown = { generation: 'g1', managed: true, organization: 'Acme', locked: ['permissionMax', 7, ''], problem: 'bad file' };
  const w = world(t, async () => ({ ...ready, policy }));
  w.registry.add(box);
  assert.equal(w.registry.list()[0].policy, null);
  await w.registry.check();
  assert.deepEqual(w.registry.list()[0].policy, {
    managed: true,
    generation: 'g1',
    organization: 'Acme',
    locked: ['permissionMax'],
    problem: 'bad file',
  });
  assert.deepEqual(w.make().list()[0].policy, w.registry.list()[0].policy, 'kept in the record');
  policy = { generation: 'g2', managed: true };
  await w.registry.check();
  assert.deepEqual(w.registry.list()[0].policy, { managed: true, generation: 'g2', organization: '', locked: [], problem: '' });
  for (const none of [undefined, null, 'x', { generation: 'g', managed: false }, { managed: true }]) {
    policy = none;
    await w.registry.check();
    assert.equal(w.registry.list()[0].policy, null);
  }
});
