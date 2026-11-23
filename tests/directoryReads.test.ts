// File search and directory-tree IPC await user-folder reads without stalling the main event loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const search = require('../electron/platform/search.cjs');
const fileTree = require('../electron/platform/fs.cjs');
const directory = { isDirectory: () => true };
const ordinaryFile = { isDirectory: () => false };
const ipc = (module: any, channel: string) => {
  const handlers = new Map<string, (...args: any[]) => any>();
  module.register({ handle: (name: string, handler: any) => handlers.set(name, handler) });
  return (...args: any[]) => handlers.get(channel)!({}, ...args);
};
function listing(t: any, output = 'one.ts\0') {
  return t.mock.method(childProcess, 'spawn', () => {
    const proc: any = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.kill = () => {};
    setImmediate(() => {
      proc.stdout.emit('data', output);
      proc.emit('close', 0);
    });
    return proc;
  });
}

test('search IPC yields during its directory probe instead of calling statSync', async (t) => {
  const probe = deferred<typeof directory>();
  const sync = t.mock.method(fs, 'statSync', () => directory);
  const asyncStat = t.mock.method(fs.promises, 'stat', () => probe.promise);
  const spawn = listing(t);
  const pending = ipc(search, 'platform:search:files')('/search-nonblocking', 'one');
  try {
    assert.equal(sync.mock.callCount(), 0, 'search must not block the main thread on folder metadata');
    assert.equal(asyncStat.mock.callCount(), 1);
    assert.equal(spawn.mock.callCount(), 0, 'listing waits for the asynchronous folder probe');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    probe.resolve(directory);
    assert.deepEqual(
      (await pending).files.map((hit: any) => hit.path),
      ['one.ts'],
    );
  }
});

