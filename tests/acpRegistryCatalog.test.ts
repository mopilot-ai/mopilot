// Registry refresh ownership, cache persistence and malformed/offline answers through the production catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
import { agent, directory, rawAgent, response } from './support/acp-registry.ts';

const require = createRequire(import.meta.url);
const { RegistryCatalog, FRESH_MS } = require('../electron/harness/registry/catalog.cjs');

test('registry discovery is lazy, coalesces reads and caches a normalized snapshot across restarts', async () => {
  const file = path.join(directory(), 'nested', 'catalog.json');
  let now = 1000;
  let calls = 0;
  const gate = deferred<Response>();
  const catalog = new RegistryCatalog({ file, now: () => now, fetch: () => (calls++, gate.promise) });
  assert.equal(calls, 0);
  const a = catalog.list();
  assert.equal(catalog.list({ force: true }), a);
  gate.resolve(response([rawAgent()]));
  assert.deepEqual((await a).agents, [agent()]);
  assert.equal(calls, 1);
  await catalog.list();
  now += FRESH_MS - 1;
  await catalog.list();
  assert.equal(calls, 1);
  now++;
  catalog.fetch = async () => (calls++, response([rawAgent('next')]));
  await catalog.list();
  assert.equal(calls, 2);
  const restored = new RegistryCatalog({ file, now: () => now, fetch: () => assert.fail('fresh cache needs no network') });
  assert.deepEqual((await restored.list()).agents, [agent('next')]);
  catalog.dispose();
  restored.dispose();
  await assert.rejects(catalog.list(), /closed/);
});

test('bad HTTP, oversized, malformed and offline replies keep the last good disk and memory snapshot, then retry', async () => {
  const file = path.join(directory(), 'catalog.json');
  const catalog = new RegistryCatalog({ file, fetch: async () => response([rawAgent()]) });
  await catalog.list();
  const saved = fs.readFileSync(file, 'utf8');
  for (const failure of [
    async () => response([], 503),
    async () => ({ ok: true, text: async () => ' '.repeat(2 * 1024 * 1024 + 1) }),
    async () => ({ ok: true, text: async () => '{' }),
    async () => response([null]),
    async () => {
      throw new Error('offline');
    },
  ]) {
    catalog.fetch = failure as any;
    const result = await catalog.list({ force: true });
    assert.match(result.error!, /Could not refresh/);
    assert.deepEqual(result.agents, [agent()]);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  }
  catalog.fetch = async () => response([rawAgent('retry')]);
  assert.equal((await catalog.list({ force: true })).error, null);
  assert.equal(catalog.agents[0].id, 'retry');
  catalog.dispose();
});

test('dispose retires pending fetch and body successes or failures without replacing the saved cache', async () => {
  for (const stage of ['fetch', 'body'])
    for (const reject of [false, true]) {
      const file = path.join(directory(), 'catalog.json');
      fs.writeFileSync(file, JSON.stringify({ agents: [agent()], checkedAt: 1 }));
      const saved = fs.readFileSync(file, 'utf8');
      const gate = deferred<any>();
      const catalog = new RegistryCatalog({
        file,
        fetch: stage === 'fetch' ? () => gate.promise : async () => ({ ok: true, text: () => gate.promise }) as any,
      });
      const work = catalog.list({ force: true });
      await new Promise((resolve) => setImmediate(resolve));
      catalog.dispose();
      if (reject) gate.reject(new Error('retired'));
      else gate.resolve(stage === 'fetch' ? response([rawAgent('stale')]) : JSON.stringify({ agents: [rawAgent('stale')] }));
      assert.deepEqual((await work).agents, [agent()]);
      assert.equal(catalog.error, null);
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
    }
});

test('corrupt and future-dated discovery caches are ignored and a failed persistence keeps prior memory', async () => {
  for (const value of ['{', JSON.stringify({ agents: [null], checkedAt: 1 }), JSON.stringify({ agents: [agent()], checkedAt: 999 })]) {
    const file = path.join(directory(), 'catalog.json');
    fs.writeFileSync(file, value);
    const catalog = new RegistryCatalog({ file, now: () => 5, fetch: async () => response([rawAgent('fresh')]) });
    assert.deepEqual(catalog.agents, []);
    assert.equal((await catalog.list()).agents[0].id, 'fresh');
    catalog.dispose();
  }
  const parent = directory();
  const catalog = new RegistryCatalog({ file: path.join(parent, 'cache.json'), fetch: async () => response([rawAgent()]) });
  fs.rmSync(parent, { recursive: true });
  fs.writeFileSync(parent, 'blocked');
  assert.match((await catalog.list()).error!, /Could not refresh/);
  assert.deepEqual(catalog.agents, []);
  catalog.dispose();
});
