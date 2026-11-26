// What taking in a chat only a machine lists leaves in this app's records (electron/app/machineChatAdoption.cjs over electron/host/wiring.cjs): bound to the machine and folder with the epoch the machine holds, followed; released again when it never reached a window (the epoch with it); the epoch read again for a chat taken in when the Host holds a newer one; and a chat deleted here while its machine is away stays out of the list across a restart, the deletion waiting in the durable outbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { remoteChatsFor } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { machineChatAdoption } = require('../electron/app/machineChatAdoption.cjs');
const { withoutPendingDeletions } = require('../electron/host/withoutPendingDeletions.cjs');
const { createHostFolders } = require('../electron/host/folders.cjs');

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-adoption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const wired = (dir: string, o: { allowed?: boolean; status?: string } = {}) =>
  remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => o.allowed ?? true,
    machines: () => ({ hostFor: () => undefined, row: () => ({ status: o.status ?? 'offline' }) }),
    acpHost: () => undefined,
  });
const stored = (dir: string, chatId: string) => new OwnershipStore(path.join(dir, 'host-ownership.json')).get(chatId);

/** The adoption over a real ownership file, a list the test controls, and a Host that follows; `restart()` is a new service over the same folder. */
function rig(t: any) {
  const dir = tmp(t);
  const steps: string[] = [];
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  let listed: { machineId: string; rows: { chatId: string; epoch?: number }[] }[] = [];
  const rebased: string[] = [];
  const make = () => {
    const chats = wired(dir);
    return machineChatAdoption({
      folders: () => ({
        bind: (chatId: string, at: { hostId: string; folder: string }) => {
          steps.push('bind');
          own.set(chatId, { hostId: at.hostId, ownerHostId: at.hostId, epoch: 0, folder: at.folder });
        },
      }),
      chats: () => ({
        ...chats,
        get: () => ({ follow: async () => void steps.push('follow') }),
        markTakenIn: (id: string, epoch?: number) => {
          steps.push('mark');
          chats.markTakenIn(id, epoch);
        },
      }),
      deps: {
        live: {
          hostOwnership: { get: (id: string) => stored(dir, id) },
          remoteSend: { rebase: async (id: string) => void rebased.push(id) },
        },
      },
      service: () => ({ chatIndex: () => listed }),
    });
  };
  return { dir, steps, rebased, adoption: make(), restart: make, list: (next: typeof listed) => (listed = next) };
}

test('a chat is bound to its machine and folder, marked as taken in with the epoch the machine holds, and followed after that, in that order', async (t) => {
  const r = rig(t);
  await r.adoption.takeIn('acp:host-claude:a', { hostId: 'box', folder: '/srv/app', epoch: 3 });
  assert.deepEqual(r.steps, ['bind', 'mark', 'follow']);
  const bound = stored(r.dir, 'acp:host-claude:a');
  assert.deepEqual([bound.hostId, bound.epoch, bound.folder, typeof bound.takenIn], ['box', 3, '/srv/app', 'number']);
  // a machine that said no epoch leaves the binding's own
  await r.adoption.takeIn('acp:host-claude:b', { hostId: 'box', folder: '/srv/b' });
  assert.deepEqual([stored(r.dir, 'acp:host-claude:b').epoch, typeof stored(r.dir, 'acp:host-claude:b').takenIn], [0, 'number']);
});

test('the mark is on the binding: after a restart the chat is still taken in, so it still keeps its Host mode, still reads a newer epoch, and a restart without it has neither', async (t) => {
  const r = rig(t);
  await r.adoption.takeIn('acp:host-claude:a', { hostId: 'box', folder: '/w', epoch: 3 });
  const after = r.restart();
  assert.equal(after.takenIn('acp:host-claude:a'), true, 'D1: the mode rule still holds');
  // the Host moved to 4 while the app was closed: the refusal reads it from the list (D2)
  r.list([{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 4 }] }]);
  assert.equal(after.refreshEpoch('acp:host-claude:a'), true);
  assert.equal(stored(r.dir, 'acp:host-claude:a').epoch, 4);
  assert.equal(typeof stored(r.dir, 'acp:host-claude:a').takenIn, 'number', 'the mark outlives an epoch change');
  // a chat started here was never marked
  new OwnershipStore(path.join(r.dir, 'host-ownership.json')).set('acp:host-claude:mine', {
    hostId: 'box',
    ownerHostId: 'box',
    epoch: 1,
    folder: '/m',
  });
  assert.equal(r.restart().takenIn('acp:host-claude:mine'), false);
});

