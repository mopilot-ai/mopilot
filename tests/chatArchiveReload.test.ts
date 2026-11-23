// Main chat-store reload advances async archive ownership only after candidate admission; rejected reloads cannot mutate a shared epoch map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmp } from './support/chat-store-profile.ts';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { register } = require('../electron/app/ipc/chats.cjs');

function fixture(t: any) {
  const { threads } = tmp(t);
  const store = new ChatsStore(threads, { legacyMirror: false, now: () => 1000 });
  store.ensure('root');
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: string[] = [];
  let fail = false;
  const load = store.load;
  store.load = function () {
    load.call(this);
    if (fail) throw new Error('Candidate validation failed');
  };
  const live: any = {
    chats: store,
    controller: { invalidate: () => events.push('invalidate') },
    codex: { threadDelete: async () => true },
  };
  register(
    { handle: (name: string, fn: any) => handlers.set(name, fn) },
    {
      live,
      claude: { deleteSession: async () => true },
      registerChats: () => ({ patchPrefs: () => true }),
      broadcastAll: (name: string) => events.push(name),
      readState: () => ({}),
      STATE_FILE: () => '',
      app: { getPath: () => '', getVersion: () => '' },
      retryMigration: () => ({ result: 'ok' }),
      restoreMigration: () => ({ id: 'migration', report: {} }),
    },
  );
  return {
    store,
    live,
    events,
    call: (name: string) => handlers.get(name)!(),
    fail: () => {
      fail = true;
    },
  };
}

test('an admitted live reload retires both zero and nonzero archive generations with the same clock', (t) => {
  const h = fixture(t);
  assert.equal(h.store.archiveEpoch('root'), 0);
  const before = h.store.archiveEpochs;
  h.call('migration:retry');
  assert.notEqual(h.store.archiveEpochs, before);
  assert.equal(before.get('root'), undefined, 'an unmodified live record had no transition to track yet');
  assert.equal(h.store.archiveEpoch('root'), 1);
  assert.deepEqual(h.events, ['invalidate', 'chats:reset']);
  h.store.patchMeta('root', { archived: 1000 });
  h.store.patchMeta('root', { archived: null });
  assert.equal(h.store.archiveEpoch('root'), 3);
  h.call('migration:retry');
  assert.equal(h.store.archiveEpoch('root'), 4);
});

test('a rejected shadow load retains the original epoch map and admitted records intact', (t) => {
  const h = fixture(t);
  h.store.patchMeta('root', { archived: 1000 });
  const epochs = h.store.archiveEpochs;
  const records = h.store.records;
  h.fail();
  assert.throws(() => h.call('migration:retry'), /previous chat snapshot/);
  assert.equal(h.store.records, records);
  assert.equal(h.store.archiveEpochs, epochs);
  assert.equal(h.store.archiveEpoch('root'), 1);
  assert.deepEqual(h.events, []);
});

test('an admitted reload reconciles live modes; a failed notification does not undo the authoritative snapshot', async (t) => {
  const h = fixture(t);
  h.live.claudeTurns = {
    permissionChanged: () => {
      h.events.push('permissions');
      return Promise.reject(new Error('live mode unavailable'));
    },
  };
  h.call('migration:retry');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.store.archiveEpoch('root'), 1);
  assert.deepEqual(h.events, ['permissions', 'invalidate', 'chats:reset']);
  h.events.length = 0;
  h.fail();
  assert.throws(() => h.call('migration:retry'), /previous chat snapshot/);
  assert.deepEqual(h.events, [], 'a rejected candidate never reconfigures a live process');
});
