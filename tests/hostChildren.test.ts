// The Host's record of its children and of its running turns (host/src/children.mjs, runJournal.mjs, recovery.mjs): what a Host that was killed hard left behind is ended or interrupted by the next one, and nothing belonging to another process is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createChildren } from '../host/src/children.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { startServer } from '../host/src/server.mjs';
import { createRecovery } from '../host/src/recovery.mjs';
import { createRunJournal } from '../host/src/runJournal.mjs';

const { processStart } = createRequire(import.meta.url)('../electron/platform/processIdentity.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-children-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const dirOf = () => fs.mkdtempSync(path.join(base, 'd-'));
const read = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

/** A process table of stand-ins: pid -> when it started; a signal sent to one is logged, and SIGTERM ends it unless it `ignoresTerm`. */
function table(
  procs: Record<number, number>,
  { ignoresTerm = [] as number[], noGroup = [] as number[], unsignalable = [] as number[] } = {},
) {
  const sent: string[] = [];
  const live = new Set(Object.keys(procs).map(Number));
  return {
    sent,
    live,
    startOf: (pid: number) => (live.has(pid) ? procs[pid] : null),
    alive: (pid: number) => live.has(pid),
    signal(pid: number, sig: NodeJS.Signals | 0, group: boolean) {
      if (unsignalable.includes(pid) || (group && noGroup.includes(pid))) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      sent.push(`${group ? '-' : ''}${pid}:${sig}`);
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !ignoresTerm.includes(pid))) live.delete(pid);
    },
  };
}
const previousRun = (dir: string, children: object[]) =>
  fs.writeFileSync(path.join(dir, 'children.json'), JSON.stringify({ hostPid: 1, children }));

test('A: children are recorded as they start and forgotten as they exit, in a file only the owner reads', () => {
  const dir = dirOf();
  const c = createChildren({ dataDir: dir, now: () => 1000 });
  c.track(10, 'codex');
  // nothing is written before start(): this Host may not hold the lock yet
  assert.equal(fs.existsSync(path.join(dir, 'children.json')), false);
  return c.start().then(() => {
    c.track(11, 'node');
    // a child started before the file could be written is in it once it can be
    assert.deepEqual(
      read(dir, 'children.json')
        .children.map((x: any) => x.pid)
        .sort(),
      [10, 11],
    );
    assert.equal(fs.statSync(path.join(dir, 'children.json')).mode & 0o777, 0o600);
    assert.deepEqual(c.list(), [10, 11]);
    c.untrack(11);
    c.untrack(11);
    c.untrack(10);
    assert.deepEqual(read(dir, 'children.json').children, []);
  });
});

test('A: a spawn through the tracking proc is recorded until the child exits; a child with no pid is not', async () => {
  const dir = dirOf();
  const c = createChildren({ dataDir: dir });
  await c.start();
  const made: any[] = [];
  const real: any = {
    spawn: (command: string) => {
      const child: any = Object.assign(new EventEmitter(), { pid: command === 'broken' ? undefined : 4242 });
      made.push(child);
      return child;
    },
    execFile: () => 'passed through',
  };
  const tracked: any = c.tracking(real);
  assert.equal(tracked.execFile(), 'passed through');
  tracked.spawn('/usr/bin/codex', ['app-server']);
  tracked.spawn('broken');
  assert.deepEqual(
    read(dir, 'children.json').children.map((x: any) => [x.pid, x.label]),
    [[4242, 'codex']],
  );
  made[0].emit('exit');
  assert.deepEqual(c.list(), []);
});

