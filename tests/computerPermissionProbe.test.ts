// Exercises non-launching permission status reads through the native helper client's real transport boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

function client() {
  let launches = 0;
  const helper = new ComputerHelper({
    spawn: () => {
      launches++;
      throw new Error('native launches prohibited');
    },
  });
  return { helper, launches: () => launches };
}

test('a non-launching permission probe never starts a stopped or starting helper', async () => {
  for (const state of ['stopped', 'starting', 'connected-starting']) {
    const r = client();
    if (state !== 'stopped') r.helper.starting = Promise.resolve({});
    if (state === 'connected-starting') r.helper.socket = { write: () => assert.fail('no probe before hello completes') };
    await assert.rejects(r.helper.permissionStatus({ noLaunch: true }), (e: any) => e.reason === 'helper_not_running');
    assert.equal(r.launches(), 0);
  }
});

test('a non-launching permission probe does not restart a helper that exits while reading', async () => {
  const r = client();
  r.helper.socket = {
    write: (line: string) => {
      const { id } = JSON.parse(line);
      r.helper.socket = null;
      const pending = r.helper.pending.get(id);
      r.helper.pending.delete(id);
      pending.reject(Object.assign(new Error('helper exited'), { reason: 'helper_exited' }));
    },
  };
  await assert.rejects(r.helper.permissionStatus({ noLaunch: true }), (e: any) => e.reason === 'helper_exited');
  assert.equal(r.launches(), 0);
});

test('a live non-launching permission probe sends the native request and records its response', async () => {
  const r = client();
  const status = { accessibility: true, screenRecording: true };
  r.helper.socket = {
    write: (line: string) => {
      const request = JSON.parse(line);
      assert.equal(request.method, 'permissions.status');
      const pending = r.helper.pending.get(request.id);
      r.helper.pending.delete(request.id);
      pending.resolve(status);
    },
  };
  assert.equal(await r.helper.permissionStatus({ noLaunch: true }), status);
  assert.deepEqual(r.helper.permissions, status);
  assert.equal(r.launches(), 0);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(
    guarded({ signal: stop.signal }, () => r.helper.permissionStatus({ noLaunch: true })),
    (e: any) => e.reason === 'aborted',
  );
});
