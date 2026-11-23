// The real Host socket passes only its authenticated current identity to the image protocol and drops an answer after that socket closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { startServer, callHost } from '../host/src/server.mjs';
import { readJsonLines } from './support/jsonLineReader.ts';
const proof = { publicKey: 'MCowBQYDK2VwAyEA', nonce: 'a1b2c3d4', signature: 'c2lnbmF0dXJl' };
async function rig(t: any, protocol: any, pairing?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-server-'));
  const paths = { dataDir: dir, socketPath: path.join(dir, 'socket'), lockPath: path.join(dir, 'lock') };
  const server = await startServer({ paths, protocol, pairing });
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return paths;
}

test('local CLI, anonymous and paired socket identities are derived at the server, and revocation or verifier errors fail closed', async (t) => {
  let trusted = true,
    broken = false;
  const protocol = { connection: (_emit: any, identity: () => unknown) => ({ call: async () => identity(), close: () => {} }) };
  const paths = await rig(t, protocol, {
    verify: () => ({ fingerprint: 'pair-a' }),
    knows: () => {
      if (broken) throw new Error('pairing unavailable');
      return trusted;
    },
  });
  assert.deepEqual(await callHost(paths.socketPath, 'host.status', {}), { id: 1, result: 'local-cli' });
  assert.deepEqual(await callHost(paths.socketPath, 'host.status', {}, { anonymous: true }), { id: 1, result: null });
  const socket = net.connect(paths.socketPath);
  const lines = readJsonLines(socket);
  const ask = async (id: number, method: string, params = {}) => {
    socket.write(JSON.stringify({ id, method, params }) + '\n');
    return lines.find((x) => x.id === id);
  };
  await ask(1, 'host.auth', proof);
  assert.equal((await ask(2, 'host.status')).result, 'pair-a');
  trusted = false;
  assert.equal((await ask(3, 'host.status')).result, null);
  broken = true;
  assert.equal((await ask(4, 'host.status')).result, null);
  socket.destroy();
});

test('a delayed result after disconnect is discarded before the real socket publication boundary', async (t) => {
  let ready!: () => void, release!: (value: string) => void, closed!: () => void;
  const entered = new Promise<void>((done) => {
    ready = done;
  });
  const retired = new Promise<void>((done) => {
    closed = done;
  });
  const protocol = {
    connection: () => ({
      call: async () => {
        ready();
        return new Promise<string>((done) => {
          release = done;
        });
      },
      close: () => {
        closed();
      },
    }),
  };
  const paths = await rig(t, protocol);
  const socket = net.connect(paths.socketPath);
  socket.write(JSON.stringify({ id: 1, method: 'host.status', params: {} }) + '\n');
  await entered;
  const close = once(socket, 'close');
  socket.destroy();
  await close;
  await retired;
  release('private result');
  await new Promise((done) => setImmediate(done));
  assert.equal(socket.destroyed, true);
});