test('directory-tree IPC yields during readdir instead of calling readdirSync', async (t) => {
  const read = deferred<any[]>();
  const sync = t.mock.method(fs, 'readdirSync', () => []);
  const asyncRead = t.mock.method(fs.promises, 'readdir', () => read.promise);
  const pending = ipc(fileTree, 'fs:readDir')('/tree-nonblocking');
  try {
    assert.equal(sync.mock.callCount(), 0, 'listing a folder must not block other windows');
    assert.equal(asyncRead.mock.callCount(), 1);
    assert.equal(pending instanceof Promise, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    read.resolve([]);
    assert.deepEqual(await pending, []);
  }
});

test('search rejects real metadata failures, treats missing/nonfolders as empty, and retries', async (t) => {
  const spawn = listing(t);
  const call = ipc(search, 'platform:search:files');
  const stat = t.mock.method(fs.promises, 'stat', async () => ordinaryFile);
  assert.deepEqual(await call('/search-nonfolder', 'one'), { files: [] });
  for (const code of ['ENOENT', 'ENOTDIR']) {
    stat.mock.mockImplementation(async () => {
      throw Object.assign(new Error(code), { code });
    });
    assert.deepEqual(await call('/search-missing-' + code, 'one'), { files: [] });
  }
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  for (const error of [failure, null]) {
    stat.mock.mockImplementation(async () => {
      throw error;
    });
    await assert.rejects(call('/search-retry', 'one'), (caught: unknown) => caught === error);
  }
  assert.equal(spawn.mock.callCount(), 0, 'invalid and failed folders never start a listing');
  stat.mock.mockImplementation(async () => directory);
  assert.equal((await call('/search-retry', 'one')).files[0].path, 'one.ts');
  assert.equal(spawn.mock.callCount(), 1);
});

for (const reverse of [false, true]) {
  test(`overlapping search probes share one listing when ${reverse ? 'newer' : 'older'} probe resolves first`, async (t) => {
    const probes = [deferred<typeof directory>(), deferred<typeof directory>()];
    let calls = 0;
    t.mock.method(fs.promises, 'stat', () => probes[calls++].promise);
    const spawn = listing(t, 'one.ts\0two.ts\0');
    const root = `/search-overlap-${reverse}`;
    const searches = [search.searchFiles(root, 'one'), search.searchFiles(root, 'two')];
    const first = reverse ? 1 : 0;
    probes[first].resolve(directory);
    await searches[first];
    probes[1 - first].resolve(directory);
    const results = await Promise.all(searches);
    assert.deepEqual(
      results.map((r) => r.files.map((hit: any) => hit.path)),
      [['one.ts'], ['two.ts']],
    );
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(spawn.mock.calls[0].arguments[2].cwd, root);
  });
}

test('an older rejected probe cannot invalidate a newer cached listing or block its retry', async (t) => {
  const older = deferred<typeof directory>();
  let calls = 0;
  t.mock.method(fs.promises, 'stat', () => (calls++ === 0 ? older.promise : Promise.resolve(directory)));
  const spawn = listing(t);
  const first = search.searchFiles('/search-reversed-failure', 'one');
  const failure = Object.assign(new Error('old read failed'), { code: 'EIO' });
  const rejected = assert.rejects(first, (error: unknown) => error === failure);
  assert.equal((await search.searchFiles('/search-reversed-failure', 'one')).files[0].path, 'one.ts');
  older.reject(failure);
  await rejected;
  assert.equal((await search.searchFiles('/search-reversed-failure', 'one')).files[0].path, 'one.ts');
  assert.equal(spawn.mock.callCount(), 1);
});

test('search probes keep their captured root and validate again even when the listing is cached', async (t) => {
  const first = deferred<typeof directory>();
  const second = deferred<typeof directory>();
  const roots = ['/search/old:folder', '/search/new"folder'];
  const stat = t.mock.method(fs.promises, 'stat', (root: string) => (root === roots[0] ? first.promise : second.promise));
  const spawn = listing(t);
  const old = search.searchFiles(roots[0], 'one');
  const current = search.searchFiles(roots[1], 'one');
  second.resolve(directory);
  assert.equal((await current).files[0].root, roots[1]);
  first.resolve(directory);
  assert.equal((await old).files[0].root, roots[0]);
  assert.deepEqual(
    spawn.mock.calls.map((call: any) => call.arguments[2].cwd),
    [roots[1], roots[0]],
  );
  stat.mock.mockImplementation(async () => ordinaryFile);
  assert.deepEqual(await search.searchFiles(roots[1], 'one'), { files: [] });
  assert.equal(spawn.mock.callCount(), 2, 'a cached folder replaced by a file is no longer searched');
});

test('directory-tree symlink reads are asynchronous and retain directory order across reversed completion', async (t) => {
  const dirent = (name: string, dir: boolean, link: boolean) => ({ name, isDirectory: () => dir, isSymbolicLink: () => link });
  const rows = [
    dirent('folder', true, false),
    dirent('plain', false, false),
    dirent('first-link', false, true),
    dirent('second-link', false, true),
  ];
  t.mock.method(fs.promises, 'readdir', async () => rows);
  const probes = [deferred<typeof directory>(), deferred<typeof ordinaryFile>()];
  const paths: string[] = [];
  t.mock.method(fs.promises, 'stat', (path: string) => {
    paths.push(path);
    return probes[paths.length - 1].promise;
  });
  const sync = t.mock.method(fs, 'statSync', () => ordinaryFile);
  let done = false;
  const read = ipc(
    fileTree,
    'fs:readDir',
  )('/tree-links').then((result: any) => {
    done = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(paths, ['/tree-links/first-link', '/tree-links/second-link']);
  assert.equal(sync.mock.callCount(), 0);
  probes[1].resolve(ordinaryFile);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  probes[0].resolve(directory);
  assert.deepEqual(await read, [
    { fileName: 'folder', isDirectory: true },
    { fileName: 'plain', isDirectory: false },
    { fileName: 'first-link', isDirectory: true },
    { fileName: 'second-link', isDirectory: false },
  ]);
});

test('directory-tree failures preserve unreadable/link contracts and another folder can finish first', async (t) => {
  const old = deferred<any[]>();
  const current = [{ name: 'unreadable-link', isDirectory: () => false, isSymbolicLink: () => true }];
  t.mock.method(fs.promises, 'readdir', (root: string) => (root === '/tree-old' ? old.promise : Promise.resolve(current)));
  t.mock.method(fs.promises, 'stat', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  const call = ipc(fileTree, 'fs:readDir');
  const pending = call('/tree-old');
  const result = [{ fileName: 'unreadable-link', isDirectory: false }];
  assert.deepEqual(await call('/tree-current'), result);
  old.reject(new Error('old readdir failed'));
  assert.deepEqual(await pending, []);
  assert.deepEqual(await call('/tree-current'), result);
});
