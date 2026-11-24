// MoMo's remote machine (host/src/momoTasks/remoteMachine.mjs) over a scripted other Host: what a start sends, what a session's frames mean, and what happens to a start whose connection is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createHomeKey } from '../host/src/momoTasks/homeKey.mjs';
// @ts-ignore
import { createHomeMachines } from '../host/src/momoTasks/homeMachines.mjs';
// @ts-ignore
import { createHomeClient } from '../host/src/momoTasks/homeClient.mjs';
// @ts-ignore
import { createRemoteMachine, agentsFromStatus } from '../host/src/momoTasks/remoteMachine.mjs';
// @ts-ignore
import { waitingIn } from '../host/src/momoTasks/sessionEvents.mjs';
import { AUTH, coded, fakeHost, LEASE, MACHINE, nextTick, sealed, tmp } from './support/hostLinkKit.ts';

// ----- the remote machine ------------------------------------------------------------------------

async function remoteWorld(t: any, answers: Record<string, any> = {}, over: { allowed?: boolean } = {}) {
  const o = sealed(tmp(t));
  const machines = createHomeMachines(o);
  if (over.allowed !== false) await machines.set(MACHINE);
  const key = createHomeKey({ ...o, dir: o.dir, homeId: () => 'home-a' });
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const client = createHomeClient({
    identity: () => key.identity(),
    stamp: () => LEASE,
    dial: async () => {
      const h = fakeHost({ ...AUTH, ...answers });
      hosts.push(h);
      return h.transport;
    },
  });
  const kept = new Map<string, string>();
  const keys = {
    get: (k: string) => kept.get(k) ?? null,
    set: async (k: string, c: string) => void kept.set(k, c),
    delete: async (k: string) => void kept.delete(k),
  };
  const ended = new Map<string, any>();
  const ends = { get: (c: string) => ended.get(c) ?? null, set: async (c: string, e: any) => void ended.set(c, e) };
  const emitted: any[] = [];
  const reports: string[] = [];
  let ids = 0;
  const remote = createRemoteMachine({
    client,
    machines,
    keys,
    ends,
    emit: async (m: string, c: string, e: any) => void emitted.push([m, c, e]),
    report: (m: string) => void reports.push(m),
    newId: () => `11111111-1111-4111-8111-${String(++ids).padStart(12, '0')}`,
  });
  return { remote, port: remote.port(), hosts, kept, ended, emitted, reports, machines, client };
}
const REQ = {
  itemId: 'i1',
  machineId: 'm1',
  harness: 'claude',
  brief: 'do the thing',
  readOnly: false,
  key: 'i1:1',
  gateOrigin: 'task',
} as any;
const frame = (chatId: string, f: any) => ({ event: 'frame', chatId, frame: f });
const durable = (event: any) => ({ t: 'durable', item: { t: 'event', event } });

test('a machine is listed with its agents when it answers and offline when it does not', async (t) => {
  const w = await remoteWorld(t, {
    'host.status': {
      harnesses: [
        { id: 'claude', detected: true, signedIn: true },
        { id: 'codex', detected: false, signedIn: false },
      ],
    },
  });
  const [m] = await w.port.list();
  assert.deepEqual(
    { ...m, agents: m.agents.map((a: any) => a.id) },
    { machineId: 'm1', name: 'Studio', online: true, outdated: false, installable: false, agents: ['claude', 'codex'] },
  );
  assert.equal(m.agents.find((a: any) => a.id === 'claude')?.state, 'ready');
  const silent = await remoteWorld(t, { 'host.status': {} });
  assert.deepEqual((await silent.port.list())[0].agents, []);
  const down = await remoteWorld(t, { 'host.status': new Error('closed') });
  assert.deepEqual(await down.port.list(), [
    { machineId: 'm1', name: 'Studio', online: false, outdated: false, installable: false, agents: [] },
  ]);
  assert.deepEqual(
    agentsFromStatus([{ id: 'gemini', detected: true, signedIn: true }], 'm').map((a: any) => a.id),
    ['acp:gemini'],
  );
});

