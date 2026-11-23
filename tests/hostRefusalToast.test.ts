// A refusal a machine's Host gave, as a toast (src/store/hostRefusalToast.ts): its sentence as the machine's row writes the name, and the row's own Update when the sentence asks for one, for a rename (src/store/actions.ts) and for a deletion the machine could not take.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll, impl, flush, deleteReceipt } from './support/store-harness.ts';

mock.module(new URL('../src/lib/host.ts', import.meta.url).href, {
  namedExports: { hostAllowedNow: () => true, useHostAccess: () => true, useHostAnswered: () => true },
});
const { store: S, resetState } = await loadStore();
const { reloadHostChats, resetHostChats } = await import('../src/lib/hostChats.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const CHAT = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000aa';
const row = (over: object = {}) => ({
  id: 'box',
  name: 'localhost',
  status: 'online',
  note: '',
  signin: null,
  agents: [],
  capabilities: {},
  ...over,
});
const machines = (...rows: object[]) => {
  impl['host.machines'] = async () => ({ machines: rows, resolved: true });
};
const last = () => st().toasts.at(-1);

test("the receipt's typed view is the one the window reads", async () => {
  // the declaration holds only types (src/lib/chatDeletion.ts): loading it is all a test can do, and the toasts below pin what its fields mean
  assert.ok(await import('../src/lib/chatDeletion.ts'));
});

beforeEach(() => {
  resetState();
  resetAll();
  resetHostChats();
  set({ threads: { [CHAT]: { id: CHAT, name: 'old' } as any } });
});

test('a rename an old Host refused says the machine as its row writes it and offers that machine’s Update in place', async () => {
  machines(row({ hostStale: true }));
  impl['acp.acpRename'] = async () => ({ error: 'localhost is too old for this. Update it.', hostId: 'box' });
  impl['host.update'] = async () => undefined;
  await S.renameThread(CHAT, 'Mine');
  assert.equal(last().text, 'localhost is too old for this. Update it.');
  assert.equal(last().kind, 'error');
  assert.equal(last().action.label, 'Update');
  // the name this Mac keeps stands, and pressing Update is the row's own Update
  assert.equal((st().threads[CHAT] as any).name, 'Mine');
  last().action.run();
  await flush();
  assert.deepEqual(callsOf('host.update'), [['box']]);
});

test('an Update that fails says why, and a Host the row cannot update offers none', async () => {
  machines(row({ hostStale: true }));
  impl['acp.acpRename'] = async () => ({ error: 'localhost is too old for this. Update it.', hostId: 'box' });
  impl['host.update'] = async () => {
    throw new Error('The machine is busy.');
  };
  await S.renameThread(CHAT, 'Mine');
  last().action.run();
  await flush();
  assert.equal(last().text, 'The machine is busy.');
  // a machine whose Host is current has nothing to update: the sentence alone, as for a machine the app does not list
  set({ toasts: [] });
  machines(row());
  await S.renameThread(CHAT, 'Mine');
  assert.equal(last().action, undefined);
  set({ toasts: [] });
  impl['host.machines'] = async () => {
    throw new Error('no list');
  };
  await S.renameThread(CHAT, 'Mine');
  assert.deepEqual([last().text, last().action], ['localhost is too old for this. Update it.', undefined]);
  // a refusal that does not ask for an update never reads the row
  set({ toasts: [] });
  impl['acp.acpRename'] = async () => ({
    error: "Can't reach the machine, so it did not get the new name. The chat keeps it here.",
    hostId: 'box',
  });
  await S.renameThread(CHAT, 'Mine');
  assert.equal(last().action, undefined);
  impl['acp.acpRename'] = async () => ({ error: 'localhost is too old for this. Update it.' });
  await S.renameThread(CHAT, 'Mine');
  assert.equal(last().action, undefined);
});

test('a deletion the machine has not made yet says which machine will, and one an old Host cannot make says so and offers its Update', async () => {
  const other = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000bb';
  const old = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000cc';
  const unknown = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000dd';
  set({
    threads: { [CHAT]: { id: CHAT } as any, [other]: { id: other } as any, [old]: { id: old } as any, [unknown]: { id: unknown } as any },
  });
  impl['host.remoteChats'] = async () => [
    { chatId: other, hostId: 'box' },
    { chatId: old, hostId: 'box' },
    { chatId: unknown, hostId: 'not-listed' },
  ];
  await reloadHostChats();
  machines(row({ hostStale: true }));
  const pending = (id: string, extra: object = {}) => {
    impl['chats.delete'] = async () => ({ ...deleteReceipt(id), remoteDeletionPending: true, ...extra });
    return S.deleteThread(id);
  };
  await pending(other);
  assert.deepEqual([last().text, last().kind, last().action], ['Deleted here. localhost deletes it when it is back.', 'info', undefined]);
  await pending(old, { remoteDeletionOutdated: true });
  assert.equal(last().text, 'Deleted here. localhost is too old to delete it there. Update it.');
  assert.equal(last().action.label, 'Update');
  // a machine this window cannot find says what happens all the same
  await pending(unknown);
  assert.equal(last().text, 'Deleted here. The machine deletes it when it is back.');
  // asked again (the window already has the receipt), it says nothing more
  const told = st().toasts.length;
  await pending(old, { remoteDeletionOutdated: true });
  await pending(unknown);
  assert.equal(st().toasts.length, told);
});

test('a machine that is down: the open chat leaves its pane, one toast names the machine as its row writes it, and asking again says nothing', async () => {
  const down = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000d0';
  set({ threads: { [down]: { id: down } as any }, threadOrder: [down], route: { name: 'thread', id: down } });
  impl['host.remoteChats'] = async () => [{ chatId: down, hostId: 'box' }];
  await reloadHostChats();
  machines(row({ status: 'offline', name: 'Studio Mac' }));
  impl['chats.delete'] = async () => ({ ...deleteReceipt(down), remoteDeletionPending: true });
  await S.deleteThread(down);
  assert.deepEqual(st().route, { name: 'home' });
  assert.equal(st().threadOrder.includes(down), false);
  assert.deepEqual(
    st().toasts.map((t: any) => t.text),
    ['Deleted here. Studio Mac deletes it when it is back.'],
  );
  await S.deleteThread(down);
  assert.equal(st().toasts.length, 1);
});

test('the chat leaves the window before the machine is asked for its name to say what is pending', async () => {
  const slow = 'acp:host-claude:3f0a3b1c-0000-4000-8000-0000000000ee';
  set({ threads: { [slow]: { id: slow } as any }, threadOrder: [slow] });
  impl['host.remoteChats'] = async () => [{ chatId: slow, hostId: 'box' }];
  await reloadHostChats();
  let release: (v: unknown) => void = () => undefined;
  impl['host.machines'] = () => new Promise((resolve) => (release = resolve));
  impl['chats.delete'] = async () => ({ ...deleteReceipt(slow), remoteDeletionPending: true });
  const done = S.deleteThread(slow);
  await flush();
  assert.equal(st().threadOrder.includes(slow), false, 'gone from the sidebar while the machine row is still being read');
  assert.equal(st().toasts.length, 0);
  release({ machines: [row()], resolved: true });
  await done;
  assert.equal(last().text, 'Deleted here. localhost deletes it when it is back.');
});
