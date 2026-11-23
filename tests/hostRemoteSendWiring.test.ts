// Main's wiring of remote sends (electron/host/wiring.cjs, electron/app/ipc/host.cjs, the session handlers of electron/app/ipc/sessions.cjs): off while Host access is off, the ownership file read each time, a machine that answers again sends what waited, the push path and the session handlers' route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { remoteSendFor, devApprovalMs } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const KEY = '00000000-0000-4000-8000-000000000001';

function setup(t: any, allowedAtStart = true) {
  installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = { allowed: allowedAtStart };
  const handlers = new Map<string, any>();
  const queues = new Map<string, any[]>();
  const sent: any[] = [];
  const listeners = new Set<(s: string) => void>();
  const host = {
    up: false,
    state: () => (host.up ? 'online' : 'offline'),
    onState: (fn: any) => (listeners.add(fn), () => listeners.delete(fn)),
    connect: async () => undefined,
    send: async (chatId: string, item: any, opts: any) => void sent.push([chatId, item, opts.key]),
    stop: async () => undefined,
    permit: async (_p: any) => undefined,
  };
  const row = { status: 'offline' };
  const rowListeners = new Set<() => void>();
  let opts: any;
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    hostFor: (id: string) => (id === 'box' ? host : null),
    row: () => row,
    onRowChange: (fn: () => void) => (rowListeners.add(fn), () => rowListeners.delete(fn)),
  };
  const notices: any[] = [];
  const live: any = {
    controller: {
      state: { get: (id: string) => ({ queue: queues.get(id) ?? [] }), patch: (id: string, p: any) => queues.set(id, p.queue) },
    },
    notifier: { notify: (...a: any[]) => notices.push(a) },
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      live,
      app: { getPath: () => dir },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
    },
    { create: (o: any) => ((opts = o), svc), allowed: () => gate.allowed },
  );
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const comeBack = () => {
    host.up = true;
    row.status = 'online';
    // the first ask makes the machines service, which is where the registry's change event comes from
    handlers.get('host:machines')({});
    opts.onChange({ machines: [] });
    return new Promise((r) => setTimeout(r, 20));
  };
  return { dir, gate, handlers, queues, sent, host, row, svc, notices, live, own, comeBack, opts: () => opts, listeners };
}

test('Host off: no service, so every chat goes the local way', async (t) => {
  const w = setup(t, false);
  assert.equal(w.live.remoteSend(), null);
  w.own.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  assert.equal(w.live.remoteSend(), null, 'the gate decides, not the ownership file');
});

test('a message to a chat on a machine that is away waits, shows the label and goes when the machine answers', async (t) => {
  const w = setup(t);
  w.own.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 3, folder: null });
  const svc = w.live.remoteSend();
  assert.equal(svc, w.live.remoteSend(), 'one service for every window');
  assert.deepEqual(await svc.send('c1', { id: KEY, text: 'hi', attachments: [], opts: {} }, 5), { action: 'queued', id: KEY });
  assert.equal(w.queues.get('c1')![0].waitingFor, 'host');
  assert.deepEqual(await svc.send('local', { text: 'x' }, 5), null);
  await w.comeBack();
  assert.deepEqual(w.sent, [['c1', { text: 'hi' }, KEY]]);
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
  // the registry changing with nothing kept is quiet
  w.opts().onChange({ machines: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.sent.length, 1);
});

test('a message for a chat on a machine goes after the mirror of chats says it listens there (#3525)', async (t) => {
  const w = setup(t);
  // the sessions are up: the mirror of chats follows the chat, and its subscribe is answered before the message goes
  w.live.acpHost = { items: { append: () => undefined, readAsync: async () => [] }, emitEvent: () => undefined };
  const order: string[] = [];
  const on = () => () => undefined;
  Object.assign(w.host, {
    events: { onPatch: on, onFrame: on, onResync: on, onInflight: on },
    subscribe: async () => (order.push('subscribe'), { snapshot: { rev: 0, items: [] }, patches: null, generation: 'g', inflight: [] }),
  });
  const send = w.host.send;
  w.host.send = async (...a: [string, any, any]) => (order.push('send'), send(...a));
  w.own.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  const svc = w.live.remoteSend();
  await svc.send('c1', { id: KEY, text: 'hi', attachments: [], opts: {} }, 5);
  await w.comeBack();
  assert.deepEqual(w.sent, [['c1', { text: 'hi' }, KEY]]);
  assert.deepEqual(order.slice(0, 2), ['subscribe', 'send']);
});

test('the ownership file is read again each time: a chat moved by another process is seen at once', async (t) => {
  const w = setup(t);
  const svc = w.live.remoteSend();
  assert.equal(svc.owns('c1'), false);
  const other = new OwnershipStore(path.join(w.dir, 'host-ownership.json'));
  other.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  assert.equal(svc.owns('c1'), true);
});

