// Opening a chat only a machine's Host lists (src/session/openMachineChat.ts): main takes it in, the chat opens once its record has reached this window, and a refusal or a record that never comes is told, never an empty chat view.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const threads: Record<string, unknown> = {};
const listeners = new Set<(s: { threads: typeof threads }) => void>();
const toasts: unknown[][] = [];
const opened: unknown[][] = [];
let reloads = 0;
mock.module('../src/store/core.ts', {
  namedExports: {
    get: () => ({ threads }),
    set: (patch: (s: { threads: typeof threads }) => { threads: typeof threads }) => Object.assign(threads, patch({ threads }).threads),
    toast: (...a: unknown[]) => void toasts.push(a),
    useStore: { subscribe: (fn: (s: { threads: typeof threads }) => void) => (listeners.add(fn), () => void listeners.delete(fn)) },
  },
});
mock.module('../src/session/openChat.ts', { namedExports: { openChat: (...a: unknown[]) => void opened.push(a) } });
mock.module('../src/lib/hostChats.ts', {
  namedExports: {
    reloadHostChats: async () => {
      reloads++;
    },
  },
});
const { openMachineChat } = await import('../src/session/openMachineChat.ts');

/** The record reaches the window: the store says so to everyone listening. */
const arrive = (id: string) => {
  threads[id] = { id };
  for (const l of [...listeners]) l({ threads });
};
beforeEach(() => {
  for (const k of Object.keys(threads)) delete threads[k];
  listeners.clear();
  toasts.length = 0;
  released.length = 0;
  opened.length = 0;
  reloads = 0;
});
const released: unknown[][] = [];
const install = (
  open: (...a: any[]) => Promise<{ chatId: string }>,
  release: () => Promise<unknown> = async () => ({ released: true }),
) => {
  const fake = fakeNative({
    hostChats: {
      open,
      release: async (...a: unknown[]) => {
        released.push(a);
        return release();
      },
    },
  });
  installNative(fake);
  return fake;
};

test('the chat opens where the click asked once its record arrives, after the machines of chats are read again', async () => {
  const fake = install(async (_m, chatId) => ({ chatId: `acp:host-${chatId}` }));
  const done = openMachineChat('ssh:box', 'claude:a', 'split');
  setTimeout(() => arrive('acp:host-claude:a'), 5);
  await done;
  assert.deepEqual(fake.callsTo('hostChats.open'), [['ssh:box', 'claude:a']]);
  assert.equal(reloads, 1);
  assert.deepEqual(opened, [['acp:host-claude:a', 'split']]);
  assert.deepEqual(toasts, []);
  assert.equal(listeners.size, 0, 'nothing listens once it has opened');
});

test('a record this window already has opens at once', async () => {
  threads['acp:host-claude:b'] = { id: 'acp:host-claude:b' };
  install(async () => ({ chatId: 'acp:host-claude:b' }));
  await openMachineChat('ssh:box', 'claude:b', 'here');
  assert.deepEqual(opened, [['acp:host-claude:b', 'here']]);
});

test('a store change that is not that chat leaves the wait as it is; a record that never comes is told, and nothing opens', async () => {
  install(async () => ({ chatId: 'acp:host-claude:c' }));
  const done = openMachineChat('ssh:box', 'claude:c', 'here', { machineName: 'Build box', wait: 30 });
  setTimeout(() => arrive('acp:host-claude:other'), 5);
  await done;
  assert.deepEqual(opened, []);
  assert.deepEqual(toasts, [['Build box did not send that chat in time. Open it again to try once more.', 'error']]);
  assert.deepEqual(released, [['ssh:box', 'claude:c']], 'the binding main wrote is taken back');
  assert.equal(listeners.size, 0, 'the wait ended with its timer');
});

test('a refusal is told with the reason and opens nothing', async () => {
  install(async () => {
    throw new Error('That machine is not in the list.');
  });
  await openMachineChat('ssh:gone', 'claude:d', 'here');
  assert.deepEqual(opened, []);
  assert.deepEqual(toasts, [["Couldn't open that chat: That machine is not in the list.", 'error']]);
});

test("the machine's title names the chat until the chat names itself; a name it has stays", async () => {
  install(async (_m, chatId) => ({ chatId: `acp:host-${chatId}` }));
  const named = openMachineChat('ssh:box', 'claude:n', 'here', { title: 'Title from the machine' });
  setTimeout(() => arrive('acp:host-claude:n'), 5);
  await named;
  assert.equal((threads['acp:host-claude:n'] as { name?: string }).name, 'Title from the machine');
  threads['acp:host-claude:m'] = { id: 'acp:host-claude:m', name: 'Own name' };
  install(async () => ({ chatId: 'acp:host-claude:m' }));
  await openMachineChat('ssh:box', 'claude:m', 'here', { title: 'Title from the machine' });
  assert.equal((threads['acp:host-claude:m'] as { name?: string }).name, 'Own name');
  install(async () => ({ chatId: 'acp:host-claude:m' }));
  await openMachineChat('ssh:box', 'claude:m', 'here');
  assert.equal((threads['acp:host-claude:m'] as { name?: string }).name, 'Own name', 'no title, nothing set');
});

test('a release that fails does not hide why the chat did not open', async () => {
  install(
    async () => ({ chatId: 'acp:host-claude:f' }),
    async () => {
      throw new Error('no answer');
    },
  );
  await openMachineChat('ssh:box', 'claude:f', 'here', { wait: 20 });
  assert.deepEqual(opened, []);
  assert.match(String(toasts[0][0]), /The machine did not send that chat in time/);
});
