// Offline chat retirement survives app restart, stays bound to the same paired identity and machine, and never reconnects a removed machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDeletionOutbox } = require('../electron/host/deletionOutbox.cjs');
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-delete-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let identity = 'paired-client';
  let status = 'offline';
  let host: any = {
    speaks: () => true,
    removeChat: async (...p: any[]) => {
      calls.push(p);
      return { removed: true };
    },
  };
  const calls: any[] = [];
  const errors: any[] = [];
  const options = {
    dir: path.join(root, 'deletions'),
    identity: () => identity,
    rowOf: () => ({ status }),
    hostFor: () => host,
    report: (e: any) => errors.push(e),
  };
  return {
    root,
    options,
    make: () => createDeletionOutbox(options),
    calls,
    errors,
    identity: (v: string) => {
      identity = v;
    },
    status: (v: string) => {
      status = v;
    },
    host: (v: any) => {
      host = v;
    },
  };
}
const deletion = { hostId: 'machine-a', chatId: 'claude:deleted', epoch: 3 };

test('offline deletion is durable before local removal and retries its original key only on the same machine and identity', async (t) => {
  const s = setup(t);
  const a = s.make();
  const row = a.enqueue(deletion);
  assert.equal(a.enqueue(deletion).key, row.key);
  await a.flush();
  assert.equal(s.calls.length, 0);
  const b = s.make();
  assert.equal(b.pending()[0].key, row.key);
  s.status('online');
  s.identity('different-client');
  await b.flush();
  assert.equal(s.calls.length, 0);
  assert.equal(b.pending().length, 1);
  s.identity('paired-client');
  await b.flush();
  assert.deepEqual(s.calls, [[deletion.chatId, { key: row.key, epoch: 3 }]]);
  assert.deepEqual(s.make().pending(), []);
});

test('lost replies, old Hosts, missing transports and negative receipts keep deletion pending rather than inventing a wipe', async (t) => {
  const s = setup(t);
  const q = s.make();
  q.enqueue(deletion);
  s.status('online');
  for (const host of [
    null,
    { speaks: () => false },
    { speaks: () => true },
    { speaks: () => true, removeChat: async () => ({ removed: false }) },
    {
      speaks: () => true,
      removeChat: async () => {
        throw new Error('lost reply');
      },
    },
  ]) {
    s.host(host);
    await q.flush();
    assert.equal(q.pending().length, 1);
  }
  assert.equal(s.errors.length, 1);
});

test('removing an offline machine drops its deletion authority and does not retain SSH records or auto-reconnect', async (t) => {
  const s = setup(t);
  const q = s.make();
  q.enqueue(deletion);
  q.enqueue({ ...deletion, hostId: 'machine-b' });
  q.dropMachine('machine-a');
  assert.deepEqual(
    q.pending().map((r: any) => r.hostId),
    ['machine-b'],
  );
  q.dropMachine('machine-b');
  s.status('online');
  await s.make().flush();
  assert.equal(s.calls.length, 0);
  assert.equal(JSON.stringify(fs.readdirSync(s.options.dir)).includes('ssh'), false);
});

