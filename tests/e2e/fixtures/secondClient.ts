// A second client of a Host, as another device would be (the phone, another Mac): paired with the Host's own code over its socket, so a test can change a chat's mode from "somewhere else" while the app under test has its own picks. VM only.
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RemoteHost } from './remoteHost';
const require = createRequire(__filename);

/** A key sealed with nothing (a throwaway client key on a scratch folder). */
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};

export async function otherClient(host: RemoteHost, name = 'another-device') {
  const { lineClient } = await import('../../../scripts/host-accept/wire.mjs');
  const { loadIdentity, pairWith, authenticate } = require('../../../electron/host/pairingClient.cjs');
  const { helloParams } = await import('../../../shared/host/schema.mjs');
  const identity = loadIdentity(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'second-client-')), 'key'), safe);
  const connect = () => {
    const socket = net.createConnection(host.socketPath);
    const closed = new Promise((resolve) => socket.on('close', resolve));
    return lineClient({
      write: (t: string) => socket.write(t),
      onData: (fn: (c: string) => void) => socket.on('data', (d) => fn(String(d))),
      kill: () => socket.destroy(),
      closed,
    });
  };
  const paired = connect();
  await pairWith((m: string, p: object) => paired.request(m, p), identity, host.code(), name);
  paired.close();
  const c = connect();
  await authenticate((m: string, p: object) => c.request(m, p), identity);
  await c.request('host.hello', helloParams());
  let n = 0;
  return {
    /** Sets a chat's mode as this client (the Host takes it from any paired client). */
    permit: (chatId: string, value: string) => c.request('chat.permit', { chatId, epoch: 1, key: `${name}-${++n}-${Date.now()}`, value }),
    close: () => c.close(),
  };
}

/** The modes the Host's audit record shows `permission.set` with, oldest first (which client set which is in the line). */
export function permissionSets(host: RemoteHost): string[] {
  const dir = path.join(host.dataDir, 'audit');
  const lines = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .sort()
        .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    : [];
  return lines.filter((l) => l.includes('permission.set')).map((l) => /"mode":"([a-z-]+)"/.exec(l)?.[1] ?? l.slice(0, 200));
}

/**
 * Calls the Host as a second client, in a Node process of its own (Playwright's loader cannot take the ESM the pairing needs): paired with the Host's code, then each `[method, params]` in order. Returns each reply. VM only.
 * @param {RemoteHost} host @param {[string, object][]} calls
 */
export function asOtherClient(host: RemoteHost, calls: [string, object][]): unknown[] {
  const script = `
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const { lineClient } = await import(process.cwd() + '/scripts/host-accept/wire.mjs');
const { loadIdentity, pairWith, authenticate } = require('./electron/host/pairingClient.cjs');
const { helloParams } = await import(process.cwd() + '/shared/host/schema.mjs');
const { socketPath, code, calls } = JSON.parse(process.env.OTHER_CLIENT);
const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
const identity = loadIdentity(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'second-client-')), 'key'), safe);
const connect = () => {
  const socket = net.createConnection(socketPath);
  const closed = new Promise((resolve) => socket.on('close', resolve));
  return lineClient({ write: (t) => socket.write(t), onData: (fn) => socket.on('data', (d) => fn(String(d))), kill: () => socket.destroy(), closed });
};
const paired = connect();
await pairWith((m, p) => paired.request(m, p), identity, code, 'phone-like');
paired.close();
const c = connect();
await authenticate((m, p) => c.request(m, p), identity);
await c.request('host.hello', helloParams());
const out = [];
for (const [method, params] of calls) out.push(await c.request(method, params));
c.close();
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;
  const env = { ...process.env, OTHER_CLIENT: JSON.stringify({ socketPath: host.socketPath, code: host.code(), calls }) };
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    env,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}
