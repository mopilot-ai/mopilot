// Two machine states the row names (#2709 follow-ups): a Host that macOS keeps off the local network (host/src/localNetwork.mjs, its
// report kept by electron/host/registry.cjs), and a machine that stopped answering because nobody is signed in on it after a restart
// (electron/host/signinWait.cjs, the registry's `explain`). Covers the knock's outcomes, the kept answer, a probe that answers late
// (removed, replaced or answered meanwhile), a relay-only machine and a failed or foreign probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { useFakeProc as installFakeProc } from './support/ports/proc.ts';
// @ts-ignore: plain ESM without declarations
import { createLocalNetworkCheck, knock } from '../host/src/localNetwork.mjs';
// @ts-ignore: plain ESM without declarations
import { hostStatus } from '../host/src/status.mjs';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');
const { createSigninWait, readWait, COMMAND } = require('../electron/host/signinWait.cjs');

const tick = () => new Promise((r) => setImmediate(r));

/** A datagram socket whose send ends the way `outcome` says, as dgram.createSocket would hand it. */
function fakeDgram(outcome: (s: EventEmitter, cb: (e: Error | null) => void) => void) {
  const sent: { size: number; port: number; host: string }[] = [];
  let closed = 0;
  const createSocket = (type: string) => {
    assert.equal(type, 'udp4');
    const s = Object.assign(new EventEmitter(), {
      send: (buf: Buffer, port: number, host: string, cb: (e: Error | null) => void) => {
        sent.push({ size: buf.length, port, host });
        setImmediate(() => outcome(s, cb));
      },
      close: () => {
        closed++;
      },
    });
    return s;
  };
  return { createSocket: createSocket as any, sent, closed: () => closed };
}
const errno = (code: string) => Object.assign(new Error(code), { code });

test('the knock: one empty datagram to the all-hosts group; sent is allowed, "no route" the denial, anything else says nothing', async () => {
  const cases: [(s: EventEmitter, cb: (e: Error | null) => void) => void, string][] = [
    [(_s, cb) => cb(null), 'sent'],
    [(_s, cb) => cb(errno('EHOSTUNREACH')), 'no-route'],
    [(_s, cb) => cb(errno('ENETUNREACH')), ''],
    [(_s, cb) => cb(errno('EADDRNOTAVAIL')), ''],
    [(s) => s.emit('error', errno('EACCES')), ''],
    // the error and the callback both come: the first says it, and the socket is closed once
    [(s, cb) => (s.emit('error', errno('EIO')), cb(null)), ''],
  ];
  for (const [outcome, want] of cases) {
    const f = fakeDgram(outcome);
    assert.equal(await knock({ createSocket: f.createSocket }), want);
    assert.deepEqual(f.sent, [{ size: 0, port: 9, host: '224.0.0.1' }], 'one empty datagram, discard port, a multicast group');
    assert.equal(f.closed(), 1);
  }
});

test('the check: only macOS guards the network; a Host not run as a service says nothing; the answer is kept a minute and shared', async () => {
  assert.equal(await createLocalNetworkCheck({ platform: 'linux', knock: async () => assert.fail('not asked') })(), 'allowed');
  assert.equal(
    await createLocalNetworkCheck({ platform: 'darwin', supervised: false, knock: async () => assert.fail('not asked') })(),
    'unknown',
    'a Host started from a terminal has the terminal’s grant',
  );
  let time = 0;
  let knocks = 0;
  let answer: 'sent' | 'no-route' | '' = 'no-route';
  const check = createLocalNetworkCheck({
    platform: 'darwin',
    knock: async () => {
      knocks++;
      return answer;
    },
    now: () => time,
  });
  const [a, b] = await Promise.all([check(), check()]);
  assert.deepEqual([a, b, knocks], ['denied', 'denied', 1]);
  // allowed meanwhile: seen once the kept answer is a minute old
  answer = 'sent';
  time = 59_999;
  assert.equal(await check(), 'denied');
  time = 60_000;
  assert.equal(await check(), 'allowed');
  answer = '';
  time = 120_000;
  assert.equal(await check(), 'unknown');
  assert.equal(knocks, 3);
});

test("the Host's status says what it knows of the local network, and 'unknown' by default", () => {
  assert.equal(hostStatus({ running: true }).localNetwork, 'unknown');
  assert.equal(hostStatus({ running: true, localNetwork: 'denied' }).localNetwork, 'denied');
});