test('a failure to resume is reported, not thrown out of the registry’s change event', async (t) => {
  const w = setup(t);
  const svc = w.live.remoteSend();
  fs.writeFileSync(path.join(w.dir, 'host-outbox'), 'a file where the folder goes');
  w.handlers.get('host:machines')({});
  await assert.doesNotReject(async () => {
    w.opts().onChange({ machines: [] });
    await new Promise((r) => setImmediate(r));
  });
  assert.ok(svc);
});

test('remoteSendFor without a window set and without deps keeps working with its defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = remoteSendFor({
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => null, row: () => undefined, onRowChange: () => () => undefined }),
    state: () => ({ get: () => ({ queue: [] }), patch: () => undefined }),
    tray: (i: any) => i,
    report: () => undefined,
  });
  assert.equal(make().owns('c1'), false);
});

test('a message that cannot be kept is reported through the ignored-error log', async (t) => {
  const w = setup(t);
  w.own.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  const svc = w.live.remoteSend();
  fs.writeFileSync(path.join(w.dir, 'host-outbox'), 'a file where the folder goes');
  const receipt = await svc.send('c1', { id: KEY, text: 'x', attachments: [], opts: {} }, 5);
  assert.equal(receipt.action, 'failed');
});

test('a chat continued back to this Mac: host:continue hands what was kept to the controller through the local Host', async (t) => {
  const w = setup(t);
  w.own.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  const svc = w.live.remoteSend();
  await svc.send('c1', { id: KEY, text: 'kept', attachments: [], opts: {} }, 5);
  const delivered: any[] = [];
  w.live.host = {
    send: async (chatId: string, item: any, opts: any) => (delivered.push([chatId, item.text, opts]), { action: 'started', id: 'l' }),
  };
  w.live.hostContinue = async () => {
    w.own.set('c1', { hostId: 'local', ownerHostId: 'local', epoch: 2, folder: null });
    return { hostId: 'local', epoch: 2 };
  };
  const r = await w.handlers.get('host:continue')({}, { chatId: 'c1', targetHostId: 'local', cwd: '/srv' });
  assert.equal(r.value.hostId, 'local');
  assert.deepEqual(delivered, [['c1', 'kept', { waitForDelivery: true }]]);
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('an unpackaged build takes MOPILOT_HOST_APPROVAL_MS as the approval timeout; a packaged one, a bad value or none keeps the default', () => {
  assert.equal(devApprovalMs({ MOPILOT_HOST_APPROVAL_MS: '1500' }, false), 1500);
  assert.equal(devApprovalMs({ MOPILOT_HOST_APPROVAL_MS: '1500' }, true), undefined);
  for (const bad of [undefined, '', 'soon', '0', '-5', '1.5'])
    assert.equal(devApprovalMs({ MOPILOT_HOST_APPROVAL_MS: bad }, false), undefined);
});

test('the timeout given to remoteSendFor counts: three unanswered periods pause the run', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  const paused: string[] = [];
  const stopped: string[] = [];
  const svc = remoteSendFor({
    dir,
    allowed: () => true,
    machines: () => ({
      hostFor: () => ({ stop: async (id: string) => void stopped.push(id) }),
      row: () => undefined,
      onRowChange: () => () => undefined,
    }),
    state: () => ({ get: () => ({ queue: [] }), patch: () => undefined }),
    tray: (i: any) => i,
    paused: (id: string) => void paused.push(id),
    approvalMs: 50,
    report: () => undefined,
  })();
  svc.onSessionPatch({ chatId: 'c1', patch: { approvals: [{ id: 'card' }] } });
  clock.advance(120);
  assert.deepEqual(paused, []);
  clock.advance(40);
  assert.deepEqual(paused, ['c1']);
  assert.deepEqual(stopped, ['c1'], 'the machine is told to stop the run');
});

test('a Host whose engine keeps the clock (approvals2, host.unattended on) is not timed by the app; an older one still is', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  for (const [speaks, flag, paused] of [
    [true, true, 0],
    [false, true, 1],
    [true, false, 1],
  ] as const) {
    const pausedChats: string[] = [];
    const svc = remoteSendFor({
      dir,
      allowed: () => true,
      machines: () => ({
        hostFor: () => ({ stop: async () => undefined, speaks: (f: string) => speaks && f === 'approvals2' }),
        row: () => undefined,
        onRowChange: () => () => undefined,
      }),
      state: () => ({ get: () => ({ queue: [] }), patch: () => undefined }),
      tray: (i: any) => i,
      paused: (id: string) => void pausedChats.push(id),
      approvalMs: 50,
      unattended: () => flag,
      report: () => undefined,
    })();
    svc.onSessionPatch({ chatId: 'c1', patch: { approvals: [{ id: 'card' }] } });
    clock.advance(200);
    assert.equal(pausedChats.length, paused, `speaks ${speaks}, flag ${flag}`);
    svc.dispose();
  }
});

