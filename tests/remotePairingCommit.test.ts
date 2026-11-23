// Mobile Remote pairing activation survives cancellation, overlapping removal and uncertain storage outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as E from '../shared/remote/envelope.mjs';
import { fs } from './support/remoteKit.ts';
import { crypto, helloFor, makePhone, openReply } from './support/remotePhone.ts';
import { deferred } from './support/async-scenarios.ts';
import { rig, states } from './support/remotePairingRig.ts';
const require = createRequire(import.meta.url);
const { DeviceList } = require('../electron/remote/deviceList.cjs');
test('cancelling while a paired device write is pending does not keep or report the new pair', async () => {
  const r = rig();
  const saved = deferred<void>();
  const release = deferred<void>();
  const rename = r.devices.o.fs.rename;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      saved.resolve();
      await release.promise;
    },
  };
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const pending = r.svc.handleHello(helloFor(phone, payload));
  await saved.promise;
  r.svc.cancel();
  release.resolve();
  assert.equal(await pending, 'declined');
  assert.equal(r.devices.get(phone.id), null);
  const reopened = new DeviceList(r.devices.o);
  await reopened.load();
  assert.equal(reopened.get(phone.id), null);
  assert.equal(states(r).includes('paired'), false);
});

test('retired re-pair staging cannot resurrect a device removed while its write is pending', async () => {
  const r = rig();
  const phone = makePhone('phone-1');
  const first = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(phone, first.payload)), 'paired');
  const next = await r.svc.begin();
  const staged = deferred<void>();
  const release = deferred<void>();
  const rename = r.devices.o.fs.rename;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      staged.resolve();
      await release.promise;
    },
  };
  const pending = r.svc.handleHello(helloFor(phone, next.payload));
  await staged.promise;
  const removal = r.devices.remove(phone.id);
  r.svc.cancel();
  release.resolve();
  assert.equal(await pending, 'declined');
  assert.equal(await removal, true);
  assert.equal(r.devices.get(phone.id), null);
  const reopened = new DeviceList(r.devices.o);
  await reopened.load();
  assert.equal(reopened.get(phone.id), null);
});

test('a failed activation leaves the staged pair inactive after restart', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  let writes = 0;
  const rename = r.devices.o.fs.rename;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      if (++writes === 2) throw new Error('activation failed');
      await (rename as any)(...args);
    },
  };
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'failed');
  assert.equal(r.devices.get(phone.id), null);
  const reopened = new DeviceList(r.devices.o);
  await reopened.load();
  assert.equal(reopened.get(phone.id), null);
});

test('after approved activation starts, cancellation cannot undo the committed pair', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  const committed = deferred<void>();
  const release = deferred<void>();
  let writes = 0;
  const rename = r.devices.o.fs.rename;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      if (++writes === 2) {
        committed.resolve();
        await release.promise;
      }
    },
  };
  const pending = r.svc.handleHello(helloFor(phone, begun.payload));
  await committed.promise;
  r.svc.cancel();
  release.resolve();
  assert.equal(await pending, 'paired');
  const reopened = new DeviceList(r.devices.o);
  await reopened.load();
  assert.ok(reopened.get(phone.id));
});

test('post-rename sync failure reports an uncertain outcome and fences access until restart', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  let renames = 0;
  const originalRename = r.devices.o.fs.rename;
  const originalOpen = r.devices.o.fs.open;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (originalRename as any)(...args);
      renames++;
    },
    open: async (...args: any[]) => {
      if (renames === 2 && args[1] === 'r') throw new Error('directory sync failed');
      return (originalOpen as any)(...args);
    },
  };
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'failed');
  assert.equal(r.state.events.at(-1).error, 'uncertain');
  assert.equal(openReply(phone, begun.payload, r.state.replies[0]).ok, false);
  assert.equal(r.devices.lease(phone.id, crypto.pairId(E.fromBase64(begun.payload.code))), null);
  await assert.rejects(r.devices.remove(phone.id), /recovery/);
  assert.equal(r.devices.currentLease({ id: phone.id, pairId: 'any', token: {} }), false);
  await assert.rejects(
    r.devices.addGuarded(
      { id: phone.id },
      () => true,
      () => undefined,
    ),
    /recovery/,
  );
  const reopened = new DeviceList({ ...r.devices.o, fs });
  await reopened.load();
  assert.ok(reopened.get(phone.id));
});

test('guarded pair writes respect a retired owner and tolerate a listener failure', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'paired');
  const old = r.devices.get(phone.id);
  assert.equal(
    await r.devices.addGuarded(
      { ...old, pairId: 'new' },
      () => false,
      () => {
        throw new Error('not called');
      },
    ),
    false,
  );
  r.devices.onChange(() => {
    throw new Error('listener failed');
  });
  assert.equal(
    await r.devices.addGuarded(
      { ...old, pairId: 'new' },
      () => true,
      () => undefined,
    ),
    true,
  );
  assert.equal(r.devices.get(phone.id).pairId, 'new');
});

