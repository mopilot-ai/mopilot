// What MoMo's home may do on another Host (host/src/homeGate.mjs, hostClients.mjs, server.mjs, protocol.mjs, approvals.mjs): the `home` kind, who may add and remove it, its allow-list, lease, modes, task registry, revocation and approval card line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHomeGate, ENDED_MS, HOME_METHODS, MAX_LEASE, MAX_LEASE_STEP, MAX_RUNNING, PENDING_MS } from '../host/src/homeGate.mjs';
import { createRequire } from 'node:module';
import { tmpDir } from './support/hostClientsWorld.ts';
const _require = createRequire(import.meta.url);

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const HOME = { fingerprint: 'f'.repeat(64), name: 'MoMo on Studio', kind: 'home' };
const stamp = (leaseEpoch: number, homeId = 'home-a') => ({ homeId, leaseEpoch });
const start = (over: Record<string, unknown> = {}) => ({
  chatId: 'claude:c1',
  epoch: 1,
  key: 'key-00000001',
  text: 'brief',
  harness: 'claude',
  permission: 'default',
  cwd: '/etc',
  home: stamp(1),
  ...over,
});

function gateIn(t: any, over: Record<string, unknown> = {}) {
  const dir = tmpDir(t);
  const stopped: string[] = [];
  const reports: string[] = [];
  const existing = new Set<string>();
  let known = true;
  const make = () =>
    createHomeGate({
      configDir: path.join(dir, 'config'),
      workDir: path.join(dir, 'work'),
      knows: () => known,
      known: (id: string) => existing.has(id),
      stop: async (id: string) => void stopped.push(id),
      report: (m: string) => void reports.push(m),
      now: () => 5,
      cap: 1000,
      enabled: () => true,
      active: () => false,
      modeOf: () => undefined,
      settleMs: 0,
      ...over,
    });
  return { dir, gate: make(), make, stopped, reports, existing, forget: () => (known = false) };
}

const refuses = (fn: () => unknown, code: string) =>
  assert.rejects(
    async () => fn(),
    (e: any) => e.code === code,
    `expected ${code}`,
  );

test('a request of any other kind passes the gate unchanged', async (t) => {
  const { gate } = gateIn(t);
  const raw = { chatId: 'claude:x', text: 'hi' };
  for (const kind of ['desktop', 'phone', 'cli']) assert.equal(await gate.admit({ ...HOME, kind }, 'chat.send', raw), raw);
  assert.equal(await gate.admit(null, 'chat.send', raw), raw);
  assert.equal(await gate.admit(undefined, 'chat.send', raw), raw);
});

test('every method outside the allow-list is refused for a home, one by one', async (t) => {
  const { gate } = gateIn(t);
  const forbidden = [
    'host.clients',
    'host.clientAdd',
    'host.clientRemove',
    'host.clientRename',
    'host.pending',
    'host.chats',
    'host.install',
    'host.installStatus',
    'host.installCancel',
    'host.login',
    'host.loginStatus',
    'host.loginInput',
    'host.logout',
    'host.modelKey',
    'host.orgLease',
    'host.policy',
    'host.toolsSync',
    'host.toolResult',
    'host.scheduleSync',
    'host.scheduleRuns',
    'host.momoGrant',
    'chat.answer',
    'chat.permit',
    'chat.remove',
    'chat.rename',
    'chat.goal',
    'chat.switch',
    'chat.login',
    'chat.attach',
    'chat.image',
    'chat.prepareContinue',
    'chat.commitContinue',
    'chat.release',
    'browser.open',
    'desktop.screenshot',
    'fs.list',
    'fs.read',
    'git.diff',
    'git.clone',
    'status',
    'send',
  ];
  for (const method of forbidden) {
    assert.ok(!HOME_METHODS.includes(method), method);
    await refuses(() => gate.admit(HOME, method, { chatId: 'claude:c1', home: stamp(1) }), 'home_not_allowed');
  }
});

