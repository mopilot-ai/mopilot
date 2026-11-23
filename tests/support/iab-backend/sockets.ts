// In-app browser backend sockets unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  require,
  IabBackends,
  mainIabBackends,
  FrameDecoder,
  encodeFrame,
  verifyDescendant,
  SOCKET_DIR,
  S,
  tick,
  fakeTab,
  fakeHost,
  fakeGrants,
} from './fixture';

export function registerSocketsCases() {
  function backends(t: any, o: any = {}) {
    const dir = path.join(fs.mkdtempSync(path.join('/tmp', 'iabt-')), 'drop');
    t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
    const host = fakeHost();
    let ok: string | null = null;
    const env = { backends: ['chrome', 'iab'], flavor: 'prod', version: '9' };
    const m = new IabBackends({
      tabs: () => host,
      grants: () => fakeGrants(),
      chatOf: (id: string) => `chat:${id}`,
      harnessPid: () => 42,
      enabled: () => true,
      pluginEnv: () => env,
      dir,
      verify: async ({ root }: any) => (root === 42 ? ok : 'no'),
      ...o,
    });
    t.after(() => m.exited());
    return { m, dir, host, env, deny: (why: string | null) => (ok = why) };
  }

  function connect(file: string) {
    return new Promise<any>((resolve, reject) => {
      const s = net.createConnection(file, () => resolve(s));
      s.on('error', reject);
    });
  }

  function rpc(s: any, method: string, params: any) {
    const d = new FrameDecoder();
    return new Promise<any>((resolve) => {
      s.on('data', (c: Buffer) => {
        for (const m of d.push(c)) if (m.id === 1) resolve(m);
      });
      s.write(encodeFrame({ jsonrpc: '2.0', id: 1, method, params }));
    });
  }

  test('a native thread gets a 0600 socket in a sticky drop dir; a verified peer is served; unload removes it', async (t) => {
    const { m, dir } = backends(t);
    assert.equal(m.available(), true);
    const file = await m.loaded(S);
    assert.equal(path.dirname(file), dir);
    assert.equal(fs.statSync(dir).mode & 0o7777, 0o1777);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(m.has(S), true);
    assert.equal(await m.loaded(S), null);
    const s = await connect(file);
    const r = await rpc(s, 'getInfo', { session_id: S });
    assert.equal(r.result.metadata.codexSessionId, S);
    assert.equal(r.result.version, '9');
    await tick();
    assert.equal(m.servers.get(S).backend.peers.size, 1);
    // the backend's held tabs let go when it goes
    const b = m.servers.get(S).backend;
    const tab = fakeTab('tab_x');
    b.held.set(tab, { listener: () => {}, detach: () => {}, children: new Map(), screencast: false });
    const closed = new Promise((r2) => s.on('close', r2));
    m.unloaded(S);
    await closed;
    assert.equal(fs.existsSync(file), false);
    assert.equal(m.has(S), false);
    assert.equal(b.held.size, 0);
    m.unloaded(S);
  });

  test("a subagent thread's backend answers to its own session id and works in its parent's chat", async (t) => {
    const { m } = backends(t);
    const file = await m.loaded('sub-1', { parent: S });
    assert.ok(file);
    const b = m.servers.get('sub-1').backend;
    assert.equal(b.threadId, 'sub-1');
    assert.equal(b.parent, S);
    assert.deepEqual(b.ctx, { chatId: b.chatOf(S), segmentId: S });
    await assert.rejects(b.handle('getTabs', { session_id: S }), /No built-in browser route/);
    assert.equal(m.servers.get(S), undefined);
    m.unloaded('sub-1');
  });

  test('an unverified peer is dropped before anything is answered', async (t) => {
    const { m, deny } = backends(t);
    deny('the peer is not under the harness');
    const file = await m.loaded(S);
    const s = await connect(file);
    const got: any[] = [];
    s.on('data', (c: Buffer) => got.push(c));
    s.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    await new Promise((r) => s.on('close', r));
    assert.deepEqual(got, []);
  });

  test('no backend when off, without a host, when the plugin lacks iab, or for no thread id; exited closes them all', async (t) => {
    const on = { v: true };
    const { m, env } = backends(t, { enabled: () => on.v });
    on.v = false;
    assert.equal(m.available(), false);
    assert.equal(await m.loaded(S), null);
    on.v = true;
    env.backends = ['chrome'];
    assert.equal(await m.loaded(S), null);
    env.backends = ['iab'];
    assert.equal(await m.loaded(''), null);
    assert.equal(await m.loaded(undefined as any), null);
    const throwing = backends(t, {
      pluginEnv: () => {
        throw new Error('x');
      },
    });
    assert.equal(throwing.m.available(), false);
    const hostless = backends(t, { tabs: () => null });
    assert.equal(hostless.m.available(), false);
    const a = await m.loaded('a');
    const b = await m.loaded('b');
    m.exited();
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(m.servers.size, 0);
  });

  test('an existing drop dir is left as it is; a socket that cannot listen leaves no backend; an unload while starting wins', async (t) => {
    const { m, dir } = backends(t);
    fs.mkdirSync(dir, { mode: 0o755 });
    const file = await m.loaded(S);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    assert.ok(file);
    // listen fails
    const failing = backends(t, {
      net: {
        createServer: () => {
          const srv: any = new EventEmitter();
          srv.listen = () => setImmediate(() => srv.emit('error', new Error('EADDRINUSE')));
          srv.close = () => {
            throw new Error('not running');
          };
          return srv;
        },
      },
    });
    assert.equal(await failing.m.loaded(S), null);
    assert.equal(failing.m.has(S), false);
    // unloaded before listen finished
    const racing = backends(t);
    const p = racing.m.loaded('r');
    racing.m.unloaded('r');
    assert.equal(await p, null);
    assert.equal(racing.m.has('r'), false);
    // a failing cleanup is survived
    const rmFail = backends(t, {
      fs: {
        ...fs,
        rmSync: () => {
          throw new Error('x');
        },
      },
    });
    await rmFail.m.loaded('x');
    rmFail.m.exited();
    assert.equal(rmFail.m.has('x'), false);
  });

  test('the default drop dir is the one the plugin lists', () => {
    assert.equal(SOCKET_DIR, '/tmp/codex-browser-use');
    const m = new IabBackends({
      tabs: () => null,
      grants: () => null,
      chatOf: (x: string) => x,
      harnessPid: () => 1,
      enabled: () => true,
      pluginEnv: () => ({ backends: [] }),
    });
    assert.equal(m.dir, SOCKET_DIR);
    assert.equal(m.verify, verifyDescendant);
  });

  test("main's backends read its live services, the switches and the plugin env of Codex's CODEX_HOME", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iab-main-'));
    try {
      const dir = path.join(home, 'codex', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { cua_repl: { env: { BROWSER_USE_AVAILABLE_BACKENDS: 'iab' } } } }),
      );
      const live: any = { browserTabs: { t: 1 }, browserGrants: { g: 1 }, controller: { chatOf: (id: string) => `chat:${id}` } };
      const server: any = { proc: { pid: 7 } };
      const flags = new Set(['native.codex.inAppBrowser']);
      const env: any = { CODEX_HOME: path.join(home, 'codex') };
      const asked: any[] = [];
      const m = mainIabBackends({
        live,
        server,
        isFlagEnabled: (k: string) => flags.has(k),
        shellEnv: { childEnv: () => env },
        browserEnabled: (f: any) => (asked.push(f), f('browser') ? true : 'off'),
        home,
      });
      assert.equal(m.o.tabs(), live.browserTabs);
      assert.equal(m.o.grants(), live.browserGrants);
      assert.equal(m.o.chatOf('t'), 'chat:t');
      assert.equal(m.o.harnessPid(), 7);
      assert.equal(m.o.enabled(), false);
      flags.add('browser');
      assert.equal(m.o.enabled(), true);
      assert.equal(asked.length, 2);
      flags.delete('native.codex.inAppBrowser');
      assert.equal(m.o.enabled(), false);
      assert.deepEqual(m.o.pluginEnv().backends, ['iab']);
      assert.equal(m.o.turns(), null, 'no registry turn ledger yet');
      // a Stop on a chat reaches the plugin's commands through the Registry's abort listeners
      const heard: any[] = [];
      live.capabilities = { onAbort: (fn: any) => (heard.push(fn), () => {}) };
      const { TurnTokens } = require('../../../electron/capabilities/contract/turnTokens.cjs');
      const turns = new TurnTokens();
      live.capabilities.turns = turns;
      assert.equal(m.o.turns(), turns);
      const listen = (_chatId: string) => {};
      assert.equal(typeof m.o.onStop(listen), 'function');
      assert.deepEqual(heard, [listen]);
      live.capabilities = undefined;
      assert.equal(m.o.onStop(listen), null, 'no registry yet');
      // CODEX_HOME unset: ~/.codex
      delete env.CODEX_HOME;
      assert.deepEqual(m.o.pluginEnv().backends, []);
      // without a host, a controller or a running app-server
      live.browserTabs = undefined;
      live.controller = null;
      server.proc = null;
      assert.equal(m.o.tabs(), null);
      assert.equal(m.o.chatOf('t'), 't');
      assert.equal(m.o.harnessPid(), undefined);
      assert.equal(
        mainIabBackends({
          live,
          server,
          isFlagEnabled: () => false,
          shellEnv: { childEnv: () => ({}) },
          browserEnabled: () => true,
        }).o.enabled(),
        false,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
