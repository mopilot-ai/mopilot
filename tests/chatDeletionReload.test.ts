// Migration reload admission preserves certified identities and live state using only in-memory boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsStore } from '../electron/platform/chats.cjs';
import { register } from '../electron/app/ipc/chats.cjs';

const seg = (kind = 'codex', nativeId = 'root') => ({ kind, nativeId });
const rec = (id = 'root', segments = [seg()]) => ({ id, segments, meta: { archived: 1 }, schemaVersion: 2 });
function fixture(rows = [rec()], audioOwnership?: any) {
  const events: string[] = [],
    handlers = new Map<string, (...args: any[]) => any>();
  const control = { rows, nativeCalls: 0, failLoad: false };
  // Never construct ChatsStore: the constructor loads disk. Production methods receive memory collections only.
  const store: any = Object.assign(Object.create(ChatsStore.prototype), {
    records: new Map(rows.map((r) => [r.id, r])),
    archiveEpochs: new Map(rows.map((r) => [r.id, 0])),
    newer: new Set(),
    unreadable: new Set(),
    fallback: false,
    isDeleted: () => false,
    admitCommit: () => true,
    now: () => 1,
    mirror: () => {},
    onChange: () => {},
    load(this: any) {
      assert.notEqual(this, store, 'Reload must populate a shadow receiver before adopting it');
      events.push('load');
      this.records = new Map(control.rows.map((r) => [r.id, r]));
      this.newer.add('candidate-newer');
      this.unreadable.add('candidate-unreadable');
      if (control.failLoad) throw Error('synthetic load failure');
    },
  });
  register(
    { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } as any,
    {
      live: {
        chats: store,
        audioOwnership,
        codex: {
          threadDelete: () => {
            control.nativeCalls++;
          },
        },
        controller: { invalidate: () => events.push('invalidate') },
      },
      claude: {
        deleteSession: () => {
          control.nativeCalls++;
        },
      },
      registerChats: () => ({ patchPrefs: () => true }),
      broadcastAll: (name: string) => events.push(name),
      STATE_FILE: () => '',
      readState: () => {},
      app: { getPath: () => '', getVersion: () => '' },
      retryMigration: () => {
        events.push('disk-retry');
        return { result: 'ok' };
      },
      restoreMigration: () => {
        events.push('disk-restore');
        return { id: 'migration', report: {} };
      },
    } as any,
  );
  return { store, control, events, call: (name: string, ...args: any[]) => handlers.get(name)!({}, ...args) };
}

test('successive reload cannot transfer a native or retained certified alias to a live owner', async () => {
  for (const retained of [false, true]) {
    const f = fixture([rec('root', retained ? [seg()] : [seg(), seg('claude', 'x')])]);
    await f.call('chats:delete', 'root');
    if (retained) {
      f.control.rows = [rec('root', [seg(), seg('claude', 'x')])];
      f.call('migration:retry');
    }
    const before = {
      records: f.store.records,
      newer: f.store.newer,
      unreadable: f.store.unreadable,
      fallback: f.store.fallback,
      archiveEpochs: f.store.archiveEpochs,
    };
    const receipt = f.call('chats:deletions')[0],
      calls = f.control.nativeCalls;
    f.control.rows = [rec(), rec('live', [seg('codex', 'live'), seg('claude', 'x')])];
    f.events.length = 0;
    assert.throws(
      () => f.call('migration:restore'),
      /Migration was attempted; any file changes remain on disk.*previous chat snapshot.*Restart is required/,
    );
    for (const key of Object.keys(before)) assert.equal(f.store[key], before[key as keyof typeof before]);
    assert.deepEqual(f.events, ['disk-restore', 'load']);
    assert.equal(f.call('chats:deletions')[0], receipt);
    assert.equal(await f.call('chats:delete', 'claude:x'), receipt);
    assert.equal(f.control.nativeCalls, calls);
  }
});

test('reload rejects typed substitution and ambiguous ownership before adopting candidate state', async () => {
  const scenarios = [
    { initial: [rec('claude:x', [seg('codex', 'claude:x')])], id: 'claude:x', next: [rec('claude:x', [seg('claude', 'x')])] },
    {
      initial: [rec('root', [seg(), seg('claude', 'x')])],
      id: 'root',
      next: [rec('root', [seg(), seg('claude', 'x')]), rec('live', [seg('codex', 'live'), seg('claude', 'x')])],
    },
  ];
  for (const scenario of [...scenarios, { ...scenarios[1], next: [...scenarios[1].next].reverse() }]) {
    const f = fixture(scenario.initial);
    await f.call('chats:delete', scenario.id);
    const before = f.store.records;
    f.control.rows = scenario.next;
    assert.throws(() => f.call('migration:retry'), /Restart is required/);
    assert.equal(f.store.records, before);
    assert.equal(f.store.fallback, false);
  }
});

test('absent certified keys and unrelated reloads are admitted without replaying native work', async () => {
  const f = fixture();
  const receipt = await f.call('chats:delete', 'root');
  f.control.rows = [rec('unrelated', [seg('codex', 'unrelated')])];
  f.events.length = 0;
  f.call('migration:restore');
  assert.deepEqual(f.events, ['disk-restore', 'load', 'invalidate', 'chats:reset']);
  assert.equal(f.store.records.has('root'), false);
  assert.equal(f.store.records.has('unrelated'), true);
  assert.equal(f.store.fallback, true);
  assert.equal(f.store.isDeleted('root'), true);
  assert.equal(await f.call('chats:delete', 'root'), receipt);
  assert.equal(f.control.nativeCalls, 1);
  const fresh = fixture();
  fresh.control.rows = [rec('other', [seg('claude', 'other')])];
  fresh.call('migration:retry');
  assert.equal(fresh.store.records.has('other'), true);
  assert.equal(fresh.control.nativeCalls, 0);
});

test('shadow load failure preserves all runtime collections and reports the already changed disk', () => {
  const f = fixture();
  const before = [f.store.records, f.store.newer, f.store.unreadable, f.store.fallback, f.store.archiveEpochs];
  f.control.failLoad = true;
  assert.throws(() => f.call('migration:restore'), /Migration was attempted; any file changes remain on disk.*Restart is required/);
  assert.deepEqual([f.store.records, f.store.newer, f.store.unreadable, f.store.fallback, f.store.archiveEpochs], before);
  assert.deepEqual(f.events, ['disk-restore', 'load']);
  assert.equal(f.control.nativeCalls, 0);
});

test('audio cleanup follows the certified chat deletion and cannot turn a completed deletion into a failed receipt', async () => {
  for (const failing of [false, true]) {
    const calls: any[] = [];
    const f = fixture([rec()], {
      delete: (...args: any[]) => {
        calls.push(args);
        if (failing) throw new Error('disk full');
      },
      collect: async () => {
        calls.push('collect');
      },
    });
    const receipt = await f.call('chats:delete', 'root');
    assert.equal(receipt.nativeDeleted, true);
    assert.deepEqual(calls[0], ['root', receipt.nativeKeys]);
    assert.equal(calls.includes('collect'), !failing);
  }
});