test("a start sends the brief in Ask for approval or read-only, never the machine's default, and follows the chat from the start of its journal", async (t) => {
  const w = await remoteWorld(t, { 'chat.start': { replayed: false, result: {} }, 'chat.subscribe': { subscribed: true } });
  const out = await w.port.start(REQ);
  assert.equal(out.ok, true);
  const chatId = (out as any).sessionId;
  assert.match(chatId, /^claude:/);
  const sent = w.hosts[0].calls.find((c) => c.method === 'chat.start')!.params;
  assert.deepEqual(
    { ...sent, key: undefined, home: undefined },
    { chatId, epoch: 1, key: undefined, text: 'do the thing', harness: 'claude', permission: 'default', home: undefined },
  );
  assert.match(sent.key, /^momo-task-[0-9a-f]{40}$/);
  assert.deepEqual(w.hosts[0].calls.find((c) => c.method === 'chat.subscribe')!.params, { chatId, epoch: 1, fromRev: 0, home: LEASE });
  // the same start again is the same chat and the same wire key
  const again = await w.port.start(REQ);
  assert.equal((again as any).sessionId, chatId);
  assert.equal(w.hosts[0].calls.filter((c) => c.method === 'chat.start').at(-1)!.params.key, sent.key);
  // read-only is asked for by name
  const ro = await w.port.start({ ...REQ, key: 'i2:1', readOnly: true });
  assert.equal(w.hosts[0].calls.filter((c) => c.method === 'chat.start').at(-1)!.params.permission, 'read-only');
  assert.equal(ro.ok, true);
  assert.equal(w.remote.size(), 2);
});

