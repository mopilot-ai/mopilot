// Signing in to an agent on a machine (electron/host/machineSignin.cjs): createSignin over each machine's remote Host, with a fresh status read to confirm, a refresh of the registry, and retire/forget/dispose as a machine leaves, is replaced or Host access ends (A: one attempt per agent, one connection per machine; W: a machine that does not answer; B: machines and agents the list does not hold; I: what the Host says).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createMachineSignin } = require('../electron/host/machineSignin.cjs');
const { LOCAL_ID } = require('../electron/host/localHost.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

type Rec = { id: string; address: string; socketPath: string; harnesses: { id: string; detected: boolean; signedIn: boolean }[] };
const rec = (o: Partial<Rec> = {}): Rec => ({
  id: 'ssh:box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  harnesses: [{ id: 'gemini', detected: true, signedIn: false }],
  ...o,
});

/** A machine's remote Host that answers the way a script says. */
function fakeRemote(o: { status?: any; login?: any; loginStatus?: any[] | ((p: any) => any); connect?: () => Promise<void> } = {}) {
  const calls: { method: string; params?: any }[] = [];
  let at = 0;
  const host: any = {
    calls,
    disposed: false,
    connect: o.connect ?? (async () => undefined),
    login: async (p: any) => (calls.push({ method: 'login', params: p }), o.login ?? { state: 'waiting' }),
    loginStatus: async (p: any) => {
      calls.push({ method: 'loginStatus', params: p });
      if (typeof o.loginStatus === 'function') return o.loginStatus(p);
      const script = o.loginStatus ?? [{ state: 'waiting', links: [], codes: [] }];
      return script[Math.min(at++, script.length - 1)];
    },
    loginCancel: async (p: any) => (calls.push({ method: 'loginCancel', params: p }), true),
    loginInput: async (p: any) => (calls.push({ method: 'loginInput', params: p }), { accepted: true }),
    status: async () => (
      calls.push({ method: 'status' }), 'status' in o ? o.status : { harnesses: [{ id: 'gemini', detected: true, signedIn: true }] }
    ),
    dispose: () => (host.disposed = true),
  };
  return host;
}

function world(t: any, records: Rec[] = [rec()], remoteOpts: Parameters<typeof fakeRemote>[0] = {}) {
  const clock = installFakeClock(t);
  const list = { records, script: [] as Rec[][] };
  const checks: string[] = [];
  const made: any[] = [];
  const opened: string[] = [];
  const views: any[] = [];
  const reported: string[] = [];
  const registry = { list: () => list.script.shift() ?? list.records, check: async () => void checks.push('check') };
  // machines.cjs keeps one remote Host per machine; so does this
  const shared = { host: null as any, off: false };
  const s = createMachineSignin({
    registry,
    hostFor: (id: string) => {
      if (shared.off) return null;
      if (!shared.host) {
        shared.host = fakeRemote(remoteOpts);
        made.push(shared.host);
      }
      return shared.host;
    },
    openExternal: (u: string) => void opened.push(u),
    onChange: (v: any) => views.push(v),
    report: (e: any) => void reported.push(String(e?.message ?? e)),
  });
  t.after(() => s.dispose());
  return { s, clock, list, checks, made, opened, views, reported, shared };
}

test('A: a sign-in runs on the machine, opens its link here, is confirmed by a fresh status read, and refreshes the registry', async (t) => {
  const w = world(t, [rec()], {
    loginStatus: [{ state: 'done', links: ['https://login.test/x', 'http://insecure.test/'], codes: ['ABCD-1234'] }],
  });
  const view = w.s.start('ssh:box', 'gemini');
  assert.deepEqual([view.hostId, view.harness, view.state], ['ssh:box', 'gemini', 'starting']);
  await settle();
  assert.deepEqual(
    w.made[0].calls.map((c: any) => c.method),
    ['login', 'loginStatus', 'status'],
  );
  assert.deepEqual(w.made[0].calls[0].params, { harness: 'gemini', methodId: undefined });
  assert.deepEqual(w.opened, ['https://login.test/x'], 'only a plain https link is opened');
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'signed-in');
  assert.equal(w.views.at(-1).state, 'signed-in');
  assert.deepEqual(w.checks, ['check'], 'the registry reads the machine again');
  assert.equal(w.made.length, 1, 'one connection serves the whole sign-in');
});

