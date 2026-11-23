// Offline SSH fixtures reject real socket input and output at the boundary even before their periodic poll runs.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deferred } from './support/async-scenarios.ts';

async function fixture(t: TestContext, resident = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-'));
  const address = (name: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\fake-ssh-${randomUUID()}` : path.join(dir, name));
  const local = address('s');
  const upstream = address('r');
  const offline = path.join(dir, 'offline');
  const log = path.join(dir, 'calls');
  const preload = path.join(dir, 'hold-poll.cjs');
  fs.writeFileSync(
    preload,
    `// Hold periodic polling so the test exercises I/O admission, and observe actual listen readiness.
globalThis.setInterval = () => 0;
const net = require('node:net');
const create = net.createServer.bind(net);
net.createServer = (...args) => {
  const server = create(...args);
  server.once('listening', () => process.send?.('ready'));
  return server;
};
`,
  );
  const request = deferred<net.Socket>();
  const sockets = new Set<net.Socket>();
  const server = resident
    ? net.createServer((socket) => {
        sockets.add(socket);
        socket.once('data', () => request.resolve(socket));
      })
    : null;
  if (server) {
    server.listen(upstream);
    await once(server, 'listening');
  }
  const child = spawn(
    process.execPath,
    [
      '--require',
      preload,
      fileURLToPath(new URL('./e2e/fixtures/fake-ssh/ssh', import.meta.url)),
      '-N',
      '-L',
      `${local}:/h/host.sock`,
      'me@box',
    ],
    {
      env: {
        ...process.env,
        FAKE_HOST_ROOT: dir,
        FAKE_HOST_LOG: log,
        FAKE_HOST_OFFLINE: offline,
        FAKE_HOST_CHATS_SOCK: resident ? upstream : '',
        FAKE_HOST_WIRE_SOCK: '',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let errors = '';
  child.stderr?.on('data', (chunk) => (errors += String(chunk)));
  const exited = once(child, 'exit');
  let client: net.Socket | undefined;
  t.after(async () => {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await exited.catch(() => {});
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message, 'ready')),
    exited.then(([code]) => assert.fail(`fake SSH exited before listening (${code}): ${errors}`)),
  ]);
  client = net.connect(local);
  client.on('error', () => {});
  await once(client, 'connect');
  const observe = () =>
    Promise.race([
      exited.then(([code]) => ({ kind: 'exit', code })),
      once(client!, 'data').then(
        ([data]) => ({ kind: 'data', data: String(data) }),
        () => ({ kind: 'closed' }),
      ),
    ]);
  return { offline, log, client, request, observe, exited };
}

test('a command arriving while offline never reaches the fake Host before the next poll', async (t) => {
  const r = await fixture(t);
  const observed = r.observe();
  fs.writeFileSync(r.offline, '');
  r.client.write(`${JSON.stringify({ id: 1, method: 'git.inspect', params: {} })}\n`);
  assert.notEqual((await observed).kind, 'data', 'offline input must not receive a successful reply');
  assert.equal((await r.exited)[0], 255);
  assert.equal(fs.existsSync(r.log), false, 'offline input must not reach command dispatch');
});

test('a resident reply released after going offline never crosses the app socket before the next poll', async (t) => {
  const r = await fixture(t, true);
  // the fixture holds the real Host's rule: a versioned request is refused until hello came first on the connection
  const hello = once(r.client, 'data');
  r.client.write(`${JSON.stringify({ id: 0, method: 'host.hello', params: {} })}\n`);
  await hello;
  const observed = r.observe();
  r.client.write(`${JSON.stringify({ id: 1, method: 'chat.start', params: { chatId: 'c', text: 'hello' } })}\n`);
  const upstream = await r.request.promise;
  fs.writeFileSync(r.offline, '');
  upstream.write(`${JSON.stringify({ id: 1, result: { turnId: 't' } })}\n`);
  assert.notEqual((await observed).kind, 'data', 'offline resident output must not be forwarded');
  assert.equal((await r.exited)[0], 255);
});

for (const state of ['offline', 'online', 'asleep'] as const)
  test(`the one-shot login probe obeys the ${state} machine state`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-probe-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const offline = path.join(dir, 'offline');
    if (state === 'offline') fs.writeFileSync(offline, '');
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./e2e/fixtures/fake-ssh/ssh', import.meta.url)), '--', 'me@box', 'stat /dev/console; sysctl kern.boottime'],
      {
        env: { ...process.env, FAKE_HOST_ROOT: dir, FAKE_HOST_OFFLINE: offline, FAKE_HOST_ASLEEP: state === 'asleep' ? 'me@box' : '' },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, state === 'offline' ? 255 : 0);
    assert.equal(result.stderr, '');
    if (state === 'offline') assert.equal(result.stdout, '', 'an unreachable machine cannot answer its console probe');
    else
      assert.match(result.stdout, state === 'asleep' ? /^root\nme\n\{ sec = \d+, usec = 0 \}\n$/ : /^me\nme\n\{ sec = \d+, usec = 0 \}\n$/);
  });

test('offline one-off startup commands cannot answer or change the daemon marker', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-startup-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const offline = path.join(dir, 'offline');
  const boot = path.join(dir, 'boot');
  fs.writeFileSync(offline, '');
  for (const command of ['host status', 'host install --print-daemon', '/usr/bin/sudo turned-on']) {
    const out = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./e2e/fixtures/fake-ssh/ssh', import.meta.url)), '--', 'me@box', command],
      {
        env: { ...process.env, FAKE_HOST_OFFLINE: offline, FAKE_HOST_BOOT_FILE: boot, FAKE_HOST_ADMIN_PASSWORD: 'fake' },
        input: 'fake\n',
        encoding: 'utf8',
      },
    );
    assert.equal(out.status, 255, command);
    assert.equal(out.stdout, '', command);
    assert.equal(fs.existsSync(boot), false);
  }
});

test('sudo becoming offline while waiting for input never changes its daemon marker', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sudo-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const offline = path.join(dir, 'offline');
  const boot = path.join(dir, 'boot');
  const preload = path.join(dir, 'ready.cjs');
  fs.writeFileSync(
    preload,
    `const on = process.stdin.on; process.stdin.on = function(name, fn) { const r = on.call(this, name, fn); if (name === 'end') process.send('ready'); return r; };`,
  );
  const child = spawn(
    process.execPath,
    [
      '--require',
      preload,
      fileURLToPath(new URL('./e2e/fixtures/fake-ssh/ssh', import.meta.url)),
      '--',
      'me@box',
      '/usr/bin/sudo turned-on',
    ],
    {
      env: { ...process.env, FAKE_HOST_OFFLINE: offline, FAKE_HOST_BOOT_FILE: boot, FAKE_HOST_ADMIN_PASSWORD: 'fake' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  const exited = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await once(child, 'message');
  fs.writeFileSync(offline, '');
  assert.ok(child.stdin);
  child.stdin.end('fake\n');
  assert.equal((await exited)[0], 255);
  assert.equal(fs.existsSync(boot), false);
});
