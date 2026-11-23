// Every admitted ACP quirks entry must have a corresponding conformance fixture before it reaches main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMimic } from './support/acpConformanceMimics.ts';
const require = createRequire(import.meta.url);
const quirks = require('../electron/harness/quirks/index.cjs');

test('each admitted ACP harness has an explicit conformance profile', () => {
  for (const id of quirks.ids()) assert.ok(loadMimic(id), `${id} has no conformance profile`);
});

test('fixture discovery rejects invalid ids and a missing profile', () => {
  assert.throws(() => loadMimic('../elsewhere'), /Invalid ACP fixture id/);
  assert.throws(() => loadMimic('no-such-harness'), /no-such-harness/);
});

test('each profile includes every mode and plan anchored by its quirks', () => {
  for (const id of quirks.ids()) {
    const q = quirks.quirks(id);
    const profile = loadMimic(id);
    const ids = new Set([
      ...(profile.modes?.availableModes ?? []).map((m: any) => m.id),
      ...((profile.configOptions ?? []).find((o: any) => o.id === 'mode')?.options ?? []).map((o: any) => o.value),
    ]);
    for (const mode of Object.keys(q.anchors ?? {})) assert.ok(ids.has(mode), `${id} has no mode ${mode}`);
    if (q.plan) assert.ok(ids.has(q.plan.mode ?? q.plan.value), `${id} has no plan mode`);
  }
});
