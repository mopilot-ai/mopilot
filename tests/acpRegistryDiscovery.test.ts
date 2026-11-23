// Overlapping ACP discovery reads retain the newest admission snapshot and never report retired failures over it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';
import { deferred } from './support/async-scenarios.ts';
const { detectBasicHarnesses, recheckBasic } = await import('../src/session/harness/acpDiscovery.ts');
beforeEach(() => reset());
const harness = (id: string) => ({ id, label: id, state: 'admitted', authMethods: [], bin: '/agent', login: null });

test('latest discovery and recheck win in either settlement order, including an obsolete recheck failure', async () => {
  for (const firstKind of ['harnesses', 'recheck'])
    for (const reverse of [false, true])
      for (const fails of [false, true]) {
        reset();
        const old = deferred<any>();
        const fresh = deferred<any>();
        fx.native.acp = { [firstKind]: () => old.promise };
        const first = firstKind === 'harnesses' ? detectBasicHarnesses() : recheckBasic('old');
        fx.native.acp.harnesses = () => fresh.promise;
        const second = detectBasicHarnesses();
        const settleOld = () => (fails ? old.reject(new Error('retired failure')) : old.resolve([harness('old')]));
        if (reverse) {
          fresh.resolve([harness('fresh')]);
          await second;
          settleOld();
        } else {
          settleOld();
          await first;
          fresh.resolve([harness('fresh')]);
        }
        await Promise.all([first, second]);
        assert.equal(fx.state.basicHarnesses[0].id, 'fresh');
        assert.equal(fx.state.basicListed, true);
        assert.deepEqual(called('toast'), []);
      }
});
