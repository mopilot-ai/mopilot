// Private socket endpoints are published only after secure startup and retired on failure or close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserShim } = require('../electron/capabilities/browser/browserShim.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');

for (const browser of [true, false]) {
  test(`${browser ? 'browser shim' : 'tool socket'}: close settles startup and a stale callback cannot publish the endpoint`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-start-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const servers: any[] = [];
    t.mock.method(browser ? http : net, 'createServer', () => {
      const server: any = new EventEmitter();
      server.listen = (_file: string, ready: () => void) => {
        server.ready = ready;
      };
      server.close = () => {
        server.closed = true;
      };
      server.unref = () => {};
      server.closeAllConnections = () => {};
      servers.push(server);
      return server;
    });
    const sessions = new EventEmitter();
    const owner = browser ? new BrowserShim({ dir, open: async () => true }) : new ToolSocket({ sessions, registry: {} });
    t.after(() => owner.close());
    const first = owner.listen();
    const rejected = assert.rejects(first, /closed|stopped/);
    if (browser) assert.deepEqual(owner.env('chat'), {}, 'pending startup has no advertised endpoint');
    else assert.equal(owner.path, null);
    owner.close();
    const second = owner.listen();
    const secondRejected = assert.rejects(second);
    await rejected;
    assert.doesNotThrow(() => servers[0].ready());
    assert.doesNotThrow(() => servers[0].emit('error', new Error('late bind error')));
    assert.equal(owner.server, servers[1]);
    owner.close();
    await secondRejected;
    if (browser) assert.deepEqual(owner.env('chat'), {});
    else assert.equal(owner.path, null);
  });
}

test('BrowserShim stops advertising the socket after a successful listener closes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = new BrowserShim({ dir, open: async () => true });
  t.after(() => shim.close());
  await shim.listen();
  assert.ok(shim.env('chat').MOPILOT_BROWSER_SOCK);
  shim.close();
  assert.deepEqual(shim.env('chat'), {});
});

test('a failed shim-script write is a rejected startup and can be retried after repair', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'scripts');
  fs.writeFileSync(dir, 'occupied');
  const shim = new BrowserShim({ dir, open: async () => true });
  t.after(() => shim.close());
  await assert.rejects(shim.listen());
  assert.deepEqual(shim.env('chat'), {});
  fs.rmSync(dir);
  await shim.listen();
  assert.ok(shim.env('chat').MOPILOT_BROWSER_SOCK);
});

for (const browser of [true, false]) {
  test(`${browser ? 'browser shim' : 'tool socket'}: close after binding but before publication retires the endpoint`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-publish-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const server: any = new EventEmitter();
    server.listen = (file: string, ready: () => void) => {
      fs.writeFileSync(file, '');
      server.ready = ready;
    };
    server.close = () => {};
    server.closeAllConnections = () => {};
    server.unref = () => {};
    t.mock.method(browser ? http : net, 'createServer', () => server);
    const owner = browser
      ? new BrowserShim({ dir, open: async () => true })
      : new ToolSocket({ sessions: new EventEmitter(), registry: {} });
    t.after(() => owner.close());
    const listening = owner.listen();
    const rejected = assert.rejects(listening, /closed/);
    server.ready();
    owner.close();
    await rejected;
    assert.equal(browser ? owner.sock : owner.path, null);
  });
}

for (const browser of [true, false]) {
  for (const denied of ['folder', 'socket', 'factory', 'bind']) {
    test(`${browser ? 'browser shim' : 'tool socket'}: ${denied} failure rejects startup, cleans up and allows retry`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-failure-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      let failing = true;
      const originalChmod = fs.chmodSync;
      t.mock.method(fs, 'chmodSync', (file: string, mode: number) => {
        const socket = file.endsWith('/s.sock');
        if (failing && ((denied === 'socket' && socket) || (denied === 'folder' && /\/(mpbr|mpmcp)-[^/]+$/.test(file))))
          throw new Error('permission denied');
        return originalChmod(file, mode);
      });
      const module = browser ? http : net;
      const originalServer = module.createServer;
      let created: any;
      t.mock.method(module, 'createServer', (...args: any[]) => {
        if (failing && denied === 'factory') throw new Error('factory denied');
        created = Reflect.apply(originalServer, module, args);
        if (failing && denied === 'bind')
          created.listen = () => {
            created.emit('error', new Error('bind denied'));
          };
        return created;
      });
      const sessions = new EventEmitter();
      const owner = browser ? new BrowserShim({ dir, open: async () => true }) : new ToolSocket({ sessions, registry: {} });
      t.after(() => owner.close());
      const first = owner.listen();
      const folder = browser ? owner.sockDir : owner.dir;
      await assert.rejects(first, /denied/);
      assert.equal(owner.server, null);
      assert.equal(owner.listening, null);
      assert.equal(browser ? owner.sock : owner.path, null);
      assert.equal(fs.existsSync(folder), false);
      if (created) assert.equal(created.listening, false);
      failing = false;
      const socket = await owner.listen();
      assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
      assert.equal(browser ? owner.sock : owner.path, socket);
      if (!browser) assert.equal(sessions.listenerCount('revoked'), 1);
      owner.close();
      if (!browser) {
        assert.equal(sessions.listenerCount('revoked'), 0);
        await owner.listen();
        assert.equal(sessions.listenerCount('revoked'), 1, 'reopened tools still observe session revocation');
      }
    });
  }
}
