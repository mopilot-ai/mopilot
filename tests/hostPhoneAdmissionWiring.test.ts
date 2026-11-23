// The production Host IPC facade binds phone permission, folder revalidation and transcript reconciliation to the same lazy services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeHost, FakeItems } from './support/host/remoteChatsKit.ts';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

test('a phone start stores its permission and reconciles its first input through the production lazy sender and mirror', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-admission-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = fakeHost();
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const state = new Map<string, any>();
  const folderReads: any[] = [];
  const sentReads: any[] = [];
  let options: any;
  let input: any;
  const records = new FakeItems();
  const sender = {
    begin: () => {},
    enqueue: (chatId: string, item: any, _origin: any, gate: Promise<unknown>) => {
      input = { chatId, item, gate };
      assert.equal(state.get(chatId)?.permission, 'read-only', 'mode is committed before the durable enqueue callback');
      return { action: 'queued' };
    },
    sent: {
      take: (chatId: string, key?: string) => (sentReads.push(['take', chatId, key]), input.item.text),
      seen: (chatId: string, text: string, key?: string) => sentReads.push(['seen', chatId, text, key]),
      attached: () => undefined,
    },
  };
  const live: any = {
    controller: {
      state: {
        get: (id: string) => state.get(id) ?? { queue: [] },
        has: (id: string) => state.has(id),
        patch: (id: string, patch: any) => state.set(id, { ...state.get(id), ...patch }),
      },
    },
    acpHost: { items: records, emitEvent: () => {} },
  };
  register(
    { handle: () => {} },
    {
      live,
      app: { getPath: () => dir },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => {},
    },
    {
      allowed: () => true,
      create: () => ({
        list: () => ({ machines: [{ id: 'box', name: 'box', status: 'online' }], resolved: true }),
        row: () => ({ id: 'box', name: 'box', harnesses: [{ id: 'claude', detected: true, signedIn: true }] }),
        hostFor: () => host,
        onRowChange: () => () => {},
      }),
      makeRemoteSend: (o: any) => {
        options = o;
        return () => sender;
      },
      createFolders: () => ({
        list: async (hostId: string, q: any) => (folderReads.push([hostId, q]), { path: q.path }),
        bind: (chatId: string, at: any) => own.set(chatId, { ...at, ownerHostId: at.hostId, epoch: 0 }),
      }),
    },
  );
  const reply = await live.hostPhone.start({
    hostId: 'box',
    folder: '/srv',
    harness: 'claude',
    text: 'first input',
    projectId: null,
    model: null,
    effort: null,
    permission: 'read-only',
  });
  const chatId = reply.chatId;
  await input.gate;
  const mirror = live.remoteChats();
  await mirror.settled(chatId);
  assert.deepEqual(await options.checkFolder('box', '/recovered'), { path: '/recovered' });
  assert.deepEqual(folderReads, [
    ['box', { path: '/srv' }],
    ['box', { path: '/recovered' }],
  ]);
  host.fire.patch(chatId, 1, { t: 'event', family: 'claude', event: { kind: 'turnStart', turnId: 'turn' } });
  host.fire.patch(chatId, 2, {
    t: 'event',
    family: 'claude',
    event: {
      kind: 'update',
      turnId: 'turn',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
    },
  });
  await mirror.settled(chatId);
  assert.deepEqual(sentReads, [
    ['take', chatId, undefined],
    ['seen', chatId, 'first input', 'turn'],
  ]);
  assert.equal(records.records.find((r) => r.t === 'user')?.user.content[0].text, 'first input');
  mirror.dispose();
});
