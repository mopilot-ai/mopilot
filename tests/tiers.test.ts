// The service tiers a Codex model reports: every one is offered as named, "default" is Standard, and a stored tier
// the model doesn't list counts as Standard (D-57).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTier, codexTiers } from '../src/harness/tiers.ts';

test('every reported tier is offered with its name and note; default is left out', () => {
  const tiers = codexTiers({
    serviceTiers: [
      { id: 'priority', name: 'Fast', description: '1.5x speed, 2x credits' },
      { id: 'flex', name: 'Flex', description: 'Half price' },
      { id: 'default', name: 'Standard' },
    ],
  });
  assert.deepEqual(tiers, [
    { id: 'priority', name: 'Fast', description: '1.5x speed, 2x credits' },
    { id: 'flex', name: 'Flex', description: 'Half price' },
  ]);
  assert.deepEqual(codexTiers({ serviceTiers: [{ id: 'scale' }] }), [{ id: 'scale', name: 'scale', description: '' }]);
  assert.deepEqual(codexTiers(null), []);
  assert.deepEqual(codexTiers({}), []);
});

test('the stored tier counts only when the model offers it', () => {
  const tiers = codexTiers({
    serviceTiers: [
      { id: 'priority', name: 'Fast' },
      { id: 'flex', name: 'Flex' },
    ],
  });
  assert.equal(activeTier(tiers, 'flex'), 'flex');
  assert.equal(activeTier(tiers, 'priority'), 'priority');
  assert.equal(activeTier(tiers, 'default'), null);
  assert.equal(activeTier(tiers, 'ultrafast'), null);
  assert.equal(activeTier(tiers, null), null);
  assert.equal(activeTier([], 'priority'), null);
});
