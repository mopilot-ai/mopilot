// electron/platform/search.cjs with a fake ripgrep process: listing (prefixes, caps, partial records,
// errors, Windows separators), the ripgrep lookup fallbacks, the listing cache and the IPC.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const search = require('../electron/platform/search.cjs');

type Script = (p: any) => void;
let script: Script = (p) => setImmediate(() => p.emit('close', 0));
const spawned: any[] = [];
mock.method(childProcess, 'spawn', (bin: string, args: string[], opts: any) => {
  const p: any = new EventEmitter();
  p.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  p.kills = 0;
  p.kill = () => {
    p.kills++;
    if (p.killThrows) throw new Error('dead');
  };
  spawned.push({ bin, args, opts, p });
  script(p);
  return p;
});
const lines =
  (...chunks: string[]) =>
  (p: any) =>
    setImmediate(() => {
      for (const c of chunks) p.stdout.emit('data', c);
      p.emit('close', 0);
    });

test('listFiles strips ./, joins split records, keeps a last record without NUL, and kills rg', async () => {
  script = lines('./a.ts\0sr', 'c/b.ts\0\0', 'tail.md');
  assert.deepEqual(await search.listFiles('/repo', { bin: '/rg' }), ['a.ts', 'src/b.ts', 'tail.md']);
  const s = spawned.at(-1);
  assert.equal(s.bin, '/rg');
  assert.equal(s.opts.cwd, '/repo');
  assert.equal(s.args.includes('--path-separator'), false);
  assert.equal(s.p.kills, 1);
});

test('listFiles stops at the cap, ignoring a trailing partial record', async () => {
  script = lines('a\0b\0c\0');
  assert.deepEqual(await search.listFiles('/r', { bin: 'rg', max: 2 }), ['a', 'b']);
  script = lines('a\0b\0partial');
  assert.deepEqual(await search.listFiles('/r', { bin: 'rg', max: 2 }), ['a', 'b']);
});

test('listFiles: a spawn error rejects; a kill that throws is ignored; a timeout returns what it has', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  script = (p) => {
    p.killThrows = true;
    setImmediate(() => p.emit('error', new Error('ENOENT')));
  };
  await assert.rejects(search.listFiles('/r', { bin: 'nope' }), /ENOENT/);
  script = (p) => setImmediate(() => p.stdout.emit('data', 'x\0'));
  const pending = search.listFiles('/r', { bin: 'rg', timeoutMs: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5);
  assert.deepEqual(await pending, ['x']);
});

test('listFiles on Windows asks for forward slashes', async (t) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', orig));
  script = lines('a/b\0');
  await search.listFiles('C:\\r', { bin: 'rg.exe' });
  assert.deepEqual(spawned.at(-1).args.slice(-2), ['--path-separator', '/']);
});

test('rgPath falls back to rg on PATH when nothing bundled exists or resolves', (t) => {
  t.mock.method(fs, 'existsSync', () => false);
  assert.equal(search.rgPath(), 'rg');
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(search.rgPath(), 'rg', 'no @vscode/ripgrep-win32 package here');
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
});

test('rank breaks full ties by path order', async () => {
  const r = await search.rank(['b/x', 'a/x'], 'x', { dirs: false });
  assert.deepEqual(
    r.map((e: any) => e.path),
    ['a/x', 'b/x'],
  );
  const r2 = await search.rank(['a/x', 'b/x'], 'x', { dirs: false });
  assert.deepEqual(
    r2.map((e: any) => e.path),
    ['a/x', 'b/x'],
  );
});

test('searchFiles: non-folders are empty; a listing is reused and expires; a failure is thrown and not reused', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.deepEqual(await search.searchFiles('', 'x'), { files: [] });
  assert.deepEqual(await search.searchFiles('rel', 'x'), { files: [] });
  assert.deepEqual(await search.searchFiles(path.join(d, 'missing'), 'x'), { files: [] });
  const before = spawned.length;
  script = lines('one.ts\0');
  assert.deepEqual(
    (await search.searchFiles(d, 'one')).files.map((f: any) => f.path),
    ['one.ts'],
  );
  assert.deepEqual((await search.searchFiles(d, 'one', { dirs: false, limit: 1 })).files.length, 1);
  assert.equal(spawned.length - before, 1, 'cached');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 60_000);
  script = (p) => setImmediate(() => p.emit('error', new Error('gone')));
  await assert.rejects(search.searchFiles(d, 'one'), /gone/);
  assert.equal(spawned.length - before, 2, 'expired and listed again');
  // the failed listing is not kept as "no files" for the next keystrokes: the next search lists again
  script = lines('one.ts\0');
  assert.deepEqual(
    (await search.searchFiles(d, 'one')).files.map((f: any) => f.path),
    ['one.ts'],
  );
  assert.equal(spawned.length - before, 3, 'listed again after the failure');
});

