// MoPilot's tools for the chats of the Claude family on a Host (host/src/claudeFamily.mjs `tools`): a session is given in-process MCP servers over the Host's registry, whose tools are the app's, relayed. A: two chats each reach their own app, W: no app / an app that leaves mid-call, B: Stop, I: a machine without a peer check gives no tools.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { createHostTools } from '../host/src/tools.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-family-tools-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const keyOf = () => `claude:${crypto.randomUUID()}`;
const spec = {
  name: 'relay_probe',
  description: 'Probe the app.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  policy: 'act' as const,
};

/** A Host's sessions with the Claude family over a fake SDK and the given tool channel. */
function setup(tools: ReturnType<typeof createHostTools>) {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const paths = createPaths({ dataDir: dir, env: {} });
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 30 } });
  let family: any;
  const sessions = createHostSessions({
    paths,
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = createClaudeFamily({ sdk: fake.sdk, tools })(ctx)) },
  });
  const close = async () => {
    sessions.close();
    runtime.close();
    await family.close();
    tools.close();
    restore();
  };
  return { dir, fake, sessions, close };
}
type Host = ReturnType<typeof setup>;

/** The app: records what it is sent. */
function app(tools: ReturnType<typeof createHostTools>) {
  const sent: any[] = [];
  const conn = tools.relay!.attach(
    (m: any) => sent.push(m),
    () => 0,
  );
  return { conn, sent };
}

/** The relay_probe tool of the session the harness started for `key`, as the CLI would call it. */
async function probeOf(h: Host, key: string) {
  const q = await until(() => h.fake.queries.find((x: any) => x.options.sessionId === key.slice('claude:'.length)));
  const servers: any[] = Object.values(q.options.mcpServers ?? {});
  const tool = servers.flatMap((s) => s.tools).find((t: any) => t.name === 'relay_probe');
  return (args: object, extra: object = {}) => tool.handler(args, extra);
}

test('A: two Claude chats each reach the app that owns them, and an answer comes back to the tool call that asked', {
  timeout: 60_000,
}, async () => {
  const tools = createHostTools();
  const h = setup(tools);
  try {
    const a1 = app(tools);
    const a2 = app(tools);
    a1.conn.sync([spec]);
    a2.conn.sync([spec]);
    const [keyA, keyB] = [keyOf(), keyOf()];
    a1.conn.send(keyA);
    a2.conn.send(keyB);
    await h.sessions.chatRuntime.send({ key: keyA, text: 'hello', cwd: h.dir });
    await h.sessions.chatRuntime.send({ key: keyB, text: 'hello', cwd: h.dir });
    const [callA, callB] = [await probeOf(h, keyA), await probeOf(h, keyB)];

    const ra = callA({ url: 'https://a.example' }, { _meta: { 'claudecode/toolUseId': 'tu-a' } });
    await until(() => a1.sent.length);
    assert.deepEqual(
      [a1.sent[0].event, a1.sent[0].chatId, a1.sent[0].name, a1.sent[0].arguments],
      ['tool', keyA, 'relay_probe', { url: 'https://a.example' }],
    );
    assert.equal(a2.sent.length, 0, 'the other chat’s app is not asked');
    a1.conn.result({ chatId: keyA, callId: a1.sent[0].callId, ok: true, content: [{ type: 'text', text: 'opened a' }] });
    assert.deepEqual((await ra).content, [{ type: 'text', text: 'opened a' }]);

    const rb = callB({ url: 'https://b.example' });
    await until(() => a2.sent.length);
    assert.equal(a2.sent[0].chatId, keyB);
    assert.equal(a1.sent.length, 1);
    a2.conn.result({ chatId: keyB, callId: a2.sent[0].callId, ok: true, content: [{ type: 'text', text: 'opened b' }] });
    assert.deepEqual((await rb).content, [{ type: 'text', text: 'opened b' }]);
  } finally {
    await h.close();
  }
});

test('W: with no app for the chat, or an app that leaves mid-call, the tool call fails at once with the reason', {
  timeout: 60_000,
}, async () => {
  const tools = createHostTools();
  const h = setup(tools);
  try {
    const a = app(tools);
    a.conn.sync([spec]);
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'hello', cwd: h.dir });
    const call = await probeOf(h, key);
    const none = await call({});
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /not connected/);
    a.conn.send(key);
    const running = call({});
    await until(() => a.sent.length);
    a.conn.detach();
    const gone = await running;
    assert.equal(gone.isError, true);
    assert.match(gone.content[0].text, /disconnected/);
  } finally {
    await h.close();
  }
});

test('B: the CLI cancelling a tool call stops it and tells the app', { timeout: 60_000 }, async () => {
  const tools = createHostTools();
  const h = setup(tools);
  try {
    const a = app(tools);
    a.conn.sync([spec]);
    const key = keyOf();
    a.conn.send(key);
    await h.sessions.chatRuntime.send({ key, text: 'hello', cwd: h.dir });
    const call = await probeOf(h, key);
    const ac = new AbortController();
    const running = call({}, { signal: ac.signal });
    await until(() => a.sent.length);
    ac.abort();
    const res = await running;
    assert.equal(res.isError, true);
    assert.equal(a.sent.at(-1).event, 'toolCancel');
    assert.equal(a.sent.at(-1).callId, a.sent[0].callId);
    // the chat's Stop reaches calls waiting for the app the same way
    const again = call({});
    await until(() => a.sent.length === 3);
    tools.relay!.abortChat(key);
    assert.equal((await again).isError, true);
    assert.equal(a.sent.at(-1).event, 'toolCancel');
  } finally {
    await h.close();
  }
});

test('I: a machine without a peer check gives a Claude session no tools', { timeout: 60_000 }, async () => {
  const tools = createHostTools({ addon: null });
  const h = setup(tools);
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'hello', cwd: h.dir });
    const q = await until(() => h.fake.queries[0]);
    assert.equal(q.options.mcpServers, undefined);
  } finally {
    await h.close();
  }
});
