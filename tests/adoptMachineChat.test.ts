// Taking in a chat only a machine's Host lists (electron/host/adoptMachineChat.cjs, the sidebar's "By machine" rows): the window names only the machine and the chat; main takes the chat's id and folder from its own index of that machine, writes nothing for a machine that is offline, a chat that machine does not list, a chat this Mac already runs elsewhere or one with no folder, and announces the chat to the windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAdoptMachineChat } = require('../electron/host/adoptMachineChat.cjs');
const { registerHostLists } = require('../electron/app/ipc/hostLists.cjs');

const rowOf = (chatId: string, folder: string | null = '/srv/app') => ({
  chatId,
  title: chatId,
  epoch: 3,
  ...(folder === null ? {} : { folder }),
});

function rig(o: { status?: string; known?: boolean; wired?: boolean; owner?: string; has?: boolean; taken?: boolean } = {}) {
  const adopted: unknown[][] = [];
  const released: string[] = [];
  const announced: any[] = [];
  const adopt = createAdoptMachineChat({
    row: (id: string) => (o.known === false ? null : { name: 'Build box', status: o.status ?? 'online', id }),
    index: () => [
      {
        machineId: 'ssh:box',
        rows: [rowOf('claude:abc'), rowOf('uuid-1', '/srv/codex'), rowOf('acp:kimi:x', '/srv/kimi'), rowOf('claude:nofolder', null)],
      },
      { machineId: 'ssh:other', rows: [rowOf('claude:elsewhere')] },
    ],
    owner: () => o.owner ?? 'local',
    has: () => o.has ?? false,
    takenIn: () => o.taken ?? false,
    machineChats: () =>
      o.wired === false
        ? null
        : { takeIn: async (...a: unknown[]) => void adopted.push(a), release: (id: string) => void released.push(id) },
    announce: (e: unknown) => announced.push(e),
  });
  return { adopt: adopt.open, release: adopt.release, adopted, announced, released };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'none',
    (e: { code?: string }) => e.code,
  );

test("the id and the folder come from the machine's own listing, under the app id of the chat's family, and the windows are told", async () => {
  const r = rig();
  assert.deepEqual(await r.adopt('ssh:box', 'claude:abc'), { chatId: 'acp:host-claude:abc' });
  assert.deepEqual(r.adopted, [['acp:host-claude:abc', { hostId: 'ssh:box', folder: '/srv/app', epoch: 3 }]]);
  assert.deepEqual(r.announced, [
    { harness: 'acp', chatId: 'acp:host-claude:abc', cwd: '/srv/app', worktreeOf: null, hostId: 'ssh:box', projectId: null },
  ]);
  // a Codex chat is bare on the Host, an ACP chat keeps its id: each opens as the harness it runs
  assert.equal((await r.adopt('ssh:box', 'uuid-1')).chatId, 'acp:host-codex:uuid-1');
  assert.equal((await r.adopt('ssh:box', 'acp:kimi:x')).chatId, 'acp:kimi:x');
  assert.deepEqual(
    r.adopted.map((a) => (a[1] as { folder: string }).folder),
    ['/srv/app', '/srv/codex', '/srv/kimi'],
    'each in the folder its machine said, never one the window sent',
  );
});

test('a chat the machine does not list, one it lists under another machine, or a request that names nothing is refused and nothing is written', async () => {
  const r = rig();
  assert.equal(await code(r.adopt('ssh:box', 'claude:elsewhere')), 'unknown_chat');
  assert.equal(await code(r.adopt('ssh:box', 'acp:host-codex:junk')), 'unknown_chat');
  assert.equal(await code(r.adopt('ssh:box', '')), 'bad_request');
  assert.equal(await code(r.adopt('', 'claude:abc')), 'bad_request');
  assert.equal(await code(r.adopt(7, 'claude:abc')), 'bad_request');
  assert.equal(await code(r.adopt('ssh:box', {})), 'bad_request');
  assert.equal(await code(rig({ known: false }).adopt('ssh:box', 'claude:abc')), 'unknown_machine');
  assert.deepEqual([r.adopted, r.announced], [[], []]);
});

test('a machine that is offline is refused with its name and nothing is written', async () => {
  const r = rig({ status: 'offline' });
  await assert.rejects(() => r.adopt('ssh:box', 'claude:abc'), { code: 'machine_offline', message: /Build box is offline/ });
  assert.deepEqual([r.adopted, r.announced], [[], []]);
});

