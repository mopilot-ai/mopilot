// Every kind of delivery the journal queues to a chat says what the user removing it from that queue does: a payload moved
// out of the journal when the item was composed (a wake-up's notes) must go back, so a new kind cannot silently lose its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/session/orchestration/', 'shared/orchestration.d.ts'];

const require = createRequire(import.meta.url);
const { ON_REMOVED } = require('../electron/session/orchestration/userRemoval.cjs');

/** The `kind: '...'` members of the SideSessionDelivery union in shared/orchestration.d.ts. */
function deliveryKinds(): string[] {
  const src = fs.readFileSync(new URL('../shared/orchestration.d.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export type SideSessionDelivery');
  const end = src.indexOf('/** A session a chat proposed', start);
  assert.ok(start > 0 && end > start, 'the delivery union is where this test looks for it');
  return [...src.slice(start, end).matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]).sort();
}

test('every delivery kind has a user-removal rule, and no rule is for a kind that is gone', () => {
  const kinds = deliveryKinds();
  assert.ok(kinds.length >= 3);
  assert.deepEqual(Object.keys(ON_REMOVED).sort(), kinds);
});

test('every kind the orchestrator writes into deliveries is one the union names', () => {
  const dir = new URL('../electron/session/orchestration/', import.meta.url);
  const written = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')))
    for (const m of fs.readFileSync(new URL(file, dir), 'utf8').matchAll(/deliveries\[[^\]]+\]\s*=\s*\{\s*(?:\n\s*)?kind: '([a-z-]+)'/g))
      written.add(m[1]);
  assert.ok(written.size >= 3, 'the scan finds the writers');
  assert.deepEqual(
    [...written].filter((k) => !deliveryKinds().includes(k)),
    [],
  );
});
