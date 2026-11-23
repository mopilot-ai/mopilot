// Production whole-chat deletion and commit admission, with native operations and persistence replaced by memory-only boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { ChatDeletion, deletionTargets, nativeKey } from '../electron/session/chatDeletion.cjs';
import { ChatsStore, registerChats } from '../electron/platform/chats.cjs';
import { createDeleteSession } from '../electron/harness/claude/delete.cjs';
import { register } from '../electron/app/ipc/chats.cjs';
import { CodexEvents } from '../electron/harness/codexEvents.cjs';
import { deferred } from './support/async-scenarios.ts';
import { inertClockPort } from './support/ports/clock.ts';
const seg = (kind = 'codex', nativeId = 'root') => ({ kind, nativeId });
const rec = (id = 'root', segments = [seg()]) => ({ id, segments, meta: { archived: 1 }, schemaVersion: 2 });

test('new chat stores admit ordinary writes before a deletion authority attaches', (t) => {
  // Constructor defaults are the subject; loading is replaced before construction, so no file is read.
  let loads = 0;
  t.mock.method(ChatsStore.prototype, 'load', function () {
    loads++;
  });
  const store = new ChatsStore('/in-memory-only');
  assert.equal(loads, 1);
  assert.equal(store.isDeleted('root'), false);
  assert.equal(store.admitCommit(rec()), true);
  assert.equal(store.records.size, 0);
});
test('another composite owning a later target blocks all native deletion before the first call', async () => {
  const f = fixture([rec('root', [seg(), seg('claude', 'shared')]), rec('other', [seg('codex', 'other'), seg('claude', 'shared')])]);
  await assert.rejects(f.deletion.delete('root'), /Native session belongs to another chat/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.store.isDeleted('root'), false);
});
test('ChatDeletion gets the real Claude delete helper with inert dependencies; no window channel deletes', async () => {
  const calls: string[] = [];
  const state = {
    sessions: new Map(),
    retiring: new Map(),
    endedTips: new Set(['exported']),
    sdk: async () => ({
      deleteSession: async (id: string) => {
        calls.push(`delete:${id}`);
        return id;
      },
    }),
  };
  const factories: Record<string, unknown> = {
    './delete.cjs': { createDeleteSession },
    './linkedFork.cjs': { createLinkedClaudeFork: () => async () => ({}) },
    './forks.cjs': { createForks: () => ({ register: () => {}, claim: () => {} }) },
    './rename.cjs': { createRename: () => async () => {} },
    './userTitle.cjs': { createUserTitle: () => async () => null },
    './state.cjs': { createState: () => state },
    'node:path': { join: (...parts: string[]) => parts.join('/') },
    './sessions.cjs': {
      createSessions: () => ({
        remote: { registerIpc: () => {}, release: () => null },
        retire: async (id: string) => {
          calls.push(`retire:${id}`);
        },
      }),
    },
    './transcripts.cjs': { createTranscripts: () => ({}) },
    './auth.cjs': { createAuth: () => ({ artifacts: { registerIpc: () => {} } }) },
    './cli.cjs': { createCli: () => ({}) },
    './governor.cjs': { createClaudeGovernor: () => ({}) },
    './warm.cjs': { createWarm: () => ({}) },
    './queries.cjs': { createQueries: () => ({}) },
    './usageSchedule.cjs': { createUsageSchedule: () => ({}), loginAccounts: () => ({}) },
    './catalog.cjs': { createCatalog: () => ({}) },
    './chromeSessions.cjs': { createChromeSessions: () => ({}) },
    './loginIdentity.cjs': { serverIdOf: () => null },
    './identityApi.cjs': { createIdentityApi: () => ({}) },
    './cliLoginRead.cjs': { readCliLogin: async () => {} },
    './designLogin.cjs': { createDesignLogin: () => ({}) },
    './accounts.cjs': { ClaudeAccounts: class {} },
    '../../platform/ports/paths.cjs': { paths: { userData: () => '/in-memory-only' } },
    '../../platform/ports/openExternal.cjs': { openExternal: () => {} },
    './transcriptEdits.cjs': {},
    '../../identity/contract/claudeBilling.cjs': {},
    './sessionOptions.cjs': {},
    './tasks.cjs': {},
    // the options it gets, so the test can call them: the live sessions and the same retire
    '../routeProcesses.cjs': { claudeProcesses: (o: any) => o },
    ...Object.fromEntries(['../../ignored.cjs', '../../platform/searchScans.cjs', '../../ledger/accounts.cjs'].map((name) => [name, {}])),
    '../../platform/ports/clock.cjs': inertClockPort,
  };
  const source = new URL('../electron/harness/claude/index.cjs', import.meta.url);
  const module: { exports: any } = { exports: {} };
  // Only repository source is read. All factory, SDK, Electron and timer boundaries are inert.
  runInNewContext(
    readFileSync(source, 'utf8'),
    {
      module,
      require: (name: string) => {
        assert.ok(Object.hasOwn(factories, name), `Unexpected dependency: ${name}`);
        return factories[name];
      },
      setInterval: () => ({ unref() {} }),
    },
    { filename: fileURLToPath(source) },
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  const harness = module.exports.createClaudeHarness();
  harness.register({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }, () => {});
  assert.equal(await harness.deleteSession('exported'), 'exported');
  assert.equal(handlers.has('claude:delete'), false);
  assert.deepEqual(calls, ['retire:claude:exported', 'delete:exported']);
  assert.equal(state.endedTips.size, 0);
  // Restart to apply (electron/harness/routeProcesses.cjs) reads these sessions and ends them through the same retire
  assert.equal(harness.routeProcesses.sessions(), state.sessions);
  await harness.routeProcesses.retire('claude:route');
  assert.equal(calls.at(-1), 'retire:claude:route');
});
function fixture(rows = [rec()]) {
  // Do not construct ChatsStore: that would load files. Its production methods operate on this memory-only fixture.
  const store: any = Object.assign(Object.create(ChatsStore.prototype), {
    records: new Map(rows.map((r) => [r.id, r])),
    archiveEpochs: new Map(rows.map((r) => [r.id, 0])),
    newer: new Set(),
    unreadable: new Set(),
    now: () => 1,
    fallback: true,
    mirror: () => {},
    onChange: () => {},
    isDeleted: () => false,
    admitCommit: () => true,
  });
  const calls: any[] = [],
    events: any[] = [];
  const remove: any = Object.fromEntries(
    ['codex', 'claude', 'acp'].map((kind) => [
      kind,
      async (t: any) => {
        calls.push(t);
      },
    ]),
  );
  const deletion = new ChatDeletion({ store, remove, broadcast: (r: any) => events.push(r) });
  return { store, calls, events, remove, deletion };
}
test('all harnesses delete canonical natives and dispatch receipt before return, retaining all metadata', async () => {
  for (const target of [seg(), seg('claude', 'raw'), seg('acp:kimi', 'raw')]) {
    const id = nativeKey(target),
      original = rec(id, [target]),
      f = fixture([original]);
    const result = await f.deletion.delete(id);
    assert.deepEqual(f.calls, [{ ...target, key: id }]);
    assert.equal(f.events[0], result);
    assert.equal(result.metadata, 'retained');
    assert.equal(result.nativeDeleted, true);
    assert.equal(f.store.records.get(id), original);
    assert.equal(f.store.commit({ ...original, meta: { archived: null } }), false);
    assert.equal(f.store.patchMeta(id, { archived: null }), false);
    assert.equal(f.store.ensure(id), false);
    assert.equal(
      f.store.setSegments(id, [
        { harness: target.kind, nativeId: id, start: 0, count: null },
        { harness: 'codex', nativeId: 'new', start: 1, count: null },
      ]),
      false,
    );
    assert.equal(f.store.ensure('unrelated'), true);
    assert.equal(f.store.patchMeta('unrelated', { archived: 2 }), true);
  }
});
test('same-chat calls coalesce; auxiliary failure is best effort; repeated success never repeats a native delete', async () => {
  const f = fixture([rec('root', [seg(), seg('claude', 'later'), seg('claude', 'later')])]),
    hold = deferred();
  f.remove.claude = async (t: any) => {
    f.calls.push(t);
    throw Error('auxiliary failed');
  };
  f.remove.codex = async (t: any) => {
    f.calls.push(t);
    await hold.promise;
  };
  const a = f.deletion.delete('root'),
    b = f.deletion.delete('root');
  assert.equal(a, b);
  hold.resolve();
  await a;
  assert.deepEqual(
    f.calls.map((t) => t.key),
    ['claude:later', 'root'],
  );
  const receipt = await f.deletion.delete('root');
  assert.equal(f.calls.length, 2);
  assert.equal(f.events.length, 2);
  assert.equal(receipt, f.events[0]);
});
test('final failure preserves aliases, releases structural protection and remains retryable', async () => {
  const original = rec('root', [seg(), seg('claude', 'later')]),
    f = fixture([original]),
    hold = deferred();
  f.remove.codex = () => hold.promise;
  const pending = f.deletion.delete('root');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.store.commit({ ...original, segments: [seg(), seg('codex', 'appended')] }), false);
  assert.equal(f.store.commit(rec('unrelated', [seg('codex', 'unrelated'), seg('claude', 'later')])), false);
  assert.equal(f.store.patchMeta('root', { pinned: true }), true);
  hold.reject(Error('final refused'));
  await assert.rejects(pending, /final refused/);
  assert.equal(f.events.length, 0);
  assert.equal(f.store.isDeleted('root'), false);
  assert.deepEqual(f.store.records.get('root').segments, original.segments);
  assert.equal(f.store.commit({ ...original, segments: [seg(), seg('codex', 'appended')] }), true);
  f.remove.codex = async (t: any) => f.calls.push(t);
  await f.deletion.delete('root');
  assert.equal(f.events.length, 1);
});
test('bad target identities, read-only target and alias theft fail before adapter calls; unrelated future records do not block', async () => {
  for (const row of [
    rec('root', [seg('unknown', 'root')]),
    rec('root', [seg('acp:', 'root')]),
    rec('root', [seg('codex', '')]),
    rec('root', [seg('codex', 'bad\0id')]),
    rec('different'),
    rec('root', []),
  ]) {
    const f = fixture([row]);
    await assert.rejects(f.deletion.delete(row.id));
    assert.equal(f.calls.length, 0);
  }
  for (const id of ['', null]) {
    const f = fixture();
    await assert.rejects(f.deletion.delete(id));
    assert.equal(f.calls.length, 0);
  }
  for (const key of ['newer', 'unreadable']) {
    const f = fixture();
    f.store[key].add('root');
    await assert.rejects(f.deletion.delete('root'), /read-only/);
    assert.equal(f.calls.length, 0);
  }
  const stray = fixture([rec('owner', [seg('codex', 'owner'), seg('codex', 'root')]), rec()]);
  await assert.rejects(stray.deletion.delete('root'), /another chat/);
  assert.equal(stray.calls.length, 0);
  const collision = fixture([rec('claude:x', [seg('codex', 'claude:x')]), rec('other', [seg('codex', 'other'), seg('claude', 'x')])]);
  await assert.rejects(collision.deletion.delete('claude:x'), /Ambiguous/);
  assert.equal(collision.calls.length, 0);
  const future = fixture([rec(), rec('future', [seg('future-kind', 'other')])]);
  await future.deletion.delete('root');
  assert.equal(future.calls.length, 1);
  const unknown = fixture([]);
  assert.equal(deletionTargets(unknown.store, 'new')[0].key, 'new');
  const long = 'x'.repeat(300);
  const lengthy = fixture([rec(long, [seg('codex', long)])]);
  await lengthy.deletion.delete(long);
  assert.equal(lengthy.events[0].chatId, long);
  const newline = fixture([rec('acp:kimi:a\nb', [seg('acp:kimi', 'a\nb')])]);
  await assert.rejects(newline.deletion.delete('acp:kimi:a\nb'), /not supported/);
  assert.equal(newline.calls.length, 0);
});
test('dispatch failure is a completed deletion; retry replays receipt without native work', async () => {
  const f = fixture();
  f.deletion.broadcast = () => {
    throw Error('closed window');
  };
  const receipt = await f.deletion.delete('root');
  assert.equal(f.store.isDeleted('root'), true);
  f.deletion.broadcast = (r: any) => f.events.push(r);
  assert.equal(await f.deletion.delete('root'), receipt);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.deletion.snapshot(), [receipt]);
});
test('direct generic metadata IPC rejects terminal writes, and no terminal change event is emitted', async () => {
  const f = fixture(),
    handlers = new Map(),
    broadcasts: any[] = [];
  registerChats({ handle: (name: any, fn: any) => handlers.set(name, fn) } as any, {
    store: f.store,
    uiState: 'unused',
    broadcast: (...args: any[]) => broadcasts.push(args),
  });
  await f.deletion.delete('root');
  for (const method of ['chats:patchMeta', 'chats:setSegments'])
    assert.throws(() => handlers.get(method)({ sender: {} }, 'root', {}), /deleted/);
  assert.equal(broadcasts.length, 0);
});
test('production IPC routes each typed native target and exposes the terminal snapshot', async () => {
  for (const target of [seg(), seg('claude', 'raw'), seg('acp:kimi', 'raw')]) {
    const id = nativeKey(target),
      f = fixture([rec(id, [target])]),
      handlers = new Map(),
      native: any[] = [];
    register(
      { handle: (name: any, fn: any) => handlers.set(name, fn) } as any,
      {
        live: {
          chats: f.store,
          codex: { threadDelete: (id: any) => native.push(['codex', id]) },
          acpHost: { remove: (id: any) => native.push(['acp', id]) },
        },
        claude: { deleteSession: (id: any) => native.push(['claude', id]) },
        registerChats: () => ({ patchPrefs: () => true }),
        broadcastAll: (_name: any, r: any) => f.events.push(r),
        STATE_FILE: () => '',
        readState: () => {},
      } as any,
    );
    const receipt = await handlers.get('chats:delete')({}, id);
    assert.equal(native.length, 1);
    assert.equal(native[0][1], target.kind === 'acp:kimi' ? id : target.nativeId);
    assert.deepEqual(handlers.get('chats:deletions')(), [receipt]);
  }
});
test('Claude helper retains retirement, completion and failure behavior without native processes', async () => {
  for (const active of [false, true]) {
    const order: string[] = [];
    const state: any = {
      sessions: new Map(active ? [['claude:raw', { done: Promise.resolve() }]] : []),
      retiring: new Map(),
      endedTips: new Set(['raw']),
      sdk: async () => ({
        deleteSession: async (id: string) => {
          order.push(id);
          return 'done';
        },
      }),
    };
    const remove = createDeleteSession(
      state,
      {
        retire: async (id: string) => {
          order.push(id);
        },
      },
      () => {},
    );
    assert.equal(await remove('raw'), 'done');
    assert.deepEqual(order, ['claude:raw', 'raw']);
    assert.equal(state.endedTips.has('raw'), false);
  }
});
test('native later-segment lifecycle events cannot remove or retire the composite row', () => {
  const ctx: any = {
    manualCompactions: new Set(),
    hostDeclined: new Map(),
    turnCommands: { stopping: new Set() },
    prewarmed: new Set(),
    chatOf: (id: string) => (id === 'later' ? 'root' : id),
  };
  for (const method of ['thread/deleted', 'thread/archived', 'thread/name/updated'])
    assert.equal(CodexEvents.prototype.mapped.call(ctx, method, { threadId: 'later' }), null);
  assert.equal(CodexEvents.prototype.mapped.call(ctx, 'thread/deleted', { threadId: 'root' }).params.threadId, 'root');
});
test('migration effects are rejected before callbacks during deletion, and admitted again after failure', async () => {
  const f = fixture(),
    hold = deferred(),
    handlers = new Map(),
    migration: string[] = [];
  f.store.load = () => migration.push('load');
  register(
    { handle: (name: any, fn: any) => handlers.set(name, fn) } as any,
    {
      live: { chats: f.store, codex: { threadDelete: () => hold.promise }, controller: { invalidate: () => migration.push('invalidate') } },
      registerChats: () => ({ patchPrefs: () => true }),
      broadcastAll: () => {},
      STATE_FILE: () => '',
      readState: () => {},
      app: { getPath: () => '', getVersion: () => '' },
      retryMigration: () => {
        migration.push('retry');
        return { result: 'ok' };
      },
      restoreMigration: () => {
        migration.push('restore');
        return null;
      },
    } as any,
  );
  const deletion = handlers.get('chats:delete')({}, 'root');
  assert.throws(() => handlers.get('migration:retry')(), /Wait/);
  assert.throws(() => handlers.get('migration:restore')(), /Wait/);
  assert.deepEqual(migration, []);
  hold.reject(Error('refused'));
  await assert.rejects(deletion, /refused/);
  handlers.get('migration:retry')();
  handlers.get('migration:restore')();
  assert.deepEqual(migration, ['retry', 'load', 'invalidate', 'restore']);
});
test('terminal commits also reject a newly introduced alias reference without affecting unrelated writes', async () => {
  const f = fixture();
  await f.deletion.delete('root');
  assert.equal(f.store.commit(rec('other', [seg('codex', 'other'), seg('codex', 'root')])), false);
  assert.equal(f.store.commit(rec('other', [seg('codex', 'other')])), true);
  // A reload's additional retained alias stays owned by the terminal composite.
  f.store.records.set('root', rec('root', [seg(), seg('claude', 'late')]));
  assert.equal(f.store.isDeleted('claude:late'), false);
  f.deletion.refreshAliases();
  assert.equal(f.store.isDeleted('claude:late'), true);
  assert.equal(f.store.commit(rec('claude:late', [seg('claude', 'late')])), false);
});
test('reload certificates expand retained aliases without rewriting native deletion or repeating adapters', async () => {
  const f = fixture();
  const original = await f.deletion.delete('root');
  f.store.records.set('root', rec('root', [seg(), seg('claude', 'late')]));
  f.deletion.refreshAliases();
  const expanded = f.deletion.snapshot()[0];
  assert.notEqual(expanded, original);
  assert.deepEqual(original.nativeKeys, ['root']);
  assert.equal(original.retainedAliasKeys, undefined);
  assert.deepEqual(expanded.nativeKeys, ['root']);
  assert.deepEqual(expanded.retainedAliasKeys, ['claude:late']);
  assert.equal(f.store.isDeleted('claude:late'), true);
  f.deletion.refreshAliases();
  assert.equal(f.events.length, 2);
  assert.equal(await f.deletion.delete('root'), expanded);
  assert.equal(f.calls.length, 1);
  assert.equal(f.events[2], expanded);
});
test('reload certificates exclude live-owned and ambiguous aliases in either record order', async () => {
  const scenarios = [
    [rec('root', [seg()]), rec('live', [seg('codex', 'live'), seg('claude', 'x')])],
    [rec('root', [seg(), seg('claude', 'x')]), rec('live', [seg('codex', 'live'), seg('claude', 'x')])],
    [rec('root', [seg(), seg('codex', 'claude:x')]), rec('claude:x', [seg('claude', 'x')])],
  ];
  for (const rows of scenarios)
    for (const ordered of [rows, [...rows].reverse()]) {
      const f = fixture();
      await f.deletion.delete('root');
      f.store.records = new Map(ordered.map((r) => [r.id, r]));
      f.deletion.refreshAliases();
      assert.equal(f.store.isDeleted('claude:x'), false);
      assert.equal(f.events.length, 1);
      assert.equal(f.calls.length, 1);
      assert.equal(f.deletion.snapshot()[0].retainedAliasKeys, undefined);
    }
});
test('migration IPC dispatches certified aliases after load and before reset, with no native repeat', async () => {
  const f = fixture(),
    handlers = new Map(),
    order: string[] = [];
  let nativeCalls = 0;
  f.store.load = function () {
    order.push('load');
    this.records.set('root', rec('root', [seg(), seg('claude', 'late')]));
  };
  register(
    { handle: (name: string, fn: any) => handlers.set(name, fn) } as any,
    {
      live: { chats: f.store, codex: { threadDelete: () => nativeCalls++ }, controller: { invalidate: () => order.push('invalidate') } },
      registerChats: () => ({ patchPrefs: () => true }),
      STATE_FILE: () => '',
      readState: () => {},
      app: { getPath: () => '', getVersion: () => '' },
      retryMigration: () => ({ result: 'ok' }),
      broadcastAll: (name: string) => order.push(name),
    } as any,
  );
  await handlers.get('chats:delete')({}, 'root');
  order.length = 0;
  handlers.get('migration:retry')();
  assert.deepEqual(order, ['load', 'chats:deleted', 'invalidate', 'chats:reset']);
  assert.deepEqual(handlers.get('chats:deletions')()[0].retainedAliasKeys, ['claude:late']);
  assert.equal(nativeCalls, 1);
});
test('reload ownership keeps later-segment precedence while excluding an empty native key', async () => {
  const f = fixture();
  await f.deletion.delete('root');
  f.store.records.set('root', rec('root', [seg(), seg('claude', 'late'), seg('codex', '')]));
  f.store.records.set('claude:late', rec('claude:late', [seg('claude', 'late')]));
  f.deletion.refreshAliases();
  assert.deepEqual(f.deletion.snapshot()[0].retainedAliasKeys, ['claude:late']);
  assert.equal(f.store.isDeleted(''), false);
  assert.equal(f.calls.length, 1);
  const first = f.deletion.snapshot()[0];
  f.store.records.set('root', rec('root', [seg(), seg('claude', 'late'), seg('codex', 'second')]));
  f.deletion.refreshAliases();
  assert.deepEqual(first.retainedAliasKeys, ['claude:late']);
  assert.deepEqual(f.deletion.snapshot()[0].retainedAliasKeys, ['claude:late', 'second']);
  assert.equal(f.calls.length, 1);
});
test('terminal native and retained alias requests replay the canonical receipt after record reload', async () => {
  for (const retained of [false, true]) {
    const f = fixture([rec('root', retained ? [seg()] : [seg(), seg('claude', 'late')])]);
    await f.deletion.delete('root');
    if (retained) {
      f.store.records.set('root', rec('root', [seg(), seg('claude', 'late')]));
      f.deletion.refreshAliases();
    }
    const expected = f.deletion.snapshot()[0],
      callsBefore = f.calls.length;
    f.store.records.set('root', rec());
    f.store.records.set('claude:late', rec('claude:late', [seg('claude', 'late')]));
    assert.equal(await f.deletion.delete('claude:late'), expected);
    assert.equal(f.calls.length, callsBefore);
    assert.equal(f.deletion.snapshot().length, 1);
  }
});
test('a reloaded first-key replacement cannot certify a new retained alias', async () => {
  const f = fixture();
  await f.deletion.delete('root');
  f.store.records.set('root', rec('root', [seg('codex', 'replacement')]));
  f.deletion.refreshAliases();
  assert.equal(f.store.isDeleted('replacement'), false);
  assert.equal(f.events.length, 1);
});
