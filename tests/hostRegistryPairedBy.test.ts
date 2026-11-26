// The Host registry keeps the pairedBy: 'code' mark (electron/host/registry.cjs): set when pairing by code adds the machine, kept on a re-add without it and across a restart, never on any other machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');

const world = (t: any) => {
  installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const file = path.join(d, 'hosts.json');
  const make = () => createRegistry({ file, status: async () => ({ harnesses: [], capabilities: {} }), report: () => {} });
  const registry = make();
  t.after(() => registry.dispose());
  return { registry, make };
};
const relay = 'relay:h_abcdefghijklmnop';
const of = (r: any, id: string) => r.list().find((x: any) => x.id === id)?.pairedBy;

test('a Mac paired by code is marked so, across a restart and a re-add; nothing else is', (t) => {
  const w = world(t);
  w.registry.add({ id: relay, name: 'Studio', address: relay, pairedBy: 'code' });
  w.registry.add({ id: 'h1', name: 'Build box', address: 'me@build.example' });
  w.registry.add({ id: 'h2', name: 'Other', address: 'me@other', pairedBy: 'ssh' as any });
  assert.deepEqual([of(w.registry, relay), of(w.registry, 'h1'), of(w.registry, 'h2')], ['code', undefined, undefined]);
  // added again (a heartbeat's update) without the mark: kept
  w.registry.add({ id: relay, name: 'Studio', address: relay });
  assert.equal(of(w.registry, relay), 'code');
  w.registry.dispose();
  const again = w.make();
  t.after(() => again.dispose());
  assert.equal(of(again, relay), 'code', 'kept across a restart');
  assert.equal(of(again, 'h1'), undefined);
});
