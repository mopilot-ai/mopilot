// Retirement snapshots use coherent kernel birth identities and fail closed when a trustworthy reader is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fakeCore } from './support/fake-core.ts';
const { identityTable, processStart, ensureRetirementMonitor } = createRequire(import.meta.url)('../electron/platform/processIdentity.cjs');
test('coherent native identities are used without touching a fallback', async () => {
  const rows = [[42, 7, 42, 'macos:123:456']];
  const read = await identityTable({
    call: async (route: string) => {
      assert.equal(route, 'proc.identities');
      return rows;
    },
  });
  assert.equal(read, rows);
});

for (const rows of [null, [], [[42, 7, 42]], [[42, 7, -1, 'birth']], [[42, 7, 42, 9]], ['malformed']])
  test(`unavailable or malformed identities (${JSON.stringify(rows)}) are not guessed`, async () => {
    assert.deepEqual(await identityTable({ call: async () => rows }), []);
  });

test('a read of the identities that fails is empty, so retirement stays unverified', async () => {
  const failing = async () => {
    throw new Error('read the process identities: EPERM');
  };
  assert.deepEqual(await identityTable({ call: failing }), []);
});

test('protected native processes remain present with explicitly unknown births', async () => {
  const rows = [[42, 7, 42, '']];
  assert.equal(await identityTable({ call: async () => rows }), rows);
});

test('a platform without trustworthy monitoring refuses before automatic package work starts and explains how to restore it', () => {
  assert.doesNotThrow(() => ensureRetirementMonitor('linux', { routes: () => ['proc.identities'] }));
  assert.doesNotThrow(() => ensureRetirementMonitor('darwin', { routes: () => ['proc.identities'] }));
  assert.throws(
    () => ensureRetirementMonitor('win32', { routes: () => ['proc.contain', 'proc.endContained', 'proc.table'] }),
    /Run this command in your terminal.*unavailable on Windows/,
  );
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.throws(() => ensureRetirementMonitor(platform, null), /The Rust core is missing/);
    assert.throws(
      () => ensureRetirementMonitor(platform, { routes: () => ['proc.table'] }),
      /cannot verify package installer shutdown.*Rebuild or update/,
    );
  }
});

test("when a process started is the core's milliseconds; no answer of any kind is null", async () => {
  const dated = fakeCore({ 'proc.started': 1_700_000_000_123 });
  assert.equal(await processStart(7, dated.addon), 1_700_000_000_123);
  assert.deepEqual(dated.asked, ['proc.started 7']);
  assert.equal(await processStart(7, fakeCore({ 'proc.started': null }).addon), null, 'no such process');
  assert.equal(await processStart(7, fakeCore({ 'proc.started': new Error('read when 7 started: EPERM') }).addon), null, 'refused');
  assert.equal(await processStart(7, fakeCore({ 'proc.started': 'soon' }).addon), null, 'garbled');
  assert.equal(await processStart(7, fakeCore({}).addon), null, 'a core without the route');
  assert.equal(await processStart(7, null), null, 'no core');
});

test('the real core dates this process as node does, and no process at all as null', async () => {
  const at = await processStart(process.pid);
  const started = Date.now() - process.uptime() * 1000;
  assert.ok(at !== null && Math.abs(at - started) < 5000, `the core said ${at}, node ${started}`);
  assert.equal(await processStart(2 ** 30), null);
});

test("the real core dates another user's process (init) as ps does", { skip: process.platform === 'win32' }, async () => {
  const printed = execFileSync('ps', ['-o', 'lstart=', '-p', '1'], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  const at = await processStart(1);
  assert.ok(at !== null && Math.abs(at - Date.parse(`${printed.trim()} UTC`)) < 1500, `the core said ${at}, ps ${printed}`);
});