const ready = (localNetwork?: unknown) => ({
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  capabilities: { iab: false, cu: false, bu: false, shell: true },
  ...(localNetwork === undefined ? {} : { localNetwork }),
});
function world(t: any, o: { status: (r: any) => Promise<unknown>; explain?: (r: any) => Promise<unknown> }) {
  const clock = installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const file = path.join(d, 'hosts.json');
  const reports: Error[] = [];
  const make = () => createRegistry({ file, report: (e: Error) => reports.push(e), ...o });
  const registry = make();
  t.after(() => registry.dispose());
  let changes = 0;
  registry.onChange(() => changes++);
  return { clock, file, registry, make, reports, changes: () => changes };
}
const box = { id: 'h1', name: 'Build box', address: 'me@build.example' };
/** One beat, then the probe it asked on the side. */
const settle = async (w: { registry: any }) => {
  await w.registry.check();
  await tick();
};

test("the registry keeps what the Host said of the local network, across a restart; an older Host's or a bad value is 'unknown'", async (t) => {
  let says: unknown = 'denied';
  const w = world(t, { status: async () => ready(says) });
  w.registry.add(box);
  assert.equal(w.registry.list()[0].localNetwork, 'unknown', 'not asked yet');
  await w.registry.check();
  assert.equal(w.registry.list()[0].localNetwork, 'denied');
  const again = w.make();
  t.after(() => again.dispose());
  assert.equal(again.list()[0].localNetwork, 'denied', 'read back from the file');
  for (const [given, kept] of [
    [undefined, 'unknown'],
    ['maybe', 'unknown'],
    ['allowed', 'allowed'],
  ]) {
    says = given;
    await w.registry.check();
    assert.equal(w.registry.list()[0].localNetwork, kept, String(given));
  }
  const raw = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  raw.hosts[0].localNetwork = 42;
  fs.writeFileSync(w.file, JSON.stringify(raw));
  w.registry.reload();
  assert.equal(w.registry.list()[0].localNetwork, 'unknown');
});

test('a machine that does not answer because nobody is signed in says so, keeps saying so while asked again, and an answer ends it', async (t) => {
  let up = false;
  let wait: string | null = 'restarted';
  const asked: any[] = [];
  const w = world(t, {
    status: async () => {
      if (!up) throw new Error('tunnel down');
      return ready('allowed');
    },
    explain: async (r: any) => {
      asked.push(r);
      return wait;
    },
  });
  w.registry.add(box);
  await settle(w);
  let [row] = w.registry.list();
  assert.equal(row.status, 'offline');
  assert.equal(row.waitingForLogin, 'restarted');
  assert.equal(row.reason, 'The machine restarted and is waiting for someone to sign in.');
  assert.equal(asked[0].id, 'h1');
  // asked again: the row keeps its reason throughout (no flicker back to "unreachable"), and nothing changes when nothing did
  const before = w.changes();
  const beat = w.registry.check();
  assert.equal(w.registry.list()[0].reason, 'The machine restarted and is waiting for someone to sign in.');
  await beat;
  await tick();
  assert.equal(w.changes() - before, 1, 'only the beat itself');
  wait = 'signed-out';
  await settle(w);
  [row] = w.registry.list();
  assert.deepEqual([row.waitingForLogin, row.reason], ['signed-out', 'The machine is waiting for someone to sign in.']);
  // signed in elsewhere but the Host is still down: back to the plain failure
  wait = null;
  await settle(w);
  [row] = w.registry.list();
  assert.deepEqual([row.waitingForLogin, row.reason], [null, 'Unreachable: tunnel down']);
  wait = 'restarted';
  await settle(w);
  up = true;
  await settle(w);
  [row] = w.registry.list();
  assert.deepEqual([row.status, row.waitingForLogin, row.reason], ['online', null, '']);
  // removed while it was offline and waiting: nothing of it is kept
  up = false;
  await settle(w);
  w.registry.remove('h1');
  w.registry.add(box);
  assert.equal(w.registry.list()[0].waitingForLogin, null);
});