test('GitHub recovery uses the remote login flow and verifies Git credentials, independently of the chat harness', async (t) => {
  const w = world(t, [rec()], {
    loginStatus: [{ state: 'done', links: ['https://github.com/login/device'], codes: ['ABCD-1234'] }],
    status: { gitSignIn: { 'github.com': 'yes' }, harnesses: [] },
  });
  w.s.start('ssh:box', 'git:github.com', 'operation-1');
  w.s.start('ssh:box', 'git:github.com', 'operation-2');
  w.s.start('ssh:box', 'git:github.com', 'operation-2');
  await settle();
  assert.equal(w.s.status('ssh:box', 'git:github.com').state, 'signed-in');
  assert.deepEqual(w.opened, ['https://github.com/login/device']);
  assert.deepEqual(w.made[0].calls[0].params, { harness: 'git:github.com', methodId: undefined });
  assert.deepEqual(w.s.status('ssh:box', 'git:github.com').recoveryKeys, ['operation-1', 'operation-2']);
  assert.equal(typeof w.s.status('ssh:box', 'git:github.com').attemptId, 'string');
});

test('GitHub recovery refuses this Mac and requires affirmative Git verification', async (t) => {
  const w = world(t, [rec(), rec({ id: LOCAL_ID, address: 'local:me' })], {
    loginStatus: [{ state: 'done' }],
    status: { gitSignIn: { 'github.com': 'unknown' } },
  });
  assert.throws(() => w.s.start(LOCAL_ID, 'git:github.com'), /remote machine/);
  assert.throws(() => w.s.start('ssh:box', 'git:github.com', ''), /interrupted operation/);
  assert.throws(() => w.s.start('ssh:box', 'git:github.com', 'x'.repeat(2049)), /interrupted operation/);
  w.s.start('ssh:box', 'git:github.com');
  await settle();
  assert.equal(w.s.status('ssh:box', 'git:github.com').state, 'failed');
  assert.equal(w.s.views().length, 1);
});

test('cancellation or replacement during connection cannot dispatch a retired sign-in', async (t) => {
  let connected!: () => void;
  const w = world(t, [rec()], {
    connect: () =>
      new Promise((r) => {
        connected = r;
      }),
  });
  w.s.start('ssh:box', 'git:github.com');
  w.s.dispose();
  connected();
  await settle();
  assert.equal(
    w.made[0].calls.some((c: any) => c.method === 'login'),
    false,
  );
  assert.equal(w.s.status('ssh:box', 'git:github.com').state, 'cancelled');
  w.s.start('ssh:box', 'git:github.com');
  w.list.records = [rec({ address: 'other@machine' })];
  connected();
  await settle();
  assert.equal(
    w.made[0].calls.some((c: any) => c.method === 'login'),
    false,
  );
  assert.equal(w.s.status('ssh:box', 'git:github.com').state, 'cancelled');
});

test('a stale connection cannot retire the already-started replacement machine sign-in', async (t) => {
  let oldReady!: () => void;
  let newReady!: () => void;
  let records = [rec({ address: 'old@machine' })];
  const oldConnection = new Promise<void>((r) => {
    oldReady = r;
  });
  const newConnection = new Promise<void>((r) => {
    newReady = r;
  });
  const old = fakeRemote({ connect: () => oldConnection });
  const newer = fakeRemote({ connect: () => newConnection });
  const s = createMachineSignin({
    registry: { list: () => records, check: async () => undefined },
    hostFor: () => (records[0].address === 'old@machine' ? old : newer),
    openExternal() {},
    onChange() {},
    report() {},
  });
  t.after(() => s.dispose());
  s.start('ssh:box', 'git:github.com', 'old-operation');
  records = [rec({ address: 'new@machine', socketPath: '/new.sock' })];
  s.start('ssh:box', 'git:github.com', 'new-operation');
  oldReady();
  await settle();
  assert.equal(s.status('ssh:box', 'git:github.com').state, 'starting');
  assert.deepEqual(s.status('ssh:box', 'git:github.com').recoveryKeys, ['new-operation']);
  assert.equal(old.calls.length, 0);
  newReady();
  await settle();
  assert.equal(s.status('ssh:box', 'git:github.com').state, 'waiting');
  assert.equal(newer.calls[0].method, 'login');
});

