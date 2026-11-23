// A served Host with a protocol and two-client pairing helpers, for the client-table tests (hostClients, hostPrincipal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../../host/src/pairing.mjs';
// @ts-ignore
import { createPaths } from '../../host/src/paths.mjs';
// @ts-ignore
import { startServer } from '../../host/src/server.mjs';
// @ts-ignore
import { createProtocol } from '../../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../../host/src/guard.mjs';
// @ts-ignore
import { helloParams } from '../../shared/host/schema.mjs';
import { line } from './host-line.ts';
import { keySafe } from './hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity, pairWith, authenticate } = require('../../electron/host/pairingClient.cjs');

export const tmpDir = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clients-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A served Host whose runtime records what it was sent. */
export async function servedHost(t: any, extra: Record<string, unknown> = {}, wrapRuntime: (runtime: any) => any = (r) => r) {
  const dir = tmpDir(t);
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sends: any[] = [];
  const runtime: any = {
    host,
    send: async (p: any) => (sends.push(p), { turnId: `t${sends.length}` }),
    permit: () => true,
  };
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const ledgerDir = path.join(dir, 'l');
  const guard = createGuard({ epochs, ledger: createLedger(ledgerDir, quiet) });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    ...extra,
  });
  const server = await startServer({ paths, runtime: wrapRuntime(runtime), pairing, protocol });
  t.after(() => server.close());
  const identity = (n: string) => loadIdentity(path.join(dir, `${n}.json`), keySafe);
  /** A connection of a new client paired with `name`, through the code. */
  const paired = async (n: string, name?: string) => {
    const id = identity(n);
    const conn = line(paths.socketPath);
    t.after(conn.close);
    await pairWith(conn.request, id, pairing.issueCode(), name);
    await conn.request('host.hello', helloParams());
    return { id, conn };
  };
  /** A new connection of an already paired client. */
  const reconnect = async (id: any) => {
    const conn = line(paths.socketPath);
    t.after(conn.close);
    await authenticate(conn.request, id);
    await conn.request('host.hello', helloParams());
    return conn;
  };
  return {
    dir,
    paths,
    pairing,
    protocol,
    runtime,
    sends,
    ledgerDir,
    identity,
    paired,
    reconnect,
    line: () => line(paths.socketPath),
  };
}
