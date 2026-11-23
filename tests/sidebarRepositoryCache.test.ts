// Sidebar repository lookups share reads and retain verified identities across a transient failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { sidebarRepositories } = require('../electron/platform/sidebarRepositories.cjs');

test('coalesces matching reads, persists only decided facts, and separates machine registrations', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answer = deferred<string>();
  const read = sidebarRepositories(dir);
  const key = JSON.stringify(['box', 'first-key', '/checkout']);
  const active = read(key, () => answer.promise);
  assert.equal(
    sidebarRepositories(dir)(key, async () => {
      throw new Error('duplicate read');
    }),
    active,
  );
  answer.resolve('github.com/org/app');
  assert.equal(await active, 'github.com/org/app');
  const otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-repo-'));
  t.after(() => fs.rmSync(otherDirectory, { recursive: true, force: true }));
  fs.copyFileSync(path.join(dir, 'sidebar-repositories.json'), path.join(otherDirectory, 'sidebar-repositories.json'));
  const restarted = sidebarRepositories(otherDirectory);
  assert.equal(await restarted(key, async () => undefined), 'github.com/org/app');
  assert.equal(await restarted(JSON.stringify(['box', 'replacement-key', '/checkout']), async () => undefined), null);
  assert.equal(await restarted(key, async () => null), null);
});

test('unrelated probes wait for a shared slot and a rejected probe frees its slot', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = sidebarRepositories(dir);
  const gate = deferred<string>();
  let started = 0;
  const requests = Array.from({ length: 5 }, (_, index) =>
    read(String(index), () => {
      started++;
      return index < 4 ? gate.promise : Promise.resolve('github.com/org/next');
    }),
  );
  await Promise.resolve();
  assert.equal(started, 4);
  gate.reject(new Error('offline'));
  assert.deepEqual(await Promise.all(requests), [null, null, null, null, 'github.com/org/next']);
  assert.equal(started, 5);
});

test('a corrupt snapshot is ignored and a successful read repairs it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sidebar-repositories.json');
  fs.writeFileSync(file, '{');
  const read = sidebarRepositories(dir);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(await read('app', async () => 'github.com/owner/app'), 'github.com/owner/app');
  assert.equal(await read('app', async () => null), 'github.com/owner/app');
  t.mock.timers.tick(60_000);
  assert.equal(await read('app', async () => 'github.com/owner/app'), 'github.com/owner/app');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, entries: [['app', 'github.com/owner/app']] });
});

test('the snapshot and freshness index stay bounded as more folders are discovered', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sidebar-repositories.json');
  const entries = Array.from({ length: 2048 }, (_, index) => [`path-${index}`, 'github.com/owner/app']);
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries }));
  const read = sidebarRepositories(dir);
  for (let index = 0; index < entries.length; index++) {
    assert.equal(await read(`missing-${index}`, async () => null), null);
  }
  assert.equal(await read('missing-5', async () => 'github.com/owner/uncached'), null);
  assert.equal(await read('new', async () => 'github.com/owner/new'), 'github.com/owner/new');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
  assert.equal(stored.length, 2048);
  assert.deepEqual(stored.at(-1), ['new', 'github.com/owner/new']);
  assert.equal(await read('path-0', async () => undefined), null);
  // The oldest freshness entry is eligible to check again after reaching the bound.
  assert.equal(await read('missing-0', async () => 'github.com/owner/found'), 'github.com/owner/found');
});