test('reading the epoch again never marks a chat as taken in, and never lowers it (a chat started here stays as it was)', async (t) => {
  const r = rig(t);
  new OwnershipStore(path.join(r.dir, 'host-ownership.json')).set('acp:host-claude:mine', {
    hostId: 'box',
    ownerHostId: 'box',
    epoch: 5,
    folder: '/m',
  });
  r.adoption.setEpoch('acp:host-claude:mine', 6);
  assert.deepEqual([stored(r.dir, 'acp:host-claude:mine').epoch, r.adoption.takenIn('acp:host-claude:mine')], [6, false]);
  r.adoption.setEpoch('acp:host-claude:mine', 2);
  assert.equal(stored(r.dir, 'acp:host-claude:mine').epoch, 6, 'an older epoch is not taken (the store would refuse it)');
  r.adoption.setEpoch('acp:host-claude:mine', Number.NaN);
  assert.equal(stored(r.dir, 'acp:host-claude:mine').epoch, 6);
  // so it is not releasable and not refreshed by a refusal
  r.list([{ machineId: 'box', rows: [{ chatId: 'claude:mine', epoch: 9 }] }]);
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:mine'), false);
});

test('releasing a chat that never arrived unbinds it with its mark and epoch and stops following it; it does nothing while Host is closed', async (t) => {
  const r = rig(t);
  await r.adoption.takeIn('acp:host-claude:r', { hostId: 'box', folder: '/w', epoch: 3 });
  const closed = wired(r.dir, { allowed: false });
  closed.release('acp:host-claude:r');
  closed.setEpoch('acp:host-claude:r', 9);
  closed.markTakenIn('acp:host-claude:other', 1);
  assert.equal(closed.takenIn('acp:host-claude:r'), false, 'closed: nothing is taken in');
  assert.deepEqual(closed.takenInChats(), []);
  assert.equal(stored(r.dir, 'acp:host-claude:r').epoch, 3, 'closed: untouched');
  assert.equal(stored(r.dir, 'acp:host-claude:other').hostId, 'local');
  r.adoption.release('acp:host-claude:r');
  const gone = stored(r.dir, 'acp:host-claude:r');
  assert.deepEqual([gone.hostId, gone.epoch, gone.takenIn], ['local', 0, undefined], 'unbound, and the epoch and the mark with it');
});

test('a refused message reads the epoch again only for a chat taken in, and only when the list holds a newer one for its machine', async (t) => {
  const r = rig(t);
  await r.adoption.takeIn('acp:host-claude:a', { hostId: 'box', folder: '/w', epoch: 3 });
  r.list([{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 4 }] }]);
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:a'), true);
  assert.equal(stored(r.dir, 'acp:host-claude:a').epoch, 4);
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:a'), false, 'nothing newer now');
  r.list([{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 2 }] }]);
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:a'), false, 'an older epoch is not taken');
  for (const rows of [[], [{ chatId: 'claude:a' }], [{ chatId: 'claude:other', epoch: 9 }]]) {
    r.list([{ machineId: 'box', rows }]);
    assert.equal(r.adoption.refreshEpoch('acp:host-claude:a'), false, JSON.stringify(rows));
  }
  r.list([{ machineId: 'elsewhere', rows: [{ chatId: 'claude:a', epoch: 9 }] }]);
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:a'), false, "another machine's row is not this chat's");
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:never-bound'), false, 'a chat with no owner here');
});

test('a refusal that comes before the list has the new epoch waits for the list: when it changes the epoch is taken and the messages are sent again', async (t) => {
  const r = rig(t);
  await r.adoption.takeIn('acp:host-claude:a', { hostId: 'box', folder: '/w', epoch: 3 });
  r.list([{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 3 }] }]);
  assert.equal(r.adoption.refreshEpoch('acp:host-claude:a'), false, 'the list lags the Host');
  r.adoption.indexChanged();
  assert.deepEqual(r.rebased, [], 'nothing newer yet: still waiting');
  r.list([{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 4 }] }]);
  r.adoption.indexChanged();
  assert.equal(stored(r.dir, 'acp:host-claude:a').epoch, 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.rebased, ['acp:host-claude:a']);
  r.adoption.indexChanged();
  assert.deepEqual(r.rebased, ['acp:host-claude:a'], 'told once');
  // a send path that fails the rebase does not break the list's change
  const failing = machineChatAdoption({
    folders: () => ({ bind: () => undefined }),
    chats: () => wired(r.dir),
    deps: {
      live: {
        hostOwnership: { get: (id: string) => stored(r.dir, id) },
        remoteSend: { rebase: async () => Promise.reject(new Error('no')) },
      },
    },
    service: () => ({ chatIndex: () => [{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 9 }] }] }),
  });
  assert.equal(failing.refreshEpoch('acp:host-claude:a'), true);
  failing.indexChanged();
});

