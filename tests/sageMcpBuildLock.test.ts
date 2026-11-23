// scripts/build-sage-mcp.mjs ensureBuilt's lock: shared by every process whatever its TMPDIR (#2374), and taken over once too old to be a build's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recorder, tempDir } from './support/scripts-shared-cli.ts';

const sageMcp = await import('../scripts/build-sage-mcp.mjs');

/** A sources folder and an exe path; `fresh` writes an exe newer than the sources. */
function project() {
  const dir = tempDir();
  const src = path.join(dir, 'Sources');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'main.swift'), '');
  fs.utimesSync(path.join(src, 'main.swift'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.utimesSync(src, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const exe = path.join(dir, 'build', 'sage-mcp');
  const fresh = () => {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'bin');
  };
  return { dir, exe, sources: [src], lock: path.join(dir, 'build.lock'), fresh };
}

test('ensure: processes with different TMPDIRs contend on one lock, next to the package it protects (#2374)', (t) => {
  // #2340 gave every test process its own TMPDIR; a lock under os.tmpdir() then stopped serializing swift builds of the one package
  const pkg = tempDir('pkg-');
  fs.mkdirSync(path.join(pkg, 'Sources'));
  fs.writeFileSync(path.join(pkg, 'Package.swift'), '');
  const tmpA = tempDir('tmp-a-');
  const tmpB = tempDir('tmp-b-');
  const saved = process.env.TMPDIR;
  t.after(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  });
  assert.equal(sageMcp.buildLockPath(pkg), path.join(pkg, '.build.lock.pid'));
  process.env.TMPDIR = tmpA;
  const lockA = sageMcp.buildLockPath(pkg);
  process.env.TMPDIR = tmpB;
  assert.equal(sageMcp.buildLockPath(pkg), lockA);
  assert.equal(sageMcp.buildLockPath(), path.join(path.resolve(import.meta.dirname, '..'), 'native/sage-mcp/.build.lock.pid'));

  let t0 = 0;
  const second: { error?: Error } = {};
  const exe = path.join(pkg, 'build', 'sage-mcp');
  process.env.TMPDIR = tmpA; // the first process
  const first = sageMcp.ensureBuilt({
    pkg,
    swift: () => true,
    build: (() => {
      assert.match(fs.readFileSync(lockA, 'utf8'), new RegExp(`^${process.pid} `));
      process.env.TMPDIR = tmpB; // a second process, building at the same time
      try {
        sageMcp.ensureBuilt({
          pkg,
          swift: () => true,
          sleep: (() => {}) as any,
          now: () => (t0 += 1000),
          maxWaitMs: 2000,
          build: (() => assert.fail('the second process built under its own lock')) as any,
        });
      } catch (error: any) {
        second.error = error;
      }
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, 'bin');
    }) as any,
  });
  assert.equal(first, exe);
  assert.match(second.error?.message ?? '', /gave up waiting 2s for the build lock .*\.build\.lock\.pid \(held by pid \d+\)/);
  assert.equal(fs.existsSync(lockA), false);
});

test('ensure: a lock held past any build is taken over even when its pid is alive (a reused pid); a young one is not', () => {
  const p = project();
  fs.writeFileSync(p.lock, '4242 tok\n');
  const old = new Date(Date.now() - sageMcp.STALE_LOCK_MS - 60_000);
  fs.utimesSync(p.lock, old, old);
  const build = recorder(p.fresh);
  assert.equal(sageMcp.ensureBuilt({ ...p, swift: () => true, alive: () => true, build: build as any }), p.exe);
  assert.equal(build.calls.length, 1);
  const q = project();
  fs.writeFileSync(q.lock, '4242 tok\n');
  const young = new Date(Date.now() - sageMcp.STALE_LOCK_MS + 60_000);
  fs.utimesSync(q.lock, young, young);
  let clock = Date.now();
  assert.throws(
    () =>
      sageMcp.ensureBuilt({
        ...q,
        swift: () => true,
        alive: () => true,
        sleep: (() => {}) as any,
        maxWaitMs: 0,
        now: () => (clock += 1000),
      }),
    /gave up waiting .* \(held by pid 4242\)/,
  );
});

test('ensure: a lock released while its age is read is not an error: the next try takes it', () => {
  const p = project();
  fs.writeFileSync(p.lock, '4242 tok\n');
  let calls = 0;
  const now = () => {
    // the 2nd reading of the clock is the lock's age: its builder finishes just before
    if (++calls === 2) fs.rmSync(p.lock);
    return Date.now();
  };
  const build = recorder(p.fresh);
  assert.equal(
    sageMcp.ensureBuilt({ ...p, swift: () => true, alive: () => true, sleep: (() => {}) as any, now, build: build as any }),
    p.exe,
  );
  assert.equal(build.calls.length, 1);
});
