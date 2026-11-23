// Antigravity's official ACP server: detection, launch, admission, sign-in and chat-owned tool channels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, fakeSpawn, INIT, dir } from './support/acp-host/fixture.ts';

const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const { resolveBasic } = require('../electron/harness/detect.cjs');
const { probe } = require('../electron/harness/admission.cjs');
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const { harnessInfo } = await import('../src/harness/registry.ts');
const { installLines } = await import('../shared/harnessInstall.mjs');

const ID = 'antigravity';
const BIN = '/tools/agy_acp_server.par';
const q = () => Q.quirks(ID);
// The capabilities and auth method names returned by Google's ACP server 1.4.3, without signing in.
const initialize = () =>
  INIT(
    {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, resume: {} },
    },
    {
      agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.3' },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    },
  );

test('Antigravity is a basic harness with its own ACP binary, install guidance and kill switch', () => {
  const info = harnessInfo('acp:antigravity')!;
  assert.ok(Q.ids().includes(ID));
  assert.deepEqual(Q.validate(q()), []);
  assert.equal(info.label, 'Antigravity');
  assert.equal(info.vendor, 'Google');
  assert.equal(info.tier, 'basic');
  assert.equal(info.channel, 'acp');
  assert.deepEqual(info.detect.bins, q().bins);
  assert.equal(DEFAULTS['harness.acp.antigravity.enabled'], true);
  assert.equal(info.resumeCommand('native-id'), null, 'ACP sessions are not agy CLI conversations');
  assert.deepEqual(info.versions.tested, [], 'initialize alone is not an admission or conformance pass');
  for (const os of ['darwin', 'linux', 'win32']) assert.deepEqual(installLines(info.kind, os, null), []);
  assert.match(info.install.docs, /agentclientprotocol\/registry\/tree\/main\/antigravity-acp/);
});

test('detection accepts the official server names and a manual path, but never mistakes agy for ACP', () => {
  const find = (name: string) => resolveBasic(ID, { env: {}, which: (bin: string) => (bin === name ? `/tools/${bin}` : null), known: [] });
  for (const bin of ['agy_acp_server.par', 'agy_acp_server', 'agy_acp_server.exe']) assert.equal(find(bin), `/tools/${bin}`);
  assert.equal(find('agy'), null);
  assert.equal(resolveBasic(ID, { env: {}, manual: BIN, exists: () => true }), BIN);
});

test('launch preserves the official Linux uid argument and disables startup syslog on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.deepEqual(q().launch({ platform }), {
      args: [...(platform === 'linux' ? ['--uid='] : []), '--nosyslog_on_start'],
    });
  }
  assert.deepEqual(q().launch({}), q().launch({ platform: process.platform }));
  assert.equal(Q.anchorOf(q(), 'unknown-mode'), 'ask');
  assert.equal(Q.isolates(ID), false, 'no unverified isolation contract for MoMo');
  assert.equal(q().mcpScope, undefined, 'each chat owns a process until session-scoped MCP is verified');
});

test('admission requires ACP v1 and the MoPilot tool handshake; sign-in and failures remain visible', async () => {
  for (const outcome of ['admitted', 'signin', 'no-tools', 'bad-protocol']) {
    const sp = fakeSpawn({
      initialize: () => (outcome === 'bad-protocol' ? { protocolVersion: 2 } : initialize()),
      'session/new': () => {
        if (outcome === 'signin') throw Object.assign(new Error('Authentication required'), { code: -32000 });
        return { sessionId: 'antigravity-session' };
      },
    });
    const ended: string[] = [];
    const result = await probe(ID, {
      quirks: Q.quirks,
      resolveBin: () => BIN,
      env: () => ({}),
      dataDir: dir,
      spawnFn: sp.spawnFn,
      tools: {
        prepare: async () => ({ mcpServers: [{ name: 'sage_0123456789ab', command: '/tools/sage-mcp', args: [], env: [] }] }),
        admission: async () => outcome !== 'no-tools',
        end: (key: string) => ended.push(key),
      },
    });
    assert.deepEqual(sp.calls[0].args, q().launch({}).args);
    assert.equal(ended.length, 1);
    assert.equal(sp.procs[0].stdin.ended, true);
    if (outcome === 'admitted') {
      assert.equal(result.state, 'admitted');
      assert.equal(result.version, '1.4.3');
      assert.equal(result.caps.loadSession, true);
      assert.equal(result.caps.audio, true);
      assert.equal(result.caps.image, true);
    } else if (outcome === 'signin') {
      assert.equal(result.state, 'signin');
      assert.equal(result.authMethods[0].id, 'oauth-personal');
    } else {
      assert.equal(result.state, 'unsupported');
      assert.match(result.reason, outcome === 'no-tools' ? /computer and browser control/ : /ACP v2/);
    }
  }
});

test('two Antigravity chats own separate processes and tool channels; reopening retains native identity', async () => {
  const t = setup({ quirks: Q.quirks, resolveBin: () => BIN, handlers: { initialize } });
  try {
    const a = 'acp:antigravity:chat-a';
    const b = 'acp:antigravity:chat-b';
    const [first, second] = await Promise.all([
      t.host.ensure(a, { cwd: dir, chatId: 'chat-a' }),
      t.host.ensure(b, { cwd: dir, chatId: 'chat-b' }),
    ]);
    assert.notEqual(first.agent, second.agent);
    assert.equal(t.sp.calls.length, 2);
    assert.deepEqual(t.prepared.map((p: any) => p.chatId).sort(), ['chat-a', 'chat-b']);
    assert.equal(await t.host.ensure(a), first);
    assert.equal(t.sp.calls.length, 2);
    for (const proc of t.sp.procs) {
      const opened = proc.received.find((m: any) => m.method === 'session/new');
      assert.equal(opened.params.mcpServers.length, 1);
      assert.equal(opened.params.mcpServers[0].name, 'sage_0123456789ab');
    }
    t.items.append('acp:antigravity:reopened', { t: 'session', sessionId: 'native-retained', cwd: dir });
    await t.host.ensure('acp:antigravity:reopened');
    const loaded = t.sp.procs[2].received.find((m: any) => m.method === 'session/load');
    assert.equal(loaded.params.sessionId, 'native-retained');
  } finally {
    t.host.closeAll();
  }
});
