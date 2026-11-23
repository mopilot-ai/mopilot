// A scheduled run uses the Host's own sign-in (#3619, credential design #3361): Claude Code's CLI for a scheduled chat is started without the key or lease the app lent (which stays for the chat it was lent to), and Codex's app-server or an ACP agent's process, shared by every chat, refuses a scheduled run while one is lent instead of handing it the lent credential.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createOwnCredentials, createOwnRuns } from '../host/src/ownCredentials.mjs';
// @ts-ignore: plain ESM without declarations
import { helloParams } from '../shared/host/schema.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';

const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-own-cred-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('ownRuns remembers the chats that run on the Host’s own sign-in', () => {
  const own = createOwnRuns();
  assert.equal(own.has('claude:a'), false);
  own.add('claude:a');
  assert.equal(own.has('claude:a'), true);
  own.delete('claude:a');
  assert.equal(own.has('claude:a'), false);
});

test('Claude Code: an own-sign-in chat’s CLI gets no lent key or lease, another chat’s still does, and the lease stays lent', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const leases = createCredentialLeases();
  const ownRuns = createOwnRuns();
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {} });
  let family: any;
  const sessions = createHostSessions({
    paths: createPaths({ dataDir: dir, env: {} }),
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = createClaudeFamily({ sdk: fake.sdk, leases, ownRuns })(ctx)) },
  });
  const args = ['-e', 'process.stdout.write(JSON.stringify({ env: process.env.ANTHROPIC_API_KEY ?? null }))'];
  const seen = async (spawnCli: any) => {
    const child = spawnCli({
      command: process.execPath,
      args,
      cwd: dir,
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    await new Promise((r) => child.once('close', r));
    return JSON.parse(out).env;
  };
  try {
    leases.set('claude', KEY);
    const lentChat = `claude:${crypto.randomUUID()}`;
    const ownChat = `claude:${crypto.randomUUID()}`;
    ownRuns.add(ownChat);
    await sessions.chatRuntime.send({ key: lentChat, text: 'hello', cwd: dir });
    await sessions.chatRuntime.send({ key: ownChat, text: 'scheduled', cwd: dir });
    const spawnLent = await until(() => fake.queries[0]?.options.spawnClaudeCodeProcess);
    const spawnOwn = await until(() => fake.queries[1]?.options.spawnClaudeCodeProcess);
    assert.equal(await seen(spawnLent), KEY, 'the chat the key was lent to still runs on it');
    assert.equal(await seen(spawnOwn), null, 'the scheduled chat runs on the Host’s own sign-in');
    assert.equal(leases.has('claude'), true, 'the lease is not cleared or replaced');
    assert.equal(await seen(spawnLent), KEY);
  } finally {
    sessions.close();
    runtime.close();
    await family?.close();
    restore();
  }
});

function protocolWith(t: any, leases: any, ownRuns?: any) {
  const dir = fs.mkdtempSync(path.join(base, 'p-'));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const sends: any[] = [];
  const runtime: any = {
    host: Object.assign(new EventEmitter(), { cancel: () => undefined }),
    send: async (p: any) => (sends.push(p.key), { action: 'started', id: 'm', turnId: 'm' }),
    prepare: async () => undefined,
  };
  return { sends, protocol: createProtocol({ runtime, epochs, guard, status: () => ({}), leases, ownRuns, dataDir: dir }) };
}
const wire = (harness: string) => ({
  id: 't',
  name: 'n',
  rrule: 'FREQ=DAILY',
  zone: 'UTC',
  prompt: 'p',
  harness,
  cwd: '/srv',
  status: 'ACTIVE' as const,
  scheduleFrom: 0,
});
const org = (harness: string) => ({
  harness,
  identity: 'a'.repeat(32),
  token: 'tok',
  gateways: { openai: 'https://g.example.test/v1' },
  expiresAt: Date.now() + 60_000,
});

test('a scheduled start: Claude Code is marked own-sign-in; Codex and ACP agents run when nothing is lent and are refused while something is', async (t) => {
  const leases = createCredentialLeases();
  const ownRuns = createOwnRuns();
  const { protocol, sends } = protocolWith(t, leases, ownRuns);
  await protocol.startScheduled({ chatId: 'claude:00000000-0000-4000-8000-0000000000c1', task: wire('claude') });
  assert.equal(ownRuns.has('claude:00000000-0000-4000-8000-0000000000c1'), true);
  assert.equal(ownRuns.has('claude:00000000-0000-4000-8000-0000000000c2'), false, 'only the scheduled chat');
  // nothing lent: Codex and an ACP agent run as before
  await protocol.startScheduled({ chatId: 'x1', task: wire('codex') });
  await protocol.startScheduled({ chatId: 'acp:kimi:k1', task: wire('kimi') });
  // a key lent to Codex, a key lent to Gemini, an organization lease for ACP agents
  leases.set('codex', 'sk-proj-dummy-0000-test-key-abcd');
  await assert.rejects(
    async () => protocol.startScheduled({ chatId: 'x2', task: wire('codex') }),
    /Codex is running on a sign-in the app lent/,
  );
  leases.set('gemini', 'gem-dummy-key');
  await assert.rejects(async () => protocol.startScheduled({ chatId: 'acp:gemini:g1', task: wire('gemini') }), /lent/);
  await protocol.startScheduled({ chatId: 'acp:kimi:k2', task: wire('kimi') });
  leases.setOrg(org('acp'), Date.now());
  await assert.rejects(async () => protocol.startScheduled({ chatId: 'acp:kimi:k3', task: wire('kimi') }), /lent/);
  assert.deepEqual(
    sends,
    ['claude:00000000-0000-4000-8000-0000000000c1', 'x1', 'acp:kimi:k1', 'acp:kimi:k2'],
    'a refused run sends nothing',
  );
  assert.equal(leases.has('codex'), true, 'a refused run does not take the other chat’s lease away');
});

test('a Host with no lease store or no own-run set starts scheduled runs as before', async (t) => {
  const { protocol, sends } = protocolWith(t, undefined, undefined);
  await protocol.startScheduled({ chatId: 'claude:00000000-0000-4000-8000-0000000000c1', task: wire('claude') });
  await protocol.startScheduled({ chatId: 'x1', task: wire('codex') });
  assert.deepEqual(sends, ['claude:00000000-0000-4000-8000-0000000000c1', 'x1']);
});

test('removing a chat forgets the credential it chose, so a later chat with that id starts from the Host’s order', async (t) => {
  const leases = createCredentialLeases();
  const ownRuns = createOwnCredentials({ leases });
  const { protocol } = protocolWith(t, leases, ownRuns);
  const chatId = 'claude:00000000-0000-4000-8000-0000000000c1';
  ownRuns.chatCredentials.admit({ chatId, harness: 'claude', credential: { source: 'own' } });
  assert.deepEqual(ownRuns.chatCredentials.choiceOf(chatId), { source: 'own' });
  const conn = protocol.connection(() => undefined);
  await conn.call('host.hello', helloParams());
  await conn.call('chat.remove', { chatId, epoch: 1, key: 'req-0000001' });
  assert.equal(ownRuns.chatCredentials.choiceOf(chatId), null);
});