test('W: the previous run’s children are ended by group, then the stubborn ones are killed; a pid that is another process now is left alone', async () => {
  const dir = dirOf();
  const t = table({ 20: 5000, 21: 5000, 22: 9_000_000 }, { ignoresTerm: [21] });
  previousRun(dir, [
    { pid: 20, label: 'codex', startedAt: 5100 },
    { pid: 21, label: 'node', startedAt: 4000 },
    { pid: 22, label: 'node', startedAt: 5000 },
    { pid: 23, label: 'gone', startedAt: 5000 },
  ]);
  const c = createChildren({ dataDir: dir, ...t, graceMs: 30, now: () => Date.now() });
  const ended = await c.start();
  assert.deepEqual(ended, [20, 21]);
  assert.deepEqual(t.sent, ['-20:SIGTERM', '-21:SIGTERM', '-21:SIGKILL']);
  // 22 started long after the record: it is another process that got the pid
  assert.ok(t.live.has(22));
  // the dead run's record is replaced by this run's
  assert.deepEqual(read(dir, 'children.json').children, []);
});

test('W: a child that is no group leader is signalled alone; one that cannot be signalled at all is ignored; nothing recorded, nothing ended', async () => {
  const dir = dirOf();
  const t = table({ 30: 100, 31: 100 }, { noGroup: [30], unsignalable: [31] });
  previousRun(dir, [
    { pid: 30, label: 'a', startedAt: 100 },
    { pid: 31, label: 'b', startedAt: 100 },
    { pid: process.pid, label: 'me', startedAt: 100 },
    { pid: 1, label: 'init', startedAt: 100 },
  ]);
  const c = createChildren({ dataDir: dir, ...t, startOf: (pid) => (pid === process.pid ? 100 : t.startOf(pid)), graceMs: 20 });
  assert.deepEqual(await c.start(), [30, 31]);
  assert.deepEqual(t.sent, ['30:SIGTERM']);
  // no file, a damaged one, or one of the wrong shape: nothing to end
  for (const body of [null, '{bad', '{"children":3}']) {
    const d = dirOf();
    if (body) fs.writeFileSync(path.join(d, 'children.json'), body);
    assert.deepEqual(await createChildren({ dataDir: d, ...t }).start(), []);
  }
});

test('B: the real core and kill tell a live process from a dead one, and a failing write is reported, not thrown', async () => {
  const dir = dirOf();
  const reports: string[] = [];
  // a data dir that is a file: the record cannot be written
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'x');
  const c = createChildren({ dataDir: path.join(blocked, 'inner'), report: (m) => reports.push(m) });
  await c.start();
  c.track(5, 'x');
  assert.match(reports[0], /children\.json/);
  // a record naming this very process with its real start time is never ended, and a pid with no process is skipped
  const real = createChildren({ dataDir: dir });
  previousRun(dir, [
    { pid: process.pid, label: 'me', startedAt: Date.now() - 5000 },
    { pid: 2 ** 22 + 12345, label: 'nobody', startedAt: Date.now() },
  ]);
  assert.deepEqual(await real.start(), []);
});

test('A: the journal retains previous turns until each commits; it writes nothing before start', () => {
  const dir = dirOf();
  const reports: string[] = [];
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ t1: 'chat-a', t2: 7 }));
  const j = createRunJournal({ dataDir: dir, report: (m) => reports.push(m) });
  j.begin('early', 'chat-z');
  assert.deepEqual(read(dir, 'running.json'), { t1: 'chat-a', t2: 7 });
  assert.deepEqual(j.start(), [['t1', 'chat-a']]);
  assert.deepEqual(read(dir, 'running.json'), { early: 'chat-z', t1: 'chat-a' });
  j.begin('t3', 'chat-b');
  j.end('early');
  j.end('early');
  assert.deepEqual(read(dir, 'running.json'), { t1: 'chat-a', t3: 'chat-b' });
  j.end('t1');
  assert.deepEqual(read(dir, 'running.json'), { t3: 'chat-b' });
  for (const body of ['{bad', undefined]) {
    const d = dirOf();
    if (body) fs.writeFileSync(path.join(d, 'running.json'), body);
    assert.deepEqual(createRunJournal({ dataDir: d }).start(), []);
  }
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'x');
  const bad = createRunJournal({ dataDir: path.join(blocked, 'inner'), report: (m) => reports.push(m) });
  assert.doesNotThrow(() => bad.start());
  assert.match(reports[0], /running\.json/);
});