test('a chat this Mac already runs on another machine is never moved by a click; one already on this machine is only announced; a chat with no folder is refused', async () => {
  const elsewhere = rig({ owner: 'ssh:other' });
  assert.equal(await code(elsewhere.adopt('ssh:box', 'claude:abc')), 'owned_elsewhere');
  assert.deepEqual([elsewhere.adopted, elsewhere.announced], [[], []]);
  const here = rig({ owner: 'ssh:box' });
  assert.deepEqual(await here.adopt('ssh:box', 'claude:abc'), { chatId: 'acp:host-claude:abc' });
  assert.deepEqual([here.adopted.length, here.announced.length], [0, 1], 'already bound: not bound again');
  const none = rig();
  assert.equal(await code(none.adopt('ssh:box', 'claude:nofolder')), 'no_folder');
  assert.deepEqual([none.adopted, none.announced], [[], []]);
});

test('without Host wired the call is refused', async () => {
  const r = rig({ wired: false });
  assert.equal(await code(r.adopt('ssh:box', 'claude:abc')), 'not_allowed');
  assert.deepEqual(r.announced, []);
});

test('the IPC call is the Host IPC own (its gate and error shape), reads this Mac index and ownership, and takes a chat in only while Host access is open', async () => {
  const lists = new Map<string, (...a: unknown[]) => unknown>();
  const calls = new Map<string, (...a: unknown[]) => unknown>();
  let open = true;
  const adopted: unknown[][] = [];
  const announced: unknown[] = [];
  registerHostLists({
    ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => void lists.set(channel, fn) },
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => void calls.set(channel, fn),
    allowed: () => open,
    service: () => ({
      list: () => ({ machines: [] }),
      chatIndex: () => [{ machineId: 'ssh:box', rows: [{ ...rowOf('claude:z', '/f'), epoch: 1 }] }],
      row: (id: string) => ({ id, name: 'box', status: 'online' }),
    }),
    deps: {
      live: {
        machineChats: { takeIn: async (...a: unknown[]) => void adopted.push(a) },
        hostOwnership: { get: () => ({ hostId: 'local' }) },
        announceRunChat: (e: unknown) => announced.push(e),
      },
    },
  });
  assert.deepEqual([...lists.keys()].sort(), ['host:chatIndex', 'host:machines']);
  assert.deepEqual([...calls.keys()], ['host:openChat', 'host:releaseChat']);
  const call = calls.get('host:openChat')!;
  assert.deepEqual(await call('ssh:box', 'claude:z'), { chatId: 'acp:host-claude:z' });
  assert.deepEqual(adopted, [['acp:host-claude:z', { hostId: 'ssh:box', folder: '/f', epoch: 1 }]]);
  assert.equal(announced.length, 1);
  open = false;
  await assert.rejects(() => Promise.resolve(call('ssh:box', 'claude:z')), { code: 'not_allowed' });
  assert.equal(adopted.length, 1, 'a closed gate adopts nothing');
});

test('an app without live services refuses the call; one without ownership records sees every chat as this Mac own', async () => {
  const service = () => ({
    list: () => ({ machines: [] }),
    chatIndex: () => [{ machineId: 'ssh:box', rows: [rowOf('claude:z', '/f')] }],
    row: (id: string) => ({ id, name: 'box', status: 'online' }),
  });
  const calls = new Map<string, (...a: unknown[]) => unknown>();
  registerHostLists({
    ipcMain: { handle: () => undefined },
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => void calls.set(channel, fn),
    allowed: () => true,
    service,
  });
  await assert.rejects(() => Promise.resolve(calls.get('host:openChat')!('ssh:box', 'claude:z')), { code: 'not_allowed' });
  const announced: unknown[] = [];
  const bare = new Map<string, (...a: unknown[]) => unknown>();
  registerHostLists({
    ipcMain: { handle: () => undefined },
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => void bare.set(channel, fn),
    allowed: () => true,
    service,
    deps: { live: { machineChats: { takeIn: async () => undefined }, announceRunChat: (e: unknown) => announced.push(e) } },
  });
  assert.deepEqual(await bare.get('host:openChat')!('ssh:box', 'claude:z'), { chatId: 'acp:host-claude:z' });
  assert.equal(announced.length, 1);
});

test('a chat already bound here announces its folder only when the machine said one: an empty one never overwrites the record a window has', async () => {
  const withFolder = rig({ owner: 'ssh:box' });
  await withFolder.adopt('ssh:box', 'claude:abc');
  assert.equal(withFolder.announced[0].cwd, '/srv/app');
  const without = rig({ owner: 'ssh:box' });
  assert.deepEqual(await without.adopt('ssh:box', 'claude:nofolder'), { chatId: 'acp:host-claude:nofolder' });
  assert.deepEqual([without.adopted, without.announced], [[], []], 'nothing to say, nothing bound again');
});

