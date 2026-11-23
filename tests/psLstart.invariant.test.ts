// Invariant (#3333): nothing asks `ps -o lstart` for a process's start time. ps prints a local time with no zone, which
// names two instants in the hour a clock is set back, so a reader in another zone (the app's, a test's Los Angeles) took a
// live MoPilot for gone. The kernel's birth has no zone: processStart in electron/platform/processIdentity.cjs reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'chrome-extension']);

function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(cjs|mjs|js|ts|tsx)$/.test(e.name)) out.push(f);
  }
  return out;
}

/** The lstart column named in a string: alone, or in a column list such as 'pid=,lstart='. */
const LSTART = /['"`](?:[\w=]*,)*lstart=?[,'"`]/;

/** The source files under `dirs` that name the lstart column in a string, relative to the repository. */
function askingLstart(dirs: string[]) {
  return dirs
    .flatMap((d) => walk(path.join(repo, d)))
    .filter((f) => LSTART.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(repo, f).split(path.sep).join('/'))
    .sort();
}

test('nothing asks ps for a start time', () => {
  for (const hit of ["'lstart='", '"lstart"', "'pid=,lstart='", '`lstart=,pid=`']) assert.match(hit, LSTART, hit);
  for (const miss of ["'lstarted'", "'pid=,ppid='", 'lstart']) assert.doesNotMatch(miss, LSTART, miss);
  assert.deepEqual(askingLstart(['electron', 'host', 'shared', 'src', 'scripts', 'relay']), []);
});
