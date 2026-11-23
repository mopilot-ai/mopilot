// Built-in browser backend policy-peer-check unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameDecoder, encodeFrame, cdpPolicy, urlAllowed, pluginBrowserEnv, verifyDescendant } from './fixture';
import { fakeCore, ancestryOf } from '../fake-core.ts';

export function registerPolicyPeerCheckCases() {
  test('frames: a u32 native-endian length, then JSON; split and joined chunks decode; oversize frames throw', () => {
    const frame = encodeFrame({ a: 1 });
    const len = os.endianness() === 'LE' ? frame.readUInt32LE(0) : frame.readUInt32BE(0);
    assert.equal(len, frame.length - 4);
    const d = new FrameDecoder();
    const two = Buffer.concat([frame, encodeFrame({ b: 2 })]);
    assert.deepEqual(d.push(two.subarray(0, 3)), []);
    assert.deepEqual(d.push(two.subarray(3, 9)), []);
    assert.deepEqual(d.push(two.subarray(9)), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => new FrameDecoder(2).push(frame), /frame too large/);
    assert.throws(() => encodeFrame({ a: 'xxxx' }, 4), /too large/);
  });

  test('URL policy: http(s) and about:blank only', () => {
    assert.equal(urlAllowed('about:blank'), true);
    assert.equal(urlAllowed('https://a.test/'), true);
    assert.equal(urlAllowed('http://a.test/'), true);
    assert.equal(urlAllowed('file:///etc/hosts'), false);
    assert.equal(urlAllowed('not a url'), false);
  });

  test('CDP filter: Target.* blocked but setAutoAttach and three emulated reads; Input limited to three; Browser.* blocked', () => {
    assert.equal(cdpPolicy('Page.navigate'), 'send');
    assert.equal(cdpPolicy('Target.setAutoAttach'), 'send');
    for (const m of ['Target.getTargetInfo', 'Target.getTargets', 'Target.closeTarget']) assert.equal(cdpPolicy(m), 'emulated');
    for (const m of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']) assert.equal(cdpPolicy(m), 'send');
    for (const m of ['Target.createTarget', 'Input.dispatchTouchEvent', 'Browser.close'])
      assert.throws(() => cdpPolicy(m), /not supported in MoPilot's built-in browser/);
    assert.throws(() => cdpPolicy(''), /A CDP method is required/);
    assert.throws(() => cdpPolicy(undefined), /A CDP method is required/);
  });

  test("plugin env: the newest cached version's cua_repl env, skipping unreadable ones; nothing without the plugin", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iab-home-'));
    try {
      assert.deepEqual(pluginBrowserEnv({ codexHome: home }), { backends: [], flavor: null, version: null });
      const dir = path.join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
      const write = (v: string, body: string) => {
        fs.mkdirSync(path.join(dir, v), { recursive: true });
        fs.writeFileSync(path.join(dir, v, '.mcp.json'), body);
      };
      write('1.0', JSON.stringify({ mcpServers: { cua_repl: { env: { BROWSER_USE_AVAILABLE_BACKENDS: 'chrome' } } } }));
      write('2.0', JSON.stringify({ mcpServers: { cua_repl: {} } }));
      write('3.0', '{ not json');
      assert.deepEqual(pluginBrowserEnv({ codexHome: home }), { backends: ['chrome'], flavor: null, version: null });
      write(
        '4.0',
        JSON.stringify({
          mcpServers: {
            cua_repl: {
              env: {
                BROWSER_USE_AVAILABLE_BACKENDS: 'chrome, iab,,mcpapps',
                BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
                BROWSER_USE_CODEX_APP_VERSION: '26.1',
              },
            },
          },
        }),
      );
      assert.deepEqual(pluginBrowserEnv({ codexHome: home }), { backends: ['chrome', 'iab', 'mcpapps'], flavor: 'prod', version: '26.1' });
      write('5.0', JSON.stringify({ mcpServers: { cua_repl: { env: 'x' } } }));
      assert.equal(pluginBrowserEnv({ codexHome: home }).flavor, 'prod');
      write('6.0', JSON.stringify({ mcpServers: { cua_repl: { env: {} } } }));
      assert.deepEqual(pluginBrowserEnv({ codexHome: home }), { backends: [], flavor: null, version: null });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  /* ------------------------------------------------------------------ peer check */

  test('peer check: the process the kernel names must descend from the app-server', async () => {
    const socket = { _handle: { fd: 7 } };
    const table: Record<number, number> = { 100: 1, 200: 100, 300: 200, 400: 1 };
    const core = (peer: unknown) => fakeCore({ 'caps.peerPid': peer, 'caps.ancestry': ancestryOf(table) });
    const ok = core(300);
    assert.equal(await verifyDescendant({ socket, root: 100, addon: ok.addon }), null);
    assert.deepEqual(ok.asked, ['caps.peerPid 7', 'caps.ancestry 300']);
    assert.equal(await verifyDescendant({ socket, root: 100, addon: core(400).addon }), 'the peer is not under the harness');
    // the root itself is not under the root
    assert.equal(await verifyDescendant({ socket, root: 100, addon: core(100).addon }), 'the peer is not under the harness');
    assert.equal(await verifyDescendant({ socket, root: 400, addon: core(300).addon }), 'the peer is not under the harness');
    assert.equal(await verifyDescendant({ socket, root: null, addon: ok.addon }), 'no harness process');
    assert.equal(await verifyDescendant({ socket: {}, root: 100, addon: ok.addon }), 'no socket');
    assert.equal(await verifyDescendant({ socket: { _handle: { fd: -1 } }, root: 100, addon: ok.addon }), 'no socket');
  });

  test('peer check: a descendant any depth down is under the harness, as a walk of the whole tree found it', async () => {
    const socket = { _handle: { fd: 7 } };
    const deep: Record<number, number> = {};
    for (let pid = 1000; pid > 100; pid--) deep[pid] = pid - 1;
    const c = fakeCore({ 'caps.peerPid': 1000, 'caps.ancestry': ancestryOf(deep) });
    assert.equal(await verifyDescendant({ socket, root: 100, addon: c.addon }), null);
  });

  test('peer check: a core that fails or answers nonsense refuses, whichever route it is', async () => {
    const socket = { _handle: { fd: 7 } };
    const check = (peer: unknown, chain: unknown) =>
      verifyDescendant({ socket, root: 100, addon: fakeCore({ 'caps.peerPid': peer, 'caps.ancestry': chain }).addon });
    for (const peer of [new Error('closed'), null, '300', 0, 1]) assert.equal(await check(peer, [300, 100]), 'socket not found');
    for (const chain of [new Error('no table'), null, { 1: 100 }, [300]])
      assert.equal(await check(300, chain), 'the peer is not under the harness');
    assert.equal(await verifyDescendant({ socket, root: 100, addon: null }), 'socket not found');
    // the defaults: the real core, and a descriptor that is no socket
    assert.equal(await verifyDescendant({ socket: { _handle: { fd: 1 << 20 } }, root: 2 ** 30 }), 'socket not found');
  });
}
