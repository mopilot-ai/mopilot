// A Codex account helper (electron/identity/accounts/sidecar.cjs) started while its binary is still looked up: it
// starts once the lookup answers, a close meanwhile starts nothing, a failed lookup ends it, and accounts reuse a
// helper still starting rather than starting another. Codex is faked (tests/support/electron-accounts.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, codex, flush } from './support/electron-accounts.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { Sidecar } = require('../electron/identity/accounts/sidecar.cjs');

test('a helper whose binary is still looked up starts once it answers; calls wait for it', async (t) => {
  setup(t);
  const bin = deferred();
  const sc = new Sidecar(bin.promise, '/h', undefined, { name: 'x' });
  assert.equal(sc.proc, null);
  assert.equal(sc.running, true);
  const r = sc.call('account/read', {});
  await flush();
  assert.equal(codex.procs.length, 0);
  bin.resolve('/x/codex');
  assert.deepEqual(await r, { account: { email: 'side@example.com', planType: 'pro' } });
  assert.equal(codex.procs.length, 1);
  assert.deepEqual(
    codex.procs[0].written.map((m: any) => m.method),
    ['initialize', 'initialized', 'account/read'],
  );
  assert.equal(sc.running, true);
  sc.close();
});

test('closing a helper during the lookup starts nothing; it has exited and its calls fail', async (t) => {
  setup(t);
  const bin = deferred();
  let exits = 0;
  const sc = new Sidecar(bin.promise, '/h', () => exits++, { name: 'x' });
  const r = sc.call('account/read', {});
  await sc.close();
  assert.equal(exits, 1);
  assert.equal(sc.running, false);
  bin.resolve('/x/codex');
  await assert.rejects(r, /Codex exited/);
  assert.equal(codex.procs.length, 0);
  // closing again changes nothing
  await sc.close();
  assert.equal(exits, 1);
});

test('a failed lookup ends the helper with its error', async (t) => {
  setup(t);
  const bin = deferred();
  let exits = 0;
  const sc = new Sidecar(bin.promise, '/h', () => exits++, { name: 'x' });
  bin.reject(new Error('no codex'));
  await assert.rejects(sc.call('account/read', {}), /no codex/);
  await sc.exited;
  assert.equal(exits, 1);
  assert.equal(sc.running, false);
  assert.equal(codex.procs.length, 0);
});

test('accounts reuse a helper still looking up its binary, and start another once it ended', async (t) => {
  const { a } = setup(t);
  const lookups: ReturnType<typeof deferred>[] = [];
  a.findBin = () => {
    const d = deferred();
    lookups.push(d);
    return d.promise;
  };
  const acc = a.active();
  const first = a.sidecar(acc);
  assert.equal(a.sidecar(acc), first);
  assert.equal(lookups.length, 1);
  lookups[0].reject(new Error('no codex'));
  await first.exited;
  const second = a.sidecar(acc);
  assert.notEqual(second, first);
  lookups[1].resolve('/x/codex');
  await second.ready;
  assert.equal(codex.procs.length, 1);
  second.close();
});
