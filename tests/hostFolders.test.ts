// The app's folder service for remote Hosts (electron/host/folders.cjs): requests validated before a connection is made (I1), answers read defensively (B1), progress only for the attempt that asked and only while access lasts (A3), connections closed however a request ends, and a chat's folder recorded with its Host in the side map (W1, W3).
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../shared/host/schema.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHostFolders } = require('../electron/host/folders.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-folders-')), 'host-ownership.json');
const LISTING = { path: '/home/u', roots: ['/home/u'], entries: [{ name: 'app', path: '/home/u/app', git: true }] };

/** A service over a fake connection: `answer` is the Host's reply per method; `events` are sent while a request is in flight. */
function world(o: { answer?: Record<string, any>; events?: any[]; allowed?: () => boolean; openFails?: Error } = {}) {
  const calls: any[] = [];
  const opened: { closed: number; onEvent: any }[] = [];
  const progress: any[] = [];
  const gate = { fns: [] as ((ok: boolean) => void)[] };
  const store = new OwnershipStore(tmpFile());
  const folders = createHostFolders({
    open: async (hostId: string, onEvent: any) => {
      if (o.openFails) throw o.openFails;
      const rec = { closed: 0, onEvent };
      opened.push(rec);
      return {
        call: async (method: string, params: any, opts: any) => {
          calls.push({ hostId, method, params, opts });
          for (const e of o.events ?? []) onEvent?.(e);
          const reply = o.answer?.[method];
          if (reply instanceof Error) throw reply;
          return typeof reply === 'function' ? reply() : reply;
        },
        close: () => void rec.closed++,
      };
    },
    store,
    onProgress: (p: any) => progress.push(p),
    allowed: o.allowed ?? (() => true),
    watch: (fn: any) => gate.fns.push(fn),
  });
  return { folders, calls, opened, progress, store, gate };
}

test('list asks the machine for a folder and returns what the picker draws; the connection is closed after (A5)', async () => {
  const w = world({ answer: { 'fs.list': LISTING } });
  assert.deepEqual(await w.folders.list('box', { path: '/home/u', hidden: true }), LISTING);
  assert.deepEqual(w.calls[0], {
    hostId: 'box',
    method: 'fs.list',
    params: { path: '/home/u', hidden: true },
    opts: { timeoutMs: 15_000 },
  });
  assert.equal(w.opened[0].closed, 1);
  // no path: the Host starts at its first root
  await w.folders.list('box', {});
  assert.deepEqual(w.calls[1].params, { hidden: false });
});

test('fields this app does not know are dropped from an answer (B3)', async () => {
  const w = world({
    answer: {
      'fs.list': { ...LISTING, extra: 1, entries: [{ ...LISTING.entries[0], size: 9 }] },
      'git.clone': { path: '/p', existed: false, log: 'x' },
    },
  });
  assert.deepEqual(await w.folders.list('box', {}), LISTING);
  assert.deepEqual(await w.folders.clone('box', { key: 'attempt-001', url: 'https://example.com/a.git', dest: '/home/u/a' }), {
    path: '/p',
    existed: false,
  });
});

test('a refusal from the machine reaches the caller with its code, and the connection is still closed (B2)', async () => {
  const w = world({ answer: { 'fs.list': Object.assign(new Error('outside'), { code: 'outside_roots' }) } });
  await assert.rejects(w.folders.list('box', { path: '/etc' }), (e: any) => e.code === 'outside_roots');
  assert.equal(w.opened[0].closed, 1);
});

test('a listing the app cannot read is an invalid answer, never an empty folder (B1)', async () => {
  for (const bad of [
    null,
    'x',
    {},
    { ...LISTING, path: '' },
    { ...LISTING, roots: 'x' },
    { ...LISTING, roots: [1] },
    { ...LISTING, entries: {} },
    { ...LISTING, entries: [null] },
    { ...LISTING, entries: [{ name: 'a', path: '/a', git: 'yes' }] },
    { ...LISTING, entries: [{ name: '', path: '/a', git: true }] },
  ]) {
    const w = world({ answer: { 'fs.list': bad } });
    await assert.rejects(w.folders.list('box', { path: '/home/u' }), (e: any) => e.code === 'invalid' && /cannot read/.test(e.message));
  }
});