test('the sweep lets go only of a taken-in binding that is a week old with no record and no message waiting: a fresh one (taken in, nothing done, app restarted) is never judged', async (t) => {
  const r = rig(t);
  const DAY = 24 * 3600 * 1000;
  const file = path.join(r.dir, 'host-ownership.json');
  const own = new OwnershipStore(file);
  const bind = (id: string, takenIn?: number) =>
    own.set(id, { hostId: 'box', ownerHostId: 'box', epoch: 3, folder: '/w', ...(takenIn === undefined ? {} : { takenIn }) });
  const now = Date.now();
  bind('acp:host-claude:fresh', now - 60_000);
  bind('acp:host-claude:old', now - 8 * DAY);
  bind('acp:host-claude:oldrecord', now - 8 * DAY);
  bind('acp:host-claude:oldmessage', now - 8 * DAY);
  bind('acp:host-claude:mine');
  const after = r.restart();
  // (a) taken in a minute before the app quit, no message, restart: nothing is let go, with or without a record
  after.sweep((id: string) => id !== 'acp:host-claude:fresh', now);
  assert.equal(stored(r.dir, 'acp:host-claude:fresh').hostId, 'box');
  // (b) old: the record or a waiting message keeps it; neither lets it go; a chat started here is never judged
  after.sweep((id: string) => id === 'acp:host-claude:oldrecord' || id === 'acp:host-claude:oldmessage', now);
  assert.deepEqual(
    ['old', 'oldrecord', 'oldmessage', 'mine', 'fresh'].map((n) => stored(r.dir, `acp:host-claude:${n}`).hostId),
    ['local', 'box', 'box', 'box', 'box'],
  );
  after.sweep(() => false, now + 8 * DAY);
  assert.deepEqual(
    ['oldrecord', 'oldmessage', 'mine', 'fresh'].map((n) => stored(r.dir, `acp:host-claude:${n}`).hostId),
    ['local', 'local', 'box', 'local'],
    'a week on, a chat with no record and nothing waiting goes too; a chat started here never',
  );
});

test('a later bind of a taken-in chat writes a fresh record without the mark, deliberately (a chat moved, continued or started again is no longer one taken in)', async (t) => {
  const r = rig(t);
  await r.adoption.takeIn('acp:host-claude:a', { hostId: 'box', folder: '/w', epoch: 3 });
  assert.equal(r.adoption.takenIn('acp:host-claude:a'), true);
  const store = new OwnershipStore(path.join(r.dir, 'host-ownership.json'));
  // the folders service's bind, as a continue or a new start uses it
  const folders = createHostFolders({ open: async () => ({ call: async () => ({}), close: () => undefined }), store });
  const before = stored(r.dir, 'acp:host-claude:a');
  assert.equal(before.ownerHostId, 'box');
  folders.bind('acp:host-claude:a', { hostId: 'other', folder: '/elsewhere' });
  const rebound = stored(r.dir, 'acp:host-claude:a');
  assert.deepEqual([rebound.hostId, rebound.folder, rebound.takenIn], ['other', '/elsewhere', undefined]);
  assert.equal(r.restart().takenIn('acp:host-claude:a'), false);
});

test('the mark is part of what an ownership record may hold: the time it was taken in, and nothing else keeps it away from the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-mark-'));
  try {
    const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
    store.set('c', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null, takenIn: 1_700_000_000_000 });
    assert.equal(new OwnershipStore(path.join(dir, 'host-ownership.json')).get('c').takenIn, 1_700_000_000_000);
    assert.deepEqual(new OwnershipStore(path.join(dir, 'host-ownership.json')).takenInChats(), [{ chatId: 'c', at: 1_700_000_000_000 }]);
    assert.throws(
      () => store.set('d', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null, takenIn: 'yes' }),
      /Invalid host ownership record/,
    );
    for (const bad of [true, false, 0, -5, 1.5])
      assert.throws(
        () => store.set('e', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: null, takenIn: bad }),
        /Invalid host ownership record/,
        `the mark is a time or absent: ${bad}`,
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat deleted here while its machine is away is still queued after the app starts again, and the index drops it however the machine lists it', async (t) => {
  const dir = tmp(t);
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('acp:host-claude:gone', {
    hostId: 'box',
    ownerHostId: 'box',
    epoch: 3,
    folder: '/w',
  });
  const first = wired(dir, { status: 'offline' });
  assert.deepEqual(await first.forget('acp:host-claude:gone'), { pending: true });
  // the app starts again: a new service over the same folder
  const second = wired(dir, { status: 'offline' });
  const pending = second.pendingDeletions();
  assert.deepEqual(
    pending.map((p: { hostId: string; chatId: string }) => [p.hostId, p.chatId]),
    [['box', 'acp:host-claude:gone']],
  );
  const index = [
    {
      machineId: 'box',
      rows: [
        { chatId: 'claude:gone', title: 'x' },
        { chatId: 'claude:kept', title: 'y' },
      ],
    },
    { machineId: 'other', rows: [{ chatId: 'claude:gone', title: 'on another machine' }] },
  ];
  const shown = withoutPendingDeletions(index, pending);
  assert.deepEqual(
    shown.map((e: { rows: { chatId: string }[] }) => e.rows.map((r) => r.chatId)),
    [['claude:kept'], ['claude:gone']],
    "only the machine that was told: the same id on another machine is that machine's own chat",
  );
  assert.equal(shown[1], index[1], 'an entry with nothing to drop is the very one');
  assert.equal(withoutPendingDeletions(index, []), index, 'nothing pending: nothing changes');
});
