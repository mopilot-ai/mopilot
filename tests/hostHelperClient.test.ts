// The Host's client of the computer-use helper (G8 #3903): launched through LaunchServices, spoken to over a private socket, one launch for callers that come together, nothing replayed when the helper exits.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHelperClient, HelperError } from '../host/src/helperClient.mjs';
// @ts-ignore: plain ESM without declarations
import { createDesktopHost } from '../host/src/desktopHost.mjs';
// @ts-ignore: plain ESM without declarations
import { createDesktopProbe } from '../host/src/desktopProbe.mjs';
import { deferred, tick } from './support/async-scenarios.ts';

const { JsonReader } = createRequire(import.meta.url)('../electron/transport/jsonReader.cjs');

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** A fake LaunchServices `open`: starts a helper (a socket server) where launch.json says, then exits as `open` does. */
function world(
  over: {
    exitCode?: number;
    neverListen?: boolean;
    helloError?: boolean;
    platform?: NodeJS.Platform;
    exists?: boolean;
    spawnError?: boolean;
  } = {},
) {
  // a unix socket path holds about a hundred bytes: the test's own temp folder is already long
  const tmp = fs.mkdtempSync('/tmp/hc-');
  cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const launches: { args: string[]; config: any }[] = [];
  const requests: any[] = [];
  const servers: net.Server[] = [];
  const clients = new Set<net.Socket>();
  const hooks: { hello: () => void } = { hello: () => undefined };
  const handler: { fn: (msg: any, reply: (m: object) => void, sock: net.Socket) => void } = {
    fn: (msg, reply) => reply({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }),
  };
  const serve = (config: any) => {
    const server = net.createServer((sock) => {
      clients.add(sock);
      let buffer = '';
      sock.on('data', (d) => {
        buffer += d;
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
          const msg = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          requests.push(msg);
          const reply = (m: object) => sock.write(`${JSON.stringify(m)}\n`);
          if (msg.method === 'hello') {
            hooks.hello();
            if (over.helloError || msg.params.token !== config.token)
              reply({ jsonrpc: '2.0', id: msg.id, error: { code: 7, message: 'unauthorized', data: { reason: 'unauthorized' } } });
            else reply({ jsonrpc: '2.0', id: msg.id, result: { version: 'test' } });
          } else handler.fn(msg, reply, sock);
        }
      });
      sock.on('close', () => clients.delete(sock));
    });
    servers.push(server);
    server.listen(config.socket);
  };
  const spawn = ((cmd: string, args: string[]) => {
    assert.equal(cmd, '/usr/bin/open');
    const config = JSON.parse(fs.readFileSync(args.at(-1)!, 'utf8'));
    launches.push({ args, config });
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (over.spawnError) return child.emit('error', new Error('spawn open ENOENT'));
      if (over.exitCode) {
        child.stderr.emit('data', 'no such app');
        return child.emit('exit', over.exitCode);
      }
      if (!over.neverListen) serve(config);
      child.emit('exit', 0);
    });
    return child;
  }) as any;
  const client = createHelperClient({
    appPath: '/Apps/MoPilot Code.app',
    mainPid: 4321,
    platform: over.platform ?? 'darwin',
    exists: () => over.exists ?? true,
    spawn,
    connectTimeoutMs: 300,
    callTimeoutMs: 400,
    tmp,
  });
  cleanup.push(() => {
    client.stop();
    for (const c of clients) c.destroy();
    for (const s of servers) s.close();
  });
  return { client, launches, requests, handler, tmp, clients, hooks };
}

test('installed: macOS with the app in place; nothing else, and nothing is started to know it', () => {
  assert.equal(world().client.installed, true);
  assert.equal(world({ platform: 'linux' }).client.installed, false);
  assert.equal(world({ exists: false }).client.installed, false);
});