test('input is checked before any connection is made: a path with a NUL, a missing machine, this Mac (I1)', async () => {
  const w = world({ answer: { 'fs.list': LISTING } });
  await assert.rejects(w.folders.list('box', { path: '/a\0b' }), /Pick a folder/);
  await assert.rejects(w.folders.list('', { path: '/a' }), (e: any) => e.code === 'invalid');
  await assert.rejects(w.folders.list('local', { path: '/a' }), (e: any) => e.code === 'invalid');
  await assert.rejects(w.folders.clone('box', { key: 'attempt-001', url: '--upload-pack=x', dest: '/a/b' }), /not one Git can clone/);
  // L: user info in an address (a token ends in .git/config and the process list), and a host or user ssh would read as an option
  for (const url of [
    'https://user:token@github.com/a/b.git',
    'https://token@github.com/a/b.git',
    'ssh://-oProxyCommand=x@host/a/b',
    'ssh://user:pw@host/a/b',
    'ssh://host;rm/a/b',
    'ssh://-host/a/b',
    'https://-host/a/b',
    'git@-host:a/b',
    'git@ho st:a/b',
    'https://',
    'https://host',
    'file:///tmp/x',
    'ext::sh -c x',
  ])
    await assert.rejects(w.folders.clone('box', { key: 'attempt-001', url, dest: '/a/b' }), /not one Git can clone/, url);
  assert.equal(w.opened.length, 0);
  for (const url of [
    'https://github.com/a/b.git',
    'https://git.example.com:8443/a/b',
    'ssh://git@github.com/a/b',
    'ssh://host.example/a/b',
    'ssh://git@h.example:22/a/b',
    'git@github.com:a/b.git',
  ])
    assert.equal(parseParams('git.clone', { key: 'attempt-001', url, dest: '/a/b' }).url, url);
  await assert.rejects(w.folders.worktree('box', { key: 'attempt-001', repo: '/r', branch: '-x' }), /branch name/);
});

test('a machine that cannot be reached fails the call with its reason (B2)', async () => {
  const w = world({ openFails: Object.assign(new Error('Could not reach the machine over SSH.'), { code: 'host_unreachable' }) });
  await assert.rejects(w.folders.list('box', {}), /Could not reach/);
});

test('clone waits as long as the repository needs, relays only its own progress, and returns the folder (A1)', async () => {
  const w = world({
    answer: { 'git.clone': { path: '/home/u/app', existed: false } },
    events: [
      { event: 'progress', key: 'attempt-001', phase: 'Receiving objects', percent: 45 },
      { event: 'progress', key: 'someone-else', phase: 'Receiving objects', percent: 99 },
      { event: 'progress', key: 'attempt-001', phase: '', percent: 50 },
      { event: 'progress', key: 'attempt-001', phase: 'Resolving deltas', percent: 'x' },
      { event: 'other', key: 'attempt-001', phase: 'x', percent: 1 },
    ],
  });
  const q = { key: 'attempt-001', url: 'https://example.com/a/app.git', dest: '/home/u/app' };
  assert.deepEqual(await w.folders.clone('box', q), { path: '/home/u/app', existed: false });
  assert.equal(w.calls[0].method, 'git.clone');
  assert.equal(w.calls[0].opts.timeoutMs, 0);
  assert.deepEqual(w.progress, [{ hostId: 'box', key: 'attempt-001', phase: 'Receiving objects', percent: 45 }]);
  assert.equal(w.opened[0].closed, 1);
});

