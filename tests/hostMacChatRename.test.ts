// A machine chat's rename on this Mac's side (electron/host/remoteChatCalls.cjs, chatIds.cjs, remoteRename.cjs, remoteSend.cjs, wiring.cjs, remoteChatState.cjs): the request carries the chat's epoch and a key and the gates of the Host's wire (A), the Host is asked with its own chat id and a name from another client is followed as the person's (W), a Host that is away or too old is said in words and never ignored (B), and an older Host without the state lane still leaves the chat a name (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { helloParams } from '../shared/host/schema.mjs';
import { world } from './support/host/remoteSendKit.ts';
import { CHAT, FakeItems, createRemoteChats, fakeHost, start, tick } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
const { withAppChatIds } = require('../electron/host/chatIds.cjs');
const { createRename, RENAME_AWAY } = require('../electron/host/remoteRename.cjs');
const { createChatState } = require('../electron/host/remoteChatState.cjs');
const { remoteRoutes } = require('../electron/host/wiring.cjs');

const U = '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
const claudeId = `claude:${U}`;

function calls(features: string[] = helloParams().features) {
  const asked: any[][] = [];
  const { requireFeatures } = require('../shared/host/schema.mjs');
  const c = chatCalls({
    needs: (method: string, params?: any) => requireFeatures(method, { features }, params),
    request: async (method: string, params: any) => (asked.push([method, params]), { result: { name: params.name } }),
    epochOf: () => 7,
    mintKey: () => 'key-rename-mint0',
    speaks: () => true,
  });
  return { c, asked };
}

test('A: the name goes to the Host with the chat’s epoch, a key and only the fields the Host parses; a retry names its own key', async () => {
  const { c, asked } = calls();
  assert.deepEqual(await c.rename({ chatId: claudeId, name: '  Mine  ', extra: 1 } as any), { name: 'Mine' });
  assert.deepEqual(asked, [['chat.rename', { chatId: claudeId, epoch: 7, key: 'key-rename-mint0', name: 'Mine' }]]);
  await c.rename({ chatId: claudeId, name: 'Mine', key: 'key-retry-00001' });
  assert.equal((asked[1][1] as any).key, 'key-retry-00001');
});