test('a Host that says it handed the chat to another machine: the side map follows, and the kept message goes to the new owner under the new epoch (B2)', async (t) => {
  installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  store.set('c1', { hostId: 'a', ownerHostId: 'a', epoch: 1, folder: '/srv/a' });
  const reports: Error[] = [];
  const sent: [string, string][] = [];
  const machine = (id: string, fail?: any) => ({
    state: () => 'online',
    onState: () => () => undefined,
    connect: async () => undefined,
    send: async (_: string, item: any) => {
      if (fail) throw fail;
      sent.push([id, item.text]);
    },
  });
  const released = (details: any) => Object.assign(new Error('This chat was handed to another host.'), { code: 'chat_released', details });
  const otherMachines = new Map<string, ReturnType<typeof machine>>();
  const otherMachine = (id: string) => {
    if (!otherMachines.has(id)) otherMachines.set(id, machine(id));
    return otherMachines.get(id);
  };
  let sourceId = 'a';
  let source: any = machine('a', released({ targetHostId: 'b', epoch: 2 }));
  const svc = remoteSendFor({
    dir,
    allowed: () => true,
    machines: () => ({
      hostFor: (id: string) => (id === sourceId ? source : otherMachine(id)),
      row: () => ({ status: 'online' }),
      onRowChange: () => () => undefined,
    }),
    state: () => ({ get: () => ({ queue: [] }), patch: () => undefined }),
    tray: (i: any) => i,
    report: (e: Error) => void reports.push(e),
  })();
  const item = (n: number, text: string) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, text, attachments: [], opts: {} });
  await svc.send('c1', item(1, 'kept'), 1);
  await new Promise((r) => setImmediate(r));
  store.refresh();
  assert.deepEqual([store.get('c1').ownerHostId, store.get('c1').epoch], ['b', 2]);
  assert.deepEqual(sent, [['b', 'kept']]);
  // an answer that names no machine, a bad epoch, or an epoch the map already has changes nothing and is reported
  for (const details of [undefined, { targetHostId: 7, epoch: 3 }, { targetHostId: 'c', epoch: 1.5 }, { targetHostId: 'c', epoch: 2 }]) {
    sourceId = 'b';
    source = machine('b', released(details));
    await svc.send('c1', item(2, 'again'), 1);
    store.refresh();
    assert.deepEqual([store.get('c1').ownerHostId, store.get('c1').epoch], ['b', 2]);
  }
  assert.equal(reports.length, 4);
  // the chat came back to this Mac: what waited goes to the local controller (nothing is sent to a machine)
  store.set('c2', { hostId: 'a', ownerHostId: 'a', epoch: 1, folder: null });
  sourceId = 'a';
  source = machine('a', released({ targetHostId: 'local', epoch: 2 }));
  const before = sent.length;
  await svc.send('c2', item(3, 'home'), 1);
  store.refresh();
  assert.deepEqual([store.get('c2').ownerHostId, store.get('c2').epoch], ['local', 2]);
  assert.equal(sent.length, before);
});

test('windowless remote sends read the matching persisted chat pick and tolerate an unrecorded chat', async (t) => {
  const w = setup(t);
  const id = 'acp:host-claude:choice';
  const selection = { hostId: 'box', harness: 'claude', model: 'on-host', effort: 'high' };
  const permission = { hostId: 'box', harness: 'claude', value: 'read-only' };
  const permits: any[] = [];
  w.host.permit = async (p: any) => void permits.push(p);
  w.live.controller.ref = () => ({ kind: 'acp:host-claude' });
  w.live.chats = {
    get: (chatId: string) => (chatId === id ? { meta: { config: { hostSelection: selection, hostPermission: permission } } } : undefined),
  };
  w.own.set(id, { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  const sender = w.live.remoteSend();
  await w.comeBack();
  await sender.send(id, { id: KEY, text: 'headless', attachments: [], opts: {} });
  assert.deepEqual(w.sent[0][1], { text: 'headless', model: 'on-host', effort: 'high', lendAs: 'claude' });
  assert.deepEqual(permits, [{ chatId: id, value: 'read-only' }]);
  w.own.set('acp:host-claude:unknown', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null });
  await sender.send('acp:host-claude:unknown', { text: 'plain', attachments: [], opts: {} });
  assert.equal(w.sent.at(-1)[1].model, undefined);
});
