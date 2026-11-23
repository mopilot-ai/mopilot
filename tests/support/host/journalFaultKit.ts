// Real protocol and on-disk state owner shared by journal failure/retry tests.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createProtocol } from '../../../host/src/protocol.mjs';
import { createRunJournal } from '../../../host/src/runJournal.mjs';
import { createEpochStore } from '../../../host/src/epochs.mjs';
import { createGuard } from '../../../host/src/guard.mjs';
import { createLedger } from '../../../host/src/ledger.mjs';
import { helloParams } from '../../../shared/host/schema.mjs';
export function journalWorld(
  dataDir: string,
  send: (p: any) => Promise<{ turnId: string }> = async () => ({ turnId: 't' }),
  options: { permit?: () => boolean; prepare?: (p: any) => Promise<void>; images?: any; identity?: string } = {},
) {
  const host: any = new EventEmitter();
  const stopped: string[] = [];
  host.cancel = (id: string) => stopped.push(id);
  const report: string[] = [];
  const journal = createRunJournal({ dataDir });
  const epochs = createEpochStore(path.join(dataDir, 'epochs'), { report: () => {} });
  const protocol = createProtocol({
    dataDir,
    images: options.images,
    runtime: {
      host,
      send,
      prepare: options.prepare,
      permit: options.permit ?? (() => true),
      familyOf: (id: string) => (id.startsWith('claude:') ? 'claude' : id.startsWith('acp:') ? 'acp' : 'codex'),
    },
    journal,
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dataDir, 'ledger'), { report: () => {} }) }),
    status: () => ({}),
    report: (m: string) => report.push(m),
  } as any);
  const open = async (chatId: string) => {
    const frames: any[] = [];
    const conn = protocol.connection(
      (m: any) => frames.push(m),
      () => options.identity ?? null,
    );
    await conn.call('host.hello', helloParams());
    await conn.call('chat.subscribe', { chatId, epoch: 1 });
    return { conn, frames };
  };
  return { host, journal, protocol, open, stopped, report };
}
