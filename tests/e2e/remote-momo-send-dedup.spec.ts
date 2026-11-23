// Electron's real remote service, MoMo operations, ChatController and durable send ledger reject reconnect duplicates across adapter families and ledger reopen.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test.skip(process.platform !== 'darwin', 'verify encrypted send receipts with the isolated macOS Keychain backend');

test('a new request envelope replays MoMo’s receipt, never a second controller admission', async ({ harness }) => {
  const entry = path.resolve(__dirname, '../../electron/remote/service.cjs');
  const results = await harness.app.evaluate(async ({ safeStorage }, entry) => {
    const require = process.getBuiltinModule('module').createRequire(entry);
    const fs = process.getBuiltinModule('fs').promises;
    const path = process.getBuiltinModule('path');
    const os = process.getBuiltinModule('os');
    const { RemoteService } = require(entry);
    const { SendLedger } = require('./sendLedger.cjs');
    const { createMomoRemoteOps } = require('./momoOps.cjs');
    const { ChatController } = require('../session/controller.cjs');
    const { SessionStore } = require('../session/state.cjs');
    const { ChatsStore } = require('../platform/chats.cjs');
    const { createMemoryLink } = require('../../shared/remote/transport.mjs');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'momo-send-repro-'));
    const results = [];
    try {
      for (const kind of ['codex', 'claude', 'acp:opencode']) {
        const chatId = `main-${kind}`;
        const state = new SessionStore();
        const chats = new ChatsStore(path.join(dir, kind.replace(':', '-'), 'chats'));
        chats.ensure(chatId);
        chats.setSegments(chatId, [{ harness: kind, nativeId: 'fake-native', start: 0, count: null }]);
        let admissions = 0;
        const startTurn = async () => {
          admissions++;
          return { started: true };
        };
        const controller = new ChatController({
          state,
          chats,
          codex: { serverObservers: new Set(), startTurn },
          claudeTurns: { startTurn },
          acpTurns: { startTurn },
          switcher: { perform: async () => ({ ready: true }) },
          claude: {},
          acp: {},
        });
        const mainChat = { ensureMainChat: async () => ({ chatId }), mainChatId: () => chatId };
        const momo = createMomoRemoteOps({
          mainChat,
          controller,
          allowed: () => true,
          momoPrefs: () => ({}),
          tap: { call: () => undefined },
          broker: () => null,
          routines: () => null,
          runTask: async () => undefined,
          answerOf: () => null,
          brainChangeAllowed: () => false,
          setPref: () => ({}),
        });
        const link = createMemoryLink();
        link.addPair('synthetic-phone');
        const file = path.join(dir, `${kind.replace(':', '-')}-sends.json`);
        (link.mac as any).sendLedger = new SendLedger({ file, fs, safe: safeStorage });
        const service = new RemoteService({ ops: { state, reachable: () => true }, momoAllowed: () => true, momo: () => momo });
        service.attach(link.mac);
        const phone = link.phone('synthetic-phone');
        const waiters = new Map<string, (reply: any) => void>();
        phone.onMessage((reply: any) => waiters.get(reply.inReplyTo)?.(reply));
        const ask = (envelope: string, text = 'hello') =>
          new Promise<any>((resolve, reject) => {
            waiters.set(envelope, resolve);
            phone
              .send({
                id: envelope,
                t: 1,
                kind: 'request',
                method: 'momo.chat.send',
                params: { id: 'stable-inner', text, expectedChatId: chatId },
              })
              .catch(reject);
          });
        const [first, concurrent] = await Promise.all([ask('first'), ask('concurrent')]);
        (link.mac as any).sendLedger = new SendLedger({ file, fs, safe: safeStorage });
        const reopened = await ask('reopened');
        const conflict = await ask('conflict', 'different');
        results.push({
          kind,
          admissions,
          queued: state.get(chatId).queue.length,
          first: first.result,
          concurrent: concurrent.result,
          reopened: reopened.result,
          conflict: conflict.error?.code,
        });
        service.detach();
      }
      return results;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, entry);
  expect(results).toHaveLength(3);
  for (const result of results) {
    expect(result.admissions, result.kind).toBe(1);
    expect(result.queued, result.kind).toBe(0);
    expect(result.first).toEqual({ sent: true });
    expect(result.concurrent).toEqual(result.first);
    expect(result.reopened).toEqual(result.first);
    expect(result.conflict).toBe('send_conflict');
  }
});
