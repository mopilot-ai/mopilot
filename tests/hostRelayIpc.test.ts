// The tool relay in the Host IPC layer (electron/app/ipc/host.cjs `onRemoteHost`; package 2.6): a new connection to a machine gets the app's browser tools announced through the app's registry, and the relay ends with the connection; with no registry (the tools are not up) nothing is announced and nothing breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick } from './support/host-wire-kit.ts';
import { fakeHost, setup } from './support/host/relayIpcKit.ts';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

test('a new connection gets the app’s browser tools, only those, and the relay is taken off with the connection', async () => {
  const registry = {
    list: () => [
      { name: 'browser_read', description: 'Read', inputSchema: { type: 'object', properties: {} }, policy: 'observe' },
      { name: 'chrome_click', description: 'Click', inputSchema: { type: 'object', properties: {} }, policy: 'act' },
      { name: 'desktop_screenshot', description: 'Look', inputSchema: { type: 'object', properties: {} }, policy: 'observe' },
    ],
    invoke: async () => ({ ok: true, content: [] }),
  };
  const opts = setup({ capabilities: registry });
  const { host, sent, events } = fakeHost();
  const end = opts.onRemoteHost('ssh:box', host);
  await tick();
  assert.equal(sent[0][0], 'host.toolsSync');
  assert.deepEqual(
    sent[0][1].tools.map((t: any) => t.name),
    ['browser_read'],
  );
  assert.equal(events.size, 1);
  end();
  assert.equal(events.size, 0);
});

test('a machine with a desktop is announced the desktop tools too, and told again when it gains one', async () => {
  const registry = {
    list: () => [
      { name: 'browser_read', description: 'Read', inputSchema: { type: 'object', properties: {} }, policy: 'observe' },
      { name: 'desktop_screenshot', description: 'Look', inputSchema: { type: 'object', properties: {} }, policy: 'observe' },
    ],
    invoke: async () => ({ ok: true, content: [] }),
  };
  const rows: Record<string, any> = { 'ssh:with': { capabilities: { desktop: true } }, 'ssh:later': { capabilities: { desktop: false } } };
  let changed = () => {};
  const handlers = new Map<string, any>();
  let opts: any;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined, live: { capabilities: registry } },
    {
      create: (o: any) => (
        (opts = o),
        {
          list: () => ({ machines: [], resolved: true }),
          row: (id: string) => rows[id],
          onRowChange: (fn: () => void) => ((changed = fn), () => undefined),
        }
      ),
      createFolders: () => ({}),
      allowed: () => true,
    },
  );
  handlers.get('host:machines')!({});
  const names = (sent: any[], i: number) => sent[i][1].tools.map((t: any) => t.name);
  const a = fakeHost();
  opts.onRemoteHost('ssh:with', a.host)();
  await tick();
  assert.deepEqual(names(a.sent, 0), ['browser_read', 'desktop_screenshot']);
  const b = fakeHost();
  const end = opts.onRemoteHost('ssh:later', b.host);
  await tick();
  assert.deepEqual(names(b.sent, 0), ['browser_read']);
  rows['ssh:later'] = { capabilities: { desktop: true } };
  changed();
  await tick();
  assert.deepEqual(names(b.sent, 1), ['browser_read', 'desktop_screenshot'], 'told again when the machine gains a desktop');
  end();
});

test('B: before the tools are up there is no registry: the connection is left alone and ending it does nothing', async () => {
  const opts = setup({});
  const { host, sent, events } = fakeHost();
  const end = opts.onRemoteHost('ssh:box', host);
  await tick();
  assert.deepEqual(sent, []);
  assert.equal(events.size, 0);
  assert.doesNotThrow(() => end());
});

test('A Host’s call runs only for a chat the ownership file puts on that machine: not a chat of this Mac, not another machine’s, and not while ownership is unknown', async () => {
  const invoked: unknown[][] = [];
  const registry = {
    list: () => [{ name: 'browser_read', description: 'Read', inputSchema: { type: 'object', properties: {} }, policy: 'observe' }],
    invoke: async (...args: unknown[]) => (invoked.push(args), { ok: true, content: [] }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ipc-'));
  const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  store.set('mine', { hostId: 'ssh:box', ownerHostId: 'ssh:box', epoch: 1 });
  store.set('theirs', { hostId: 'ssh:other', ownerHostId: 'ssh:other', epoch: 1 });
  const opts = setup({ capabilities: registry }, dir);
  const { host, events } = fakeHost();
  opts.onRemoteHost('ssh:box', host);
  const call = (chatId: string) =>
    [...events].forEach((fn) =>
      fn({ event: 'tool', chatId, segmentId: 's', callId: `k-${chatId}`, name: 'browser_read', arguments: {}, epoch: 1 }),
    );
  for (const chatId of ['theirs', 'unknown', 'mine']) call(chatId);
  await tick();
  assert.deepEqual(
    invoked.map((a) => a[0]),
    ['mine'],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B: a chat with no ownership record is this Mac’s own, and a Host’s call for it runs nothing', async () => {
  const invoked: unknown[] = [];
  const opts = setup({
    capabilities: {
      list: () => [{ name: 'browser_read', policy: 'observe' }],
      invoke: async (...a: unknown[]) => (invoked.push(a), { ok: true, content: [] }),
    },
  });
  const { host, events } = fakeHost();
  opts.onRemoteHost('ssh:box', host);
  [...events].forEach((fn) =>
    fn({ event: 'tool', chatId: 'mine', segmentId: 's', callId: 'k', name: 'browser_read', arguments: {}, epoch: 1 }),
  );
  await tick();
  assert.equal(invoked.length, 0);
});

test('a change of the machine list sweeps the approvals of machines that are gone, and only once the list is read and Host access is on', async () => {
  const swept: string[][] = [];
  const live = { computerUse: { hostDesktop: { approvals: { sweep: (present: Set<string>) => swept.push([...present]) } } } };
  const handlers = new Map<string, any>();
  let opts: any;
  let allowed = true;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined, live },
    {
      create: (o: any) => ((opts = o), { list: () => ({ machines: [], resolved: true }) }),
      createFolders: () => ({}),
      allowed: () => allowed,
    },
  );
  handlers.get('host:machines')!({});
  opts.onChange({ machines: [{ id: 'ssh:a' }, { id: 'ssh:b' }], resolved: true });
  opts.onChange({ machines: [], resolved: false });
  allowed = false;
  opts.onChange({ machines: [], resolved: true });
  assert.deepEqual(swept, [['ssh:a', 'ssh:b']]);
});
