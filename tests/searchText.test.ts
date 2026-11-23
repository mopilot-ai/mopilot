// electron/platform/searchText.cjs: the Files pane's `?` search reads ripgrep's JSON matches under a folder, kept to a
// limit, with failures rejected (so the pane offers Retry) and the IPC handler's limit clamped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import childProcess from 'node:child_process';
// the bridge's types for window.native.search.text (src/lib/native/search.ts)
import '../src/lib/native/search.ts';

const require = createRequire(import.meta.url);
const { searchText, matchOf } = require('../electron/platform/searchText.cjs');
const search = require('../electron/platform/search.cjs');

const record = (path: string, line: number, text: string, start = 0) =>
  JSON.stringify({ type: 'match', data: { path: { text: path }, line_number: line, lines: { text }, submatches: [{ start }] } });

/** A fake ripgrep: `chunks` arrive on stdout, then it closes with `code` (or fails to start with `error`). */
function rg(
  t: any,
  chunks: string[],
  { code = 0, signal = null as string | null, error = null as Error | null, hang = false, killThrows = false, errorAfter = false } = {},
) {
  const spawned: { args: string[]; cwd: string; killed: number }[] = [];
  t.mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
  t.mock.method(fs.promises, 'stat', async () => ({ isDirectory: () => true }));
  t.mock.method(childProcess, 'spawn', (_bin: string, args: string[], opts: any) => {
    const proc: any = new EventEmitter();
    const seen = { args, cwd: opts.cwd, killed: 0 };
    spawned.push(seen);
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.kill = () => {
      seen.killed++;
      if (killThrows) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };
    setImmediate(() => {
      if (error) return proc.emit('error', error);
      for (const c of chunks) proc.stdout.emit('data', c);
      if (!hang) proc.emit('close', code, signal);
      // a process that fails after it closed (a late spawn error) changes nothing
      if (errorAfter) proc.emit('error', new Error('late'));
    });
    return proc;
  });
  return spawned;
}

test('a match record becomes a row: path without ./, its line, the column in characters and the line without its newline', () => {
  assert.deepEqual(matchOf(JSON.parse(record('./src/a.ts', 3, 'const é = find;\n', 13))), {
    path: 'src/a.ts',
    line: 3,
    column: 12,
    text: 'const é = find;',
  });
  assert.equal(matchOf(JSON.parse(record('a.ts', 1, 'x'.repeat(400)))).text.length, 300, 'a long line is cut for its row');
  assert.equal(matchOf({ type: 'match', data: { path: { text: 'a' }, line_number: 1, lines: { text: 'x' } } }).column, 0);
  for (const bad of [
    null,
    { type: 'begin' },
    { type: 'match' },
    { type: 'match', data: { path: {}, line_number: 1, lines: { text: '' } } },
  ]) {
    assert.equal(matchOf(bad), null);
  }
  assert.equal(matchOf({ type: 'match', data: { path: { text: 'a' }, line_number: '1', lines: { text: '' } } }), null);
  assert.equal(matchOf({ type: 'match', data: { path: { text: 'a' }, line_number: 1, lines: { bytes: 'AA==' } } }), null);
});

test('the search runs ripgrep literally in the folder and keeps every match, across chunks and a last line with no newline', async (t) => {
  const two = record('b.ts', 9, 'find me');
  const spawned = rg(t, [
    `${record('./a.ts', 1, 'find')}\n{"type":"begin"}\n${two.slice(0, 10)}`,
    `${two.slice(10)}\nnot json\n`,
    record('c.ts', 2, 'find'),
  ]);
  const out = await searchText('/repo', 'find');
  assert.deepEqual(
    out.matches.map((m: any) => [m.path, m.line]),
    [
      ['a.ts', 1],
      ['b.ts', 9],
      ['c.ts', 2],
    ],
  );
  assert.equal(out.truncated, false);
  assert.equal(spawned[0].cwd, '/repo');
  assert.deepEqual(spawned[0].args.slice(-3), ['--', 'find', '.']);
  assert.ok(spawned[0].args.includes('--fixed-strings') && spawned[0].args.includes('--smart-case'));
});

test('past the limit the search stops and says more were left out; later output and its close change nothing', async (t) => {
  const spawned = rg(t, [[1, 2, 3].map((n) => record('a.ts', n, 'x')).join('\n') + '\n', `${record('b.ts', 1, 'x')}\n`]);
  const out = await searchText('/repo', 'x', { limit: 2 });
  assert.equal(out.matches.length, 2);
  assert.equal(out.truncated, true);
  assert.equal(spawned[0].killed, 1);
});

test('a search that already exited when it is stopped still answers', async (t) => {
  rg(t, [[1, 2].map((n) => record('a.ts', n, 'x')).join('\n') + '\n'], { hang: true, killThrows: true });
  assert.equal((await searchText('/repo', 'x', { limit: 1 })).matches.length, 1);
});

test('the limit reached by the last line, read at close, also stops the search', async (t) => {
  rg(t, [`${record('a.ts', 1, 'x')}\n${record('a.ts', 2, 'x')}`]);
  const out = await searchText('/repo', 'x', { limit: 1 });
  assert.deepEqual([out.matches.length, out.truncated], [1, true]);
});