test('the lease stamp: missing, malformed, stale, equal from another machine; the newest is kept across a restart', async (t) => {
  const { gate, make } = gateIn(t);
  await refuses(() => gate.admit(HOME, 'host.hello', {}), 'home_stamp_missing');
  await refuses(() => gate.admit(HOME, 'host.hello', { home: 'x' }), 'home_stamp_missing');
  await refuses(() => gate.admit(HOME, 'host.hello', { home: { homeId: 'a', leaseEpoch: 0 } }), 'home_stamp_missing');
  assert.deepEqual(await gate.admit(HOME, 'host.hello', { protocol: 1, home: stamp(4) }), { protocol: 1 });
  assert.deepEqual(gate.newest(), { ...stamp(4), by: HOME.fingerprint, was: null });
  // the old home, still holding the same key, is refused once the new one was seen
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(3, 'home-old') }), 'home_lease_stale');
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(4, 'home-b') }), 'home_lease_stale');
  assert.deepEqual(await gate.admit(HOME, 'host.status', { home: stamp(5, 'home-b') }), {});
  assert.deepEqual(await gate.admit(HOME, 'host.status', { home: stamp(5, 'home-b') }), {});
  // the other Host restarts: a new gate over the same folder still refuses the old lease
  const after = make();
  assert.deepEqual(after.newest(), { ...stamp(5, 'home-b'), by: HOME.fingerprint, was: null });
  await refuses(() => after.admit(HOME, 'host.status', { home: stamp(4) }), 'home_lease_stale');
  // a reclaim by the owner bumps the lease by two and is believed
  assert.deepEqual(await after.admit(HOME, 'host.status', { home: stamp(7, 'home-a') }), {});
});

test('a home that was removed is refused even before its connection is cut', async (t) => {
  const { gate, forget } = gateIn(t);
  forget();
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(1) }), 'home_not_allowed');
});

test("a start: only Ask for approval or read-only; the folder is the Host's own; nothing else rides along", async (t) => {
  const { gate, dir } = gateIn(t);
  const ok = await gate.admit(HOME, 'chat.start', start({ human: true }));
  assert.equal(ok.permission, 'default');
  assert.equal(ok.human, undefined);
  assert.equal(ok.home, undefined);
  assert.ok(ok.cwd.startsWith(path.join(dir, 'work')), 'the home cannot choose the folder');
  assert.ok(fs.statSync(ok.cwd).isDirectory());
  assert.equal((await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:c2', permission: 'read-only' }))).permission, 'read-only');
  // a replay of its own start (same chat id) is the same folder, never a second one
  assert.equal((await gate.admit(HOME, 'chat.start', start())).cwd, ok.cwd);
  for (const permission of ['full-access', 'auto-review', 'plan', undefined, 7])
    await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:c3', permission })), 'home_mode_refused');
  for (const field of ['sideChat', 'credential', 'planBase', 'goal', 'images', 'files'])
    await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:c4', [field]: true })), 'home_not_allowed');
  for (const chatId of [undefined, '', 'a b', 'x'.repeat(201), 7])
    await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId })), 'home_not_allowed');
});

test("a start cannot take over a chat that exists, a MoMo chat id, or another home's session", async (t) => {
  const { gate, existing } = gateIn(t);
  existing.add('claude:mine');
  await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:mine' })), 'home_not_allowed');
  await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:12345678-1234-8234-8234-c0de12345678' })), 'home_not_allowed');
  await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:t1' }));
  const other = { ...HOME, fingerprint: 'e'.repeat(64) };
  await refuses(() => gate.admit(other, 'chat.start', start({ chatId: 'claude:t1' })), 'home_not_allowed');
});