test('an indeterminate remove, rename or ratchet update fences the old snapshot until a new store reads disk', async () => {
  for (const operation of ['remove', 'rename', 'update']) {
    const r = rig();
    const begun = await r.svc.begin();
    const phone = makePhone();
    assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'paired');
    const original = r.devices.get(phone.id);
    const lease = r.devices.lease(phone.id, original.pairId);
    let renamed = false;
    const rename = r.devices.o.fs.rename;
    const open = r.devices.o.fs.open;
    r.devices.o.fs = {
      ...fs,
      rename: async (...args: any[]) => {
        await (rename as any)(...args);
        renamed = true;
      },
      open: async (...args: any[]) => {
        if (renamed && args[1] === 'r') throw new Error('directory sync failed');
        return (open as any)(...args);
      },
    };
    const work =
      operation === 'remove'
        ? r.devices.remove(phone.id)
        : operation === 'rename'
          ? r.devices.rename(phone.id, 'Renamed')
          : r.devices.update(phone.id, { lastSeenAt: 123 }, original.pairId);
    await assert.rejects(work, /directory sync failed/);
    assert.equal(r.devices.currentLease(lease), false);
    assert.equal(r.devices.lease(phone.id, original.pairId), null);
    await assert.rejects(r.devices.rename(phone.id, 'stale write'), /recovery/);
    const reopened = new DeviceList({ ...r.devices.o, fs });
    await reopened.load();
    const read = reopened.get(phone.id);
    if (operation === 'remove') assert.equal(read, null);
    if (operation === 'rename') assert.equal(read.name, 'Renamed');
    if (operation === 'update') assert.equal(read.lastSeenAt, 123);
  }
});

test('stage directory-sync failure locks storage without claiming activation was attempted', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  let renamed = false;
  const rename = r.devices.o.fs.rename;
  const open = r.devices.o.fs.open;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      renamed = true;
    },
    open: async (...args: any[]) => {
      if (renamed && args[1] === 'r') throw 'sync failed';
      return (open as any)(...args);
    },
  };
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'failed');
  assert.equal(r.state.events.at(-1).error, 'storage-locked');
  const reopened = new DeviceList({ ...r.devices.o, fs });
  await reopened.load();
  assert.equal(reopened.get(phone.id), null);
});

test('relay removal during local confirmation prevents the phone from being paired', async () => {
  const decision = deferred<'allow'>();
  const r = rig({ confirm: () => decision.promise });
  const begun = await r.svc.begin();
  const phone = makePhone();
  const pending = r.svc.handleHello(helloFor(phone, begun.payload));
  await new Promise((resolve) => setImmediate(resolve));
  r.svc.pairRemoved(crypto.pairId(E.fromBase64(begun.payload.code)));
  decision.resolve('allow');
  assert.equal(await pending, 'declined');
  assert.equal(r.devices.get(phone.id), null);
});

test('relay removal invalidates a pending QR before a phone hello arrives', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const pair = crypto.pairId(E.fromBase64(begun.payload.code));
  r.svc.pairRemoved(pair);
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), begun.payload)), 'ignored');
  assert.equal(states(r).at(-1), 'cancelled');
});

test('relay removal during activation suppresses paired success and removes only the matching pair', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  const activated = deferred<void>();
  const release = deferred<void>();
  let writes = 0;
  const rename = r.devices.o.fs.rename;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      if (++writes === 2) {
        activated.resolve();
        await release.promise;
      }
    },
  };
  const pending = r.svc.handleHello(helloFor(phone, begun.payload));
  await activated.promise;
  const pair = crypto.pairId(E.fromBase64(begun.payload.code));
  r.svc.pairRemoved(pair);
  release.resolve();
  assert.equal(await pending, 'declined');
  assert.equal(r.devices.get(phone.id), null);
  assert.equal(states(r).includes('paired'), false);
});

test('a delayed relay removal cannot remove a replacement pair for the same phone', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'paired');
  const old = r.devices.get(phone.id);
  await r.devices.add({ ...old, pairId: 'replacement' });
  assert.equal(await r.devices.removePair(phone.id, old.pairId), false);
  assert.equal(r.devices.get(phone.id).pairId, 'replacement');
});

test('relay retirement fences old and new leases even if durable deletion fails', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'paired');
  const old = r.devices.get(phone.id);
  const lease = r.devices.lease(phone.id, old.pairId);
  r.devices.retirePair(old.pairId);
  r.devices.o.fs = {
    ...fs,
    rename: async () => {
      throw new Error('disk failed');
    },
  };
  await assert.rejects(r.devices.removePair(phone.id, old.pairId), /disk failed/);
  assert.equal(r.devices.currentLease(lease), false);
  assert.equal(r.devices.lease(phone.id, old.pairId), null);
  r.devices.o.fs = fs;
  await r.devices.add({ ...old, pairId: 'replacement' });
  assert.ok(r.devices.lease(phone.id, 'replacement'));
});

test('a removed pairing never reports success if its local deletion fails', async () => {
  const r = rig();
  const begun = await r.svc.begin();
  const phone = makePhone();
  const activated = deferred<void>();
  const release = deferred<void>();
  let writes = 0;
  const rename = r.devices.o.fs.rename;
  r.devices.o.fs = {
    ...fs,
    rename: async (...args: any[]) => {
      await (rename as any)(...args);
      if (++writes === 2) {
        activated.resolve();
        await release.promise;
      }
    },
  };
  const pending = r.svc.handleHello(helloFor(phone, begun.payload));
  await activated.promise;
  const pair = crypto.pairId(E.fromBase64(begun.payload.code));
  r.svc.pairRemoved(pair);
  r.devices.removePair = async () => {
    throw new Error('disk unavailable');
  };
  release.resolve();
  assert.equal(await pending, 'failed');
  assert.equal(r.state.events.at(-1).error, 'uncertain');
  assert.equal(r.devices.lease(phone.id, pair), null);
  assert.equal(states(r).includes('paired'), false);
});
