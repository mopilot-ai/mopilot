// The fake Host the chat specs use carries a message's files the way the real Host does (#5145): its own folder per message holding the bytes, and the paths in the turn input it logs, so a spec fails when the files are not in the turn input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectSocket } from './support/connectSocket.ts';
import { waitFor } from './support/waitFor.ts';

const FAKE = path.join(import.meta.dirname, 'e2e', 'fixtures', 'fake-ssh', 'host-chats.cjs');

async function rig(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-host-files-'));
  const sock = path.join(root, 's.sock');
  const log = path.join(root, 'log');
  const child = spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_HOST_CHATS_SOCK: sock, FAKE_HOST_LOG: log, FAKE_HOST_ROOT: root },
    stdio: 'ignore',
  });
  let client: net.Socket | undefined;
  t.after(async () => {
    client?.destroy();
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'the fake Host to exit');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conn = (client = await connectSocket(sock, 'the fake Host to accept a connection'));
  let buffer = '';
  const waiting = new Map<number, (m: any) => void>();
  conn.setEncoding('utf8');
  conn.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (m.id !== undefined) waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      conn.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const logged = () =>
    fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { root, call, logged };
}

test('a message with a file and a folder: the Host keeps the bytes in its own folder and the turn input names the paths', async (t) => {
  const r = await rig(t);
  const body = Buffer.from('the secret word is plum');
  const id = createHash('sha256').update(body).digest('hex');
  await r.call('chat.attach', { chatId: 'c1', imageId: id, offset: 0, size: body.length, data: body.toString('base64') });
  await r.call('chat.send', {
    chatId: 'c1',
    key: 'k1',
    text: 'read them',
    files: [
      { id, name: 'note.txt', rel: '' },
      { id, name: 'proj', rel: 'deep/a.txt' },
    ],
  });
  const input = r.logged().find((l) => l.method === 'turn.input');
  assert(input, 'the turn input of a message with files is logged');
  const text: string = input.params.input[0].text;
  const paths = [...text.matchAll(/^@(.+)$/gm)].map((m) => m[1]);
  assert.equal(paths.length, 2);
  assert(paths.every((p) => p.startsWith(r.root)));
  assert.equal(fs.readFileSync(paths[0], 'utf8'), 'the secret word is plum');
  assert.equal(fs.readFileSync(path.join(paths[1], 'deep', 'a.txt'), 'utf8'), 'the secret word is plum');
});

test('a message without files has no staged folder and logs no extra turn input', async (t) => {
  const r = await rig(t);
  await r.call('chat.send', { chatId: 'c2', key: 'k2', text: 'hello' });
  assert.equal(
    r.logged().some((l) => l.method === 'turn.input'),
    false,
  );
  assert.equal(fs.existsSync(path.join(r.root, 'chat-files')), false);
});

for (const code of ['ENOENT', 'ECONNREFUSED']) {
  test(`a transient startup ${code} does not turn a healthy fake Host into a failed file test`, { timeout: 15_000 }, async (t) => {
    const connect = net.connect;
    let attempts = 0;
    t.mock.method(net, 'connect', (...args: any[]) => {
      if (++attempts === 1) {
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(Object.assign(new Error('injected startup failure'), { code })));
        return socket;
      }
      return Reflect.apply(connect, net, args);
    });
    const r = await rig(t);
    assert.ok(attempts >= 2, 'a refused socket must not establish readiness');
    await r.call('chat.send', { chatId: 'ready', key: 'ready', text: 'hello' });
    assert.equal(r.logged().find((entry) => entry.method === 'chat.send').params.text, 'hello');
  });
}

test('an unexpected connection error fails the setup instead of being retried as startup', async (t) => {
  const failure = Object.assign(new Error('not a startup race'), { code: 'EACCES' });
  let attempts = 0;
  t.mock.method(net, 'connect', () => {
    attempts++;
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(failure));
    return socket;
  });
  await assert.rejects(rig(t), (error) => error === failure);
  assert.equal(attempts, 1);
});
