// The MoPilot 12-Grid Bench catalog (#1381): every task is well formed and unique, every family and surface it should
// cover is covered, and every one of the 12 grid cells has a smoke task and three or more tasks in all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOG } = await import('../bench/lib/mgb/tasks/index.mjs');
const { cellsOf, validateTask, FAMILIES, SURFACES, COLUMNS } = await import('../bench/lib/mgb/schema.mjs');

test('every task in the catalog is valid, once', () => {
  const ids = CATALOG.map((t: any) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of CATALOG) assert.deepEqual(validateTask(t), [], t.id);
  assert.ok(CATALOG.length >= 32);
});

test('the catalog covers its families, and every grid cell has a smoke task and three or more full ones', () => {
  const families = new Set(CATALOG.map((t: any) => t.family));
  for (const f of Object.keys(FAMILIES)) assert.ok(families.has(f), f);
  const cells = (tier?: string) => CATALOG.filter((t: any) => !tier || t.tier === tier).flatMap((t: any) => cellsOf(t));
  // every one of the 12 cells: a smoke task, and at least three tasks in the full tier
  for (const s of SURFACES)
    for (const c of COLUMNS) {
      assert.ok(cells('smoke').includes(`${s}×${c}`), `smoke ${s}×${c}`);
      assert.ok(cells().filter((x: string) => x === `${s}×${c}`).length >= 3, `full ${s}×${c}`);
    }
});
