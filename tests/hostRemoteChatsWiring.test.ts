// Main's wiring of the chats that run on a machine (electron/host/wiring.cjs remoteChatsFor, electron/app/ipc/host.cjs): off while Host access is off or the sessions are not up, every remote chat of the ownership file followed when a machine appears, and what a chat says reaching the ACP host's bus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpHostFake, rowListeners, startWorld, tmp } from './support/host/remoteChatsWiringKit.ts';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { remoteChatsFor, remoteRoutes } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

function fakeHost() {
  const patch = new Set<any>();
  const asked: any[] = [];
  const host: any = {
    asked,
    state: () => 'online',
    onState: () => () => undefined,
    connect: async () => undefined,
    subscribe: async (...a: any[]) => (asked.push(a), { snapshot: { rev: 1, items: [] }, patches: null, generation: 'g', inflight: [] }),
    events: {
      onPatch: (fn: any) => (patch.add(fn), () => patch.delete(fn)),
      onFrame: () => () => undefined,
      onResync: () => () => undefined,
      onInflight: () => () => undefined,
    },
    fire: (p: any) => patch.forEach((f) => f(p)),
  };
  return host;
}

test('the service is off while Host access is off or the sessions are not up, and made once otherwise', (t) => {
  const dir = tmp(t);
  let allowed = false;
  let acp: any;
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => allowed,
    machines: () => ({ hostFor: () => null }),
    acpHost: () => acp,
    report: () => undefined,
  });
  assert.equal(chats.get(), null);
  chats.retireSideChats();
  allowed = true;
  assert.equal(chats.get(), null);
  chats.followAll();
  acp = acpHostFake();
  const service = chats.get();
  assert.ok(service);
  assert.equal(chats.get(), service);
});

