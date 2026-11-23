// How main hands the person's "Update automatically" to the machines service (electron/app/ipc/host.cjs): read from the saved preferences each time Host auto-update asks, on unless it was turned off, and on while no state can be read yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('../electron/app/ipc/host.cjs');

test('the machines service is told whether the person left Update automatically on, read afresh each time', async () => {
  const handlers = new Map<string, any>();
  let opts: any;
  let state: any = { prefs: {} };
  const svc: any = { list: () => ({ machines: [], resolved: true }), dispose: () => undefined, sshArgsFor: () => [] };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => '/ud', once: () => undefined },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
      readState: () => state,
    },
    {
      create: (o: any) => ((opts = o), svc),
      allowed: () => true,
      makeAskpass: () => ({ env: async () => ({ env: {}, release: () => undefined }), close: () => undefined }),
    },
  );
  await handlers.get('host:machines')({});
  assert.equal(opts.autoUpdateOn(), true, 'the default is on');
  state = { prefs: { autoUpdate: false } };
  assert.equal(opts.autoUpdateOn(), false, 'turned off in Settings');
  state = { prefs: { autoUpdate: true } };
  assert.equal(opts.autoUpdateOn(), true);
  state = undefined;
  assert.equal(opts.autoUpdateOn(), true, 'no state yet is not a refusal');
});