test('a call launches the helper through LaunchServices with a private config, says hello with its token, then asks', async () => {
  const w = world();
  assert.deepEqual(await w.client.call('permissions.status'), { echoed: 'permissions.status' });
  assert.equal(w.launches.length, 1);
  assert.deepEqual(w.launches[0].args.slice(0, 5), ['-n', '-g', '-a', '/Apps/MoPilot Code.app', '--args']);
  assert.equal(w.launches[0].config.mainPid, 4321);
  assert.deepEqual(w.launches[0].config.denyBundleIds, []);
  assert.equal(fs.statSync(path.dirname(w.launches[0].config.socket)).mode & 0o777, 0o700);
  assert.deepEqual(
    w.requests.map((r) => r.method),
    ['hello', 'permissions.status'],
  );
  // a second call uses the running helper
  await w.client.call('screenshot', { maxSide: 100 });
  assert.equal(w.launches.length, 1);
  assert.deepEqual(w.requests.at(-1).params, { maxSide: 100 });
});

test('callers that come together share one launch', async () => {
  const w = world();
  const all = await Promise.all([w.client.call('a'), w.client.call('b'), w.client.call('c')]);
  assert.deepEqual(
    all.map((r: any) => r.echoed),
    ['a', 'b', 'c'],
  );
  assert.equal(w.launches.length, 1);
});

test('the helper’s own errors keep their reason and code', async () => {
  const w = world();
  w.handler.fn = (msg, reply) =>
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: 1, message: 'screenRecording permission not granted', data: { reason: 'permission_denied' } },
    });
  await assert.rejects(
    w.client.call('screenshot'),
    (e: any) => e instanceof HelperError && e.reason === 'permission_denied' && e.code === 1 && /permission/.test(e.message),
  );
  w.handler.fn = (msg, reply) => reply({ jsonrpc: '2.0', id: msg.id, error: {} });
  await assert.rejects(w.client.call('x'), (e: any) => e.reason === null && e.code === null && /helper error/.test(e.message));
});

test('a line that is not an answer is ignored, and an answer nobody waits for is dropped', async () => {
  const w = world();
  w.handler.fn = (msg, reply, sock) => {
    sock.write('not json\nnull\n7\n\n');
    reply({ jsonrpc: '2.0', id: 9999, result: 'stray' });
    reply({ jsonrpc: '2.0', id: msg.id, result: 'real' });
  };
  assert.equal(await w.client.call('x'), 'real');
});

test('a connection whose lines cannot be framed is dropped as a helper that went, and the next call launches it again', async () => {
  const w = world();
  await w.client.call('warm');
  const failing = mock.method(JsonReader.prototype, 'frame', () => {
    throw new Error('the core could not frame it');
  });
  try {
    await assert.rejects(w.client.call('broken'), (e: any) => e.reason === 'helper_exited');
  } finally {
    failing.mock.restore();
  }
  assert.deepEqual(await w.client.call('again'), { echoed: 'again' });
  assert.equal(w.launches.length, 2);
});

test('a request that does not get an answer fails with a timeout, and a late answer does nothing', async () => {
  const w = world();
  const hold = deferred<void>();
  w.handler.fn = (msg, reply) => void hold.promise.then(() => reply({ jsonrpc: '2.0', id: msg.id, result: 'late' }));
  await assert.rejects(w.client.call('slow', {}, { timeoutMs: 30 }), (e: any) => e.reason === 'helper_timeout');
  hold.resolve();
  await tick();
  assert.equal((await w.client.call('fast')) as any, 'late' as any, 'the next call is answered by its own reply, not the late one');
});

test('the helper exiting fails what waits, replays nothing, and the next call launches it again', async () => {
  const w = world();
  await w.client.call('warm');
  w.handler.fn = (_msg, _reply, sock) => sock.destroy();
  await assert.rejects(w.client.call('input.click'), (e: any) => e.reason === 'helper_exited');
  const clicks = w.requests.filter((r) => r.method === 'input.click').length;
  assert.equal(clicks, 1, 'the click was not sent again');
  w.handler.fn = (msg, reply) => reply({ jsonrpc: '2.0', id: msg.id, result: 'back' });
  assert.equal(await w.client.call('input.click'), 'back');
  assert.equal(w.launches.length, 2);
  assert.ok(!fs.existsSync(path.dirname(w.launches[0].config.socket)), 'the first launch’s private folder is gone');
});

test('requests that only undo launch nothing when the helper is not running', async () => {
  const w = world();
  for (const m of ['control.release', 'input.release', 'app.cancel'])
    await assert.rejects(w.client.call(m), (e: any) => e.reason === 'helper_not_running');
  assert.equal(w.launches.length, 0);
  await w.client.call('warm');
  assert.deepEqual(await w.client.call('input.release'), { echoed: 'input.release' });
});

