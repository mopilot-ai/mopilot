// The chat index inside main's machines service (electron/host/machines.cjs) and its IPC lists (electron/app/ipc/hostLists.cjs): the service follows an online machine's chats when something listens, answers `chatIndex()` with its rows, and ends with the service; the lists are empty while Host access is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { registerHostLists } = require('../electron/app/ipc/hostLists.cjs');
const S = require('../shared/host/schema.mjs');

function world(t: any, allowed: () => boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-chats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = async () => ({ harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: {} });
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
  let told = 0;
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed,
    watch: () => undefined,
    registry,
    installer: {},
    pool: { get: () => ({ acquire: () => ({ socketPath: '/h/host.sock', ready: Promise.resolve(true), release: () => undefined }) }) },
    call: status,
    session: async () => ({
      close: () => undefined,
      call: async (method: string) =>
        method === 'host.hello'
          ? { ...S.helloParams(), capabilities: {}, moved: [] }
          : method === 'host.chats'
            ? { chats: [{ chatId: 'c1', title: 'one', updatedAt: 5, rev: 1 }], at: 0, generation: 'g' }
            : { watching: true, at: 0, generation: 'g' },
    }),
    chats: { onChange: () => void told++ },
  });
  t.after(() => m.dispose());
  return { m, registry, told: () => told };
}

test('a machines service with a listener follows an online machine, answers its rows, and stops with the service', async (t) => {
  const w = world(t, () => true);
  assert.deepEqual(w.m.chatIndex(), [], 'nothing is read before the registry says the machine is online');
  await w.registry.check();
  await waitFor(() => w.m.chatIndex()[0]?.state === 'ready', 'the machine’s chats');
  assert.deepEqual(
    w.m.chatIndex().map((e: any) => [e.machineId, e.rows.map((r: any) => r.chatId)]),
    [['ssh:box', ['c1']]],
  );
  await waitFor(() => w.told() > 0, 'the listener to be told');
  w.m.dispose();
  assert.deepEqual(w.m.chatIndex(), [], 'a disposed service holds nothing');
});

test('the lists the windows read are empty while Host access is closed and the service’s own when it is open', () => {
  const handlers = new Map<string, () => unknown>();
  let open = false;
  registerHostLists({
    ipcMain: { handle: (c: string, fn: () => unknown) => handlers.set(c, fn) },
    allowed: () => open,
    service: () => ({ list: () => ({ machines: ['m'] }), chatIndex: () => ['rows'] }),
  });
  assert.deepEqual([handlers.get('host:machines')!(), handlers.get('host:chatIndex')!()], [{ machines: [], resolved: true }, []]);
  open = true;
  assert.deepEqual([handlers.get('host:machines')!(), handlers.get('host:chatIndex')!()], [{ machines: ['m'] }, ['rows']]);
});
