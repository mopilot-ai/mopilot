// Pending Host deletion remains explicit in whole-chat receipts, including mixed native segments, before the renderer hides the local chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatDeletion } from '../electron/session/chatDeletion.cjs';
import { register } from '../electron/app/ipc/chats.cjs';

function store(id: string, segments: any[]) {
  const records = new Map([[id, { id, segments, meta: {} }]]);
  return { records, newer: new Set(), unreadable: new Set(), record: (key: string) => records.get(key) } as any;
}
test('an earlier remote segment keeps its pending cleanup visible even when the canonical native is local', async () => {
  const chats = store('root', [
    { kind: 'codex', nativeId: 'root' },
    { kind: 'acp:kimi', nativeId: 'remote' },
  ]);
  const deletion = new ChatDeletion({
    store: chats,
    remove: { codex: async () => {}, acp: async () => ({ pending: true }) },
    broadcast: () => {},
  });
  assert.equal((await deletion.delete('root')).remoteDeletionPending, true);
});
test('production deletion IPC awaits durable remote retirement and returns the pending receipt with native cleanup', async () => {
  const chats = store('acp:kimi:remote', [{ kind: 'acp:kimi', nativeId: 'remote' }]);
  const handlers = new Map<string, any>();
  let removed = false;
  register(
    { handle: (name, fn) => handlers.set(name, fn) } as any,
    {
      live: {
        chats,
        remoteForget: async () => ({ pending: true }),
        acpHost: {
          remove: () => {
            removed = true;
          },
        },
      },
      registerChats: () => ({}),
      readState: () => {},
      broadcastAll: () => {},
      STATE_FILE: () => '',
    } as any,
  );
  const receipt = await handlers.get('chats:delete')({}, 'acp:kimi:remote');
  assert.equal(receipt.remoteDeletionPending, true);
  assert.equal(removed, true);
});
test('a Host too old to take the deletion is carried to the window on the receipt, whichever segment of the chat is on it', async () => {
  const chats = store('root', [
    { kind: 'codex', nativeId: 'root' },
    { kind: 'acp:kimi', nativeId: 'remote' },
  ]);
  const deletion = new ChatDeletion({
    store: chats,
    remove: { codex: async () => {}, acp: async () => ({ pending: true, outdated: true }) },
    broadcast: () => {},
  });
  const receipt = await deletion.delete('root');
  assert.deepEqual([receipt.remoteDeletionPending, receipt.remoteDeletionOutdated], [true, true]);
  const canonical = store('acp:kimi:remote', [{ kind: 'acp:kimi', nativeId: 'remote' }]);
  const first = new ChatDeletion({
    store: canonical,
    remove: { acp: async () => ({ pending: true, outdated: true }) },
    broadcast: () => {},
  });
  assert.equal((await first.delete('acp:kimi:remote')).remoteDeletionOutdated, true);
  const plain = new ChatDeletion({
    store: store('acp:kimi:p', [{ kind: 'acp:kimi', nativeId: 'p' }]),
    remove: { acp: async () => ({ pending: true }) },
    broadcast: () => {},
  });
  assert.equal(Object.hasOwn(await plain.delete('acp:kimi:p'), 'remoteDeletionOutdated'), false);
});
