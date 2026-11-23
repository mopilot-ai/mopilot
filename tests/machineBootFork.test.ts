// A boot of its own for each machine the app makes itself (machineBoot.cjs `fork`): same dependencies, its own view listener, so a join it allows belongs to its own command only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMachineBoot } = require('../electron/host/machineBoot.cjs');

test('fork makes another boot over the same registry, relay and pairing, with its own view listener', () => {
  const made: any[] = [];
  const deps = {
    relay: null,
    registry: { add: () => undefined, list: () => [] },
    bundle: () => ({}),
    updateKey: () => 'k',
    pair: async () => undefined,
    openPaired: async () => ({}),
  };
  const makeBoot = (o: any) => (made.push(o), { view: { state: 'idle' } });
  const boot = createMachineBoot({ ...deps, onView: () => undefined, makeBoot });
  const seen: any[] = [];
  const child = boot.fork((v: any) => seen.push(v));
  assert.equal(typeof child.allow, 'function');
  assert.equal(typeof child.fork, 'function');
  assert.notEqual(child, boot);
  assert.equal(typeof child.view, 'function');
});