test('progress stops when Host access is lost, and the open connections are closed (A3)', async () => {
  let allowed = true;
  let release!: (v: unknown) => void;
  const w = world({
    allowed: () => allowed,
    answer: { 'git.clone': () => new Promise((r) => (release = r)) },
  });
  const p = w.folders.clone('box', { key: 'attempt-001', url: 'https://example.com/a/app.git', dest: '/home/u/app' });
  await new Promise((r) => setImmediate(r));
  w.opened[0].onEvent({ event: 'progress', key: 'attempt-001', phase: 'Receiving objects', percent: 10 });
  allowed = false;
  for (const fn of w.gate.fns) fn(false);
  assert.equal(w.opened[0].closed, 1, 'the connection ended with the access');
  w.opened[0].onEvent({ event: 'progress', key: 'attempt-001', phase: 'Receiving objects', percent: 20 });
  release({ path: '/home/u/app', existed: false });
  await p;
  assert.deepEqual(
    w.progress.map((x: any) => x.percent),
    [10],
  );
  // access coming back changes nothing for what was closed
  for (const fn of w.gate.fns) fn(true);
});

test('a connection made after access was lost is closed and runs nothing (A3, A4)', async () => {
  let allowed = true;
  const w = world({ allowed: () => allowed, answer: { 'fs.list': LISTING } });
  const inner = w.folders.list('box', {});
  allowed = false;
  await assert.rejects(inner, (e: any) => e.code === 'disposed');
  assert.equal(w.opened[0].closed, 1);
  assert.equal(w.calls.length, 0);
});

test('a clone or worktree answer the app cannot read is invalid, not a path to start in (B1)', async () => {
  for (const bad of [null, {}, { path: '', existed: true }, { path: '/p' }, { path: '/p', existed: 'no' }]) {
    const w = world({ answer: { 'git.clone': bad, 'git.worktree': bad } });
    await assert.rejects(
      w.folders.clone('box', { key: 'attempt-001', url: 'https://example.com/a.git', dest: '/home/u/a' }),
      (e: any) => e.code === 'invalid',
    );
    await assert.rejects(
      w.folders.worktree('box', { key: 'attempt-002', repo: '/home/u/a', branch: 'feature/x' }),
      (e: any) => e.code === 'invalid',
    );
  }
});

test('worktree returns the folder the machine made', async () => {
  const w = world({ answer: { 'git.worktree': { path: '/home/u/a.worktrees/feature%2fx', existed: true } } });
  assert.deepEqual(await w.folders.worktree('box', { key: 'attempt-002', repo: '/home/u/a', branch: 'feature/x' }), {
    path: '/home/u/a.worktrees/feature%2fx',
    existed: true,
  });
  assert.equal(w.calls[0].opts.timeoutMs, 120_000);
});

test('dispose closes what is open and refuses new requests (A3, A5)', async () => {
  const w = world({ answer: { 'fs.list': LISTING } });
  w.folders.dispose();
  await assert.rejects(w.folders.list('box', {}), (e: any) => e.code === 'disposed');
});

