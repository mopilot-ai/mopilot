// A fake conformance admission probe retains ownership until its exact child exits, including a rejected probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { app, probeFake } from './conformance/lib/acp.mjs';

for (const rejected of [false, true]) {
  test(`fake admission waits for its child exit, rejected probe ${rejected}`, async (t) => {
    const proc = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill() {},
    });
    const require = createRequire(import.meta.url);
    const agent = require('../electron/harness/acp/agent.cjs');
    const spawn = t.mock.method(agent, 'spawn', () => proc);
    const failure = new Error('admission failed');
    const result = { state: 'unsupported' };
    t.mock.method(app(), 'probe', async (_id: string, options: any) => {
      (options.spawnFn ?? agent.spawn)('/fake', [], {});
      if (rejected) throw failure;
      return result;
    });
    let settled = false;
    const probing = Promise.resolve(probeFake('fake', { bin: '/fake', dataDir: '/fixture/data' }, {}));
    void probing.then(
      () => (settled = true),
      () => (settled = true),
    );
    const outcome = rejected ? assert.rejects(probing, (error) => error === failure) : probing;
    try {
      for (let n = 0; n < 4; n++) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(spawn.mock.callCount(), 1);
      assert.equal(settled, false, 'a settled admission result does not establish child exit');
    } finally {
      proc.emit('exit', 0, null);
      await outcome;
    }
    if (!rejected) assert.equal(await probing, result);
  });
}