test('send, stop, subscribe and history reach only the sessions this home started', async (t) => {
  const { gate, existing } = gateIn(t);
  existing.add('claude:other');
  const own = await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:t1' }));
  for (const method of ['chat.send', 'chat.stop', 'chat.subscribe', 'chat.history']) {
    const params = { chatId: 'claude:t1', epoch: 1, home: stamp(1), cwd: '/', human: true };
    const out = await gate.admit(HOME, method, params);
    assert.equal(out.home, undefined);
    assert.equal(out.human, undefined);
    if (method === 'chat.send') assert.equal(out.cwd, own.cwd, "a follow-up keeps the task's own folder");
    await refuses(() => gate.admit(HOME, method, { chatId: 'claude:other', home: stamp(1) }), 'home_not_allowed');
    await refuses(() => gate.admit(HOME, method, { home: stamp(1) }), 'home_not_allowed');
  }
  const other = { ...HOME, fingerprint: 'e'.repeat(64) };
  await refuses(() => gate.admit(other, 'chat.send', { chatId: 'claude:t1', home: stamp(1) }), 'home_not_allowed');
});

test('a missing home stamp on a raw request does not throw on a null body, and an agent whose mode this Host does not hold is not started', async (t) => {
  const { gate } = gateIn(t);
  await refuses(() => gate.admit(HOME, 'host.status', null), 'home_stamp_missing');
  for (const harness of ['acp:gemini', 'acp:kimi', 7, undefined])
    await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'acp:gemini:c1', harness })), 'home_not_allowed');
  assert.ok(await gate.admit(HOME, 'chat.start', start({ chatId: 'codex-c1', harness: 'codex' })));
});

test("a hello from a home carries no list of moved chats, and a status no sign-in hosts: neither can reach the owner's chats or credentials", async (t) => {
  const { gate } = gateIn(t);
  const moved = [{ chatId: 'claude:owner', epoch: 99, rev: 1, targetHostId: 'x' }];
  assert.deepEqual(
    await gate.admit(HOME, 'host.hello', {
      protocol: { major: 1 },
      features: ['epoch'],
      moved,
      capabilities: { cu: true },
      home: stamp(1),
    }),
    {
      protocol: { major: 1 },
      features: ['epoch'],
    },
  );
  assert.deepEqual(await gate.admit(HOME, 'host.hello', { home: stamp(1) }), {});
  assert.deepEqual(await gate.admit(HOME, 'host.status', { signIn: ['github.com\nusername=x'], home: stamp(1) }), {});
});

test('the lease cannot be ratcheted far ahead: a first stamp past the ceiling or a jump past the step is refused, and removing the home leaves its lease as a floor', async (t) => {
  const { gate } = gateIn(t);
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(2 ** 53 - 1) }), 'home_lease_jump');
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(MAX_LEASE + 1) }), 'home_lease_jump');
  assert.equal(gate.newest(), null, 'nothing was kept for a refused stamp');
  await gate.admit(HOME, 'host.status', { home: stamp(5) });
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(5 + MAX_LEASE_STEP + 1) }), 'home_lease_jump');
  assert.deepEqual(gate.newest(), { ...stamp(5), by: HOME.fingerprint, was: null });
  await gate.admit(HOME, 'host.status', { home: stamp(5 + MAX_LEASE_STEP) });
  // the owner removes the key: the epoch stays as a floor nobody holds, so nothing older is believed again
  await gate.revoke(HOME.fingerprint);
  assert.deepEqual(gate.newest(), { ...stamp(5 + MAX_LEASE_STEP), by: null, was: HOME.fingerprint });
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(1) }), 'home_lease_stale');
});

