// A computer access world for tests (#1364): a real host on 127.0.0.1 (port 0) over a real registry and session store,
// with an encrypted store whose "encryption" is a tag, an in-memory access log, and client connections to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { ComputerAccessHost } = require('../../electron/computerAccess/host.cjs');
export const { HANDSHAKE_BYTES, HANDSHAKES_MAX, ATTEMPTS_PER_MINUTE } = require('../../electron/computerAccess/listener.cjs');
export const { ClientConnection } = require('../../electron/computerAccess/clientConnection.cjs');
export const { AccessStore } = require('../../electron/computerAccess/store.cjs');
export const { AccessLog } = require('../../electron/computerAccess/accessLog.cjs');
export const { RemoteOwners } = require('../../electron/computerAccess/owners.cjs');
export const { newKeyPair } = require('../../electron/computerAccess/handshake.cjs');
export const { parseOffer } = require('../../electron/computerAccess/offer.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { SessionStore } = require('../../electron/session/state.cjs');
const { acceptWebSocket } = require('../../electron/capabilities/browser/wsServer.cjs');

export const fakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4),
});

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(5);
  }
}

export type World = Awaited<ReturnType<typeof world>>;

/** A host, listening, with a registry that has a browser, a Chrome, an app and a never-offered tool. */
export async function world(
  o: {
    flag?: () => boolean;
    hostAnchor?: () => unknown;
    ledger?: any;
    registry?: any;
    enabled?: boolean;
    answer?: (id: string, r: unknown) => boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-access-host-'));
  const store = new AccessStore({ file: path.join(dir, 'store.json'), safeStorage: fakeSafe() });
  const registry = o.registry ?? new Registry();
  const calls: any[] = [];
  if (!o.registry) {
    registry.register({
      name: 'browser_navigate',
      policy: 'observe',
      schema: { type: 'object', properties: { url: { type: 'string' } } },
      handler: (args: any, ctx: any) => (calls.push({ args, ctx }), `went to ${args.url}`),
    });
    registry.register({ name: 'chrome_navigate', policy: 'observe', handler: () => 'chrome' });
    registry.register({ name: 'desktop_screenshot', policy: 'observe', handler: () => 'shot' });
    registry.register({ name: 'browser_javascript_exec', policy: 'observe', handler: () => 'never' });
    registry.register({ name: 'send_message_to_chat', policy: 'observe', handler: () => 'never' });
  }
  // as in main, every session change reaches the host (a remote owner's cards go to its device)
  let hostRef: any = null;
  const sessions = new SessionStore({ publish: (p: any) => hostRef?.onSessionPatch(p) });
  const owners = new RemoteOwners();
  const answers: any[] = [];
  const written: any[] = [];
  const log = new AccessLog({ dir: path.join(dir, 'log'), writer: { append: (_f: string, lines: string[]) => written.push(...lines) } });
  const host = new ComputerAccessHost({
    store,
    owners,
    registry: () => registry,
    answer: o.answer ?? ((id: string, result: unknown) => (answers.push({ id, result }), true)),
    sessions: () => sessions,
    hostAnchor: o.hostAnchor ?? (() => 'full'),
    flagOn: o.flag ?? (() => true),
    log,
    ledger: o.ledger,
    hostName: () => 'Studio',
    accept: acceptWebSocket,
    port: 0,
    handshakeMs: 500,
  });
  hostRef = host;
  if (o.enabled !== false) await host.setEnabled(true);
  const clients: any[] = [];
  const url = () => `ws://127.0.0.1:${host.listening.port}/mopilot-access`;
  /** A device that pairs (the person allows with these scopes) and stays connected. */
  async function pair(scopes: any = { browser: true }, name = 'Laptop') {
    const offer = parseOffer(host.startPairing().text);
    const identity = newKeyPair();
    const c = new ClientConnection({ url: url(), identity, pair: { name, secret: offer.secret, fingerprint: offer.fingerprint } });
    clients.push(c);
    const r = await c.connect();
    await until(() => host.request);
    const paired = c.paired();
    const device = host.answerPairing(true, scopes);
    await paired;
    return { c, identity, hostKey: r.host, device, code: r.code };
  }
  /** A paired device connecting again. */
  async function connect(identity: any, hostKey: string) {
    const c = new ClientConnection({ url: url(), identity, hostKey, handshakeMs: 2000 });
    clients.push(c);
    await c.connect();
    await until(() => [...host.conns].some((x: any) => x.open && x.deviceId));
    return c;
  }
  async function close() {
    for (const c of clients) c.close();
    await host.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { dir, store, registry, sessions, owners, answers, written, log, host, calls, url, pair, connect, close, clients };
}