test('nothing found (exit 1) is no results; an unreadable entry (exit 2) keeps what was found, or fails with none', async (t) => {
  rg(t, [], { code: 1 });
  assert.deepEqual(await searchText('/repo', 'x'), { matches: [], truncated: false });
  t.mock.restoreAll();
  rg(t, [record('a.ts', 1, 'x')], { code: 2 });
  assert.equal((await searchText('/repo', 'x')).matches.length, 1);
  t.mock.restoreAll();
  rg(t, [], { code: 2 });
  await assert.rejects(searchText('/repo', 'x'), /Text search failed \(exit 2\)/);
  t.mock.restoreAll();
  rg(t, [], { code: null as any, signal: 'SIGKILL' });
  await assert.rejects(searchText('/repo', 'x'), /stopped \(SIGKILL\)/);
});

test('ripgrep that cannot start rejects, so the pane shows the reason with Retry', async (t) => {
  rg(t, [], { error: Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(searchText('/repo', 'x', { bin: 'rg' }), /ENOENT/);
});

test('a search out of time keeps what it found, cut short, and fails when it found nothing', async (t) => {
  rg(t, [`${record('a.ts', 1, 'x')}\n`], { hang: true });
  assert.deepEqual(await searchText('/repo', 'x', { timeoutMs: 5 }).then((r: any) => [r.matches.length, r.truncated]), [1, true]);
  t.mock.restoreAll();
  rg(t, [], { hang: true });
  await assert.rejects(searchText('/repo', 'x', { timeoutMs: 5 }), /timed out/);
});

test('a blank query, a relative or missing folder finds nothing without running ripgrep', async (t) => {
  const spawned = rg(t, []);
  assert.deepEqual(await searchText('/repo', '   '), { matches: [], truncated: false });
  assert.deepEqual(await searchText('repo', 'x'), { matches: [], truncated: false });
  assert.deepEqual(await searchText('', 'x'), { matches: [], truncated: false });
  t.mock.method(fs.promises, 'stat', async () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  });
  assert.deepEqual(await searchText('/gone', 'x'), { matches: [], truncated: false });
  assert.equal(spawned.length, 0);
});

test('the IPC handler searches with a clamped limit and stringified arguments', async (t) => {
  rg(t, [[1, 2, 3].map((n) => record('a.ts', n, 'x')).join('\n') + '\n']);
  const handlers = new Map<string, (...a: any[]) => any>();
  search.register({ handle: (name: string, fn: any) => handlers.set(name, fn) });
  const call = handlers.get('platform:search:text')!;
  assert.equal((await call({}, '/repo', 'x', { limit: 0 })).matches.length, 3, 'a missing limit is the default');
  assert.equal((await call({}, '/repo', 'x', { limit: 2 })).matches.length, 2);
  assert.deepEqual(await call({}, null, null), { matches: [], truncated: false });
  assert.equal((await call({}, '/repo', 'x', { limit: 5000 })).matches.length, 3, 'a limit past the cap is the cap');
});

test('a late error after the search closed changes nothing', async (t) => {
  rg(t, [`${record('a.ts', 1, 'x')}\n`], { errorAfter: true });
  assert.equal((await searchText('/repo', 'x')).matches.length, 1);
});

test('on Windows ripgrep is asked for forward slashes, like every other path the app takes', async (t) => {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spawned = rg(t, []);
    await searchText('/repo', 'x', { bin: 'rg' });
    assert.ok(spawned[0].args.join(' ').includes('--path-separator /'));
  } finally {
    Object.defineProperty(process, 'platform', was);
  }
});

test('a newer search from the same window stops the older one; another window’s search keeps running', async (t) => {
  const spawned = rg(t, [], { hang: true });
  const handlers = new Map<string, (...a: any[]) => any>();
  search.register({ handle: (name: string, fn: any) => handlers.set(name, fn) });
  const call = handlers.get('platform:search:text')!;
  const first = call({ sender: { id: 1 } }, '/repo', 'a');
  const other = call({ sender: { id: 2 } }, '/repo', 'a', { limit: 1 });
  await new Promise((r) => setImmediate(r));
  const second = call({ sender: { id: 1 } }, '/repo', 'ab');
  await assert.rejects(first, /replaced by a newer one/);
  assert.equal(spawned[0].killed, 1);
  assert.equal(spawned[1].killed, 0, 'the other window’s search runs on');
  // a blank search from each window stops what each still runs, and finds nothing itself
  assert.deepEqual(await call({ sender: { id: 1 } }, '/repo', ' '), { matches: [], truncated: false });
  assert.deepEqual(await call({}, '/repo', ' '), { matches: [], truncated: false });
  await assert.rejects(second, /replaced/);
  await call({ sender: { id: 2 } }, '/repo', ' ');
  await assert.rejects(other, /replaced/);
});

test('a search asked to stop before it starts stops at once; the line width and node_modules are bounded', async (t) => {
  const spawned = rg(t, [], { hang: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchText('/repo', 'x', { signal: controller.signal }), /replaced/);
  const args = spawned[0].args.join(' ');
  assert.ok(args.includes('--glob !node_modules') && args.includes('--max-columns 1000 --max-columns-preview'));
});
