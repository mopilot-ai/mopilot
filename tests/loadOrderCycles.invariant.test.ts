// No app module reads, while it loads, a const, let or class it imports from a module in its own import cycle
// (scripts/load-order.mjs). Such a binding may not be initialized yet: the dev server throws, and the bundled app can read
// undefined and fail without a word, as task Stop did when a store-barrel move changed which module loaded first (#2525).
// Read it when called instead, inside a function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFiles, hazardsIn } from '../scripts/load-order.mjs';

export const GUARDS = ['src/', 'shared/'];

test('no module reads a binding from its own import cycle while it loads', () => {
  const hazards = hazardsIn(appFiles()).map((h: any) => `${h.file}: ${h.name} (a ${h.kind} from ${h.from})`);
  assert.deepEqual(hazards, [], 'read it inside a function (when called), or make it a function declaration');
});
