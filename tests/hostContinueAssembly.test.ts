// Main's Switch host (electron/host/continueAssembly.cjs and its IPC wiring): a chat on this Mac moves to a machine through the dialog's request, and a machine that comes back is told what was continued without it (3.1, 3.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeHostProcess } from './support/hostProcessKit.ts';

const require = createRequire(import.meta.url);
const { createContinueAssembly, servesOf } = require('../electron/host/continueAssembly.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { createContinueInbox } = require('../electron/host/continueInbox.cjs');

const CHAT = 'claude:c1';
const tick = () => new Promise((r) => setImmediate(r));
const turns = [
  {
    id: 't1',
    status: 'completed',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'fix the login bug' }] },
      { type: 'agentMessage', text: 'Fixed it.' },
    ],
  },
];

function mac(o: { kind?: string; turn?: string; queue?: unknown[] | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-'));
  const hosts: Record<string, ReturnType<typeof makeHostProcess>> = { B: makeHostProcess('B'), C: makeHostProcess('C') };
  const statuses: Record<string, string> = { B: 'online', C: 'online' };
  const live: any = {
    sessions: {
      has: (id: string) => id === CHAT,
      snapshot: () => ({ turn: o.turn ?? 'idle', ...(o.queue === null ? {} : { queue: o.queue ?? [] }) }),
    },
    chats: { records: new Map([[CHAT, {}]]) },
    switchRunner: {
      ref: () => ({ kind: o.kind ?? 'acp:gemini' }),
      label: (k: string) => (k === 'acp:gemini' ? 'Gemini' : k),
      continues: createContinueInbox({ dir: path.join(dir, 'inbox') }),
      folderOf: async () => dir,
      chatTurns: async () => ({ turns, failed: [] }),
      chats: { record: () => ({ segments: [{ model: 'sonnet' }] }) },
    },
  };
  const sessions: string[] = [];
  const machines = {
    list: () => ({ machines: Object.entries(statuses).map(([id, status]) => ({ id, status })) }),
    session: async (id: string, onEvent?: (e: any) => void) => {
      sessions.push(id);
      const conn = hosts[id].protocol.connection((m: object) => onEvent?.(m));
      // the line protocol's git methods are the server's, not the versioned protocol's: a machine without a repository here
      return {
        call: (m: string, p: object) => (m.startsWith('git.') ? Promise.resolve({ isRepo: false }) : conn.call(m, p)),
        close: () => conn.close(),
      };
    },
  };
  const reports: string[] = [];
  return { dir, hosts, statuses, live, machines, sessions, reports };
}
const req = (over: object = {}) => ({ chatId: CHAT, targetHostId: 'B', cwd: '/work/b', lostHostConfirmed: false, ...over });
const code = (c: string) => (e: any) => e?.code === c;
const assemble = (m: ReturnType<typeof mac>) =>
  createContinueAssembly({ dir: m.dir, live: m.live, machines: () => m.machines, report: (p: string) => m.reports.push(p) });

test("the dialog's request moves a chat from this Mac to a machine: the machine's first reply carries the conversation, the side map and the Mac agree", async () => {
  const m = mac();
  const svc = assemble(m);
  new OwnershipStore(path.join(m.dir, 'host-ownership.json')).set(CHAT, {
    hostId: 'local',
    ownerHostId: 'local',
    epoch: 0,
    folder: '/mac',
  });
  assert.deepEqual(await svc.run(req()), { hostId: 'B', epoch: 1 });
  assert.deepEqual(new OwnershipStore(path.join(m.dir, 'host-ownership.json')).get(CHAT).ownerHostId, 'B');
  const conn = m.hosts.B.protocol.connection(() => undefined);
  await conn.call('host.hello', { protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
  await conn.call('chat.send', { chatId: CHAT, epoch: 1, key: 'assembly-key-0001', text: 'go on' });
  assert.match(m.hosts.B.sends[0].text, /from="Gemini"/);
  assert.match(m.hosts.B.sends[0].text, /fix the login bug/);
});

test('a running turn or a queued message keeps the chat on the Mac; a machine that is offline cannot take it', async () => {
  // a turn waiting for the user (an approval or a question) is a turn that is not over
  for (const o of [{ turn: 'running' }, { turn: 'awaitingUser' }, { queue: [{}] }]) {
    const m = mac(o);
    await assert.rejects(assemble(m).run(req()), code('turn_running'));
    assert.equal(new OwnershipStore(path.join(m.dir, 'host-ownership.json')).get(CHAT).ownerHostId, 'local');
  }
  const off = mac();
  off.statuses.B = 'offline';
  await assert.rejects(assemble(off).run(req()), code('target_offline'));
  await assert.rejects(assemble(off).run(req({ targetHostId: 'nobody' })), code('target_offline'));
  const attention = mac();
  attention.statuses.B = 'attention';
  assert.deepEqual(await assemble(attention).run(req()), { hostId: 'B', epoch: 1 });
});

test("a chat with no queue field is idle; it moves from a machine to another, from the source Host's stream, and it comes back to this Mac", async () => {
  const m = mac({ queue: null });
  const svc = assemble(m);
  await svc.run(req());
  const b = m.hosts.B.protocol.connection(() => undefined);
  await b.call('host.hello', { protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
  await b.call('chat.send', { chatId: CHAT, epoch: 1, key: 'assembly-key-0002', text: 'a question on B' });
  assert.deepEqual(await svc.run(req({ targetHostId: 'C', cwd: '/work/c' })), { hostId: 'C', epoch: 2 });
  const c = m.hosts.C.protocol.connection(() => undefined);
  await c.call('host.hello', { protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
  await c.call('chat.send', { chatId: CHAT, epoch: 2, key: 'assembly-key-0003', text: 'and on C' });
  assert.match(m.hosts.C.sends[0].text, /a question on B/);
  // the Mac knows the chat from its records alone when no session of it is open
  m.live.sessions.has = () => false;
  assert.deepEqual(await svc.run(req({ targetHostId: 'local', cwd: m.dir })), { hostId: 'local', epoch: 3 });
  assert.equal(m.live.switchRunner.continues.pending(CHAT).cwd, fs.realpathSync(m.dir));
  // and a chat the Mac still runs cannot be prepared here
  m.live.sessions.has = () => true;
  await assert.rejects(m.live.switchRunner.continues.target.check({ harness: 'nonsense', cwd: m.dir }), code('harness_not_configured'));
});

test("the source lost: the Mac continues without it from the user's yes", async () => {
  const m = mac();
  const svc = assemble(m);
  await svc.run(req());
  m.statuses.B = 'offline';
  await assert.rejects(svc.run(req({ targetHostId: 'C', cwd: '/work/c' })), code('lost_host_declined'));
  assert.deepEqual(await svc.run(req({ targetHostId: 'C', cwd: '/work/c', lostHostConfirmed: true })), { hostId: 'C', epoch: 2 });
});

test('a commit whose answers are lost is asked again after a pause', async () => {
  const m = mac();
  const real = m.machines.session;
  let lost = 2;
  m.machines.session = async (id: string, onEvent?: any) => {
    const s = await real(id, onEvent);
    return {
      ...s,
      call: async (method: string, params: object) => {
        const res = await s.call(method, params);
        if (id === 'C' && method === 'chat.commitContinue' && lost-- > 0) throw new Error('reply lost');
        return res;
      },
    };
  };
  const svc = assemble(m);
  await svc.run(req({ targetHostId: 'C', cwd: '/work/c' }));
  // the source of the next move is C: its commit loses two answers
  await assert.deepEqual(await svc.run(req({ targetHostId: 'B', cwd: '/work/b' })), { hostId: 'B', epoch: 2 });
});

test('the agent a chat runs on names the harness the target must have; one that cannot be continued is refused', async () => {
  const acp = mac({ kind: 'acp:gemini' });
  assert.deepEqual(await assemble(acp).run(req()), { hostId: 'B', epoch: 1 });
  const codex = mac({ kind: 'codex' });
  await assert.rejects(assemble(codex).run(req()), code('harness_not_configured'));
  const odd = mac({ kind: 'something-else' });
  await assert.rejects(assemble(odd).run(req()), code('unsupported'));
});

function ipc(m: ReturnType<typeof mac>, userData: string) {
  const handlers = new Map<string, any>();
  let onChange: (s: any) => void = () => undefined;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live: m.live, app: { getPath: () => userData }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: ((o: any) => ((onChange = o.onChange), m.machines)) as any,
      allowed: () => true,
    },
  );
  return { call: (c: string, ...a: any[]) => handlers.get(c)({}, ...a), change: (s: any) => onChange(s) };
}

test("IPC: host:continue runs through main's service once the chat sessions exist", async () => {
  const m = mac();
  const { call } = ipc(m, m.dir);
  new OwnershipStore(path.join(m.dir, 'host-ownership.json')).set(CHAT, {
    hostId: 'local',
    ownerHostId: 'local',
    epoch: 0,
    folder: '/mac',
  });
  assert.deepEqual(await call('host:continue', req()), { value: { hostId: 'B', epoch: 1 } });
});

test('IPC: a machine that turns online is told what was continued without it; one that stays as it was, or is offline, is not', async () => {
  const m = mac();
  const { call, change } = ipc(m, m.dir);
  await call('host:machines');
  const store = new OwnershipStore(path.join(m.dir, 'host-ownership.json'));
  store.set(CHAT, {
    hostId: 'C',
    ownerHostId: 'C',
    epoch: 1,
    folder: '/c',
    lostHost: { sourceHostId: 'B', targetHostId: 'C', epoch: 1, rev: 0 },
  });
  change({ machines: [{ id: 'B', status: 'offline' }] });
  await tick();
  assert.deepEqual(m.sessions, []);
  change({ machines: [{ id: 'B', status: 'online' }] });
  await tick();
  await tick();
  await tick();
  assert.equal(m.hosts.B.epochs.current(CHAT), 1, 'the machine was told and poisoned its copy');
  const before = m.sessions.length;
  change({ machines: [{ id: 'B', status: 'online' }] });
  await tick();
  assert.equal(m.sessions.length, before);
  // a failure to tell it is reported, not thrown
  m.machines.session = async () => {
    throw new Error('tunnel down');
  };
  store.set(CHAT, {
    hostId: 'C',
    ownerHostId: 'C',
    epoch: 2,
    folder: '/c',
    lostHost: { sourceHostId: 'B', targetHostId: 'C', epoch: 2, rev: 0 },
  });
  change({ machines: [{ id: 'B', status: 'offline' }] });
  change({ machines: [{ id: 'B', status: 'online' }] });
  await tick();
  await tick();
  await tick();
});

test("3.5: the assembly reads the chat's folder on this Mac with the Host's own git and on a machine from the side map", async () => {
  const m = mac();
  const svc = assemble(m);
  new OwnershipStore(path.join(m.dir, 'host-ownership.json')).set(CHAT, { hostId: 'local', ownerHostId: 'local', epoch: 0, folder: null });
  // a folder that is not a repository: the Mac's own git says so, and the target's folder is compared with nothing
  assert.deepEqual(await svc.codePlan(req()), { state: 'no_repository', repository: null, branch: null, dirty: 0, plan: null });
  assert.deepEqual(await svc.run(req()), { hostId: 'B', epoch: 1 });
  // on a machine, the folder the side map recorded is the source's
  new OwnershipStore(path.join(m.dir, 'host-ownership.json')).set(CHAT, { hostId: 'B', ownerHostId: 'B', epoch: 1, folder: null });
  assert.deepEqual(await svc.codePlan(req({ targetHostId: 'C' })), null);
});

test("IPC: host:codePlan reads through main's service once the chat sessions exist", async () => {
  const m = mac();
  const { call } = ipc(m, m.dir);
  new OwnershipStore(path.join(m.dir, 'host-ownership.json')).set(CHAT, { hostId: 'local', ownerHostId: 'local', epoch: 0, folder: null });
  assert.deepEqual(await call('host:codePlan', { chatId: CHAT, targetHostId: 'B', cwd: '/work/b' }), {
    value: { state: 'no_repository', repository: null, branch: null, dirty: 0, plan: null },
  });
});

test('a chat that was started on a machine (its transcript is mirrored here, this Mac never held it) comes back to this Mac', async () => {
  const m = mac({ queue: null });
  const svc = assemble(m);
  await svc.run(req());
  // what a chat that began on the machine looks like: the machine owns it, this Mac's continue Host has no record of it, and the mirror left a transcript here
  fs.rmSync(path.join(m.dir, 'host-continue', 'owners.json'), { force: true });
  assert.equal(new OwnershipStore(path.join(m.dir, 'host-ownership.json')).get(CHAT).ownerHostId, 'B');
  assert.equal(m.live.chats.records.has(CHAT), true);
  assert.deepEqual(await svc.run(req({ targetHostId: 'local', cwd: m.dir })), { hostId: 'local', epoch: 2 });
  assert.equal(new OwnershipStore(path.join(m.dir, 'host-ownership.json')).get(CHAT).ownerHostId, 'local');
  assert.equal(m.live.switchRunner.continues.pending(CHAT).cwd, fs.realpathSync(m.dir));
});

test('a chat this Mac runs still cannot be prepared on this Mac, and a chat the machine owns is not served here', async () => {
  const m = mac({ queue: null });
  const svc = assemble(m);
  await assert.rejects(svc.run(req({ targetHostId: 'local', cwd: m.dir })), code('same_host'));
});

test('this Mac runs a chat only when the side map puts it here and the Mac holds it: a session, or its records', () => {
  const at = (hostId: string) => ({ refresh: () => undefined, get: () => ({ hostId }) });
  const live = (session: boolean, record: boolean) => ({ sessions: { has: () => session }, chats: { records: { has: () => record } } });
  for (const [hostId, session, record, serves] of [
    ['local', true, false, true],
    ['local', false, true, true],
    ['local', false, false, false],
    // a chat a machine runs has a transcript here, and the Mac does not run it
    ['ssh:box', true, true, false],
    ['ssh:box', false, true, false],
  ] as const)
    assert.equal(servesOf(at(hostId), live(session, record))('c'), serves, `${hostId} session ${session} record ${record}`);
  let refreshed = 0;
  servesOf({ refresh: () => void refreshed++, get: () => ({ hostId: 'local' }) }, live(true, true))('c');
  assert.equal(refreshed, 1, 'the side map is read again each time');
});
