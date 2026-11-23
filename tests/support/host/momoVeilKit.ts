// A Host's protocol over a fake runtime with a real approvals engine, journal and push port, and MoMo's home and chats made as the serve entry makes them: shared by the chat veil's tests (hostChatVeil.test.ts, hostMomoLostRegistry.test.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../../../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../../../host/src/momoChats.mjs';
// @ts-ignore
import { createMomoHidden } from '../../../host/src/momoWiring.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
// @ts-ignore
import { createProtocol } from '../../../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../../../host/src/epochs.mjs';
// @ts-ignore
import { createGuard } from '../../../host/src/guard.mjs';
// @ts-ignore
import { createLedger } from '../../../host/src/ledger.mjs';
// @ts-ignore
import { helloParams } from '../../../shared/host/schema.mjs';

export const quiet = { report: () => undefined };
export const MOMO = ['momo'];
export const PROVIDER_ENV = { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' };
export const scratch = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-veil-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** MoMo's chats over a fake runtime, with a real approvals engine, journal, push port and chat registry. */
export async function world(t: any) {
  const dir = scratch(t);
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sends: any[] = [];
  const runtime: any = {
    host,
    familyOf: (id: string) => (id.startsWith('claude:') ? 'claude' : 'acp'),
    send: async (p: any) => (sends.push(p), { turnId: `t${sends.length}` }),
    permit: () => true,
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
  });
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  const records = new Map<string, any>();
  const patchMeta = (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } });
  const sessions: any = { chats: { records, patchMeta }, isolated: () => true };
  home.chats = createMomoChats({ home, sessions, epochs, env: PROVIDER_ENV });
  const { chatId: M } = await home.chats.start({ harness: 'claude' });
  const hidden = createMomoHidden();
  hidden.bind(home.chats.isHidden);
  const told: any[] = [];
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({}),
    dataDir: dir,
    momo: home,
    notify: hidden.notify((m: any) => told.push(m)),
  });
  const connect = async (principal: unknown) => {
    const out: any[] = [];
    const conn = protocol.connection(
      (m: object) => out.push(m),
      () => null,
      { principal: () => principal as any },
    );
    await conn.call('host.hello', helloParams());
    return { conn, out };
  };
  const card = (chatId: string, requestId = 'r1') => {
    host.emit('event', { kind: 'turnStart', key: chatId, turnId: 't1' });
    host.emit('event', {
      kind: 'permission',
      key: chatId,
      requestId,
      turnId: 't1',
      toolCall: { title: 'send the mail', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
  };
  return { dir, home, M, host, sends, protocol, connect, card, told, hidden, epochs };
}
