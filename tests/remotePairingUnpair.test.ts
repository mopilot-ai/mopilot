// Settings removal owns the exact pair it observed, so a queued replacement survives stale removal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fs } from './support/remoteKit.ts';
import { helloFor, makePhone } from './support/remotePhone.ts';
import { deferred } from './support/async-scenarios.ts';
import { rig } from './support/remotePairingRig.ts';
const { DeviceList } = createRequire(import.meta.url)('../electron/remote/deviceList.cjs');

test('removing an old pair cannot delete a queued replacement for the same phone', async () => {
  const r = rig();
  const phone = makePhone();
  const begun = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'paired');
  const previous = r.devices.get(phone.id);
  const staged = deferred<void>();
  const release = deferred<void>();
  const rename = r.devices.o.fs.rename;
  let held = false;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      if (!held) {
        held = true;
        staged.resolve();
        await release.promise;
      }
    },
  };
  const replacement = r.devices.addGuarded(
    { ...previous, pairId: 'p_replacement_pair' },
    () => true,
    () => undefined,
  );
  await staged.promise;
  const removal = r.svc.unpair(phone.id, previous.pairId);
  release.resolve();
  assert.equal(await replacement, true);
  assert.equal(await removal, false);
  assert.equal(r.devices.get(phone.id).pairId, 'p_replacement_pair');
  const reopened = new DeviceList(r.devices.o);
  await reopened.load();
  assert.equal(reopened.get(phone.id).pairId, 'p_replacement_pair');
  assert.equal(r.state.cancelled.includes('p_replacement_pair'), false);
});

test('an already stale store removal preserves the replacement lease', async () => {
  const r = rig();
  const phone = makePhone();
  const begun = await r.svc.begin();
  await r.svc.handleHello(helloFor(phone, begun.payload));
  const previous = r.devices.get(phone.id);
  await r.devices.add({ ...previous, pairId: 'p_current_pair' });
  const lease = r.devices.lease(phone.id, 'p_current_pair');
  assert.ok(lease);
  assert.equal(await r.devices.removePair(phone.id, previous.pairId), false);
  assert.equal(r.devices.currentLease(lease), true);
  assert.ok(r.devices.lease(phone.id, 'p_current_pair'));
  const reopened = new DeviceList(r.devices.o);
  await reopened.load();
  const stale = reopened.removePair(phone.id, previous.pairId);
  assert.ok(reopened.lease(phone.id, 'p_current_pair'));
  assert.equal(await stale, false);
});

test('removal of a pending replacement waits for its exact activation', async () => {
  const r = rig();
  const phone = makePhone();
  const begun = await r.svc.begin();
  await r.svc.handleHello(helloFor(phone, begun.payload));
  const previous = r.devices.get(phone.id);
  const staged = deferred<void>();
  const release = deferred<void>();
  const rename = r.devices.o.fs.rename;
  let held = false;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      if (!held) {
        held = true;
        staged.resolve();
        await release.promise;
      }
    },
  };
  const replacement = r.devices.addGuarded(
    { ...previous, pairId: 'p_pending_pair' },
    () => true,
    () => undefined,
  );
  await staged.promise;
  const removal = r.devices.removePair(phone.id, 'p_pending_pair');
  release.resolve();
  assert.equal(await replacement, true);
  assert.equal(await removal, true);
  assert.equal(r.devices.get(phone.id), null);
});