test('I: recovery ends the children, interrupts the turns on the protocol, and says so once; a clean start says nothing', async () => {
  const dir = dirOf();
  const reports: string[] = [];
  previousRun(dir, []);
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ t9: 'chat-q' }));
  const recovery = createRecovery({ dataDir: dir, report: (m) => reports.push(m) });
  const told: any[] = [];
  const done = await recovery.run({
    interrupted: (left) => {
      told.push(left);
    },
  });
  assert.deepEqual(done, { ended: [], interrupted: 1 });
  assert.deepEqual(told, [[['t9', 'chat-q']]]);
  assert.match(reports[0], /interrupted 1 turn/);
  const quiet = createRecovery({ dataDir: dirOf(), report: (m) => reports.push(m) });
  assert.deepEqual(await quiet.run({ interrupted: () => assert.fail('nothing was running') }), { ended: [], interrupted: 0 });
  assert.equal(reports.length, 1);
  // the proc port is put back as it was
  const restore = quiet.install();
  restore();
});

test('B: the server runs the clean-up once it holds the lock and before it listens; a Host that does not get the lock cleans up nothing', async () => {
  const paths = createPaths({ dataDir: dirOf(), env: {} });
  const seen: string[] = [];
  const server = await startServer({
    paths,
    afterLock: async () => {
      seen.push(fs.existsSync(paths.lockPath) ? 'locked' : 'no lock', fs.existsSync(paths.socketPath) ? 'listening' : 'not listening');
    },
  });
  assert.deepEqual(seen, ['locked', 'not listening']);
  await assert.rejects(startServer({ paths, afterLock: async () => void seen.push('second') }), /already uses/);
  assert.deepEqual(seen, ['locked', 'not listening']);
  await server.close();
});

test('B: with the real core and signals a process an older Host recorded is ended; a core that cannot say ends nothing', async () => {
  // a process in a group of its own, as the harnesses' children are
  const left = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const exited = new Promise((r) => left.once('exit', r));
  try {
    const dir = dirOf();
    previousRun(dir, [{ pid: left.pid, label: 'sleep', startedAt: Date.now() }]);
    assert.deepEqual(await createChildren({ dataDir: dir }).start(), [left.pid]);
    await exited;
    assert.equal(await processStart(left.pid!), null);
  } finally {
    left.kill('SIGKILL');
  }
  // one that leads no group of its own is ended alone
  const lone = spawn('sleep', ['30'], { stdio: 'ignore' });
  const loneExited = new Promise((r) => lone.once('exit', r));
  try {
    const dir = dirOf();
    previousRun(dir, [{ pid: lone.pid, label: 'sleep', startedAt: Date.now() }]);
    assert.deepEqual(await createChildren({ dataDir: dir }).start(), [lone.pid]);
    await loneExited;
  } finally {
    lone.kill('SIGKILL');
  }
  // the record is the one older Hosts wrote, a pid and a start in milliseconds; not knowing leaves its process alone
  const unknown = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const dir = dirOf();
    previousRun(dir, [{ pid: unknown.pid, label: 'sleep', startedAt: Date.now() }]);
    assert.deepEqual(await createChildren({ dataDir: dir, startOf: async () => null }).start(), []);
    assert.equal(unknown.exitCode, null);
    assert.equal(unknown.signalCode, null);
  } finally {
    unknown.kill('SIGKILL');
  }
  // Child cleanup remains best effort; startup retains markers and reports a pending-turn journal write failure.
  const blocked = path.join(dirOf(), 'blocked');
  fs.writeFileSync(blocked, 'x');
  await createChildren({ dataDir: path.join(blocked, 'inner') }).start();
  assert.doesNotThrow(() => createRunJournal({ dataDir: path.join(blocked, 'inner') }).start());
});
