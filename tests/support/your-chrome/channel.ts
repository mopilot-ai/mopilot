// Per-chat Chrome channel lifecycle, connection and stale-process recovery cases.
import { test, assert, require, ChromeChannel, spawnSpec, pageUrl, HOST, tick, fakeFork } from './fixture.ts';

export function registerChannelLifecycle() {
  test('ChromeChannel: one instance per chat, reused, stopped when idle, restarted after a crash', async (t) => {
    // the idle timer runs on a mocked clock: a real short timeout can fire between two calls on a busy machine
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // the fake CLI answers on setImmediate, which the mocked clock leaves alone
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    const { fork, children } = fakeFork();
    const spec = spawnSpec({ outputDir: '/o', env: {} });
    const ch = new ChromeChannel({ fork, spec: () => spec, idleMs: 60 });
    const a1 = await ch.instance('chat-a');
    t.mock.timers.tick(59);
    const a2 = await ch.instance('chat-a');
    assert.equal(a1, a2);
    t.mock.timers.tick(59);
    assert.equal(children[0].stopped, false, 'each call waits the idle time again');
    await ch.instance('chat-b');
    assert.equal(children.length, 2, 'a tab group (instance) per chat');
    const c = children[0];
    assert.equal(c.modulePath, HOST);
    assert.deepEqual(c.started, spec.args, 'the CLI args go over the parent port');
    assert.deepEqual(c.options, spec.options);
    assert.equal(c.got[0].params.clientInfo.name, 'MoPilot');
    assert.equal(c.got[1].method, 'notifications/initialized');

    // a crash drops the instance; the next call starts another
    children[1].emit('exit', 1);
    await settle();
    await ch.instance('chat-b');
    assert.equal(children.length, 3);

    // idle: asked to stop (it closes its tab group)
    t.mock.timers.tick(60);
    await settle();
    assert.ok(children[0].stopped && children[2].stopped);
    assert.equal(ch.chats.size, 0);
    await ch.instance('chat-a');
    assert.equal(children.length, 4);
    ch.stopAll();
    await settle();
    assert.ok(children[3].stopped);
  });

  test('ChromeChannel: a failed start is not kept; tools() lists once through a short-lived instance', async () => {
    const bad = fakeFork({ failStart: true });
    const ch = new ChromeChannel({ fork: bad.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
    await assert.rejects(ch.instance('c'), /stopped/);
    await tick();
    assert.equal(ch.chats.size, 0);

    const ok = fakeFork();
    const ch2 = new ChromeChannel({ fork: ok.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
    const tools = await ch2.tools();
    assert.deepEqual(
      tools.map((t: any) => t.name),
      ['browser_navigate'],
      'only the allowed tools',
    );
    await ch2.tools();
    assert.equal(ok.children.length, 1);
    await tick();
    assert.ok(ok.children[0].stopped);
  });

  test('ChromeChannel.test reports what the extension said', async () => {
    const { fork, children } = fakeFork({
      onCall: () => ({
        content: [null, { type: 'text', text: '### Error\nError: Playwright Extension not found in "/x".' }],
        isError: true,
      }),
    });
    const ch = new ChromeChannel({ fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
    assert.deepEqual(await ch.test(), { ok: false, message: 'Playwright Extension not found in "/x".' });
    assert.equal(children[0].got[0].params.clientInfo.name, 'MoPilot connection test');
    await tick();
    assert.ok(children[0].stopped);
  });
}

export function registerChannelRecovery() {
  test('Chrome connection reports version warnings, missing versions and failed startup', async () => {
    for (const scenario of ['version', 'version-throws', 'no-message', 'failure', 'startup']) {
      const fake = fakeFork({
        failStart: scenario === 'startup',
        onCall: () => ({
          content: scenario === 'no-message' ? [{ type: 'image' }, { type: 'text', text: 'ok' }] : [],
          ...(scenario === 'failure' ? { isError: true } : {}),
        }),
      });
      const ch = new ChromeChannel({
        fork: fake.fork,
        spec: () => spawnSpec({ outputDir: '/o', env: {} }),
        pinnedExtension: '1.0.0',
        extensionVersion: () => {
          if (scenario === 'version-throws') throw new Error('missing');
          return scenario === 'no-message' ? '1.0.0' : '0.9.0';
        },
      });
      const result = await ch.test();
      assert.equal(result.ok, !['failure', 'startup'].includes(scenario));
      assert.ok(result.extension);
    }
  });

  test('Chrome channel ignores stale process exits after stopping/replacing a chat instance', async () => {
    const f = fakeFork();
    const channel = new ChromeChannel({ fork: f.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }), clientName: 'Custom' });
    channel.stop('missing');
    await channel.instance('chat');
    const old = f.children[0];
    channel.stop('chat');
    const next = await channel.instance('chat');
    old.emit('exit', 0);
    assert.equal(await channel.instance('chat'), next);
    channel.stopAll();
    const fail = fakeFork({ failStart: true });
    const bad = new ChromeChannel({ fork: fail.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
    const start = bad.instance('chat');
    bad.stop('chat');
    await assert.rejects(start, /stopped/);
  });
}

export function registerConnectionFallbacks() {
  test('Chrome page parsing and connection setup tolerate absent content and non-Error failures', async () => {
    assert.equal(pageUrl([null, { type: 'text' }]), null);
    for (const error of [null, 'setup failed']) {
      const ch = new ChromeChannel({
        fork: () => {},
        spec: () => {
          throw error;
        },
      });
      assert.deepEqual(await ch.test(), { ok: false, message: String(error) });
    }
  });

  test('Chrome connection handles an empty reply and stops an instance after a call exception', async (t) => {
    const empty = fakeFork({ onCall: () => ({}) });
    const ch = new ChromeChannel({ fork: empty.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
    assert.deepEqual(await ch.test(), { ok: true, message: 'Connected to Chrome.' });
    const { PlaywrightInstance } = require('../../../electron/capabilities/browser/extension.cjs');
    t.mock.method(PlaywrightInstance.prototype, 'call', async () => {
      throw new Error('relay disconnected');
    });
    const failed = fakeFork();
    const broken = new ChromeChannel({ fork: failed.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
    assert.deepEqual(await broken.test(), { ok: false, message: 'relay disconnected' });
    assert.equal(failed.children[0].stopped, true);
  });
}