test('a chat taken in that never reached a window is released only while this Mac has no record of it, it is bound to that machine, and its binding says it was taken in', async () => {
  const bound = rig({ owner: 'ssh:box', taken: true });
  assert.deepEqual(await bound.release('ssh:box', 'claude:abc'), { released: true });
  assert.deepEqual(bound.released, ['acp:host-claude:abc']);
  // a chat that is starting on that machine, or was started here: bound, no record yet, never taken in from the list
  const starting = rig({ owner: 'ssh:box' });
  assert.deepEqual(await starting.release('ssh:box', 'claude:abc'), { released: false });
  assert.deepEqual(starting.released, []);
  const known = rig({ owner: 'ssh:box', taken: true, has: true });
  assert.deepEqual(await known.release('ssh:box', 'claude:abc'), { released: false }, 'a window has a record of it');
  const elsewhere = rig({ owner: 'ssh:other', taken: true });
  assert.deepEqual(await elsewhere.release('ssh:box', 'claude:abc'), { released: false });
  const local = rig({ taken: true });
  assert.deepEqual(await local.release('ssh:box', 'claude:abc'), { released: false });
  assert.deepEqual([known.released, elsewhere.released, local.released], [[], [], []]);
  assert.equal(await code(rig({ wired: false }).release('ssh:box', 'claude:abc')), 'not_allowed');
  assert.equal(await code(rig().release('', 'claude:abc')), 'bad_request');
  assert.equal(await code(rig({ known: false }).release('ssh:box', 'claude:abc')), 'unknown_machine');
  // a wiring without a release hook still answers
  const bare = createAdoptMachineChat({
    row: () => ({ name: 'b', status: 'online' }),
    index: () => [{ machineId: 'ssh:box', rows: [rowOf('claude:abc')] }],
    owner: () => 'ssh:box',
    has: () => false,
    takenIn: () => true,
    machineChats: () => ({ takeIn: async () => undefined }),
    announce: () => undefined,
  });
  assert.deepEqual(await bare.release('ssh:box', 'claude:abc'), { released: true });
});

test('a chat already bound here reads the epoch the machine holds when its row is opened again', async () => {
  const epochs: [string, number][] = [];
  const r = createAdoptMachineChat({
    row: () => ({ name: 'Build box', status: 'online' }),
    index: () => [
      { machineId: 'ssh:box', rows: [{ ...rowOf('claude:abc'), epoch: 4 }, { chatId: 'claude:noepoch', folder: '/f' } as any] },
    ],
    owner: () => 'ssh:box',
    has: () => false,
    takenIn: () => false,
    machineChats: () => ({ takeIn: async () => undefined, setEpoch: (id: string, epoch: number) => void epochs.push([id, epoch]) }),
    announce: () => undefined,
  });
  await r.open('ssh:box', 'claude:abc');
  await r.open('ssh:box', 'claude:noepoch');
  assert.deepEqual(epochs, [['acp:host-claude:abc', 4]], 'a row that names no epoch leaves the one bound');
});

test('the index the windows read, pulled or pushed, leaves out the chats whose deletion still waits for their machine', async () => {
  const { chatIndexHooks } = require('../electron/app/hostChatHooks.cjs');
  const entries = [{ machineId: 'ssh:box', state: 'ready', rows: [rowOf('claude:gone'), rowOf('claude:kept')] }];
  const pending = [{ hostId: 'ssh:box', chatId: 'acp:host-claude:gone' }];
  const lists = new Map<string, (...a: unknown[]) => unknown>();
  registerHostLists({
    ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => void lists.set(channel, fn) },
    handle: () => undefined,
    allowed: () => true,
    service: () => ({ list: () => ({ machines: [] }), chatIndex: () => entries, row: () => ({}) }),
    chats: { pendingDeletions: () => pending },
  });
  const pulled = (await lists.get('host:chatIndex')!()) as typeof entries;
  assert.deepEqual(
    pulled[0].rows.map((r) => r.chatId),
    ['claude:kept'],
  );
  const pushed: unknown[][] = [];
  const hooks = chatIndexHooks({
    deps: { broadcastAll: (...a: unknown[]) => void pushed.push(a), live: { machineChats: { pendingDeletions: () => pending } } },
    allowed: () => true,
    service: () => ({ chatIndex: () => entries, row: () => undefined }),
  });
  hooks.onChange();
  assert.deepEqual(
    (pushed[0][1] as typeof entries)[0].rows.map((r) => r.chatId),
    ['claude:kept'],
  );
});
