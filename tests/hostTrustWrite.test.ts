// Host trust-file ownership: one physical config directory has one synchronous writer, including nested pairing/key-store changes, competing CLI processes and recovery after a writer dies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { withTrustWrite } from '../host/src/trustWrite.mjs';
import { tryLock } from '../scripts/pid-lock.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-trust-write-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const config = () => fs.mkdtempSync(path.join(base, 'config-'));

test('nested writes through a symlink share the owner; exceptions release it for the next write', () => {
  const dir = config();
  const alias = `${dir}-link`;
  fs.symlinkSync(dir, alias);
  assert.equal(
    withTrustWrite(dir, () => withTrustWrite(alias, () => 42)),
    42,
  );
  assert.equal(fs.existsSync(path.join(dir, 'trust-write.lock')), false);
  assert.throws(
    () =>
      withTrustWrite(dir, () => {
        throw new Error('disk fault');
      }),
    /disk fault/,
  );
  assert.equal(
    withTrustWrite(alias, () => 7),
    7,
  );
});

test('an existing live owner is a retryable refusal, never a stale-snapshot write', () => {
  const dir = config();
  const owner = tryLock(path.join(dir, 'trust-write.lock'));
  assert.equal(owner.owned, true);
  if (!owner.owned) throw new Error('test needs the lock');
  try {
    assert.throws(
      () => withTrustWrite(dir, () => assert.fail('must not run')),
      (e: any) => e.code === 'trust_busy',
    );
  } finally {
    owner.release();
  }
  assert.equal(
    withTrustWrite(dir, () => 'retry'),
    'retry',
  );
});

test('a separate process holds the same lock; after SIGKILL the next writer recovers it', async (t) => {
  const dir = config();
  const module = new URL('../host/src/trustWrite.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { withTrustWrite } from ${JSON.stringify(module)};
    withTrustWrite(${JSON.stringify(dir)}, () => {
      process.stdout.write('held\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  const output = await Promise.race([
    once(child.stdout!, 'data').then(([bytes]) => String(bytes)),
    once(child, 'exit').then(() => {
      throw new Error('writer exited before acquiring trust');
    }),
  ]);
  assert.match(output, /held/);
  assert.throws(
    () => withTrustWrite(dir, () => assert.fail('another process owns it')),
    (e: any) => e.code === 'trust_busy',
  );
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
  assert.equal(
    withTrustWrite(dir, () => 'recovered'),
    'recovered',
  );
  assert.equal(fs.existsSync(path.join(dir, 'trust-write.lock')), false);
});
