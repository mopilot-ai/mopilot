// A deleted Codex chat's file checkpoints go with it (electron/app/ipc/chats.cjs → session/turnCheckpoints.cjs forget), and the chat is deleted all the same when its folder is unknown or removing them fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsStore } from '../electron/platform/chats.cjs';
import { nativeKey } from '../electron/session/chatDeletion.cjs';
import { register } from '../electron/app/ipc/chats.cjs';

const seg = (kind = 'codex', nativeId = 'root') => ({ kind, nativeId });
const rec = (id = 'root', segments = [seg()]) => ({ id, segments, meta: { archived: 1 }, schemaVersion: 2 });
/** A memory-only chat store (constructing ChatsStore would load files). */
function fixture(rows = [rec()]) {
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
  return { store };
}

test('a deleted Codex chat’s file checkpoints go with it; an unknown folder or a failing removal deletes the chat all the same', async () => {
  for (const [cwd, forgets] of [
    ['/w/p', async () => undefined],
    [undefined, async () => undefined],
    ['/disk', async () => undefined],
    ['/w/p', async () => Promise.reject(new Error('locked'))],
  ] as const) {
    const id = nativeKey(seg()),
      f = fixture([rec(id, [seg()])]),
      handlers = new Map(),
      calls: unknown[][] = [];
    register(
      { handle: (name: any, fn: any) => handlers.set(name, fn) } as any,
      {
        live: {
          chats: f.store,
          codex: {
            threadDelete: (nid: any) => calls.push(['delete', nid]),
            cwdOf: () => (cwd === '/disk' ? undefined : cwd),
            // a chat not opened this run: its folder is read from disk
            folderOf: async () => (cwd === '/disk' ? '/disk' : undefined),
            turnChanges: { checkpoints: { forget: (nid: any, at: any) => (calls.push(['forget', nid, at]), forgets()) } },
          },
        },
        claude: {},
        registerChats: () => ({ patchPrefs: () => true }),
        broadcastAll: () => {},
        STATE_FILE: () => '',
        readState: () => {},
      } as any,
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      await handlers.get('chats:delete')({}, id);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(
      calls,
      cwd
        ? [
            ['delete', 'root'],
            ['forget', 'root', cwd],
          ]
        : [['delete', 'root']],
    );
  }
});
