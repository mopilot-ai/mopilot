// Installing an agent on a machine from the app (electron/host/machineInstall.cjs): one install per machine and agent that two clicks or windows join, followed until the Host says how it ended, then the machine is read again so the row shows the agent as it is now (A: join, cancel, retire, dispose; W: offline, older Host, lost install, misses, deadline; B: what is refused before anything is sent; I: the Host's failure text, bounded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMachineInstall, EXPIRE_MS } = require('../electron/host/machineInstall.cjs');

const until = async (fn: () => any, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const CODEX = { id: 'codex', detected: false, signedIn: false, installable: true };

/** A machine whose Host answers `install` and then each `installStatus` from `answers` in turn (an Error is thrown); the last answer repeats. */
function world(
  o: {
    answers?: any[];
    first?: any;
    harnesses?: any[];
    status?: string;
    connect?: () => Promise<void>;
    hostless?: boolean;
    expireMs?: number;
  } = {},
) {
  const calls: { method: string; params: any }[] = [];
  const views: any[] = [];
  const reported: unknown[] = [];
  const record = {
    id: 'ssh:box',
    name: 'box',
    address: 'me@box',
    socketPath: '/h.sock',
    status: o.status ?? 'online',
    harnesses: o.harnesses ?? [CODEX],
  };
  const records = [record];
  let checks = 0;
  const answers = [...(o.answers ?? [{ state: 'done', version: 'codex-cli 1.0.0' }])];
  const next = () => {
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return a;
  };
  const host = {
    connect: o.connect ?? (async () => undefined),
    install: async (params: any) => {
      calls.push({ method: 'install', params });
      if (o.first instanceof Error) throw o.first;
      return o.first ?? { state: 'running', line: 'Installing Codex…' };
    },
    installStatus: async (params: any) => (calls.push({ method: 'installStatus', params }), next()),
    installCancel: async (params: any) => (calls.push({ method: 'installCancel', params }), true),
  };
  const installs = createMachineInstall({
    registry: { list: () => records, check: async () => void checks++ },
    hostFor: () => (o.hostless ? null : host),
    onChange: (v: any) => views.push(v),
    report: (e: unknown) => reported.push(e),
    pollMs: 1,
    expireMs: o.expireMs,
    connectMs: 50,
  });
  return { installs, calls, views, reported, record, records, checks: () => checks, host };
}

test('an install runs on the machine, is followed to its end, and the machine is read again before the window hears it ended', async () => {
  const w = world({
    answers: [
      { state: 'running', line: 'added 3 packages' },
      { state: 'done', version: 'codex-cli 1.0.0' },
    ],
  });
  const first = w.installs.start('ssh:box', 'codex');
  assert.deepEqual(first, { hostId: 'ssh:box', harness: 'codex', state: 'queued', line: '', error: null, version: null });
  await until(() => w.views.at(-1)?.state === 'installed');
  assert.equal(w.checks(), 1, 'the row is fresh when the window hears the install ended');
  assert.deepEqual(
    w.views.map((v) => [v.state, v.line]),
    [
      ['queued', ''],
      ['running', 'Installing Codex…'],
      ['running', 'added 3 packages'],
      ['installed', ''],
    ],
  );
  assert.equal(w.installs.status('ssh:box', 'codex').version, 'codex-cli 1.0.0');
  assert.deepEqual(w.calls[0], { method: 'install', params: { harness: 'codex' } });
  assert.equal(w.installs.status('ssh:box', 'gemini'), null);
});

test('A: a second start joins the install under way; one that ended starts again (Retry)', async () => {
  const w = world({
    answers: [
      { state: 'running', line: '' },
      { state: 'failed', error: 'npm could not find the package.' },
    ],
  });
  const a = w.installs.start('ssh:box', 'codex');
  const b = w.installs.start('ssh:box', 'codex');
  assert.deepEqual(a, b);
  await until(() => w.installs.status('ssh:box', 'codex').state === 'failed');
  assert.equal(w.calls.filter((c) => c.method === 'install').length, 1, 'two clicks are one install');
  assert.equal(w.installs.status('ssh:box', 'codex').error, 'npm could not find the package.');
  assert.equal(w.checks(), 0, 'a failed install changes nothing on the machine');
  w.installs.start('ssh:box', 'codex');
  await until(() => w.calls.filter((c) => c.method === 'install').length === 2);
});

test('B: a machine not listed, offline, or not offering that agent is refused before anything is sent', () => {
  const w = world({
    harnesses: [{ ...CODEX }, { id: 'claude', detected: true, signedIn: true }, { id: 'cursor', detected: false, signedIn: false }],
  });
  const refused = (id: string, harness: string, code: string) =>
    assert.throws(
      () => w.installs.start(id, harness),
      (e: any) => e.code === code,
    );
  refused('ssh:none', 'codex', 'unknown_machine');
  refused('ssh:box', 'claude', 'invalid');
  refused('ssh:box', 'cursor', 'invalid');
  refused('ssh:box', 'gemini', 'invalid');
  w.record.harnesses = 'nonsense' as any;
  refused('ssh:box', 'codex', 'invalid');
  w.record.status = 'offline';
  assert.throws(() => w.installs.start('ssh:box', 'codex'), /box is offline/);
  assert.deepEqual([w.calls, w.views], [[], []]);
});

test('W: an older Host says to update it; an unreachable machine or no Host access ends as unreachable', async () => {
  const old = world({ first: Object.assign(new Error('lacks install'), { code: 'feature_missing' }) });
  old.installs.start('ssh:box', 'codex');
  await until(() => old.installs.status('ssh:box', 'codex').state === 'failed');
  assert.equal(old.installs.status('ssh:box', 'codex').error, 'Update the Host on this machine to install agents from here.');
  const down = world({ first: new Error('host_unreachable') });
  down.installs.start('ssh:box', 'codex');
  await until(() => down.installs.status('ssh:box', 'codex').state === 'unreachable');
  assert.equal(down.installs.status('ssh:box', 'codex').error, 'host_unreachable');
  const slow = world({ connect: () => new Promise(() => undefined) });
  slow.installs.start('ssh:box', 'codex');
  await until(() => slow.installs.status('ssh:box', 'codex').state === 'unreachable');
  assert.equal(slow.installs.status('ssh:box', 'codex').error, 'Could not reach the machine over SSH.');
  const off = world({ hostless: true });
  off.installs.start('ssh:box', 'codex');
  await until(() => off.installs.status('ssh:box', 'codex').state === 'unreachable');
  assert.equal(off.installs.status('ssh:box', 'codex').error, 'Host is not available for this account.');
  const blank = world({ first: { toString: () => '' } as any });
  // an error with no message still says something
  blank.host.install = async () => {
    throw '';
  };
  blank.installs.start('ssh:box', 'codex');
  await until(() => blank.installs.status('ssh:box', 'codex').state === 'unreachable');
  assert.equal(blank.installs.status('ssh:box', 'codex').error, 'The machine did not answer.');
});

test('W: a Host that lost the install, misses in a row, and the deadline each end it; one miss is forgiven', async () => {
  const lost = world({ answers: [null] });
  lost.installs.start('ssh:box', 'codex');
  await until(() => lost.installs.status('ssh:box', 'codex').state === 'failed');
  assert.equal(lost.installs.status('ssh:box', 'codex').error, 'The machine lost the install. Try again.');
  const flaky = world({ answers: [new Error('blip'), { state: 'done', version: '' }] });
  flaky.installs.start('ssh:box', 'codex');
  await until(() => flaky.installs.status('ssh:box', 'codex').state === 'installed');
  assert.equal(flaky.installs.status('ssh:box', 'codex').version, null);
  const gone = world({ answers: [new Error('gone')] });
  gone.installs.start('ssh:box', 'codex');
  await until(() => gone.installs.status('ssh:box', 'codex').state === 'unreachable');
  assert.equal(gone.installs.status('ssh:box', 'codex').error, 'gone');
  const stuck = world({ answers: [{ state: 'running', line: 'Installing Codex…' }], expireMs: 30 });
  stuck.installs.start('ssh:box', 'codex');
  await until(() => stuck.installs.status('ssh:box', 'codex').state === 'failed');
  assert.equal(stuck.installs.status('ssh:box', 'codex').error, 'The install took too long and was stopped.');
  assert.ok(
    stuck.calls.some((c) => c.method === 'installCancel'),
    'the machine is told to stop it',
  );
  // waiting behind another install does not count against the deadline
  const behind = world({ answers: [...Array(60).fill({ state: 'queued', line: '' }), { state: 'done' }], expireMs: 30 });
  behind.installs.start('ssh:box', 'codex');
  // wait for the end, not for "no longer queued": the state is 'running' between the queue and the machine's 'done', and a slow runner can read it there
  await until(() => behind.installs.status('ssh:box', 'codex').state === 'installed');
  assert.ok(EXPIRE_MS > 20 * 60_000, 'the app waits for one install queued behind another');
});

test("I: the Host's failure and progress text is one bounded line; a failure with none says so; a cancel on the Host ends cancelled", async () => {
  const w = world({
    answers: [
      { state: 'running', line: `a\nb\u0007${'x'.repeat(900)}` },
      { state: 'failed', error: 7 },
    ],
  });
  w.installs.start('ssh:box', 'codex');
  await until(() => w.installs.status('ssh:box', 'codex').state === 'failed');
  const running = w.views.find((v) => v.line.startsWith('a b'));
  assert.equal(running.line.length, 500);
  assert.equal(w.installs.status('ssh:box', 'codex').error, 'The install failed.');
  const c = world({ first: { state: 'cancelled' } });
  c.installs.start('ssh:box', 'codex');
  await until(() => c.installs.status('ssh:box', 'codex').state === 'cancelled');
  const same = world({ answers: [{ state: 'running', line: 'Installing Codex…' }, { state: 'done' }] });
  same.installs.start('ssh:box', 'codex');
  await until(() => same.installs.status('ssh:box', 'codex').state === 'installed');
  assert.deepEqual(
    same.views.map((v) => v.state),
    ['queued', 'running', 'installed'],
    'an unchanged answer tells the window nothing new',
  );
});

test('A: cancel ends it here and on the machine; forget and dispose end every install; nothing to cancel says false', async () => {
  const w = world({ answers: [{ state: 'running', line: 'x' }] });
  assert.equal(w.installs.cancel('ssh:box', 'codex'), false);
  w.installs.start('ssh:box', 'codex');
  await until(() => w.installs.status('ssh:box', 'codex').state === 'running');
  assert.equal(w.installs.cancel('ssh:box', 'codex'), true);
  assert.equal(w.installs.status('ssh:box', 'codex').state, 'cancelled');
  assert.equal(w.installs.cancel('ssh:box', 'codex'), false);
  await until(() => w.calls.some((c) => c.method === 'installCancel'));
  // a cancel the machine cannot hear is reported, not thrown
  w.host.installCancel = async () => {
    throw new Error('offline');
  };
  w.installs.start('ssh:box', 'codex');
  const stopped = w.installs.forget('ssh:box');
  assert.ok(stopped);
  await stopped;
  assert.equal(w.installs.status('ssh:box', 'codex').state, 'cancelled');
  assert.equal((w.reported.at(-1) as Error).message, 'offline');
  assert.equal(w.installs.forget('ssh:box'), null, 'nothing under way');
  w.installs.start('ssh:box', 'codex');
  w.installs.dispose();
  assert.equal(w.installs.status('ssh:box', 'codex').state, 'cancelled');
  const calls = w.calls.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.calls.filter((c, i) => i >= calls && c.method === 'installStatus').length, 0, 'a retired install is not followed');
});

