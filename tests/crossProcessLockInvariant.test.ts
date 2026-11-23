// No lock, slot or build cache that several processes share lives under os.tmpdir(): each test process has its own TMPDIR (#2340), so such a path is private to one process and serializes nothing (#2374).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

export const GUARDS = ['bench/', 'scripts/', 'tests/support/'];

/** What a path under the temp folder is named for when it is meant to be shared between processes. */
const SHARED = /lock|cache|slot|\.pid\b|shared/i;
/** Scanned: build and CI scripts, bench tooling, and the fixtures unit tests share. */
const SCANNED = /^(?:scripts|bench|tests\/support)\/.*\.(?:m?js|cjs|ts|sh)$/;

/** Paths under the temp folder that are shared by design, with why that is safe: `file` -> text of the line. */
const ALLOWED: Record<string, { line: string; why: string }> = {
  'scripts/test-slots.mjs': {
    line: "export const SLOT_DIR = path.join(os.tmpdir(), 'mopilot-unit-test-slots');",
    why: 'the budget is machine-wide and its owner computes it in the launching process, before test processes get their own TMPDIR; a run started inside a test holds no slots (HELD)',
  },
};

/** The statements that take a path from the temp folder (a line, or the lines to its closing parenthesis) for something shared. */
export function sharedUnderTmpdir(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (/^\s*(\/\/|\*|\/\*|#)/.test(lines[i])) {
      i++;
      continue;
    }
    let end = i;
    let depth = 0;
    for (; end < Math.min(lines.length, i + 6); end++) {
      depth += (lines[end].match(/\(/g)?.length ?? 0) - (lines[end].match(/\)/g)?.length ?? 0);
      if (depth <= 0) break;
    }
    const statement = lines.slice(i, end + 1).join('\n');
    if (/tmpdir|TMPDIR/.test(statement) && SHARED.test(statement) && !/mkdtemp/.test(statement)) found.push(statement.trim());
    i = end + 1;
  }
  return found;
}

test('the check tells a shared path under the temp folder from a private scratch folder', () => {
  assert.deepEqual(sharedUnderTmpdir("lock = path.join(os.tmpdir(), 'sage-mcp-build.lock'),"), [
    "lock = path.join(os.tmpdir(), 'sage-mcp-build.lock'),",
  ]);
  assert.equal(sharedUnderTmpdir('const cache = path.join(process.env.TMPDIR, `build-${hash}`);').length, 1);
  assert.equal(sharedUnderTmpdir(['const lock = path.join(', '  os.tmpdir(),', "  'x.lock',", ');'].join('\n')).length, 1);
  assert.equal(sharedUnderTmpdir("const slots = path.join(os.tmpdir(), 'slots');").length, 1);
  // a private folder per call, a comment, and a path with no shared name are fine
  assert.deepEqual(sharedUnderTmpdir("const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));"), []);
  assert.deepEqual(sharedUnderTmpdir("  // the lock lives beside os.tmpdir()'s sibling"), []);
  assert.deepEqual(sharedUnderTmpdir("const out = path.join(os.tmpdir(), 'report.md');\nconst lock = 1;"), []);
  assert.deepEqual(sharedUnderTmpdir('const lock = path.join(pkgDir, `.build.lock`);'), []);
});

test('no script or shared fixture keeps a cross-process lock or cache under the per-process temp folder (#2374)', () => {
  const files = execFileSync('git', ['ls-files', 'scripts', 'bench', 'tests/support'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => SCANNED.test(f) && fs.existsSync(f));
  assert.ok(
    files.includes('scripts/build-sage-mcp.mjs') && files.includes('scripts/test-slots.mjs'),
    'the scan finds the builders and the runner',
  );
  const hits: string[] = [];
  const allowedSeen = new Set<string>();
  for (const file of files) {
    for (const line of sharedUnderTmpdir(fs.readFileSync(file, 'utf8'))) {
      if (ALLOWED[file]?.line === line) allowedSeen.add(file);
      else hits.push(`${file}: ${line}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    'a path every process must agree on cannot be under os.tmpdir() (each test process has its own TMPDIR): put it next to what it protects, e.g. buildLockPath in scripts/build-sage-mcp.mjs, or add it to ALLOWED here with why it is safe',
  );
  assert.deepEqual([...allowedSeen], Object.keys(ALLOWED), 'every allowed path is still in its file (remove the entry when it goes)');
});
