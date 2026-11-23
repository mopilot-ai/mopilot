// Channel readiness is generation-owned: stop and a replacement start retire subscriptions from an earlier load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
import { prim } from './support/remoteKit.ts';
const { RemoteChannel } = createRequire(import.meta.url)('../electron/remote/channel.cjs');

for (const order of ['old-first', 'new-first'] as const) {
  test(`stop followed by a replacement start installs one listener set (${order})`, async () => {
    const loads = [deferred<void>(), deferred<void>()];
    let reads = 0;
    let active = 0;
    const subscribe = () => {
      active++;
      return () => active--;
    };
    const channel = new RemoteChannel({
      prim,
      devices: { load: () => loads[reads++].promise, list: () => [], onChange: subscribe },
      relay: { on: subscribe },
    });
    try {
      const old = channel.start();
      channel.stop();
      const current = channel.start();
      if (order === 'old-first') {
        loads[0].resolve();
        await old;
        assert.equal(active, 0);
        loads[1].resolve();
        await current;
      } else {
        loads[1].resolve();
        await current;
        assert.equal(active, 6);
        loads[0].resolve();
        await old;
      }
      assert.equal(active, 6);
    } finally {
      channel.stop();
    }
    assert.equal(active, 0);
  });
}