test('A: a second start joins the sign-in under way, and a second agent on the machine shares its connection', async (t) => {
  const w = world(t, [
    rec({
      harnesses: [
        { id: 'gemini', detected: true, signedIn: false },
        { id: 'qwen', detected: true, signedIn: false },
      ],
    }),
  ]);
  w.s.start('ssh:box', 'gemini');
  const again = w.s.start('ssh:box', 'gemini');
  w.s.start('ssh:box', 'qwen');
  await settle();
  assert.equal(again.state, 'starting');
  assert.equal(w.made.length, 1);
  const logins = w.made[0].calls.filter((c: any) => c.method === 'login').map((c: any) => c.params.harness);
  assert.deepEqual(logins, ['gemini', 'qwen']);
  assert.equal(w.s.cancel('ssh:box', 'gemini'), true);
  await settle();
  assert.ok(
    w.made[0].calls.some((c: any) => c.method === 'loginCancel' && c.params.harness === 'gemini'),
    'the machine is told to stop',
  );
  assert.equal(w.s.cancel('ssh:box', 'gemini'), false, 'nothing left to cancel');
});

test('B: a machine or an agent the list does not hold is refused before anything is asked of a machine', async (t) => {
  const w = world(t, [rec({ harnesses: [{ id: 'gemini', detected: false, signedIn: false }] })]);
  assert.throws(
    () => w.s.start('ssh:other', 'gemini'),
    (e: any) => e.code === 'unknown_machine',
  );
  assert.throws(
    () => w.s.start('ssh:box', 'gemini'),
    (e: any) => e.code === 'invalid',
    'an agent that is not installed',
  );
  assert.throws(
    () => w.s.start('ssh:box', 'codex'),
    (e: any) => e.code === 'invalid',
    'an agent the machine never listed',
  );
  await settle();
  assert.equal(w.made.length, 0);
  assert.deepEqual(w.views, []);
});

test('B: a machine with no socket on record, or one that left the list, ends the sign-in as unreachable', async (t) => {
  const w = world(t, [rec({ socketPath: '' })]);
  w.s.start('ssh:box', 'gemini');
  await settle();
  const v = w.s.status('ssh:box', 'gemini');
  assert.deepEqual([v.state, v.error], ['unreachable', 'This machine has no Host socket on record.']);
  // the list holds the machine when the sign-in is asked for, and not when its first request is made
  w.list.script = [[rec()], []];
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').error, 'That machine is not in the list.');
});

test('W: a machine that does not answer in time ends the sign-in without touching the shared connection, and the next try asks again', async (t) => {
  const w = world(t, [rec()], { connect: () => new Promise(() => undefined) });
  w.s.start('ssh:box', 'gemini');
  await settle();
  w.clock.advance(15_000);
  await settle();
  const v = w.s.status('ssh:box', 'gemini');
  assert.deepEqual([v.state, v.error], ['unreachable', 'Could not reach the machine over SSH.']);
  assert.equal(w.made[0].disposed, false, 'chat sends share this connection');
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(w.made.length, 1);
});

test('W: a connection that fails at once ends the sign-in with its reason', async (t) => {
  const w = world(t, [rec()], {
    connect: async () => {
      throw Object.assign(new Error('The host is unreachable: offline'), { code: 'host_unreachable' });
    },
  });
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.match(w.s.status('ssh:box', 'gemini').error, /offline/);
});

test('I: Host off for the account ends the sign-in as not available', async (t) => {
  const w = world(t);
  w.shared.off = true;
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').error, 'Host is not available for this account.');
});

test('A: a machine whose address changed ends the sign-in begun on the old machine; a moved socket does too', async (t) => {
  const w = world(t);
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'waiting');
  w.list.records = [rec({ address: 'me@moved' })];
  w.clock.advance(1000);
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'cancelled', 'another machine answers to this id now');
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'waiting');
  w.list.records = [rec({ address: 'me@moved', socketPath: '/other.sock' })];
  w.clock.advance(1000);
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'cancelled');
});

test('A: a sign-in started after the machine moved runs on the new machine; it is not retired by its own first call', async (t) => {
  const w = world(t, [rec()], { loginStatus: [{ state: 'failed', error: 'no' }] });
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'failed');
  w.list.records = [rec({ address: 'me@moved' })];
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.notEqual(w.s.status('ssh:box', 'gemini').state, 'cancelled');
  assert.equal(w.made[0].calls.filter((c: any) => c.method === 'login').length, 2);
});