test('followAll follows each chat the ownership file puts on a machine, reading the file again each time, and not the chats that run here', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const acp = acpHostFake();
  const hosts: Record<string, any> = { box: fakeHost() };
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: (id: string) => hosts[id] ?? null }),
    acpHost: () => acp,
    report: (e: Error) => assert.fail(e.message),
  });
  chats.followAll();
  assert.equal(hosts.box.asked.length, 0);
  // another process claims two chats: one on the machine, one that is handed to this Mac
  own.set('acp:kimi:a', { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/a' });
  own.set('acp:kimi:b', { hostId: 'local', ownerHostId: 'local', epoch: 1, folder: null });
  chats.followAll();
  await chats.get()!.settled('acp:kimi:a');
  assert.deepEqual(
    hosts.box.asked.map((a: any[]) => a[0]),
    ['acp:kimi:a'],
  );
  assert.deepEqual(acp.records[0], { t: 'session', harness: 'kimi', sessionId: 'host:box', cwd: '/srv/a', at: acp.records[0].at });
  // what the machine says reaches the bus with the chat's key
  hosts.box.fire({
    chatId: 'acp:kimi:a',
    rev: 2,
    patch: { item: { t: 'event', family: 'acp', event: { kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' } } },
  });
  await chats.get()!.settled('acp:kimi:a');
  assert.deepEqual(acp.events, [{ kind: 'turnEnd', turnId: 't', stopReason: 'end_turn', key: 'acp:kimi:a' }]);
});

test('main follows its remote chats when a machine appears, and offers the service to the rest of main', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  own.set('acp:kimi:a', { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/a' });
  const acp = acpHostFake();
  const host = fakeHost();
  const handlers = new Map<string, any>();
  let opts: any;
  const patched: any[] = [];
  const live: any = {
    acpHost: acp,
    controller: { state: { get: () => ({ queue: [] }), has: () => true, patch: (...a: any[]) => patched.push(a) } },
  };
  // the Host tells the chat's goal in its Hello: it is shown from main's session store
  host.subscribe = async (...a: any[]) => (
    host.asked.push(a),
    { snapshot: { rev: 1, items: [] }, patches: null, generation: 'g', inflight: [], chatState: { goal: { status: 'active' } } }
  );
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: (o: any) => (
        (opts = o), { list: () => ({ machines: [], resolved: true }), hostFor: () => host, row: () => ({ status: 'online' }) }
      ),
      allowed: () => true,
    },
  );
  assert.equal(typeof live.remoteChats, 'function');
  handlers.get('host:machines')({});
  assert.deepEqual(await handlers.get('host:pendingDeletions')({}), { value: [] });
  opts.onChange({ machines: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.asked.length, 1);
  assert.deepEqual(patched, [['acp:kimi:a', { goal: { status: 'active' } }]]);
  // a card the machine closes closes the question of that id in the app's form cards (#4001)
  host.fire({
    chatId: 'acp:kimi:a',
    rev: 2,
    patch: { item: { t: 'event', family: 'acp', event: { kind: 'permissionCancelled', requestId: 'q1' } } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(acp.closedQuestions, ['acp:kimi:a|q1']);
  assert.equal(live.remoteChats(), live.remoteChats());
});

const ASK = { chatId: 'acp:kimi:c1', hostId: 'box', folder: '/srv/app', harness: 'kimi', projectId: 'p1' };

test('a chat for a machine: its folder goes on record with the machine, its first message is told to start it, and it is listed before the window hears back', async (t) => {
  const w = startWorld(t);
  assert.deepEqual(await w.start(ASK), { value: { chatId: 'acp:kimi:c1' } });
  assert.deepEqual(w.own().get('acp:kimi:c1'), { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/app' });
  assert.deepEqual(w.begun, [['acp:kimi:c1', { harness: 'acp:kimi', projectId: 'p1' }]]);
  assert.deepEqual(w.followed, ['acp:kimi:c1']);
  assert.deepEqual(w.order, ['begin', 'follow']);
  // no project is none
  await w.start({ ...ASK, chatId: 'acp:kimi:c2', projectId: undefined });
  assert.equal((w.begun[1] as any)[1].projectId, null);
});

test('the Host side-chat entry point uses the stable parent’s current agent, machine and folder', async (t) => {
  const w = startWorld(t, {
    row: {
      name: 'box',
      harnesses: [
        { id: 'kimi', detected: true },
        { id: 'claude', detected: true, signedIn: true },
      ],
    },
  });
  await w.start(ASK);
  const inherited = {
    hostPermission: { hostId: 'box', harness: 'claude', value: 'read-only' },
    hostSelection: { hostId: 'box', harness: 'claude', model: 'preferred' },
  };
  const patches: unknown[] = [];
  w.live.chats = {
    records: new Map(),
    get: () => ({ meta: { config: { hostAgent: 'claude', ...inherited } } }),
    patchMeta: (...args: unknown[]) => (patches.push(args), true),
  };
  const open = w.handlers.get('host:openSideChat');
  assert.equal(typeof open, 'function');
  const { value } = await open(null, ASK.chatId);
  assert.match(value.chatId, /^acp:host-claude:side-chat-/);
  assert.equal(value.hostId, ASK.hostId);
  assert.equal(value.cwd, ASK.folder);
  assert.deepEqual(value.config, inherited);
  assert.deepEqual(patches, [[value.chatId, { config: inherited }]]);
  assert.deepEqual(w.own().get(value.chatId), { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/app' });
  assert.deepEqual(w.begun.at(-1)?.[1].sideChat, { sourceId: ASK.chatId, epoch: 0 });
  assert.equal(w.begun.at(-1)?.[1].harness, 'claude');
});

test('a previous app’s side chat retires when machines are followed and its parent stays bound', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const side = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const bound = { hostId: 'box', ownerHostId: 'box', folder: '/p', epoch: 0 };
  own.set(side, bound);
  own.set('acp:kimi:parent', bound);
  const removed: string[] = [];
  const retired: string[] = [];
  const chats = remoteChatsFor({
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => null }),
    acpHost: () => ({ ...acpHostFake(), remove: (chatId: string) => removed.push(chatId) }),
    sender: () => ({ forgetChat: (chatId: string) => retired.push(chatId) }) as any,
    safeStorage: () => keySafe,
    canFollow: (id: string) => id !== side,
  });
  chats.followAll();
  own.refresh();
  assert.deepEqual(
    own.remoteChats().map((c: any) => c.chatId),
    ['acp:kimi:parent'],
  );
  assert.deepEqual([...new Set(retired)], [side]);
  assert.deepEqual(removed, [side]);
  assert.equal(chats.pendingDeletions().length, 1, 'cleanup waits in the deletion outbox while the machine is away');
});

test('B1: a chat for a machine is refused with a reason when the request, the machine or its agent is not usable, and leaves nothing on record', async (t) => {
  const w = startWorld(t);
  for (const bad of [
    undefined,
    {},
    { ...ASK, folder: '' },
    { ...ASK, hostId: 7 },
    { ...ASK, chatId: 'acp:gemini:c1' },
    { ...ASK, chatId: 'claude:c1' },
  ]) {
    const r = await w.start(bad);
    assert.equal(r.error.code, 'invalid', JSON.stringify(bad));
  }
  const missing = startWorld(t, { row: undefined });
  assert.equal((await missing.start(ASK)).error.code, 'unknown_machine');
  const none = startWorld(t, { row: { name: 'build-box', harnesses: [{ id: 'kimi', detected: false }] } });
  assert.deepEqual((await none.start(ASK)).error, { message: "Kimi Code isn't installed on build-box.", code: 'harness_not_configured' });
  const bare = startWorld(t, { row: { name: 'build-box' } });
  assert.equal((await bare.start(ASK)).error.code, 'harness_not_configured');
  for (const x of [w, missing, none, bare]) {
    assert.deepEqual(x.begun, []);
    assert.deepEqual(x.own().get('acp:kimi:c1').hostId, 'local');
  }
});

const FAMILY_ROW = {
  name: 'build-box',
  status: 'online',
  harnesses: [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: false },
  ],
};
const CLAUDE_ASK = { chatId: 'acp:host-claude:u1', hostId: 'box', folder: '/srv/app', harness: 'claude', projectId: 'p1' };

test('a Claude Code chat for a machine begins under its app id, to be started on the Host as claude', async (t) => {
  const w = startWorld(t, { row: FAMILY_ROW });
  assert.deepEqual(await w.start(CLAUDE_ASK), { value: { chatId: 'acp:host-claude:u1' } });
  assert.deepEqual(w.own().get('acp:host-claude:u1'), { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/app' });
  assert.deepEqual(w.begun, [['acp:host-claude:u1', { harness: 'claude', projectId: 'p1' }]]);
  assert.deepEqual(w.followed, ['acp:host-claude:u1']);
});

test('B1: a Claude Code or Codex chat is refused with the name of the agent and the machine when it is signed out there, missing, or the id is not its own', async (t) => {
  const w = startWorld(t, { row: FAMILY_ROW });
  assert.deepEqual((await w.start({ ...CLAUDE_ASK, chatId: 'acp:host-codex:u2', harness: 'codex' })).error, {
    message: 'Sign in to Codex on build-box.',
    code: 'harness_not_configured',
  });
  for (const chatId of ['claude:u1', 'acp:claude:u1', 'acp:host-codex:u1'])
    assert.equal((await w.start({ ...CLAUDE_ASK, chatId })).error.code, 'invalid');
  const gone = startWorld(t, { row: { name: 'build-box', harnesses: [{ id: 'claude', detected: false }] } });
  assert.deepEqual((await gone.start(CLAUDE_ASK)).error, {
    message: "Claude Code isn't installed on build-box.",
    code: 'harness_not_configured',
  });
  for (const x of [w, gone]) {
    assert.deepEqual(x.begun, []);
    assert.equal(x.own().get('acp:host-claude:u1').hostId, 'local');
  }
});

test('A3: while Host access is off a chat for a machine is refused outright', async (t) => {
  const w = startWorld(t, { allowed: false });
  assert.equal((await w.start(ASK)).error.code, 'not_allowed');
  assert.deepEqual(w.begun, []);
});

test('the routes for a chat on another machine answer null for this Mac’s chats and while Host is off, and reach the services otherwise', async () => {
  const off = remoteRoutes({});
  assert.equal(off.stop('c', 't'), null);
  assert.equal(off.answer('card', 'allow'), null);
  const idle = remoteRoutes({ remoteSend: () => null, remoteChats: () => null });
  assert.equal(idle.stop('c', 't'), null);
  assert.equal(idle.answer('card', null), null);
  const seen: any[] = [];
  const on = remoteRoutes({
    remoteSend: () => ({ stop: (...a: any[]) => (seen.push(['stop', ...a]), Promise.resolve('stopped')) }),
    remoteChats: () => ({ answer: (...a: any[]) => (seen.push(['answer', ...a]), Promise.resolve(true)) }),
  });
  assert.equal(await on.stop('c', 't'), 'stopped');
  assert.equal(await on.answer('card', 'allow'), true);
  assert.deepEqual(seen, [
    ['stop', 'c', 't'],
    ['answer', 'card', 'allow'],
  ]);
});

test('a deleted chat is no longer followed and the ownership file forgets it; while Host is off nothing is touched', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  own.set('acp:kimi:a', { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/a' });
  const acp = acpHostFake();
  const host = fakeHost();
  let allowed = true;
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => allowed,
    machines: () => ({ hostFor: () => host }),
    acpHost: () => acp,
  });
  chats.followAll();
  await chats.get()!.settled('acp:kimi:a');
  allowed = false;
  assert.deepEqual(chats.pendingDeletions(), []);
  await chats.forget('acp:kimi:a');
  assert.equal(new OwnershipStore(path.join(dir, 'host-ownership.json')).get('acp:kimi:a').hostId, 'box');
  allowed = true;
  await chats.forget('acp:kimi:a');
  assert.equal(new OwnershipStore(path.join(dir, 'host-ownership.json')).get('acp:kimi:a').hostId, 'local');
  host.fire({ chatId: 'acp:kimi:a', rev: 9, patch: { item: { t: 'event', family: 'acp', event: { kind: 'turnEnd', turnId: 't' } } } });
  await chats.get()!.settled('acp:kimi:a');
  assert.deepEqual(acp.events, []);
});

test('quitting disposes what Host started (the machines service with its tunnels, the remote sends, the followed chats); an app that cannot say when it quits is left alone', async (t) => {
  const dir = tmp(t);
  const quits: (() => void)[] = [];
  const disposed: string[] = [];
  const handlers = new Map<string, any>();
  const live: any = { acpHost: acpHostFake(), controller: { state: { get: () => ({ queue: [] }), patch: () => undefined } } };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      live,
      app: { getPath: () => dir, once: (e: string, fn: () => void) => e === 'will-quit' && quits.push(fn) },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
    },
    {
      create: () => ({
        list: () => ({ machines: [], resolved: true }),
        hostFor: () => null,
        row: () => ({}),
        dispose: () => disposed.push('machines'),
      }),
      allowed: () => true,
    },
  );
  assert.equal(quits.length, 1);
  // nothing was made yet: quitting has nothing to dispose
  quits[0]();
  assert.equal(disposed.length, 0);
  handlers.get('host:machines')({});
  const sends = live.remoteSend();
  sends.dispose = () => disposed.push('sends');
  const chats = live.remoteChats();
  chats.dispose = () => disposed.push('chats');
  quits[0]();
  assert.deepEqual(disposed, ['chats', 'sends', 'machines']);
  // an app without once (a test double) registers nothing
  register(
    { handle: () => undefined },
    { live: {}, app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => ({}) as any, allowed: () => true },
  );
});

test('a Claude Code chat starts on a machine where it is signed out when the user gave a key and that Host takes keys, and only then', async (t) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
    decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
  };
  const out = { name: 'build-box', status: 'online', harnesses: [{ id: 'claude', detected: true, signedIn: false, takesKey: true }] };
  const w = startWorld(t, { row: out, safeStorage });
  assert.equal((await w.start(CLAUDE_ASK)).error.code, 'harness_not_configured', 'no key yet');
  assert.deepEqual(await w.setKey('anthropic', 'sk-ant-dummy-0000-test-key-abcd'), { value: '…abcd' });
  assert.deepEqual(await w.start(CLAUDE_ASK), { value: { chatId: 'acp:host-claude:u1' } });
  // an older Host that cannot hold the key: still refused
  const old = startWorld(t, { row: { ...out, harnesses: [{ id: 'claude', detected: true, signedIn: false }] }, safeStorage });
  await old.setKey('anthropic', 'sk-ant-dummy-0000-test-key-abcd');
  assert.equal((await old.start(CLAUDE_ASK)).error.code, 'harness_not_configured');
});

test('a scheduled run on a machine starts its chat through the same checks as the composer, and sends through the outbox', async (t) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
    decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
  };
  const row = {
    name: 'build-box',
    status: 'online',
    harnesses: [
      { id: 'claude', detected: true, signedIn: true },
      { id: 'codex', detected: true, signedIn: false, takesKey: true },
    ],
  };
  const w = startWorld(t, { row, safeStorage });
  const m = w.live.machineChats;
  assert.equal(m.allowed(), true);
  assert.equal(m.nameOf('box'), 'build-box');
  assert.deepEqual(m.readiness('box', 'claude'), { ok: true, by: 'machine', machine: row });
  assert.equal(m.readiness('box', 'codex').error.message, 'Sign in to Codex on build-box.');
  await w.setKey('openai', 'sk-dummy-0000-test-key-wxyz');
  assert.equal(m.readiness('box', 'codex').by, 'lent');
  const id = m.newChatId('claude');
  assert.match(id, /^acp:host-claude:[0-9a-f-]{36}$/);
  assert.deepEqual(await m.start({ chatId: id, hostId: 'box', folder: '/srv/app', harness: 'claude', projectId: null }), {
    chatId: id,
    by: 'machine',
  });
  assert.deepEqual(w.begun, [[id, { harness: 'claude', projectId: null }]]);
  const sent: any[] = [];
  w.live.remoteSend().send = async (...a: any[]) => (sent.push(a), { action: 'queued', id: 'k' });
  assert.deepEqual(await m.send(id, { text: 'hi' }), { action: 'queued', id: 'k' });
  assert.deepEqual(sent, [[id, { text: 'hi' }, null]]);
});

test('A3: while Host access is off a scheduled run on a machine is refused, and nothing is sent', async (t) => {
  const w = startWorld(t, { allowed: false });
  const m = w.live.machineChats;
  assert.equal(m.readiness('box', 'kimi').error.code, 'not_allowed');
  assert.throws(() => m.start(ASK), { code: 'not_allowed' });
  assert.equal(m.send('acp:kimi:c1', { text: 'hi' }), null);
  assert.equal(startWorld(t, { row: undefined }).live.machineChats.nameOf('gone'), null);
  assert.deepEqual(w.begun, []);
});

test('Host access that ends between the check and the start refuses the chat instead of binding one with no first message', async (t) => {
  let open = true;
  // access ends while the machine's agents are read, after the start was let in
  const row = {
    name: 'build-box',
    get harnesses() {
      open = false;
      return [{ id: 'kimi', detected: true, signedIn: true }];
    },
  };
  const w = startWorld(t, { allowed: () => open, row });
  await assert.rejects(w.live.machineChats.start({ ...ASK, chatId: 'acp:kimi:late' }), { code: 'not_allowed' });
  assert.deepEqual(w.begun, []);
});

test('a machine that fires its own scheduled tasks: its Host and row while Host is on, its row changes, and a run’s chat taken in like one started here', async (t) => {
  let open = true;
  const w = startWorld(t, { allowed: () => open });
  const m = w.live.machineChats;
  assert.equal(m.hostFor('box'), null);
  assert.equal(m.rowOf('box').name, 'build-box');
  let heard = 0;
  m.onRows(() => heard++);
  rowListeners.at(-1)?.();
  assert.equal(heard, 1);
  await m.adopt('acp:kimi:run1', { hostId: 'box', folder: '/srv/app' });
  assert.deepEqual(w.own().get('acp:kimi:run1'), { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/app' });
  assert.deepEqual(w.followed, ['acp:kimi:run1']);
  open = false;
  assert.equal(m.hostFor('box'), null);
  assert.equal(m.rowOf('box'), null);
});

test('the pending-deletion IPC exposes only public ids and machine removal cancels that pending authority', async (t) => {
  const w = startWorld(t);
  await w.start(ASK);
  await w.live.remoteForget(ASK.chatId);
  assert.deepEqual(await w.handlers.get('host:pendingDeletions')({}), { value: [{ hostId: ASK.hostId, chatId: ASK.chatId }] });
  // the machine's browser tabs go with it when main has them; a removal that names no machine drops nothing of another's
  const dropped: string[] = [];
  w.live.hostTabs = { dropHost: (id: string) => dropped.push(id) };
  await w.handlers.get('host:remove')({}, ASK.hostId);
  await w.handlers.get('host:remove')({}, undefined);
  assert.deepEqual(dropped, [ASK.hostId, '']);
  assert.deepEqual(await w.handlers.get('host:pendingDeletions')({}), { value: [] });
});

test('the main start handler refuses a retired Host scope and retains the current one for the first prompt', async (t) => {
  const row = { name: 'Build box', status: 'online', hostKey: 'current', harnesses: [{ id: 'kimi', detected: true }] };
  const w = startWorld(t, { row });
  const replaced = await w.start({ ...ASK, scope: 'retired' });
  assert.equal(replaced.error.code, 'machine_changed');
  assert.deepEqual(w.begun, []);
  assert.deepEqual(await w.start({ ...ASK, scope: 'current' }), { value: { chatId: ASK.chatId } });
  assert.deepEqual(w.begun, [[ASK.chatId, { harness: 'acp:kimi', projectId: 'p1', scope: 'current' }]]);
  row.status = 'offline';
  assert.deepEqual(await w.handlers.get('host:sidebarRepository')(null, 'box', { path: '/srv/app' }), { value: null });
});