test('start records are bounded: a start that never became a session is forgotten after a while, a session in use is never evicted, and a full table refuses', async (t) => {
  const clock = { at: 5 };
  const { gate, existing } = gateIn(t, { now: () => clock.at, cap: 3 });
  // cheap starts that never run: they cannot push out a session in use
  await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:live' }));
  existing.add('claude:live');
  for (let i = 0; i < 2; i++) await gate.admit(HOME, 'chat.start', start({ chatId: `claude:${i}` }));
  assert.ok(await gate.admit(HOME, 'chat.send', { chatId: 'claude:live', home: stamp(1) }), "the running session is still the home's");
  assert.deepEqual(gate.startedBy('claude:live'), { kind: 'momo', home: 'MoMo on Studio' });
  // the table is full: another start is refused, not made room for
  await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:more' })), 'home_not_allowed');
  assert.ok(await gate.admit(HOME, 'chat.send', { chatId: 'claude:live', home: stamp(1) }));
  // later, the ones that never ran are forgotten and room is back; the live one stays
  clock.at += PENDING_MS + 1;
  assert.ok(await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:fresh' })));
  await refuses(() => gate.admit(HOME, 'chat.send', { chatId: 'claude:0', home: stamp(1) }), 'home_not_allowed');
  assert.ok(await gate.admit(HOME, 'chat.send', { chatId: 'claude:live', home: stamp(1) }));
});

test('a session that ended a day ago is forgotten, so a long-lived Host never fills up; one still running is not', async (t) => {
  const clock = { at: 5 };
  const running = new Set<string>();
  const { gate, existing } = gateIn(t, { now: () => clock.at, cap: 3, active: (id: string) => running.has(id) });
  for (const id of ['claude:a', 'claude:b', 'claude:c']) {
    await gate.admit(HOME, 'chat.start', start({ chatId: id }));
    existing.add(id);
  }
  running.add('claude:a');
  await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:d' })), 'home_not_allowed');
  clock.at += ENDED_MS + 1;
  assert.ok(await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:d' })));
  assert.equal(gate.startedBy('claude:b'), null, 'an ended session is no longer recorded');
  assert.ok(gate.startedBy('claude:a'), 'a running one stays');
});

test('a home may run only so many tasks at once on a machine, with its own refusal; another home is not held by it', async (t) => {
  const running = new Set<string>();
  const { gate, existing } = gateIn(t, { active: (id: string) => running.has(id) });
  for (let i = 0; i < MAX_RUNNING; i++) {
    await gate.admit(HOME, 'chat.start', start({ chatId: `claude:r${i}` }));
    existing.add(`claude:r${i}`);
    running.add(`claude:r${i}`);
  }
  await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:over' })), 'home_too_many');
  assert.ok(await gate.admit({ ...HOME, fingerprint: 'e'.repeat(64) }, 'chat.start', start({ chatId: 'claude:other-home' })));
  running.delete('claude:r0');
  assert.ok(await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:fits' })));
});

test('a follow-up is its text and nothing else, and goes only to a session still held to Ask for approval or read-only', async (t) => {
  const modes = new Map<string, string>();
  const { gate } = gateIn(t, { modeOf: (id: string) => modes.get(id) });
  await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:s1' }));
  const send = (extra: object = {}) =>
    gate.admit(HOME, 'chat.send', { chatId: 'claude:s1', epoch: 1, key: 'key-00000009', text: 'go', home: stamp(1), ...extra });
  assert.ok(await send());
  for (const field of ['goal', 'images', 'files', 'followUp', 'model', 'effort', 'attachments', 'skills', 'sideChat'])
    await refuses(() => send({ [field]: field === 'followUp' ? 'steer' : ['x'] }), 'home_not_allowed');
  modes.set('claude:s1', 'read-only');
  assert.ok(await send());
  modes.set('claude:s1', 'full-access');
  await refuses(() => send(), 'home_mode_changed');
  modes.set('claude:s1', 'auto-review');
  await refuses(() => send(), 'home_mode_changed');
});

test('while the host-link switch is off this machine serves a home nothing', async (t) => {
  let on = false;
  const { gate } = gateIn(t, { enabled: () => on });
  await refuses(() => gate.admit(HOME, 'host.status', { home: stamp(1) }), 'home_not_allowed');
  on = true;
  assert.deepEqual(await gate.admit(HOME, 'host.status', { home: stamp(1) }), {});
});

test('a removal that lands while a start is being recorded leaves no session behind: the start is refused and what it recorded is dropped, and the sessions are stopped again after they settle', async (t) => {
  let present = true;
  const stops: string[] = [];
  const { gate, existing } = gateIn(t, { knows: () => present, stop: async (id: string) => void stops.push(id), settleMs: 5 });
  const pending = gate.admit(HOME, 'chat.start', start({ chatId: 'claude:late' }));
  // the owner removes the key while the start is being kept
  present = false;
  const removal = gate.revoke(HOME.fingerprint);
  await refuses(() => pending, 'home_not_allowed');
  await removal;
  assert.equal(gate.startedBy('claude:late'), null, 'nothing of it is left on the table');
  // a start that got past the check before the removal is stopped once (the pass after it settles does not repeat it), and a request made during it is refused
  present = true;
  await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:landed' }));
  existing.add('claude:landed');
  const going = gate.revoke(HOME.fingerprint);
  await refuses(
    () => gate.admit(HOME, 'chat.send', { chatId: 'claude:landed', epoch: 1, key: 'key-00000008', text: 'x', home: stamp(1) }),
    'home_not_allowed',
  );
  await going;
  assert.deepEqual(
    stops.filter((id) => id === 'claude:landed'),
    ['claude:landed'],
  );
});

test("a chat that is on disk but not loaded (known to the Host's epoch table) cannot be claimed by its id", async (t) => {
  const onDisk = new Set(['claude:on-disk']);
  const { gate } = gateIn(t, { known: (id: string) => onDisk.has(id) });
  await refuses(() => gate.admit(HOME, 'chat.start', start({ chatId: 'claude:on-disk' })), 'home_not_allowed');
  assert.equal(gate.startedBy('claude:on-disk'), null);
  // and the Host's own check reads both the loaded sessions and the epoch table
  const { homeGateFor } = await import('../host/src/homeGate.mjs');
  const root = tmpDir(t);
  const dataDir = path.join(root, 'd');
  let mode: string | undefined;
  const loaded = new Set(['claude:loaded']);
  const made = homeGateFor({
    paths: { configDir: path.join(root, 'c'), dataDir },
    pairing: { stillKnows: () => true, onForgotten: () => undefined, onAdded: () => undefined },
    sessions: { state: { has: (id: string) => loaded.has(id), get: () => ({ turn: 'running' }) } },
    policy: { modeOf: () => mode },
    audit: { note: () => undefined },
    epochs: { current: (id: string) => (id === 'claude:epoched' ? 3 : 0) },
    report: () => undefined,
  });
  for (const chatId of ['claude:loaded', 'claude:epoched'])
    await refuses(() => made.admit(HOME, 'chat.start', start({ chatId })), 'home_not_allowed');
  const first = await made.admit(HOME, 'chat.start', start({ chatId: 'claude:new' }));
  loaded.add('claude:new');
  // the task's folder is outside the Host's data dir (journals, ledgers), so an agent beside its folder does not read them
  assert.ok(first.cwd.startsWith(`${dataDir}-momo-tasks`) && !first.cwd.startsWith(`${dataDir}${path.sep}`));
  // a session running now counts toward the limit: starting another reads whether the first has a turn (the Host's own state)
  assert.ok(await made.admit(HOME, 'chat.start', start({ chatId: 'claude:second' })));
  // a session running now counts toward the limit, and the Host's own record of the chat's mode is what a follow-up is checked against
  assert.ok(await made.admit(HOME, 'chat.send', { chatId: 'claude:new', epoch: 1, key: 'key-00000001', text: 'x', home: stamp(1) }));
  mode = 'full-access';
  await refuses(
    () => made.admit(HOME, 'chat.send', { chatId: 'claude:new', epoch: 1, key: 'key-00000002', text: 'x', home: stamp(1) }),
    'home_mode_changed',
  );
});

test('a sweep that fails with no message at all still does not stop the Host starting', async (t) => {
  const { gate, reports } = gateIn(t);
  await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:q1' }));
  assert.equal(
    await gate.sweep(() => {
      throw null;
    }),
    0,
  );
  assert.match(reports.at(-1) ?? '', /MoMo home sessions: null/);
});

test("the lease and the task registry are kept sealed in the Host's config folder, never in a home's MoMo folder", async (t) => {
  const { gate, dir, make } = gateIn(t);
  await gate.admit(HOME, 'host.status', { home: stamp(2) });
  const file = path.join(dir, 'config', 'home-link.json');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(path.join(dir, 'data', 'momo')), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('"leaseEpoch"'), false, 'sealed, not plain JSON');
  assert.deepEqual(make().newest(), { ...stamp(2), by: HOME.fingerprint, was: null }, 'kept across a restart');
});

test('an unreadable state allows nothing; a missing one is a Host that never had a home', async (t) => {
  const { gate, dir, make } = gateIn(t);
  assert.equal(gate.newest(), null);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'home-link.json'), '{not json');
  const broken = make();
  await refuses(() => broken.admit(HOME, 'host.status', { home: stamp(1) }), 'home_state_unreadable');
  assert.equal(broken.startedBy('claude:t1'), null, 'a card is still shown without the line');
  await refuses(() => broken.revoke('a'.repeat(64)), 'home_state_unreadable');
});

