// Reproduces phone-created machine chats through the real main-process facade, durable outbox and transcript pairing, with a delayed fake Host.
import path from 'node:path';
import { test, expect } from './fixtures/app';

for (const family of ['claude', 'codex', 'acp']) {
  test(`phone start on ${family}: immediate durable reply, picked mode, first user text once`, async ({ harness }) => {
    const entry = path.resolve(__dirname, '../../electron/app/hostPhone.cjs');
    const result = await harness.app.evaluate(
      async (_electron, { entry, family }) => {
        const require = process.getBuiltinModule('module').createRequire(entry);
        const fs = process.getBuiltinModule('fs');
        const os = process.getBuiltinModule('os');
        const path = process.getBuiltinModule('path');
        const { createHostPhone } = require(entry);
        const { createMachineChatStart } = require('../host/machineChatStart.cjs');
        const { createRemoteSend } = require('../host/remoteSend.cjs');
        const { createOutbox } = require('../host/outbox.cjs');
        const { createRemoteChats } = require('../host/remoteChats.cjs');
        const { queueItem } = require('../session/queueItem.cjs');
        const { SessionStore } = require('../session/state.cjs');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-machine-start-'));
        const state = new SessionStore({ publish: () => {} });
        const agent = family === 'acp' ? 'fake' : family;
        const chatId = `acp:${family === 'acp' ? 'fake' : `host-${family}`}:phone-repro`;
        const records: any[] = [];
        const events: any[] = [];
        const patches = new Set<(p: any) => void>();
        let folderReady!: () => void;
        let rpcReply!: () => void;
        const folder = new Promise<void>((resolve) => {
          folderReady = resolve;
        });
        const rpc = new Promise<void>((resolve) => {
          rpcReply = resolve;
        });
        const starts: any[] = [];
        let dispatched!: () => void;
        const started = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        const host = {
          state: () => 'online',
          connect: async () => {},
          onState: () => () => {},
          subscribe: async () => ({ snapshot: { rev: 0, items: [] }, patches: null, generation: 'g1', inflight: [] }),
          events: {
            onPatch: (fn: (p: any) => void) => (patches.add(fn), () => patches.delete(fn)),
            onFrame: () => () => {},
            onResync: () => () => {},
            onInflight: () => () => {},
          },
          start: async (_id: string, item: any) => {
            starts.push(item);
            dispatched();
            await rpc;
          },
        };
        const owner = () => ({ hostId: 'box', epoch: 1, folder: '/srv' });
        let sender: any;
        const chats = createRemoteChats({
          items: {
            append: (_id: string, ...rows: any[]) => records.push(...rows),
            readAsync: async () => [...records],
            flush: async () => {},
          },
          hostFor: () => host,
          ownerOf: owner,
          emit: (e: any) => events.push(e),
          state: () => state,
          sent: { take: (...args: any[]) => sender.sent.take(...args), seen: (...args: any[]) => sender.sent.seen(...args) },
        });
        sender = createRemoteSend({
          outbox: createOutbox({ dir }),
          ownerOf: owner,
          hostFor: () => host,
          rowOf: () => ({ status: 'online' }),
          state: () => state,
          tray: queueItem,
          subscribed: (id: string) => chats.subscribed(id),
        });
        const machineChats = createMachineChatStart({
          row: () => ({ name: 'box', harnesses: [{ id: agent, detected: true, signedIn: true }] }),
          apiKeys: { hasFor: () => false },
          orgAccess: { covers: () => false },
          bind: () => {},
          begin: (id: string, start: any) => sender.begin(id, start),
          follow: (id: string) => chats.follow(id),
        });
        const phone = createHostPhone({
          allowed: () => true,
          watch: () => {},
          machines: () => ({ list: () => ({ machines: [{ id: 'box', name: 'box', status: 'online' }] }) }),
          folders: () => ({ list: () => folder }),
          machineChats: { ...machineChats, newChatId: () => chatId },
          enqueue: (id: string, item: any, gate: Promise<unknown>) => sender.enqueue(id, item, null, gate),
          setMode: (id: string, mode: string) => state.patch(id, { permission: mode }),
          announce: () => {},
          move: async () => {},
          plan: async () => {},
          ownership: { get: owner },
          orgCovers: () => false,
          changed: () => {},
          projects: () => [],
        });
        try {
          const reply = await phone.start({
            hostId: 'box',
            folder: '/srv',
            harness: family === 'acp' ? 'acp:fake' : family,
            projectId: null,
            text: 'My first message',
            model: null,
            effort: null,
            permission: 'auto-review',
          });
          const before = {
            queue: state.get(chatId).queue.map((q: any) => q.text),
            requests: starts.length,
            durable: createOutbox({ dir })
              .pending(chatId)
              .map((e: any) => e.options.item.text),
          };
          folderReady();
          await started;
          const fire = (rev: number, item: any) => patches.forEach((fn) => fn({ chatId, rev, patch: { item } }));
          const event = (ev: any) => ({ t: 'event', family, event: ev });
          fire(1, event({ kind: 'turnStart', turnId: 'native-turn' }));
          fire(
            2,
            event({
              kind: 'update',
              turnId: 'native-turn',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } },
            }),
          );
          await chats.settled(chatId);
          fire(3, { t: 'user', turnId: 'native-turn', text: 'My first message' });
          await chats.settled(chatId);
          rpcReply();
          await sender.resume();
          const user = records.filter((r) => r.t === 'user');
          return {
            reply,
            before,
            permission: starts[0]?.permission,
            users: user.map((r) => r.user.content),
            starts: events.filter((e) => e.kind === 'turnStart').length,
            queue: state.get(chatId).queue,
          };
        } finally {
          folderReady();
          rpcReply();
          sender.dispose();
          chats.dispose();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      { entry, family },
    );
    expect(result.reply).toEqual({ chatId: expect.any(String) });
    expect(result.before).toEqual({ queue: ['My first message'], requests: 0, durable: ['My first message'] });
    expect(result.permission).toBe('auto-review');
    expect(result.users).toEqual([[{ type: 'text', text: 'My first message', text_elements: [] }]]);
    expect(result.starts).toBe(1);
    expect(result.queue).toEqual([]);
  });
}