test('A: a Host without the feature is refused before anything is sent, and a name the Host would refuse never leaves this Mac', async () => {
  const old = calls(helloParams().features.filter((f: string) => f !== 'chatName'));
  await assert.rejects(
    old.c.rename({ chatId: claudeId, name: 'Mine' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('chatName'),
  );
  const { c, asked } = calls();
  for (const p of [
    { chatId: claudeId, name: '' },
    { chatId: claudeId, name: 'a\nb' },
    { chatId: claudeId, name: 'x'.repeat(201) },
    undefined,
  ])
    await assert.rejects(c.rename(p as any), (e: any) => e.code === 'invalid');
  assert.equal(old.asked.length + asked.length, 0);
});

test('W: the Host is asked with its own chat id, whatever id the app shows', async () => {
  const asked: any[] = [];
  const host = { state: () => 'online', rename: async (p: any) => (asked.push(p), { name: p.name }) };
  const view = withAppChatIds(host, () => true);
  await view.rename({ chatId: `acp:host-claude:${U}`, name: 'Mine', key: 'k' });
  assert.deepEqual(asked, [{ chatId: claudeId, name: 'Mine', key: 'k' }]);
});

function renamer(over: Record<string, any> = {}) {
  const sent: any[] = [];
  const hosts: Record<string, any> = {
    online: { state: () => 'online', rename: async (p: any) => (sent.push(p), { name: p.name }) },
    away: { state: () => 'offline', rename: async () => assert.fail('an offline machine is never asked') },
    old: {
      state: () => 'online',
      rename: async () =>
        Promise.reject(
          Object.assign(new Error('The host cannot do this safely yet (it lacks chatName). Update it.'), { code: 'feature_missing' }),
        ),
    },
    refuses: {
      state: () => 'online',
      rename: async () =>
        Promise.reject(Object.assign(new Error('This machine has no such chat.'), { code: 'chat_unknown', fromHost: true })),
    },
    dropped: { state: () => 'online', rename: async () => Promise.reject(Object.assign(new Error('gone'), { code: 'host_unreachable' })) },
    words: {
      state: () => 'online',
      rename: async () => Promise.reject(Object.assign(new Error('The disk is full.'), { code: 'new_code', fromHost: true })),
    },
    bare: { state: () => 'online', rename: async () => Promise.reject({ code: 'new_code' }) },
    mute: { state: () => 'online', rename: async () => Promise.reject(Object.assign(new Error(''), { code: undefined })) },
    ...over,
  };
  const owners: Record<string, string> = {
    here: 'local',
    r1: 'online',
    r2: 'away',
    r3: 'gone',
    r4: 'old',
    r5: 'refuses',
    r6: 'dropped',
    r7: 'words',
    r8: 'mute',
    r9: 'bare',
  };
  const make = createRename({
    isRemote: (id: string) => owners[id] !== 'local',
    hostFor: (hostId: string) => hosts[hostId],
    ownerOf: (id: string) => ({ hostId: owners[id] }),
    machineOf: () => 'Pocket Mac',
    mintKey: () => 'key-mint-0000001',
  });
  return { make, sent };
}

test('B: the name reaches an online machine’s Host now; a chat that runs here is null; a machine that is away, or none, says so', async () => {
  const { make, sent } = renamer();
  assert.equal(make('here', 'Mine'), null);
  assert.deepEqual(await make('r1', 'Mine'), { name: 'Mine' });
  assert.deepEqual(sent, [{ chatId: 'r1', name: 'Mine', key: 'key-mint-0000001' }]);
  for (const id of ['r2', 'r3']) await assert.rejects(make(id, 'Mine') as Promise<unknown>, { message: RENAME_AWAY });
  assert.match(RENAME_AWAY, /Can't reach the machine/);
});

test('B: a Host that is too old, one that refuses, and one that fails are each worded; the table’s words win over the Host’s sentence', async () => {
  const { make } = renamer();
  const said = async (id: string) => {
    try {
      await (make(id, 'Mine') as Promise<unknown>);
    } catch (e: any) {
      return [e.message, e.code];
    }
    return null;
  };
  assert.deepEqual(await said('r4'), ['Pocket Mac is too old for this. Update it.', 'feature_missing']);
  // the failure names the machine and says its sentence is final (the window shows it as written and offers that machine's Update)
  await assert.rejects(make('r4', 'Mine') as Promise<unknown>, { worded: true, hostId: 'old' });
  assert.deepEqual(await said('r5'), ['Pocket Mac has no such chat.', 'chat_unknown']);
  // the connection dropped meanwhile: the machine is away, not a refusal
  assert.deepEqual(await said('r6'), [RENAME_AWAY, 'host_unreachable']);
  // a code the table does not know shows the Host's own sentence; a failure with no words at all says the machine is away
  assert.deepEqual(await said('r7'), ['The disk is full.', 'new_code']);
  assert.deepEqual(await said('r8'), [RENAME_AWAY, undefined]);
  // a failure that is no Error and says nothing
  assert.deepEqual(await said('r9'), [RENAME_AWAY, 'new_code']);
});

test('W: the service the app keeps asks the machine named by the registry row, and wires the route the ACP host takes', async (t) => {
  const w = world(t);
  const renames: any[] = [];
  (w.host as any).rename = async (p: any) => (renames.push(p), { name: p.name });
  w.remote('c1');
  assert.equal(w.service.rename('local-chat', 'x'), null);
  assert.deepEqual(await w.service.rename('c1', 'Mine'), { name: 'Mine' });
  assert.equal(renames[0].chatId, 'c1');
  assert.equal(renames[0].name, 'Mine');
  // a Host that refuses says the machine's name (the row's, else "The machine")
  (w.host as any).rename = async () => Promise.reject(Object.assign(new Error('x'), { code: 'feature_missing' }));
  await assert.rejects(w.service.rename('c1', 'Mine') as Promise<unknown>, { message: 'The machine is too old for this. Update it.' });
  (w.row as any).name = 'Pocket Mac';
  await assert.rejects(w.service.rename('c1', 'Mine') as Promise<unknown>, { message: 'Pocket Mac is too old for this. Update it.' });
  (w.host as any).rename = async (p: any) => ({ name: p.name });
  // the route main hands the ACP host: this service's answer, or nothing for a chat that runs here and while Host is off
  assert.deepEqual(await remoteRoutes({ remoteSend: () => w.service }).rename('c1', 'Mine'), { name: 'Mine' });
  assert.equal(remoteRoutes({ remoteSend: () => w.service }).rename('local-chat', 'Mine'), null);
  assert.equal(remoteRoutes({ remoteSend: () => null }).rename('c1', 'Mine'), null);
  assert.equal(remoteRoutes({}).rename('c1', 'Mine'), null);
});

/** The mirror's title handling alone: what the Host's state lane says, and the transcript and window it ends in. */
function lane(records: any[] = []) {
  const items = new FakeItems();
  items.records.push(...records);
  const emitted: any[] = [];
  const state = createChatState({
    items,
    emit: (e: object) => void emitted.push(e),
    state: () => null,
    questions: () => null,
    now: () => 1000,
    note: () => undefined,
  });
  const told = (patch: object, gone = false) => state.apply({ chatId: CHAT, gone }, patch);
  const titles = () => items.records.filter((r) => r.t === 'title');
  return { told, titles, emitted };
}

test('W: a name the person gave on the phone or another Mac is kept here as theirs and replaces what the window shows', async () => {
  const user = { t: 'user', user: { content: [{ type: 'text', text: 'fix the login page please' }] } };
  const l = lane([user, { t: 'title', name: 'Fix the login page', auto: true, at: 5 }]);
  await l.told({ title: { name: 'Mine', provisional: null, named: true } });
  assert.deepEqual(l.titles().at(-1), { t: 'title', name: 'Mine', at: 1000 });
  // the window replaces the name it shows, which is the one before: the Host's automatic title
  assert.deepEqual(l.emitted, [{ kind: 'threadName', key: CHAT, chatId: CHAT, name: 'Mine', provisional: 'Fix the login page' }]);
  // told again (a reconnect), and this Mac's own rename coming back from the Host: nothing is written twice
  await l.told({ title: { name: 'Mine', provisional: null, named: true } });
  assert.equal(l.titles().length, 2);
  // an automatic title after the person's name is never kept, and a person's later name replaces theirs
  await l.told({ title: { name: 'Auto later', provisional: null } });
  assert.equal(l.titles().at(-1).name, 'Mine');
  await l.told({ title: { name: 'Second', provisional: null, named: true } });
  assert.deepEqual(l.titles().at(-1), { t: 'title', name: 'Second', at: 1000 });
  // a chat that was left meanwhile keeps nothing
  await l.told({ title: { name: 'Late', named: true } }, true);
  assert.equal(l.titles().at(-1).name, 'Second');
});

test('W: a name with no title before it, and an automatic title the person already made theirs, are followed or kept as they are said', async () => {
  const fresh = lane([{ t: 'user', user: { content: [{ type: 'text', text: 'hello there' }] } }]);
  await fresh.told({ title: { name: 'Mine', provisional: null, named: true } });
  assert.deepEqual(fresh.titles(), [{ t: 'title', name: 'Mine', at: 1000 }]);
  // no earlier title: the window shows the first words, which is what it replaces
  assert.equal(fresh.emitted[0].provisional, 'hello there');
  // the Host's own automatic title for a chat this Mac then named the same: the person's record wins over the automatic one
  const same = lane([{ t: 'title', name: 'Same', auto: true, at: 5 }]);
  await same.told({ title: { name: 'Same', provisional: null, named: true } });
  assert.deepEqual(same.titles().at(-1), { t: 'title', name: 'Same', at: 1000 });
  const mine = lane([{ t: 'title', name: 'Same', at: 5 }]);
  await mine.told({ title: { name: 'Same', provisional: null, named: true } });
  assert.equal(mine.titles().length, 1);
});

test('I: an older Host with no state lane sends no title, so the mirror writes none: the chat is named by its first message (store-core: threadTitle, nameAtSend)', async () => {
  const items = new FakeItems();
  const host = fakeHost();
  const emitted: any[] = [];
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: object) => void emitted.push(e),
    now: () => 1000,
    report: () => undefined,
  });
  // an older Host's subscribe answers no chat state at all, and its stream has no state frame
  chats.follow(CHAT);
  await chats.settled(CHAT);
  host.fire.frame(CHAT, start('t1').event);
  await tick();
  await chats.settled(CHAT);
  assert.equal(items.records.filter((r) => r.t === 'title').length, 0);
  assert.equal(emitted.filter((e) => e.kind === 'threadName').length, 0);
});

test('the renderer’s typed view of acp:rename is the one the window reads: the name, and why a machine did not take it', async () => {
  // the declaration holds only types (src/lib/native/acp.ts): loading it is all a test can do, and the answer's shape is pinned by the IPC and renameThread tests
  assert.ok(await import('../src/lib/native/acp.ts'));
});