test('a failed listing replaced by a newer one meanwhile leaves the newer one cached', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'search-race-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  let fail!: (p: any) => void;
  let started!: () => void;
  const listingStarted = new Promise<void>((resolve) => (started = resolve));
  script = (p) => {
    fail = () => p.emit('error', new Error('gone'));
    started();
  };
  const first = search.searchFiles(d, 'a');
  await listingStarted;
  // the cached listing expires and a newer one replaces it before the first fails
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 60_000);
  script = lines('a.ts\0');
  assert.deepEqual(
    (await search.searchFiles(d, 'a')).files.map((f: any) => f.path),
    ['a.ts'],
  );
  fail(null);
  await assert.rejects(first, /gone/);
  const before = spawned.length;
  await search.searchFiles(d, 'a');
  assert.equal(spawned.length, before, 'the newer listing is still cached');
  clock.mock.restore();
});

test('searchFiles keeps at most 8 folders cached', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-many-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  script = lines('f\0');
  const dirs = Array.from({ length: 9 }, (_, i) => fs.mkdirSync(path.join(root, `d${i}`), { recursive: true }) ?? path.join(root, `d${i}`));
  for (const dir of dirs) await search.searchFiles(dir, '');
  const before = spawned.length;
  await search.searchFiles(dirs[0], '');
  assert.equal(spawned.length - before, 1, 'the oldest was evicted');
  await search.searchFiles(dirs[8], '');
  assert.equal(spawned.length - before, 1, 'the newest is still cached');
});

test('IPC: limits clamp to 1..500, dirs on unless false, odd arguments are stringified', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'search-ipc-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  script = lines('a/b.ts\0c.ts\0');
  const h = new Map<string, any>();
  search.register({ handle: (ch: string, f: any) => h.set(ch, f) });
  const call = (...a: any[]) => h.get('platform:search:files')({}, ...a);
  assert.equal((await call(d, null, undefined)).files.length, 3);
  assert.equal((await call(d, '', { limit: 0 })).files.length, 3, '0 means the default');
  assert.equal((await call(d, '', { limit: -5 })).files.length, 1);
  assert.deepEqual(
    (await call(d, '', { dirs: false })).files.map((f: any) => f.match_type),
    ['file', 'file'],
  );
  assert.deepEqual(await call(null, 'x'), { files: [] });
});

test('file listing ignores output and close events after a timeout has settled its result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let proc: any;
  script = (p) => {
    proc = p;
    setImmediate(() => p.stdout.emit('data', 'first.ts\0partial'));
  };
  const pending = search.listFiles('/r', { bin: 'rg', timeoutMs: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5);
  const files = await pending;
  assert.deepEqual(files, ['first.ts']);
  proc.emit('close', 0);
  assert.deepEqual(files, ['first.ts']);
  proc.stdout.emit('data', 'late.ts\0');
  proc.emit('close', 0);
  assert.deepEqual(files, ['first.ts']);
});

test('file listing ignores output after the file cap has settled its result', async () => {
  let proc: any;
  script = (p) => {
    proc = p;
    setImmediate(() => p.stdout.emit('data', 'first.ts\0second.ts\0partial'));
  };
  const files = await search.listFiles('/r', { bin: 'rg', max: 1 });
  assert.deepEqual(files, ['first.ts']);
  proc.stdout.emit('data', 'late.ts\0');
  proc.emit('close', 0);
  assert.deepEqual(files, ['first.ts']);
});

for (const [code, signal, output] of [
  [2, null, ''],
  [7, null, 'partial.ts\0'],
  [null, 'SIGTERM', 'partial.ts\0'],
] as const) {
  test(`file listing rejects failed exit ${code}/${signal} instead of an empty success`, async () => {
    script = (p) =>
      setImmediate(() => {
        if (output) p.stdout.emit('data', output);
        p.emit('close', code, signal);
      });
    await assert.rejects(search.listFiles('/repo', { bin: 'rg' }), /File listing failed/);
  });
}

test('a timeout before any complete file is an error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  script = () => {};
  const pending = search.listFiles('/repo', { bin: 'rg', timeoutMs: 100 });
  const failed = assert.rejects(pending, /File listing timed out/);
  t.mock.timers.tick(100);
  await failed;
});

test('failed empty listings are not cached; retry can find files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  script = (p) => setImmediate(() => p.emit('close', 2));
  await assert.rejects(search.searchFiles(root, ''), /File listing failed/);
  const before = spawned.length;
  script = lines('recovered.ts\0');
  assert.deepEqual(
    (await search.searchFiles(root, '', { dirs: false })).files.map((f: any) => f.path),
    ['recovered.ts'],
  );
  assert.equal(spawned.length, before + 1);
});

test('normal empty listings and readable partial exit-2 listings remain valid', async () => {
  for (const [code, output, expected] of [
    [0, '', []],
    [1, '', []],
    [2, 'readable.ts\0', ['readable.ts']],
  ] as const) {
    script = (p) =>
      setImmediate(() => {
        if (output) p.stdout.emit('data', output);
        p.emit('close', code);
      });
    assert.deepEqual(await search.listFiles('/repo', { bin: 'rg' }), expected);
  }
});