test('bind records the chat folder with its Host; a chat nobody claimed is owned by it, one handed over keeps its owner and epoch (W1)', () => {
  const w = world();
  w.folders.bind('c1', { hostId: 'box', folder: '/home/u/app' });
  assert.deepEqual(w.store.get('c1'), { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/home/u/app' });
  w.store.set('c2', { hostId: 'lab', ownerHostId: 'box', epoch: 3, folder: '/old' });
  w.folders.bind('c2', { hostId: 'lab', folder: '/home/u/new' });
  assert.deepEqual(w.store.get('c2'), { hostId: 'lab', ownerHostId: 'box', epoch: 3, folder: '/home/u/new' });
  // two chats on one Host keep each other's records, ids with delimiters included
  w.folders.bind('a|b', { hostId: 'box', folder: '/x' });
  w.folders.bind('__proto__', { hostId: 'box', folder: '/y' });
  assert.equal(w.store.get('c1').folder, '/home/u/app');
  assert.equal(w.store.get('a|b').folder, '/x');
  assert.equal(w.store.get('__proto__').folder, '/y');
});

test('bind refuses a missing folder, leaves this Mac without a record, and reports a side map it cannot write (W3)', () => {
  const w = world();
  assert.throws(
    () => w.folders.bind('c1', { hostId: 'box', folder: '' }),
    (e: any) => e.code === 'invalid',
  );
  w.folders.bind('c1', { hostId: 'local', folder: '/home/me/app' });
  assert.equal(w.store.get('c1').hostId, 'local');
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  fs.writeFileSync(`${file}.bak`, '{not json either');
  const broken = createHostFolders({ open: async () => undefined, store: new OwnershipStore(file) });
  assert.throws(() => broken.bind('c1', { hostId: 'box', folder: '/a' }), /unreadable/);
});

test('the defaults let a service run without a progress listener, a gate or a watcher', async () => {
  const folders = createHostFolders({
    open: async (_id: string, onEvent: any) => ({
      call: async () => (
        onEvent({ event: 'progress', key: 'attempt-001', phase: 'Receiving objects', percent: 5 }), { path: '/p', existed: false }
      ),
      close: () => undefined,
    }),
    store: new OwnershipStore(tmpFile()),
  });
  assert.deepEqual(await folders.clone('box', { key: 'attempt-001', url: 'https://example.com/a.git', dest: '/home/u/a' }), {
    path: '/p',
    existed: false,
  });
});

test('status asks the machine for a repository’s branch and changes, reads the answer defensively, and says to update an older Host', async () => {
  const good = {
    isRepo: true,
    branch: 'main',
    head: 'a'.repeat(40),
    remote: 'https://example.com/o/r.git',
    files: [
      { path: 'a.ts', added: 3, removed: 1 },
      { path: 'img.png', added: 0, removed: 0, binary: true },
      { path: 'new.ts', added: 0, removed: 0, untracked: true },
    ],
    truncated: false,
  };
  const w = world({ answer: { 'git.status': good } });
  // a Host that sends no upstream (an older one) is read as having none
  assert.deepEqual(await w.folders.status('box', { path: '/srv/app' }), { ...good, upstream: null, unreadable: false });
  assert.deepEqual(w.calls[0], { hostId: 'box', method: 'git.status', params: { path: '/srv/app' }, opts: { timeoutMs: 45_000 } });
  assert.equal(w.opened[0].closed, 1);
  // not a repository, and the optional facts left out
  assert.deepEqual(await world({ answer: { 'git.status': { isRepo: false } } }).folders.status('box', { path: '/srv' }), { isRepo: false });
  const bare = await world({
    answer: { 'git.status': { isRepo: true, files: [], unreadable: true, truncated: true, branch: '', head: 7 } },
  }).folders.status('box', { path: '/srv' });
  assert.deepEqual(bare, {
    isRepo: true,
    branch: null,
    head: null,
    remote: null,
    upstream: null,
    files: [],
    truncated: true,
    unreadable: true,
  });
  // an answer that is not a status is refused, not drawn
  const bad = (reply: any) =>
    assert.rejects(world({ answer: { 'git.status': reply } }).folders.status('box', { path: '/srv' }), /cannot read/);
  await bad(null);
  await bad({ isRepo: 'yes' });
  await bad({ isRepo: true, files: 'x' });
  await bad({ isRepo: true, files: new Array(5001).fill({ path: 'a', added: 0, removed: 0 }) });
  await bad({ isRepo: true, files: [{ path: '', added: 0, removed: 0 }] });
  await bad({ isRepo: true, files: [{ path: 'a', added: -1, removed: 0 }] });
  await bad({ isRepo: true, files: [{ path: 'a', added: 1.5, removed: 0 }] });
  await bad({ isRepo: true, files: [{ path: 'a'.repeat(1001), added: 0, removed: 0 }] });
  // an older Host answers Unknown method: the app says to update it; any other refusal passes with its code
  await assert.rejects(
    world({ answer: { 'git.status': new Error('Unknown method git.status.') } }).folders.status('box', { path: '/srv' }),
    (e: any) => e.code === 'host_outdated' && /Update the Host/.test(e.message),
  );
  const refusal = Object.assign(new Error('That folder is outside what this host shares.'), { code: 'outside_roots' });
  await assert.rejects(
    world({ answer: { 'git.status': refusal } }).folders.status('box', { path: '/srv' }),
    (e: any) => e.code === 'outside_roots',
  );
  // a request without a folder is refused before any connection is made (I1)
  const none = world();
  await assert.rejects(none.folders.status('box', {}));
  assert.equal(none.opened.length, 0);
});

test('tree and read ask the machine for a folder’s entries and a file’s start, read the answers defensively, and say to update an older Host', async () => {
  const tree = {
    path: '/srv/app',
    entries: [
      { name: 'src', isDirectory: true },
      { name: 'a.ts', isDirectory: false },
    ],
    truncated: false,
  };
  const w = world({ answer: { 'fs.tree': tree, 'fs.read': { kind: 'text', text: 'hi', size: 2, truncated: false } } });
  assert.deepEqual(await w.folders.tree('box', { path: '/srv/app' }), tree);
  assert.deepEqual(w.calls[0], { hostId: 'box', method: 'fs.tree', params: { path: '/srv/app' }, opts: { timeoutMs: 45_000 } });
  assert.deepEqual(await w.folders.read('box', { path: '/srv/app/a.ts', limit: 100 }), {
    kind: 'text',
    text: 'hi',
    size: 2,
    truncated: false,
  });
  assert.deepEqual(w.calls[1].params, { path: '/srv/app/a.ts', limit: 100 });
  assert.equal(
    w.opened.every((o) => o.closed === 1),
    true,
  );
  assert.deepEqual(
    await world({ answer: { 'fs.tree': { path: '/x', entries: [], truncated: true } } }).folders.tree('box', { path: '/x' }),
    {
      path: '/x',
      entries: [],
      truncated: true,
    },
  );
  assert.deepEqual(await world({ answer: { 'fs.read': { kind: 'binary', size: 9 } } }).folders.read('box', { path: '/x' }), {
    kind: 'binary',
    size: 9,
  });
  assert.deepEqual(await world({ answer: { 'fs.read': { kind: 'text', text: 'x', size: 1 } } }).folders.read('box', { path: '/x' }), {
    kind: 'text',
    text: 'x',
    size: 1,
    truncated: false,
  });
  const badTree = (reply: any) =>
    assert.rejects(world({ answer: { 'fs.tree': reply } }).folders.tree('box', { path: '/x' }), /cannot read/);
  await badTree(null);
  await badTree({ path: '', entries: [] });
  await badTree({ path: '/x', entries: 'x' });
  await badTree({ path: '/x', entries: new Array(2501).fill({ name: 'a', isDirectory: false }) });
  await badTree({ path: '/x', entries: [{ name: 'a/b', isDirectory: false }] });
  await badTree({ path: '/x', entries: [{ name: 'a\0b', isDirectory: false }] });
  // a backslash is an ordinary character in a name on the machine
  assert.equal(
    (
      await world({ answer: { 'fs.tree': { path: '/x', entries: [{ name: 'we\\ird', isDirectory: false }] } } }).folders.tree('box', {
        path: '/x',
      })
    ).entries[0].name,
    'we\\ird',
  );
  await badTree({ path: '/x', entries: [{ name: 'a', isDirectory: 'yes' }] });
  await badTree({ path: '/x', entries: [{ name: '', isDirectory: false }] });
  const badRead = (reply: any) =>
    assert.rejects(world({ answer: { 'fs.read': reply } }).folders.read('box', { path: '/x' }), /cannot read/);
  await badRead(null);
  await badRead({ kind: 'text', text: 'x', size: -1 });
  await badRead({ kind: 'text', text: 7, size: 1 });
  await badRead({ kind: 'image', size: 1 });
  await badRead({ kind: 'text', text: 'x'.repeat(4_000_001), size: 1 });
  for (const [method, call] of [
    ['fs.tree', (f: any) => f.tree('box', { path: '/x' })],
    ['fs.read', (f: any) => f.read('box', { path: '/x' })],
  ] as const)
    await assert.rejects(
      call(world({ answer: { [method]: new Error('Unknown method x.') } }).folders),
      (e: any) => e.code === 'host_outdated',
      method,
    );
  const refusal = Object.assign(new Error('nope'), { code: 'not_a_file' });
  await assert.rejects(
    world({ answer: { 'fs.read': refusal } }).folders.read('box', { path: '/srv' }),
    (e: any) => e.code === 'not_a_file',
  );
  const none = world();
  await assert.rejects(none.folders.read('box', {}));
  await assert.rejects(none.folders.read('box', { path: '/x', limit: 0 }));
  await assert.rejects(none.folders.tree('box', {}));
  assert.equal(none.opened.length, 0);
});

test('diff asks the machine for a repository’s patch, reads the answer defensively, and says to update an older Host', async () => {
  const good = { isRepo: true, patch: 'diff --git a/x b/x\n+1\n', truncated: true, unreadable: false };
  const w = world({ answer: { 'git.diff': good } });
  assert.deepEqual(await w.folders.diff('box', { path: '/srv/app', scope: 'branch' }), good);
  assert.deepEqual(w.calls[0], {
    hostId: 'box',
    method: 'git.diff',
    params: { path: '/srv/app', scope: 'branch' },
    opts: { timeoutMs: 45_000 },
  });
  assert.equal(w.opened[0].closed, 1);
  assert.deepEqual(await world({ answer: { 'git.diff': { isRepo: false } } }).folders.diff('box', { path: '/x', scope: 'uncommitted' }), {
    isRepo: false,
  });
  assert.deepEqual(
    await world({ answer: { 'git.diff': { isRepo: true, patch: '' } } }).folders.diff('box', { path: '/x', scope: 'uncommitted' }),
    {
      isRepo: true,
      patch: '',
      truncated: false,
      unreadable: false,
    },
  );
  const bad = (reply: any) =>
    assert.rejects(world({ answer: { 'git.diff': reply } }).folders.diff('box', { path: '/x', scope: 'branch' }), /cannot read/);
  await bad(null);
  await bad({ isRepo: 'yes' });
  await bad({ isRepo: true, patch: 7 });
  await bad({ isRepo: true, patch: 'x'.repeat(4_100_001) });
  await assert.rejects(
    world({ answer: { 'git.diff': new Error('Unknown method git.diff.') } }).folders.diff('box', { path: '/x', scope: 'branch' }),
    (e: any) => e.code === 'host_outdated',
  );
  const none = world();
  await assert.rejects(none.folders.diff('box', { path: '/x' }));
  await assert.rejects(none.folders.diff('box', { path: '/x', scope: 'all' }));
  assert.equal(none.opened.length, 0);
});

test('search asks the Host for the files whose names match, reads the answer strictly, and says to update an older Host (#4103)', async () => {
  const w = world({ answer: { 'fs.search': { files: ['src/a.ts', 'b.ts'], truncated: true } } });
  assert.deepEqual(await w.folders.search('box', { path: '/srv/app', query: 'a' }), { files: ['src/a.ts', 'b.ts'], truncated: true });
  assert.deepEqual(w.calls[0], {
    hostId: 'box',
    method: 'fs.search',
    params: { path: '/srv/app', query: 'a', limit: 50 },
    opts: { timeoutMs: 20_000 },
  });
  assert.equal(w.opened[0].closed, 1);
  assert.deepEqual(await world({ answer: { 'fs.search': { files: [] } } }).folders.search('box', { path: '/srv', query: '' }), {
    files: [],
    truncated: false,
  });
  const bad = (reply: any) =>
    assert.rejects(world({ answer: { 'fs.search': reply } }).folders.search('box', { path: '/srv', query: 'a' }), /cannot read/);
  await bad(null);
  await bad({ files: 'x' });
  await bad({ files: new Array(201).fill('a') });
  await bad({ files: [''] });
  await bad({ files: [7] });
  await bad({ files: ['a'.repeat(1001)] });
  await assert.rejects(
    world({ answer: { 'fs.search': new Error('Unknown method fs.search.') } }).folders.search('box', { path: '/srv', query: 'a' }),
    (e: any) => e.code === 'host_outdated' && /Update the Host/.test(e.message),
  );
  const refusal = Object.assign(new Error('That folder is outside what this host shares.'), { code: 'outside_roots' });
  await assert.rejects(
    world({ answer: { 'fs.search': refusal } }).folders.search('box', { path: '/srv', query: 'a' }),
    (e: any) => e.code === 'outside_roots',
  );
  // a request that is not a search is refused before any connection is made
  const none = world();
  await assert.rejects(none.folders.search('box', { path: '/srv', query: 7 }));
  assert.equal(none.opened.length, 0);
});