test('A: another machine answering to the id retires the installs begun on the old one; a cancel while connecting sends nothing', async () => {
  let release = () => undefined as void;
  const w = world({ connect: () => new Promise<void>((r) => (release = r)) });
  w.installs.start('ssh:box', 'codex');
  await until(() => w.views.length === 1);
  w.installs.cancel('ssh:box', 'codex');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.calls.filter((c) => c.method === 'install').length, 0);
  const moved = world({
    answers: [{ state: 'running', line: '' }],
    harnesses: [CODEX, { id: 'gemini', detected: false, signedIn: false, installable: true }],
  });
  moved.installs.start('ssh:box', 'codex');
  await until(() => moved.calls.some((c) => c.method === 'installStatus'));
  moved.records[0] = { ...moved.record, address: 'me@other' };
  // the next call to the machine notices the move: what began on the old one ends quietly
  moved.installs.start('ssh:box', 'gemini');
  await until(() => moved.installs.status('ssh:box', 'codex').state === 'cancelled');
  assert.equal(moved.installs.status('ssh:box', 'gemini').state !== 'cancelled', true);
  moved.installs.dispose();
});

test('W: a machine that left the list before its cancel reached it is reported; a cancel while the first request is in flight leaves the install ended', async () => {
  let fail = (_e: Error) => undefined as void;
  const w = world();
  w.host.install = (p: any) => (w.calls.push({ method: 'install', params: p }), new Promise((_r, reject) => (fail = reject)));
  w.installs.start('ssh:box', 'codex');
  await until(() => w.calls.length === 1);
  w.records.length = 0;
  assert.equal(w.installs.cancel('ssh:box', 'codex'), true);
  await until(() => w.reported.length === 1);
  assert.equal((w.reported[0] as any).code, 'unknown_machine');
  fail(new Error('connection closed'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.installs.status('ssh:box', 'codex').state, 'cancelled', 'the late failure changes nothing');
});

test('a service made without listeners still follows an install to its end; a poll waiting for its turn ends when the install does', async () => {
  const host = {
    connect: async () => undefined,
    install: async () => ({ state: 'running' }),
    installStatus: async () => ({ state: 'running' }),
    installCancel: async () => {
      throw new Error('gone');
    },
  };
  const records = [{ id: 'ssh:box', name: 'box', address: 'a', socketPath: '/s', status: 'online', harnesses: [CODEX] }];
  const installs = createMachineInstall({
    registry: { list: () => records, check: async () => undefined },
    hostFor: () => host,
    pollMs: 60_000,
  });
  installs.start('ssh:box', 'codex');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(installs.cancel('ssh:box', 'codex'), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(installs.status('ssh:box', 'codex').state, 'cancelled');
});

test('A: a status read that fails after the install was cancelled changes nothing', async () => {
  let fail = (_e: Error) => undefined as void;
  const w = world();
  w.host.installStatus = (p: any) => (w.calls.push({ method: 'installStatus', params: p }), new Promise((_r, reject) => (fail = reject)));
  w.installs.start('ssh:box', 'codex');
  await until(() => w.calls.some((c) => c.method === 'installStatus'));
  w.installs.cancel('ssh:box', 'codex');
  fail(new Error('connection closed'));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([w.installs.status('ssh:box', 'codex').state, w.installs.status('ssh:box', 'codex').error], ['cancelled', null]);
});