test('a probe that fails reads as none; one that answers after the machine was removed, replaced or disposed is dropped', async (t) => {
  let release: (v: unknown) => void = () => undefined;
  let mode: 'reject' | 'hold' = 'reject';
  const w = world(t, {
    status: async () => {
      throw new Error('tunnel down');
    },
    explain: (): Promise<unknown> => (mode === 'reject' ? Promise.reject(new Error('ssh broke')) : new Promise((r) => (release = r))),
  });
  w.registry.add(box);
  await settle(w);
  assert.deepEqual([w.registry.list()[0].waitingForLogin, w.registry.list()[0].reason], [null, 'Unreachable: tunnel down']);
  assert.deepEqual(
    w.reports.map((e) => e.message),
    ['ssh broke'],
    'the broken probe is reported',
  );

  mode = 'hold';
  let beat = w.registry.check();
  await tick();
  w.registry.remove('h1');
  release('restarted');
  await beat;
  await tick();
  assert.deepEqual(w.registry.list(), [], 'removed: not revived');

  w.registry.add(box);
  beat = w.registry.check();
  await tick();
  w.registry.add({ ...box, name: 'Build box 2' });
  release('restarted');
  await beat;
  await tick();
  assert.deepEqual([w.registry.list()[0].name, w.registry.list()[0].waitingForLogin], ['Build box 2', null], 'replaced: not its answer');

  beat = w.registry.check();
  await tick();
  w.registry.dispose();
  release('restarted');
  await beat;
  await tick();
  assert.equal(w.registry.list()[0].waitingForLogin, null, 'disposed: nothing kept');
});

test('the probe reads who owns the console: another owner or the login window is a wait; a boot after the last answer is a restart', () => {
  const boot = (sec: number) => `{ sec = ${sec}, usec = 0 } Mon Nov  2 09:00:00 2026`;
  assert.equal(readWait(`root\nme\n${boot(2000)}\n`, 1_000_000), 'restarted');
  assert.equal(readWait(`root\nme\n${boot(500)}\n`, 1_000_000), 'signed-out');
  assert.equal(readWait(`other\nme\n${boot(500)}\n`, null), 'signed-out', 'never answered: nothing says it restarted');
  assert.equal(readWait(`me\nme\n${boot(2000)}\n`, 1_000_000), null, 'signed in: the Host is down for another reason');
  for (const foreign of ['', 'root\n', 'root\nme\n', 'root\nme\nsomething else\n']) assert.equal(readWait(foreign, null), null, foreign);
});

test('the probe runs one quiet command over SSH, kept two minutes per machine and answer; a relay-only machine or a failure says nothing', async (t) => {
  const clock = installFakeClock(t, 5_000_000);
  const runs: [any, string][] = [];
  let reply: { code: number; stdout: string } | Error = { code: 0, stdout: 'root\nme\n{ sec = 6000, usec = 0 }\n' };
  const wait = createSigninWait({
    run: async (record: any, command: string) => {
      runs.push([record, command]);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  const rec = { id: 'h1', address: 'me@build', identity: '', lastHeartbeat: 1_000_000 };
  assert.equal(await wait({ ...rec, id: 'r', address: 'relay:abc' }), null);
  assert.equal(runs.length, 0, 'no SSH for a relay-only machine');
  const [a, b] = await Promise.all([wait(rec), wait(rec)]);
  assert.deepEqual([a, b, runs.length], ['restarted', 'restarted', 1]);
  assert.equal(runs[0][1], COMMAND);
  reply = { code: 255, stdout: '' };
  clock.advance(119_999);
  assert.equal(await wait(rec), 'restarted', 'kept');
  clock.advance(1);
  assert.equal(await wait(rec), null, 'ssh failed');
  assert.equal(await wait(rec), null, 'and a failure is asked again, not kept');
  assert.equal(runs.length, 3);
  // a new answer from the machine is a new question; a run that throws reaches the caller, and is not kept either
  reply = new Error('spawn failed');
  await assert.rejects(wait({ ...rec, lastHeartbeat: 2_000_000 }), /spawn failed/);
  reply = { code: 0, stdout: 'root\nme\n{ sec = 6000, usec = 0 }\n' };
  assert.equal(await wait({ ...rec, lastHeartbeat: 2_000_000 }), 'restarted');
  assert.equal(runs.length, 5);
});

test('by default the probe goes through ssh, never prompting, with the key the machine signs in with', async (t) => {
  const spawned: { bin: string; args: string[] }[] = [];
  installFakeProc(t, {
    spawn: (bin: string, args: string[]) => {
      spawned.push({ bin, args });
      const child = Object.assign(new EventEmitter(), {
        pid: 1,
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('root\nme\n{ sec = 9000, usec = 0 }\n'));
        child.emit('close', 0);
      });
      return child;
    },
  });
  const wait = createSigninWait();
  assert.equal(await wait({ id: 'h1', address: 'me@build', identity: '/keys/id_build', lastHeartbeat: 1000 }), 'restarted');
  const { bin, args } = spawned[0];
  assert.equal(bin, 'ssh');
  assert.ok(args.includes('BatchMode=yes'), 'never prompts');
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/keys/id_build']);
  assert.deepEqual(args.slice(-3), ['--', 'me@build', COMMAND]);
});