test('concurrent reconnect notifications do not dispatch one deletion twice', async (t) => {
  const s = setup(t);
  const q = s.make();
  q.enqueue(deletion);
  s.status('online');
  let release: any;
  s.host({
    speaks: () => true,
    removeChat: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const first = q.flush();
  assert.equal(q.flush(), first);
  release({ removed: true });
  await first;
  assert.deepEqual(q.pending(), []);
});

for (const step of ['writeFileSync', 'fsyncSync', 'renameSync'])
  test(`an admission failure at ${step} cannot be claimed as a persisted deletion`, (t) => {
    const s = setup(t);
    const q = s.make();
    const fault = t.mock.method(fs, step as any, () => {
      throw new Error('full disk');
    });
    assert.throws(() => q.enqueue(deletion));
    fault.mock.restore();
    q.enqueue(deletion);
    assert.equal(s.make().pending().length, 1);
  });

test('missing identity, unreadable directories and corrupt records fail closed without replacing recovery data', (t) => {
  const s = setup(t);
  s.identity('');
  assert.throws(() => s.make().enqueue(deletion), /no paired identity/);
  s.identity('paired-client');
  const q = s.make();
  q.enqueue(deletion);
  const machine = path.join(s.options.dir, fs.readdirSync(s.options.dir)[0]);
  const file = path.join(machine, fs.readdirSync(machine)[0]);
  fs.writeFileSync(file, '{}');
  // the list leaves the unreadable job out, says so, and keeps its file
  assert.deepEqual(q.pending(), []);
  assert.match(String(s.errors.at(-1).message), /preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  fs.rmSync(s.options.dir, { recursive: true });
  fs.writeFileSync(s.options.dir, 'not a directory');
  assert.throws(() => q.pending());
});

test('Host access revocation before dispatch leaves deletion durable without obtaining another connection', async (t) => {
  const s = setup(t);
  s.status('online');
  let enabled = false;
  let revokeDuringRetirement = true;
  const q = createDeletionOutbox({
    ...s.options,
    enabled: () => enabled,
    beforeDelete: () => {
      if (revokeDuringRetirement) enabled = false;
    },
  });
  q.enqueue(deletion);
  await q.flush();
  enabled = true;
  await q.flush();
  assert.equal(s.calls.length, 0);
  assert.equal(q.pending().length, 1);
  enabled = true;
  revokeDuringRetirement = false;
  await q.flush();
  assert.equal(q.pending().length, 0);
});

test('Windows deletion jobs sync their file and retain lost replies without attempting directory fsync', async (t) => {
  const s = setup(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const q = createDeletionOutbox({ ...s.options, report: undefined });
    q.enqueue(deletion);
    s.status('online');
    s.host({
      speaks: () => true,
      removeChat: async () => {
        throw new Error('lost reply');
      },
    });
    await q.flush();
    assert.equal(q.pending().length, 1);
    q.dropMachine(deletion.hostId);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('one corrupt deletion cannot block healthy admissions or cleanup, and machine removal drops even the corrupt file', async (t) => {
  const s = setup(t);
  const q = s.make();
  const badRow = q.enqueue(deletion);
  const folder = path.join(s.options.dir, fs.readdirSync(s.options.dir)[0]);
  const badFile = path.join(folder, fs.readdirSync(folder)[0]);
  fs.writeFileSync(badFile, '{}');
  const good = { ...deletion, chatId: 'claude:healthy-cleanup' };
  q.enqueue(good);
  assert.throws(() => q.enqueue(deletion), /preserved/);
  s.status('online');
  await q.flush();
  assert.deepEqual(
    s.calls.map((c) => c[0]),
    [good.chatId],
  );
  assert.equal(q.has(badRow), true);
  assert.deepEqual(q.pending(), []);
  assert.match(String(s.errors.at(-1).message), /preserved/);
  q.dropMachine(deletion.hostId);
  assert.deepEqual(q.pending(), []);
});

test('a failed local input retirement leaves only that deletion pending while another chat can settle', async (t) => {
  const s = setup(t);
  const q = createDeletionOutbox({
    ...s.options,
    beforeDelete: (id: string) => {
      if (id === deletion.chatId) throw new Error('unreadable input outbox');
    },
  });
  q.enqueue(deletion);
  q.enqueue({ ...deletion, chatId: 'healthy' });
  s.status('online');
  await q.flush();
  assert.deepEqual(
    q.pending().map((r: any) => r.chatId),
    [deletion.chatId],
  );
  assert.equal(s.errors.length, 1);
});

test('orphan temporary/recovery files are not dispatched and a torn job cannot replace a healthy deletion', async (t) => {
  const s = setup(t);
  const q = s.make();
  const row = q.enqueue(deletion);
  const machine = path.join(s.options.dir, fs.readdirSync(s.options.dir)[0]);
  const file = path.join(machine, fs.readdirSync(machine)[0]);
  fs.writeFileSync(path.join(s.options.dir, 'recovery-notes'), 'kept');
  fs.writeFileSync(path.join(machine, 'unpublished.next'), 'partial');
  fs.writeFileSync(file, '{');
  q.enqueue({ ...deletion, chatId: 'healthy-after-torn' });
  s.status('online');
  await q.flush();
  assert.equal(s.calls[0][0], 'healthy-after-torn');
  assert.equal(q.has(row), true);
  assert.equal(fs.readFileSync(path.join(s.options.dir, 'recovery-notes'), 'utf8'), 'kept');
});

test('a machine entry that is not a folder is reported on flush and by the list, and never dispatched', async (t) => {
  const s = setup(t);
  fs.mkdirSync(s.options.dir, { recursive: true });
  fs.writeFileSync(path.join(s.options.dir, 'a'.repeat(64)), 'not a folder');
  const outbox = s.make();
  await outbox.flush();
  assert.equal(s.errors.length, 1);
  assert.match(String(s.errors[0].message), /cannot be read/);
  assert.deepEqual(outbox.pending(), []);
  assert.equal(s.errors.length, 2);
  assert.deepEqual(s.calls, []);
});

test('a deletion store that cannot be listed is reported by flush, never thrown at a reconnect notification', async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.options.dir, 'a file where the store folder belongs');
  await s.make().flush();
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].code, 'ENOTDIR');
  assert.deepEqual(s.calls, []);
});

test('a job can be found by machine and chat for this identity, and taken back when the local deletion did not happen', (t) => {
  const s = setup(t);
  const q = s.make();
  assert.equal(q.queued(deletion.hostId, deletion.chatId), false);
  const row = q.enqueue(deletion);
  assert.equal(q.queued(deletion.hostId, deletion.chatId), true);
  assert.equal(q.queued(deletion.hostId, 'claude:another'), false);
  q.cancel(row);
  assert.equal(q.has(row), false);
  s.identity('');
  assert.equal(q.queued(deletion.hostId, deletion.chatId), false);
});
