// tests/support/hermetic-system-fs.ts: while main is loaded in a unit test, the machine's system install folders
// (/opt, /usr, /Applications, /System) read as empty in every fs form, and every fs call main makes is covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hideSystemPaths, PATH_CALLS, SYNC_ONLY, HIDDEN } from './support/hermetic-system-fs.ts';

export const GUARDS = ['electron/', 'shared/'];

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// a system path that is real on every machine: /usr/bin/env (POSIX), its folder, and a made-up one beside it
const REAL = '/usr/bin/env';
const isEnoent = (e: any) => e?.code === 'ENOENT' && typeof e.syscall === 'string' && typeof e.path === 'string';

test('a system path exists only when the test lists it, and every other call on one fails ENOENT', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-'));
  const file = path.join(tmp, 'f');
  fs.writeFileSync(file, 'x');
  const listed = new Set(['/opt/homebrew/bin/codex']);
  const show = hideSystemPaths(listed);
  try {
    assert.equal(fs.existsSync('/opt/homebrew/bin/codex'), true);
    assert.equal(fs.existsSync(REAL), false);
    assert.equal(fs.existsSync(new URL(`file://${REAL}`)), false);
    assert.equal(fs.existsSync(file), true);
    // a listed path is there to existsSync alone: what the machine has behind it is never read
    assert.throws(() => fs.realpathSync('/opt/homebrew/bin/codex'), isEnoent);
    assert.throws(() => fs.realpathSync.native(REAL), isEnoent);
    assert.throws(() => fs.statSync(REAL), { code: 'ENOENT', syscall: 'stat', path: REAL });
    assert.throws(() => fs.readFileSync(Buffer.from(REAL)), isEnoent);
    assert.throws(() => fs.readFileSync(new URL(`file://${REAL}`)), isEnoent);
    assert.throws(() => fs.readdirSync('/usr/bin'), isEnoent);
    assert.throws(() => fs.createReadStream(REAL), isEnoent);
    await assert.rejects(fs.promises.readFile(REAL), isEnoent);
    await assert.rejects(fs.promises.realpath('/Applications/ChatGPT.app'), isEnoent);
    const viaCallback = await new Promise((resolve) => fs.stat(REAL, (error) => resolve(error)));
    assert.ok(isEnoent(viaCallback));
    assert.throws(() => (fs.rm as any)(REAL), isEnoent);
    const viaNative = await new Promise((resolve) => fs.realpath.native(REAL, (error) => resolve(error)));
    assert.ok(isEnoent(viaNative));
    // everything else is the real disk, in each form
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
    assert.equal(fs.realpathSync.native(file), fs.realpathSync(file));
    assert.equal(await fs.promises.readFile(file, 'utf8'), 'x');
    assert.equal(await new Promise((resolve) => fs.readFile(file, 'utf8', (_e, s) => resolve(s))), 'x');
  } finally {
    show();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // undone: the real functions are back, and the system path is the machine's again
  for (const n of PATH_CALLS)
    for (const f of [(fs as any)[n], (fs as any)[`${n}Sync`], (fs.promises as any)[n]]) assert.equal(f[HIDDEN], undefined, n);
  for (const n of ['existsSync', ...SYNC_ONLY]) assert.equal((fs as any)[n][HIDDEN], undefined, n);
  assert.equal(fs.existsSync('/usr/bin'), true);
});

/** The fs functions a source file calls: `fs.x(`, `fsp.x(`, `fs.promises.x(`, and names destructured from fs. */
const fsCalls = (src: string) => [
  ...[...src.matchAll(/\b(?:fs\.promises|fsp|fs)\.(\w+)(?:\.native)?\(/g)].map((m) => m[1]),
  ...[...src.matchAll(/\{([^}]*)\}\s*=\s*(?:require\('(?:node:)?fs(?:\/promises)?'\)|fs)(?:\.promises)?[;\n]/g)].flatMap((m) =>
    m[1].split(',').map((n) => n.split(':')[0].trim()),
  ),
];
// calls on an open file descriptor, which never name a path
const FD_CALLS = new Set(['closeSync', 'fstatSync', 'readSync', 'writeSync', 'fsyncSync', 'fchmodSync', 'ftruncateSync']);

test('a checkout that lives under a system folder keeps its own files readable', () => {
  const show = hideSystemPaths(new Set(), '/usr/bin');
  try {
    assert.ok(fs.readFileSync(REAL).length > 0);
    assert.equal(fs.existsSync(REAL), true);
    assert.throws(() => fs.readdirSync('/usr/lib'), isEnoent);
  } finally {
    show();
  }
});

test('every fs call main makes is hidden for system paths, or takes a file descriptor', () => {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?js$/.test(e.name)) sources.push(p);
    }
  };
  walk(path.join(ROOT, 'electron'));
  walk(path.join(ROOT, 'shared'));
  const used = new Map<string, string>();
  for (const f of sources) for (const n of fsCalls(fs.readFileSync(f, 'utf8'))) used.set(n, path.relative(ROOT, f));
  // the scan sees what main calls (an fs/promises alias reads as `fs.` too, so each name is checked in both modules)
  assert.ok(used.has('realpathSync') && used.has('readFileSync') && used.has('readdir'), [...used.keys()].join(' '));
  const show = hideSystemPaths(new Set());
  try {
    const missed = [...used].filter(([n]) => {
      if (FD_CALLS.has(n)) return false;
      // fs.watch has an async-iterator twin in fs.promises that main does not use
      const forms = [(fs as any)[n], ...(SYNC_ONLY.includes(n) ? [] : [(fs.promises as any)[n]])].filter(Boolean);
      return !forms.length || forms.some((f) => !f[HIDDEN]);
    });
    // a new fs call in main: add it to PATH_CALLS or SYNC_ONLY (or FD_CALLS when it takes no path)
    assert.deepEqual(
      missed.map(([n, f]) => `${n} (${f})`),
      [],
    );
  } finally {
    show();
  }
});