test('startedBy names the home for a task session only', async (t) => {
  const { gate } = gateIn(t);
  await gate.admit(HOME, 'chat.start', start({ chatId: 'claude:t1' }));
  assert.deepEqual(gate.startedBy('claude:t1'), { kind: 'momo', home: 'MoMo on Studio' });
  assert.equal(gate.startedBy('claude:mine'), null);
  assert.equal(gate.startedBy('constructor'), null);
});

test('removal stops what that home started in full and then forgets it; a stop that fails keeps the record for a later sweep', async (t) => {
  const { gate, stopped, reports, dir, existing } = gateIn(t, {});
  const mine = { ...HOME, fingerprint: 'a'.repeat(64) };
  const theirs = { ...HOME, fingerprint: 'b'.repeat(64) };
  await gate.admit(mine, 'chat.start', start({ chatId: 'claude:m1' }));
  await gate.admit(mine, 'chat.start', start({ chatId: 'claude:m2' }));
  await gate.admit(theirs, 'chat.start', start({ chatId: 'claude:t1' }));
  for (const id of ['claude:m1', 'claude:m2', 'claude:t1']) existing.add(id);
  assert.equal(await gate.revoke('a'.repeat(64)), 2);
  assert.deepEqual([...new Set(stopped)].sort(), ['claude:m1', 'claude:m2']);
  await refuses(() => gate.admit(mine, 'chat.send', { chatId: 'claude:m1', home: stamp(1) }), 'home_not_allowed');
  assert.ok(await gate.admit(theirs, 'chat.send', { chatId: 'claude:t1', home: stamp(1) }));
  assert.equal(await gate.revoke('c'.repeat(64)), 0);
  // a stop that throws is reported, the record stays, and the sweep stops it once it can
  let failing = true;
  const sessionsOf = new Set<string>();
  const flaky = createHomeGate({
    now: () => 5,
    cap: 1000,
    enabled: () => true,
    active: () => false,
    modeOf: () => undefined,
    settleMs: 0,
    configDir: path.join(dir, 'x'),
    workDir: path.join(dir, 'w'),
    knows: () => true,
    known: (id: string) => sessionsOf.has(id),
    stop: async () => {
      if (failing) throw new Error('boom');
    },
    report: (m: string) => void reports.push(m),
  });
  await flaky.admit(mine, 'chat.start', start({ chatId: 'claude:f1' }));
  await flaky.admit(mine, 'chat.start', start({ chatId: 'claude:f2', key: 'key-00000002' }));
  sessionsOf.add('claude:f1');
  sessionsOf.add('claude:f2');
  assert.equal(await flaky.revoke('a'.repeat(64)), 0);
  assert.equal(reports.length, 4, 'each of the two sessions failed twice: now and after the settle');
  assert.match(reports[0], /could not be stopped.*boom/);
  assert.deepEqual(
    flaky.startedBy('claude:f1'),
    { kind: 'momo', home: 'MoMo on Studio' },
    'still recorded, so the card still says who started it',
  );
  failing = false;
  assert.equal(await flaky.sweep(() => false), 2);
  assert.equal(flaky.startedBy('claude:f1'), null);
});
