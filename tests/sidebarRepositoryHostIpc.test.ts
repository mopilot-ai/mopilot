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
const { helloParams } = require('../shared/host/schema.mjs');

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

function hostInspection(reply: unknown, branches?: unknown, reads: Record<string, (path: string) => unknown> = {}) {
  const calls: Record<string, unknown>[] = [];
  let closed = false;
  const folders = createHostFolders({
    allowed: () => true,
    open: async (hostId: string) => ({
      call: async (method: string, params: { path: string }) => {
        calls.push({ hostId, method, params });
        if (method === 'host.hello') return helloParams();
        if (reads[method]) return reads[method](params.path);
        return method === 'host.gitBranches' ? branches : reply;
      },
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

test('checkout identity accepts current replies and resolves older Hosts through their branch lookup', async () => {
  const cwd = '/srv/app/src';
  const top = '/srv/app';
  const branch = { isRepo: true, top, sub: 'src', current: 'main', default: null, commits: true, branches: ['main'] };
  for (const [reply, expected] of [
    [{ sidebarCheckout: true, path: top }, top],
    [{ sidebarCheckout: true, path: 'C:\\App' }, 'C:\\App'],
    [{ sidebarCheckout: true, path: null }, null],
    [{ sidebarCheckout: true }, undefined],
    [{ isRepo: false }, undefined],
  ]) {
    const w = hostInspection(reply);
    assert.equal(await w.folders.checkout('box', { path: cwd }), expected);
    assert.deepEqual(w.calls, [{ hostId: 'box', method: 'git.inspect', params: { path: cwd, sidebar: true, checkout: true } }]);
    assert.equal(w.isClosed(), true);
  }
  const share = { 'fs.list': async (path: string) => ({ path, roots: ['/srv'], entries: [] }) };
  for (const reply of [
    { isRepo: true, remote: null },
    { sidebar: true, origin: null },
  ]) {
    const w = hostInspection(reply, branch, share);
    assert.equal(await w.folders.checkout('box', { path: cwd }), top);
    assert.deepEqual(w.calls[2], { hostId: 'box', method: 'host.gitBranches', params: { path: cwd } });
  }
  const nested = '/srv/app.worktrees/team%2fbranch/nested';
  const olderNested = hostInspection({ isRepo: true, remote: null }, { ...branch, top: nested }, share);
  assert.equal(await olderNested.folders.checkout('box', { path: `${nested}/src` }), nested);
  const managed = '/srv/app.worktrees/feature';
  const older = { sidebar: true, origin: null };
  const oldManaged = (text: string, list = share['fs.list']) =>
    hostInspection(
      older,
      { ...branch, top: managed },
      {
        'fs.read': () => ({ kind: 'text', text, size: text.length }),
        'fs.list': list,
      },
    );
  const pointer = 'gitdir: /srv/app/.git/worktrees/feature\n';
  assert.equal(await oldManaged(pointer).folders.checkout('box', { path: managed }), top);
  for (const malformed of ['invalid pointer', 'gitdir: \n', 'gitdir: /srv/app/.git/worktrees/feature\0\n']) {
    assert.equal(await oldManaged(malformed).folders.checkout('box', { path: managed }), undefined);
  }
  assert.equal(await oldManaged('gitdir: /other/.git/worktrees/feature\n').folders.checkout('box', { path: managed }), managed);
  const refuse = async () => {
    throw Object.assign(new Error('outside roots'), { code: 'outside_roots' });
  };
  const timeout = async () => {
    throw Object.assign(new Error('timeout'), { code: 'read_timed_out' });
  };
  assert.equal(await oldManaged(pointer, refuse).folders.checkout('box', { path: managed }), managed);
  assert.equal(await oldManaged(pointer, timeout).folders.checkout('box', { path: managed }), undefined);
  const outside = hostInspection(older, branch, { 'fs.list': refuse });
  assert.equal(await outside.folders.checkout('box', { path: cwd }), null);
  const timedOut = hostInspection(older, branch, {
    'fs.list': async () => {
      throw new Error('timed out');
    },
  });
  assert.equal(await timedOut.folders.checkout('box', { path: cwd }), undefined);
  assert.equal(
    await hostInspection(older, branch, { 'fs.list': () => ({ path: 'relative', entries: [] }) }).folders.checkout('box', { path: cwd }),
    undefined,
  );
  const windowsTop = 'C:\\App.worktrees\\feature';
  const noPointer = hostInspection(
    older,
    { ...branch, top: windowsTop },
    {
      'fs.read': () => ({ kind: 'text', text: pointer, size: pointer.length, truncated: true }),
    },
  );
  assert.equal(await noPointer.folders.checkout('box', { path: windowsTop }), undefined);
  assert.equal(
    await hostInspection(
      older,
      { ...branch, top: managed },
      {
        'fs.read': async () => {
          throw Object.assign(new Error('not a file'), { code: 'not_a_file' });
        },
      },
    ).folders.checkout('box', { path: managed }),
    managed,
  );
  assert.equal(
    await hostInspection(older, { ...branch, top: managed }, { 'fs.read': timeout }).folders.checkout('box', { path: managed }),
    undefined,
  );
  assert.equal(await hostInspection({ sidebar: true }, { isRepo: false }).folders.checkout('box', { path: cwd }), undefined);
  for (const value of ['relative', '/nul\0path', true, []]) {
    await assert.rejects(hostInspection({ sidebarCheckout: true, path: value }).folders.checkout('box', { path: cwd }), /checkout path/);
  }
  await assert.rejects(
    hostInspection({ sidebar: true }, { ...branch, top: 'relative' }).folders.checkout('box', { path: cwd }),
    /checkout path/,
  );
  await assert.rejects(hostInspection(null).folders.checkout('box', { path: cwd }), /checkout path/);
});

test('checkout and origin use independent cached facts for the same remote folder', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-01T00:00:00Z') });
  const dir = mkdtempSync(join(tmpdir(), 'sidebar-checkout-ipc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let machine = { hostKey: 'paired', status: 'online' };
  let checkout: string | null = '/srv/app';
  const pending = deferred<string>();
  const probes: string[] = [];
  const request = { path: '/src/link', checkout: true };
  const handlers = new Map<string, (id: string, query: unknown) => Promise<unknown>>();
  registerHostFolders({
    handle: (name: string, handler: (id: string, query: unknown) => Promise<unknown>) => handlers.set(name, handler),
    app: { getPath: () => dir },
    machine: () => machine,
    folders: () => ({
      checkout: (_id: string, q: { path: string }) => {
        probes.push(q.path);
        if (q.path === '/srv/app.worktrees/notes') return null;
        return q.path.startsWith('/src/reused') ? pending.promise : checkout;
      },
      repository: () => 'https://github.com/org/app',
    }),
  });
  const read = handlers.get('host:sidebarRepository')!;
  assert.equal(await read('box', request), '/srv/app');
  const nonRepo = { path: '/srv/app.worktrees/notes', checkout: true };
  assert.equal(await read('box', nonRepo), nonRepo.path);
  assert.equal(await read('box', { path: request.path }), 'github.com/org/app');
  machine = { hostKey: 'paired', status: 'offline' };
  assert.equal(await read('box', request), '/srv/app');
  assert.equal(await read('box', nonRepo), nonRepo.path);
  machine = { hostKey: 'paired', status: 'online' };
  t.mock.timers.tick(60_000);
  const active = Array.from({ length: 4 }, (_, index) => read('box', { path: `/src/reused-${index}`, checkout: true }));
  const queued = read('box', { path: '/src/queued', checkout: true });
  const cached = read('box', request);
  await Promise.resolve();
  machine = { hostKey: 'new', status: 'online' };
  pending.resolve('/srv/retired');
  assert.deepEqual(await Promise.all([...active, queued]), [null, null, null, null, null]);
  assert.equal(await cached, null);
  assert.equal(probes.includes('/src/queued'), false);
  assert.equal(await read('box', { path: '/src/stale-renderer', checkout: true, expectedHostKey: 'paired' }), null);
  assert.equal(probes.includes('/src/stale-renderer'), false);
  machine = { hostKey: 'new', status: 'offline' };
  assert.equal(await read('box', request), null);
  machine = { hostKey: 'new', status: 'online' };
  assert.equal(await read('box', request), '/srv/app');
  checkout = null;
  t.mock.timers.tick(60_000);
  assert.equal(await read('box', request), request.path, 'a narrower share replaces the old checkout with the working folder');
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