test('A: one agent finishing does not end the sign-in of another agent on the same machine', async (t) => {
  const w = world(
    t,
    [
      rec({
        harnesses: [
          { id: 'gemini', detected: true, signedIn: false },
          { id: 'qwen', detected: true, signedIn: false },
        ],
      }),
    ],
    {
      loginStatus: (p: any) =>
        p.harness === 'gemini' ? { state: 'done', links: [], codes: [] } : { state: 'waiting', links: [], codes: ['QQQQ-1111'] },
    },
  );
  w.s.start('ssh:box', 'gemini');
  w.s.start('ssh:box', 'qwen');
  await settle();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'signed-in');
  assert.deepEqual([w.s.status('ssh:box', 'qwen').state, w.s.status('ssh:box', 'qwen').codes], ['waiting', ['QQQQ-1111']]);
});

test("I: the Host's word that it is signed in counts only when its own status says so", async (t) => {
  for (const status of [
    { harnesses: [{ id: 'other', signedIn: true }] },
    { harnesses: [{ id: 'gemini', signedIn: false }] },
    { harnesses: null },
    null,
  ]) {
    const w = world(t, [rec()], { loginStatus: [{ state: 'done', links: [], codes: [] }], status });
    w.s.start('ssh:box', 'gemini');
    await settle();
    const v = w.s.status('ssh:box', 'gemini');
    assert.deepEqual([v.state, v.error], ['failed', 'The machine says it is not signed in.']);
  }
});

test('I: a registry that fails to refresh is reported and changes nothing about how the sign-in ended', async (t) => {
  const w = world(t, [rec()], { loginStatus: [{ state: 'done', links: [], codes: [] }] });
  const failures: string[] = [];
  const failing = createMachineSignin({
    registry: { list: () => [rec()], check: async () => Promise.reject(new Error('disk full')) },
    hostFor: () => fakeRemote({ loginStatus: [{ state: 'done', links: [], codes: [] }] }),
    openExternal: () => undefined,
    onChange: () => undefined,
    report: (e: any) => void failures.push(String(e?.message ?? e)),
  });
  t.after(() => failing.dispose());
  failing.start('ssh:box', 'gemini');
  await settle();
  assert.equal(failing.status('ssh:box', 'gemini').state, 'signed-in');
  assert.deepEqual(failures, ['disk full'], "the failure goes to the caller's report");
  assert.equal(w.s.status('ssh:box', 'gemini'), null);
});

test('A: a machine that leaves the list has its sign-ins ended and its Host told to stop them; closing the app ends every one', async (t) => {
  const w = world(t);
  w.s.start('ssh:box', 'gemini');
  await settle();
  const told = w.s.forget('ssh:box');
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'cancelled');
  await told;
  assert.ok(w.made[0].calls.some((c: any) => c.method === 'loginCancel'));
  assert.equal(w.made[0].disposed, false, 'the connection belongs to machines.cjs');
  w.s.start('ssh:box', 'gemini');
  await settle();
  w.s.dispose();
  assert.equal(w.s.status('ssh:box', 'gemini').state, 'cancelled');
});

test('A: forgetting a machine with no sign-in does nothing', async (t) => {
  const w = world(t);
  assert.equal(w.s.forget('ssh:box'), null);
  assert.equal(w.made.length, 0);
});

test('A: a typed code goes to the machine that waits for it, once the sign-in is under way', async (t) => {
  const w = world(t);
  assert.equal(await w.s.input('ssh:box', 'gemini', 'abc'), false, 'nothing under way');
  w.s.start('ssh:box', 'gemini');
  await settle();
  assert.equal(await w.s.input('ssh:box', 'gemini', 'abc'), true);
  assert.deepEqual(w.made[0].calls.at(-1), { method: 'loginInput', params: { harness: 'gemini', text: 'abc' } });
});

test('a relay-only machine (paired by code: relay:<host id>, no socket of its own) is signed in through its Host like any other', async (t) => {
  const w = world(t, [rec({ id: 'relay:h_abcdefghijklmnop', address: 'relay:h_abcdefghijklmnop', socketPath: '' })]);
  w.s.start('relay:h_abcdefghijklmnop', 'gemini');
  await settle();
  assert.equal(w.made.length, 1, 'its Host was reached');
  assert.notEqual(w.s.status('relay:h_abcdefghijklmnop', 'gemini').error, 'This machine has no Host socket on record.');
});
