// Every module that declares `@host-portable` in its header runs in the Host process, so it must load with Electron absent and
// reach none of the app layers host/boundary.json forbids. A module declares itself; there is no list to append to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

// the folder it scans, for the guards in tests/invariantGuards.invariant.test.ts
export const GUARDS = ['electron/', 'host/boundary.json'];
const ROOT = path.join(import.meta.dirname, '..');
const MARK = '@host-portable';

/** The comment lines a file opens with, however many. */
const headerOf = (text: string) => {
  const lines = text.split('\n');
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end < 0 ? lines.length : end);
};

const portable = treeFiles(path.join(ROOT, 'electron'), /\.cjs$/)
  .filter((f) => headerOf(fs.readFileSync(f, 'utf8')).some((l) => l.includes(MARK)))
  .map((f) => path.relative(ROOT, f));

test('there are host-portable modules to check', () => {
  assert.ok(portable.length > 0, 'the scan found no module that declares @host-portable');
});

test('a host-portable module never names Electron', () => {
  for (const f of portable)
    assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT, f), 'utf8'),
      /require\(\s*['"]electron(?:\/[\w-]+)?['"]\s*\)|from\s+['"]electron['"]/,
      f,
    );
});

test('together they load with Electron blocked, and pull in nothing the Host boundary forbids', () => {
  const forbidden = (JSON.parse(fs.readFileSync(path.join(ROOT, 'host/boundary.json'), 'utf8')).forbidden as string[]).filter(
    (p) => p !== 'electron',
  );
  const script = `
    const M = require('module'); const load = M._load;
    M._load = function (r, ...a) { if (r === 'electron' || r.startsWith('electron/')) throw new Error('electron was required'); return load.call(this, r, ...a); };
    for (const f of ${JSON.stringify(portable.map((f) => path.join(ROOT, f)))}) require(f);
    console.log(JSON.stringify(Object.keys(require.cache)));`;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const loaded = (JSON.parse(out.stdout) as string[]).map((f) => path.relative(ROOT, f));
  assert.deepEqual(
    loaded.filter((f) => forbidden.some((p) => f.startsWith(p))),
    [],
  );
});

test('the tool-refusal helpers and the Claude tab tracker load without the visibility rules or any browser-layer module', () => {
  const script = `
    const M = require('module'); const load = M._load;
    M._load = function (r, ...a) { if (r === 'electron' || r.startsWith('electron/')) throw new Error('electron was required'); return load.call(this, r, ...a); };
    require(${JSON.stringify(path.join(ROOT, 'electron/capabilities/mcp/socket.cjs'))});
    require(${JSON.stringify(path.join(ROOT, 'electron/harness/claude/sessionTools.cjs'))});
    require(${JSON.stringify(path.join(ROOT, 'electron/harness/claude/chromeTabs.cjs'))});
    console.log(JSON.stringify(Object.keys(require.cache)));`;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const loaded = (JSON.parse(out.stdout) as string[]).map((f) => path.relative(ROOT, f));
  assert.deepEqual(
    loaded.filter((f) => /capabilities\/(visibility|browser\/)/.test(f)),
    [],
  );
});