test('a start that cannot go is refused in the words of the cause, and nothing is kept for it', async (t) => {
  const none = await remoteWorld(t, {}, { allowed: false });
  assert.deepEqual(await none.port.start(REQ), {
    ok: false,
    code: 'machine_not_allowed',
    message: "MoMo isn't allowed to use that machine.",
  });
  const w = await remoteWorld(t, { 'chat.start': { ok: 1 }, 'chat.subscribe': { ok: 1 } });
  const basic = await w.port.start({ ...REQ, harness: 'acp:gemini' });
  assert.equal((basic as any).code, 'read_only_unsupported');
  assert.match((basic as any).message, /can't be limited to asking first/);
  const basicRo = await w.port.start({ ...REQ, harness: 'acp:gemini', readOnly: true });
  assert.match((basicRo as any).message, /can't be held read-only/);
  assert.equal(w.hosts.length, 0, 'nothing was sent');
  const refused = await remoteWorld(t, {
    'chat.start': Object.assign(coded('home_mode_refused', 'no'), { details: { key: 'permission' } }),
  });
  const r = await refused.port.start(REQ);
  assert.deepEqual(r, { ok: false, code: 'home_mode_refused', message: 'no', details: { key: 'permission' } });
  assert.equal(refused.kept.size, 0, 'the start key is given back');
  assert.equal(refused.remote.size(), 0);
  // what a machine says is shown as a short line without control characters
  const wordy = await remoteWorld(t, { 'chat.start': coded('refused', `first\nsecond\u0000${'x'.repeat(400)}`) });
  const said = ((await wordy.port.start(REQ)) as any).message as string;
  assert.ok(said.length <= 200 && !/[\u0000-\u001f]/.test(said) && said.startsWith('first second'));
  const plain = await remoteWorld(t, { 'host.hello': undefined });
  plain.client.call = async () => Promise.reject('text');
  assert.equal(((await plain.port.start(REQ)) as any).message, 'text');
});

test('a session that started but could not be followed yet keeps its start key: a start again is the same chat, never a second one', async (t) => {
  let follows = 0;
  const w = await remoteWorld(t, {
    'chat.start': {},
    'chat.subscribe': () => {
      if (++follows === 1) throw new Error('link lost');
      return {};
    },
  });
  const first = (await w.port.start(REQ)) as any;
  assert.equal(first.ok, true);
  assert.equal(w.kept.get(REQ.key), first.sessionId, 'the key stays');
  assert.match(w.reports.join(' '), /could not be followed yet/);
  const again = (await w.port.start(REQ)) as any;
  assert.equal(again.sessionId, first.sessionId);
  const starts = w.hosts.flatMap((h) => h.calls.filter((c) => c.method === 'chat.start'));
  assert.deepEqual([...new Set(starts.map((c) => c.params.chatId))], [first.sessionId]);
});

test('MoMo proves its key only to the machine it was allowed on: another Host id is refused, and an id that cannot be pinned is not accepted', async (t) => {
  const w = await remoteWorld(t, { 'host.challenge': { nonce: 'n1', hostId: 'c'.repeat(32) }, 'host.status': {} });
  await assert.rejects(w.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'machine_changed' && /Allow it again/.test(e.message));
  assert.equal(
    w.hosts[0].calls.some((c) => c.method === 'host.auth'),
    false,
    'no proof was signed for it',
  );
  await assert.rejects(w.machines.set({ ...MACHINE, hostId: 'short' }), /pin/);
});

test('a start whose connection is lost after it was sent keeps its key, and the retry sends the same chat and wire key', async (t) => {
  let starts = 0;
  const w = await remoteWorld(t, {
    'chat.start': () => {
      if (++starts === 1) throw new Error('socket closed');
      return {};
    },
    'chat.subscribe': {},
  });
  const first = (await w.port.start(REQ)) as any;
  assert.equal(first.ok, false);
  assert.equal(first.code, 'machine_lost');
  assert.equal(w.kept.size, 1, 'the key stays: the machine may have started it');
  const again = (await w.port.start(REQ)) as any;
  assert.equal(again.ok, true);
  const sent = w.hosts.flatMap((h) => h.calls.filter((c) => c.method === 'chat.start')).map((c) => [c.params.chatId, c.params.key]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], 'the same chat id and the same wire key, which the machine answers as a repeat');
  // a refusal the Host gave, or a connection that never opened, is not that: nothing could have started
  const refused = await remoteWorld(t, { 'chat.start': coded('home_mode_refused', 'no') });
  await refused.port.start(REQ);
  assert.equal(refused.kept.size, 0);
});

test('a remote session is read like a local one: the reply of the turn that ended, a failure, a Stop that says nothing', async (t) => {
  const w = await remoteWorld(t, { 'chat.start': {}, 'chat.subscribe': {} });
  const chatId = ((await w.port.start(REQ)) as any).sessionId;
  const host = w.hosts[0];
  host.push(frame(chatId, durable({ kind: 'turnStart', turnId: 't1' })));
  host.push(
    frame(chatId, durable({ kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'All ' } } })),
  );
  host.push(
    frame(chatId, durable({ kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'done' } } })),
  );
  host.push(frame(chatId, durable({ kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' })));
  await nextTick();
  await nextTick();
  assert.deepEqual(w.emitted, [['m1', chatId, { kind: 'finished', report: 'All done' }]]);
  assert.deepEqual(w.ended.get(chatId), { kind: 'finished', report: 'All done' });
  host.push(frame(chatId, durable({ kind: 'turnEnd', turnId: 't2', stopReason: 'cancelled' })));
  host.push(frame(chatId, durable({ kind: 'turnEnd', turnId: 't3', error: { code: 'rate_limit', message: 'limit' } })));
  await nextTick();
  await nextTick();
  assert.equal(w.emitted.length, 2);
  assert.equal(w.emitted[1][2].kind, 'failed');
  // frames that carry nothing of the turn, and chats not followed, are ignored
  host.push({ event: 'closed', chatId, reason: 'x' });
  host.push(frame(chatId, { t: 'delta' }));
  host.push(frame(chatId, { t: 'durable', item: { t: 'user' } }));
  host.push(frame(chatId, undefined));
  host.push(frame(chatId, { t: 'state', patch: { title: 'x' } }));
  await nextTick();
  assert.equal(w.emitted.length, 2);
});

test('an approval card waiting on the owner is needs_you once, and resumed when it closes; a failing report is reported', async (t) => {
  const w = await remoteWorld(t, { 'chat.start': {}, 'chat.subscribe': {} });
  const chatId = ((await w.port.start(REQ)) as any).sessionId;
  const host = w.hosts[0];
  host.push(frame(chatId, { t: 'state', patch: { attention: { kind: 'approval', cards: ['r1'] } } }));
  host.push(frame(chatId, { t: 'state', patch: { attention: { kind: 'approval', cards: ['r1', 'r2'] } } }));
  await nextTick();
  assert.deepEqual(w.emitted, [
    ['m1', chatId, { kind: 'needs_you', line: 'Waiting for your approval on Studio', cardId: `approval:${chatId}` }],
  ]);
  host.push(frame(chatId, { t: 'state', patch: { attention: null } }));
  host.push(frame(chatId, { t: 'state', patch: { attention: null } }));
  await nextTick();
  assert.deepEqual(w.emitted.at(-1), ['m1', chatId, { kind: 'resumed' }]);
  assert.equal(w.emitted.length, 2);
  assert.equal(waitingIn(null), null);
  assert.equal(waitingIn({ title: 'x' }), null);
  // a card that waits, then a turn that ends, is not waiting any more
  host.push(frame(chatId, { t: 'state', patch: { attention: { kind: 'approval' } } }));
  host.push(frame(chatId, durable({ kind: 'turnEnd', turnId: 't9', stopReason: 'end_turn' })));
  await nextTick();
  await nextTick();
  host.push(frame(chatId, { t: 'state', patch: { attention: null } }));
  await nextTick();
  assert.equal(w.emitted.filter((e) => e[2].kind === 'resumed').length, 1);
  // delivery that fails is reported, never thrown at the wire
  const bad = await remoteWorld(t, { 'chat.start': {}, 'chat.subscribe': {} });
  const failing = createRemoteMachine({
    client: bad.client,
    machines: bad.machines,
    keys: { get: () => null, set: async () => undefined, delete: async () => undefined },
    ends: { get: () => null, set: async () => Promise.reject(new Error('disk')) },
    emit: async () => Promise.reject('no card'),
    report: (m: string) => void bad.reports.push(m),
  });
  const id = ((await failing.port().start(REQ)) as any).sessionId;
  const h = bad.hosts[0];
  h.push(frame(id, { t: 'state', patch: { attention: { kind: 'approval' } } }));
  h.push(frame(id, durable({ kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' })));
  await nextTick();
  await nextTick();
  h.push(frame(id, { t: 'state', patch: { attention: { kind: 'approval' } } }));
  h.push(frame(id, { t: 'state', patch: { attention: null } }));
  await nextTick();
  await nextTick();
  assert.ok(bad.reports.some((r) => /disk/.test(r)));
  assert.ok(bad.reports.some((r) => /no card/.test(r)));
});

test('stop reaches the machine with a key of its own; probe reads a kept end, follows again, or says gone or unreachable', async (t) => {
  const w = await remoteWorld(t, { 'chat.start': {}, 'chat.subscribe': {}, 'chat.stop': {} });
  const chatId = ((await w.port.start(REQ)) as any).sessionId;
  await w.port.stop('m1', chatId);
  await w.port.stop('m1', chatId);
  const stops = w.hosts[0].calls.filter((c) => c.method === 'chat.stop');
  assert.equal(stops.length, 2);
  assert.notEqual(stops[0].params.key, stops[1].params.key);
  assert.match(stops[0].params.key, /^momo-task-/);
  await w.port.stop('unknown', chatId);
  assert.equal(w.hosts[0].calls.filter((c) => c.method === 'chat.stop').length, 2);
  assert.deepEqual(await w.port.probe('m1', chatId), { state: 'running' });
  assert.equal(w.hosts[0].calls.filter((c) => c.method === 'chat.subscribe').at(-1)!.params.fromRev, 0);
  w.ended.set(chatId, { kind: 'finished', report: 'r' });
  assert.deepEqual(await w.port.probe('m1', chatId), { state: 'ended', event: { kind: 'finished', report: 'r' } });
  assert.deepEqual(await w.port.probe('m9', 'claude:zzz'), { state: 'gone' });
  const away = await remoteWorld(t, { 'chat.subscribe': coded('home_not_allowed') });
  assert.deepEqual(await away.port.probe('m1', 'claude:old'), { state: 'gone' });
  const off = await remoteWorld(t, { 'chat.subscribe': new Error('closed') });
  assert.deepEqual(await off.port.probe('m1', 'claude:old'), { state: 'unreachable' });
  const lost = await remoteWorld(t, { 'chat.subscribe': coded('stale_epoch') });
  assert.deepEqual(await lost.port.probe('m1', 'claude:old'), { state: 'unreachable' });
  // a session no longer followed
  w.remote.track('claude:x');
  assert.equal(w.remote.size(), 2);
  w.remote.untrack('claude:x');
  w.remote.untrack(chatId, 'm1');
  assert.equal(w.remote.size(), 0);
});
