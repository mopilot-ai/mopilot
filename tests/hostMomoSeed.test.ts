// The seed hooks of the gate, notes and learning services (host/src/momoServices): each writes one non-empty record through its normal path, so the travel test checks every file they keep.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { world } from './support/host/momoCoreWorld.ts';

test('seeding writes one record of everything the gate, notes and learning keep, and the services show it', async (t) => {
  const w = await world(t);
  await w.home.seed();
  for (const f of ['gate-taint.json', 'gate-key.json', 'cards.json', 'bound-notes.json', 'notes.json', 'learning.json'])
    assert.ok(fs.existsSync(path.join(w.home.storage.dir, f)), `${f} was written`);
  assert.equal(w.gate.taintFor('momo-seed').tainted(), true);
  assert.equal((await w.gate.cards('seed-device')).length, 1, 'a card waits');
  assert.equal(w.notes.view()[0].lines.length, 1, 'a line is in a note');
  assert.equal(w.learning.gateRules().length, 1, 'an owner rule is on');
  assert.equal((await w.home.stores().audit.verify()).ok, true);
});
