// Folder IPC keeps repository identity and diff options distinct when routing to a machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { registerHostFolders } = require('../electron/app/ipc/hostFolders.cjs');

test('a re-paired machine cannot inherit an earlier registration’s repository answer', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-host-ipc-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let owner: { hostKey: string; status: string } | undefined = { hostKey: 'first', status: 'online' };
  const old = deferred<string>();
  const probes: unknown[][] = [];
  const handlers = new Map<string, (id: string, args?: unknown) => Promise<unknown>>();
  registerHostFolders({
    handle: (channel: string, handler: (id: string, args?: unknown) => Promise<unknown>) => handlers.set(channel, handler),
    app: { getPath: () => directory },
    machine: (id: string) => (id === 'box' ? owner : undefined),
    folders: () => ({
      branches: (id: string, query: { path: string }) => ({ machine: id, path: query.path }),
      repository: (id: string, query: { path: string }) => {
        probes.push([id, query.path]);
        if (owner?.hostKey === 'first') return old.promise;
        return 'git@github.com:owner/replacement.git';
      },
    }),
  });
  const read = handlers.get('host:sidebarRepository')!;
  assert.equal(await read('unknown', { path: '/app' }), null);
  assert.equal(await read('box'), null);
  assert.equal(await read('box', { path: '' }), null);
  const pending = read('box', { path: '/app' });
  await Promise.resolve();
  owner = { hostKey: 'second', status: 'online' };
  assert.equal(await read('box', { path: '/app' }), 'github.com/owner/replacement');
  const branches = handlers.get('host:gitBranches')!;
  assert.throws(() => branches('box', { path: '/app', expectedHostKey: 'first' }), { code: 'machine_changed' });
  assert.deepEqual(await branches('box', { path: '/app', expectedHostKey: 'second' }), { machine: 'box', path: '/app' });
  assert.deepEqual(await branches(null as unknown as string), { machine: '', path: undefined });
  old.resolve('https://github.com/owner/old');
  assert.equal(await pending, null);
  assert.equal(await read('box', { path: '/app', fresh: true, expectedHostKey: 'first' }), null);
  assert.equal(await read('box', { path: '/app', fresh: true, expectedHostKey: 'second' }), 'github.com/owner/replacement');
  owner = { hostKey: 'second', status: 'offline' };
  assert.equal(await read('box', { path: '/app' }), 'github.com/owner/replacement');
  assert.equal(await read('box', { path: '/another' }), null);
  owner = { hostKey: '', status: 'offline' };
  assert.equal(await read('box', { path: '/app', fresh: true }), null);
  owner = undefined;
  assert.equal(await read('box', { path: '/app' }), null);
  assert.deepEqual(probes, [
    ['box', '/app'],
    ['box', '/app'],
    ['box', '/app'],
  ]);
});

const { createHostFolders } = require('../electron/host/folders.cjs');

function hostInspection(reply: unknown) {
  const calls: Record<string, unknown>[] = [];
  let closed = false;
  const folders = createHostFolders({
    allowed: () => true,
    open: async (hostId: string) => ({
      call: (method: string, params: unknown) => (calls.push({ hostId, method, params }), reply),
      close: () => {
        closed = true;
      },
    }),
  });
  return { folders, calls, isClosed: () => closed };
}

test('Changes reads both diff scopes on a registered machine', async () => {
  const patch = { isRepo: true, patch: 'patch', truncated: false, unreadable: false };
  const { folders, calls } = hostInspection(patch);
  const handlers = new Map<string, (id: string, args: unknown) => Promise<unknown>>();
  registerHostFolders({
    handle: (channel: string, handler: (id: string, args: unknown) => Promise<unknown>) => handlers.set(channel, handler),
    folders: () => folders,
    machine: () => ({ hostKey: 'paired', status: 'online' }),
  });
  const diff = handlers.get('host:gitDiff')!;
  for (const scope of ['branch', 'uncommitted']) {
    assert.deepEqual(await diff('box', { path: '/app', scope }), patch);
  }
  assert.deepEqual(calls, [
    { hostId: 'box', method: 'git.diff', params: { path: '/app', scope: 'branch' } },
    { hostId: 'box', method: 'git.diff', params: { path: '/app', scope: 'uncommitted' } },
  ]);
});

test('repository identity reads only the requested machine and rejects a malformed answer', async () => {
  const origin = 'git@github.com:owner/repo.git';
  for (const [reply, expected] of [
    [{ isRepo: true, remote: origin }, origin],
    [{ isRepo: false }, undefined],
    [{ isRepo: true, remote: null }, undefined],
    [{ sidebar: true, origin }, origin],
    [{ sidebar: true, origin: null }, null],
    [{ sidebar: true }, undefined],
  ]) {
    const w = hostInspection(reply);
    assert.equal(await w.folders.repository('box', { path: '/remote/checkout' }), expected);
    assert.equal(w.calls[0].method, 'git.inspect');
    assert.deepEqual(w.calls[0].params, { path: '/remote/checkout', sidebar: true });
    assert.equal(w.isClosed(), true);
  }
  for (const reply of [null, { isRepo: true }, { isRepo: true, remote: 3 }, { sidebar: true, origin: 3 }]) {
    const w = hostInspection(reply);
    await assert.rejects(w.folders.repository('other', { path: '/remote/checkout' }), /cannot read/);
  }
});

test('the scoped start keeps the selected credential with the durable first-message record', async () => {
  const { createMachineChatStart } = require('../electron/host/machineChatStart.cjs');
  const begun: unknown[][] = [];
  const service = createMachineChatStart({
    row: () => ({ name: 'Build box', hostKey: 'paired', harnesses: [{ id: 'codex', detected: true, signedIn: true }] }),
    apiKeys: { hasFor: () => false },
    orgAccess: { covers: () => false },
    bind: () => undefined,
    begin: (...args: unknown[]) => begun.push(args),
    follow: () => undefined,
  });
  const chatId = 'acp:host-codex:example';
  const credential = { source: 'own', login: 'work' };
  await service.start({ chatId, hostId: 'box', folder: '/srv/app', harness: 'codex', scope: 'paired', credential });
  assert.deepEqual(begun, [[chatId, { harness: 'codex', projectId: null, credential, scope: 'paired' }]]);
});
