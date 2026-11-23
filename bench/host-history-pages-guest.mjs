// Exercise the actual Host CLI on a private VM-only data directory: a fresh second socket recovers every paged item after an exact-child SIGKILL restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createChatLog } from '../host/src/chatLog.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { MAX_FRAME } from '../shared/host/frames.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.platform, 'darwin');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-page-'));
const paths = createPaths({ dataDir });
const chatId = 'acp:kimi:history-proof';
const expected = [
  { t: 'user', turnId: 't1', text: 'oldest 🦊 ' + 'x'.repeat(MAX_FRAME) },
  ...Array.from({ length: 24 }, (_, n) => ({ t: 'assistant', turnId: `t${n + 1}`, text: `item-${n}:` + 'kept'.repeat(600) })),
];
const log = createChatLog({ dataDir, epoch: () => 0 });
for (const item of expected) log.finish(chatId, item);
const digest = (items) => crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
const clients = new Set();
let child;
async function start() {
  child = spawn(process.execPath, [path.join(root, 'host', 'bin', 'mopilot-host.mjs'), 'serve', '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (s) => (output += s));
  child.stderr.on('data', (s) => (output += s));
  const end = Date.now() + 60_000;
  while (!output.includes('Host serving on')) {
    if (child.exitCode !== null || Date.now() > end) throw new Error(`Host startup failed: ${output.slice(-8000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return child.pid;
}
async function connect() {
  const socket = net.connect(paths.socketPath);
  // Connect failures reject once(connect); later request failures are reported by each bounded request timeout.
  socket.on('error', () => {
    /* Keep the socket error observed while its connect/request promise reports the failure. */
  });
  clients.add(socket);
  await once(socket, 'connect');
  const token = fs.readFileSync(paths.socketPath + '.token', 'utf8');
  let nextId = 0,
    buffer = '';
  const pending = new Map(),
    frames = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (m.frame) frames.push(m.frame);
      const waiter = pending.get(m.id);
      if (!waiter) continue;
      pending.delete(m.id);
      clearTimeout(waiter.timer);
      m.error ? waiter.reject(Object.assign(new Error(m.error), { code: m.code })) : waiter.resolve(m.result);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, method, params, token }) + '\n');
    });
  const agreed = await request('host.hello', helloParams());
  assert.ok(agreed.agreed.features.includes('historyPages'));
  return { socket, frames, request };
}
async function read(client) {
  await client.request('chat.subscribe', { chatId, epoch: 0 });
  const hello = client.frames.find((f) => f.t === 'hello');
  assert.equal(hello.snapshot.paged, true);
  let cursor = { index: 0, offset: 0 },
    pages = 0,
    bytes = 0,
    wire = '';
  do {
    const page = await client.request('chat.history', { chatId, epoch: 0, generation: hello.generation, rev: hello.rev, ...cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_FRAME);
    wire += page.chunk;
    pages++;
    bytes += Buffer.byteLength(page.chunk);
    cursor = page.next;
  } while (cursor);
  const items = wire
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.deepEqual(items, expected);
  return { generation: hello.generation, rev: hello.rev, pages, bytes, count: items.length, sha256: digest(items) };
}
try {
  const oldPid = await start();
  const first = await connect();
  const before = await read(first);
  first.socket.destroy();
  const died = once(child, 'exit');
  child.kill('SIGKILL');
  await died;
  const newPid = await start();
  assert.notEqual(newPid, oldPid);
  const second = await connect();
  const after = await read(second);
  assert.deepEqual(after, before);
  assert.ok(after.pages > 1);
  process.stdout.write(
    JSON.stringify({
      pass: true,
      oldPid,
      newPid,
      before,
      after,
      expectedSha256: digest(expected),
      scope:
        'real Host CLI and disk restart; two fresh authenticated local-CLI sockets; synthetic committed journal; no model turn, login change or GUI app',
    }) + '\n',
  );
} finally {
  for (const socket of clients) socket.destroy();
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
