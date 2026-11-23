// bench/lib/contract.mjs: the harness version contract's process watch (the pinned CLI served the instances) and its
// run lock (one holder, a dead holder taken over), with no VM and no real process.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../bench/lib/contract.mjs');

test('the pinned CLI is serving only when one of its processes lives across two polls and is not a --version ask', () => {
  const prefix = '/w/prefix/claude@2.1.295';
  const seen = new Set<string>();
  const ps = (...rows: string[]) => ['  PID COMMAND', ...rows].join('\n');
  assert.equal(
    c.servingProcess(ps(`  10 ${prefix}/node_modules/.bin/claude --output-format stream-json`), prefix, seen),
    false,
    'one poll is not enough',
  );
  assert.equal(c.servingProcess(ps(`  10 ${prefix}/node_modules/.bin/claude --output-format stream-json`), prefix, seen), true);
  // the app asks every candidate for its version: never proof that it runs it
  const asks = new Set<string>();
  for (let i = 0; i < 3; i++)
    assert.equal(
      c.servingProcess(
        ps(`  11 ${prefix}/node_modules/.bin/claude --version`, `  12 ${prefix}/bin/claude --help `, '  13 /opt/homebrew/bin/claude -p'),
        prefix,
        asks,
      ),
      false,
    );
  // a pid seen once, gone, then a new one: still not two polls of the same process
  const churn = new Set<string>();
  assert.equal(c.servingProcess(ps(`  20 ${prefix}/x`), prefix, churn), false);
  assert.equal(c.servingProcess(ps(`  21 ${prefix}/x`, 'garbage line'), prefix, churn), false);
  assert.equal(c.servingProcess(undefined as never, prefix, churn), false);
});

test('the run lock: one holder at a time, a dead holder taken over, a lock mid-write left alone', () => {
  const made = new Set<string>();
  const files = new Map<string, string>();
  const fsx = {
    mkdirExclusive: (d: string) => {
      if (made.has(d)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      made.add(d);
    },
    readFile: (f: string) => {
      if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(f) as string;
    },
    writeFile: (f: string, s: string) => void files.set(f, s),
    rm: (d: string) => {
      made.delete(d);
      files.delete(`${d}/owner`);
    },
  };
  const alive = new Set([100]);
  const isAlive = (pid: number) => alive.has(pid);
  assert.equal(c.acquireLock(fsx, '/w/lock', 100, isAlive), true);
  assert.equal(files.get('/w/lock/owner'), '100\n');
  assert.equal(c.acquireLock(fsx, '/w/lock', 200, isAlive), false, 'a live holder keeps it');
  alive.delete(100);
  assert.equal(c.acquireLock(fsx, '/w/lock', 200, isAlive), true, 'a dead holder is taken over');
  assert.equal(files.get('/w/lock/owner'), '200\n');
  // a holder between mkdir and writing its pid
  files.delete('/w/lock/owner');
  assert.equal(
    c.acquireLock(fsx, '/w/lock', 300, () => false),
    false,
  );
  // an owner file that is not a pid is a dead holder
  files.set('/w/lock/owner', 'junk');
  assert.equal(
    c.acquireLock(fsx, '/w/lock', 300, () => true),
    true,
  );
  // a lock that cannot be taken over (it comes back at once) is given up after one try
  const sticky = { ...fsx, rm: () => undefined, readFile: () => '1' };
  assert.equal(
    c.acquireLock(sticky, '/w/lock', 400, () => false),
    false,
  );
  assert.throws(
    () =>
      c.acquireLock(
        {
          ...fsx,
          mkdirExclusive: () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        },
        '/x',
        1,
        isAlive,
      ),
    /EACCES/,
  );
});
