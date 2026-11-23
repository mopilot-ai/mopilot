// A Host process without its socket server for the continue tests: its protocol over a fake ACP runtime that remembers what it was sent.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../../host/src/guard.mjs';
// @ts-ignore
import { createContinueWiring } from '../../host/src/continueWiring.mjs';

const quiet = { report: () => undefined };

/** A Host process without the socket server: its protocol over a fake ACP runtime that remembers what it was sent. */
export function makeHostProcess(id: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `host-wire-${id}-`));
  const acp: any = new EventEmitter();
  acp.cancel = () => undefined;
  acp.chats = new Map();
  acp.starting = new Map();
  acp.ids = ['gemini'];
  acp.close = (key: string) => acp.chats.delete(key);
  const sends: any[] = [];
  const runtime: any = {
    host: acp,
    send: async (p: any) => {
      // what the agent is sent: the handoff goes in front of the user's words as a prefix (host/src/protocol.mjs)
      const { prefix, ...rest } = p;
      sends.push(prefix ? { ...rest, text: `${prefix}\n\n${p.text}` } : p);
      acp.chats.set(p.key, { prompting: null });
      return { turnId: `${id}-t${sends.length}` };
    },
  };
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
  const ledger = createLedger(path.join(dir, 'ledger'), quiet);
  const problems: string[] = [];
  const { continueHost, target } = createContinueWiring({
    dataDir: dir,
    runtime,
    hostFs: {
      existingDirectory: async (p: any) => {
        if (p === '/missing') throw Object.assign(new Error('That folder does not exist.'), { code: 'not_found' });
        return p;
      },
    } as any,
    epochs,
    ledger,
    report: (p: string) => problems.push(p),
  });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard: createGuard({ epochs, ledger }),
    status: () => ({}),
    continueHost,
    handoffs: target,
  });
  return { id, dir, runtime, sends, epochs, continueHost, protocol, problems, acp };
}
