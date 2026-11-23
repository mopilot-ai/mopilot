// Deleting an ACP chat lets go of a chat that runs on another machine first (electron/app/ipc/chats.cjs remoteForget, set by electron/app/ipc/host.cjs), so the mirror does not make it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsStore } from '../electron/platform/chats.cjs';
import { register } from '../electron/app/ipc/chats.cjs';

const ID = 'acp:kimi:c1';

/** A memory-only chat store with one ACP chat: its production methods run, nothing is read or written. */
const store = () =>
  Object.assign(Object.create(ChatsStore.prototype), {
    records: new Map([[ID, { id: ID, segments: [{ kind: 'acp:kimi', nativeId: 'c1' }], meta: { archived: 1 }, schemaVersion: 2 }]]),
    archiveEpochs: new Map([[ID, 0]]),
    newer: new Set(),
    unreadable: new Set(),
    now: () => 1,
    fallback: true,
    mirror: () => {},
    onChange: () => {},
    isDeleted: () => false,
    admitCommit: () => true,
  });

async function deleteChat(remoteForget: ((id: string) => void) | undefined, remoteSend?: () => any) {
  const order: string[] = [];
  const handlers = new Map<string, any>();
  register(
    { handle: (name: string, fn: any) => handlers.set(name, fn) } as any,
    {
      live: {
        chats: store(),
        acpHost: { remove: (id: string) => order.push(`remove ${id}`) },
        ...(remoteSend ? { remoteSend } : {}),
        ...(remoteForget ? { remoteForget: (id: string) => (order.push(`forget ${id}`), remoteForget(id)) } : {}),
      },
      claude: {},
      registerChats: () => ({ patchPrefs: () => true }),
      broadcastAll: () => undefined,
      STATE_FILE: () => '',
      readState: () => {},
    } as any,
  );
  await handlers.get('chats:delete')({}, ID);
  return order;
}

test('a deleted ACP chat is let go as a chat on a machine first, then removed here', async () => {
  const forgotten: string[] = [];
  assert.deepEqual(await deleteChat((id) => forgotten.push(id)), [`forget ${ID}`, `remove ${ID}`]);
  assert.deepEqual(forgotten, [ID]);
});

test('without Host wiring the chat is simply removed', async () => {
  assert.deepEqual(await deleteChat(undefined), [`remove ${ID}`]);
});

test('a chat on a machine is stopped there before it is let go; one on this Mac, or a machine that is away, does not hold the delete up', async () => {
  const stops: string[] = [];
  const hosted = () => ({ stop: (id: string) => (stops.push(id), Promise.resolve({ stopped: true })) });
  assert.deepEqual(await deleteChat(() => {}, hosted), [`forget ${ID}`, `remove ${ID}`]);
  assert.deepEqual(stops, [ID]);
  // a chat that runs here: remoteSend answers null for it
  assert.deepEqual(
    await deleteChat(
      () => {},
      () => ({ stop: () => null }),
    ),
    [`forget ${ID}`, `remove ${ID}`],
  );
  // the machine is away: the stop is refused, the delete goes on
  assert.deepEqual(
    await deleteChat(
      () => {},
      () => ({ stop: () => Promise.reject(new Error('The machine is away.')) }),
    ),
    [`forget ${ID}`, `remove ${ID}`],
  );
  // Host is off: no service
  assert.deepEqual(
    await deleteChat(
      () => {},
      () => null,
    ),
    [`forget ${ID}`, `remove ${ID}`],
  );
});