test('a helper that cannot be started says why: not macOS, not installed, open failed, no open, never listens, refuses hello', async () => {
  await assert.rejects(
    world({ platform: 'linux' }).client.call('x'),
    (e: any) => e.reason === 'helper_unavailable' && /needs macOS/.test(e.message),
  );
  await assert.rejects(
    world({ exists: false }).client.call('x'),
    (e: any) => e.reason === 'helper_unavailable' && /not at \/Apps/.test(e.message),
  );
  await assert.rejects(
    world({ exitCode: 1 }).client.call('x'),
    (e: any) => e.reason === 'helper_unavailable' && /open failed \(1\): no such app/.test(e.message),
  );
  await assert.rejects(
    world({ spawnError: true }).client.call('x'),
    (e: any) => e.reason === 'helper_unavailable' && /ENOENT/.test(e.message),
  );
  await assert.rejects(
    world({ neverListen: true }).client.call('x'),
    (e: any) => e.reason === 'helper_unavailable' && /did not start/.test(e.message),
  );
  const refused = world({ helloError: true });
  await assert.rejects(refused.client.call('x'), (e: any) => e.reason === 'unauthorized');
  assert.deepEqual(fs.readdirSync(refused.tmp), [], 'a failed start leaves no private folder');
});

test('stop closes the connection and removes the private folder; a stopped client starts again on the next call', async () => {
  const w = world();
  await w.client.call('warm');
  const dir = path.dirname(w.launches[0].config.socket);
  assert.ok(fs.existsSync(dir));
  w.client.stop();
  assert.ok(!fs.existsSync(dir));
  w.client.stop();
  assert.equal(await w.client.call('again').then((r: any) => r.echoed), 'again');
  assert.equal(w.launches.length, 2);
});

test('installed reads the real file system by default: the app folder is there or it is not', () => {
  const dir = fs.mkdtempSync('/tmp/hc-');
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(createHelperClient({ appPath: path.join(dir, 'Missing.app'), platform: 'darwin' }).installed, false);
  assert.equal(createHelperClient({ appPath: dir, platform: 'darwin' }).installed, true);
});

test('running: false before the first call, false while the helper is still saying hello, true after, false once it is gone', async () => {
  const w = world();
  assert.equal(w.client.running, false);
  let during: boolean | null = null;
  w.hooks.hello = () => void (during = w.client.running);
  await w.client.call('warm');
  assert.equal(during, false, 'a helper that has not answered hello is not up yet');
  assert.equal(w.client.running, true);
  w.client.stop();
  assert.equal(w.client.running, false);
});

test('the real client, probe and desktop host: a helper the readings started again mid-lease is not the one holding control, so the click is not made blind', async () => {
  const w = world();
  w.handler.fn = (msg, reply) =>
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      result: msg.method === 'permissions.status' ? { accessibility: true, screenRecording: true } : { ok: msg.method },
    });
  const probe = createDesktopProbe({ installed: true, call: (m: string, p: object, o: object) => w.client.call(m, p, o) });
  const host = createDesktopHost({ helper: w.client, probe, epochOf: () => 1, maxReply: 100_000 });
  await probe.refresh();
  const owner = {};
  await host.lease(owner, 'chat-a', 1, '*');
  await host.call(owner, 'chat-a', 1, 'call-0001', 'input.click', { x: 1 });
  // the helper dies; the probe's next reading starts another one
  for (const c of w.clients) c.destroy();
  while (w.client.running) await tick();
  await probe.refresh();
  assert.equal(w.client.running, true, 'it is up again, started by the reading');
  const sent = w.requests.length;
  await assert.rejects(host.call(owner, 'chat-a', 1, 'call-0002', 'input.click', { x: 2 }), (e: any) => e.code === 'helper_restarted');
  assert.deepEqual(
    w.requests.slice(sent).map((r) => r.method),
    ['control.acquire'],
    'control was taken on the new helper and the click was not sent',
  );
  await host.call(owner, 'chat-a', 1, 'call-0003', 'input.click', { x: 2 });
  assert.equal(w.requests.at(-1).method, 'input.click');
  await host.dispose();
});
