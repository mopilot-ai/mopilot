// A machine's Claude Code logins and a chat's pin to one (#4667 H2): the harness's account list as the Host reports it, a pin checked against it and kept in the chat's file, the `chat.login` method, and what the Host says in its report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { claudeLoginsOf } from '../host/src/claudeLogins.mjs';
import { createChatCredentials, harnessOfChat } from '../host/src/chatCredentials.mjs';
import { createOwnCredentials, createOwnRuns } from '../host/src/ownCredentials.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { reportedHarness } from '../host/src/harnessState.mjs';
import { loadHandlers } from '../host/src/methodHandlers.mjs';
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';
import { LOGINS_FEATURE } from '../shared/host/logins.mjs';

const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-logins-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));
const refused = (code: string) => (e: any) => e.code === code;
const CLAUDE = 'claude:11111111-1111-4111-8111-111111111111';
const LIST = [
  { id: 'default', state: 'ok' },
  { id: 'work', state: 'ok' },
  { id: 'old', state: 'signedOut' },
];

test('the account list becomes the Host’s logins: the machine’s own login named for the machine, an added one by its address, state, billing and which is in use', () => {
  assert.deepEqual(
    claudeLoginsOf({
      active: 'work',
      accounts: [
        { id: 'default', isDefault: true, loggedIn: true, authMethod: 'claude.ai' },
        { id: 'work', email: 'w@x.com', loggedIn: true, authMethod: 'claude.ai' },
        { id: 'key', loggedIn: false, authMethod: 'api_key' },
      ],
    }),
    [
      { id: 'default', label: 'This machine', state: 'ok', limited: false, billing: 'subscription', active: false },
      { id: 'work', label: 'w@x.com', state: 'ok', limited: false, billing: 'subscription', active: true },
      { id: 'key', label: 'key', state: 'signedOut', limited: false, billing: 'apiKey', active: false },
    ],
  );
  assert.deepEqual(claudeLoginsOf(null), []);
  assert.deepEqual(claudeLoginsOf({}), []);
  assert.equal(claudeLoginsOf({ accounts: [{ id: 'x' }] })[0].billing, 'subscription');
});

function world(dataDir?: string) {
  const pins: any[][] = [];
  const logins = new Map();
  const credentials = createChatCredentials({ leases: createCredentialLeases(), ownRuns: createOwnRuns(), dataDir, logins });
  credentials.bindLogins('claude', { list: () => LIST, pin: (...a: any[]) => void pins.push(a) });
  return { credentials, pins };
}

test('a pin is checked against the machine’s logins: unknown, signed out, and an agent that lists none are refused with their codes and change nothing', () => {
  const w = world();
  assert.deepEqual(w.credentials.setLogin({ chatId: CLAUDE, login: 'work' }), { login: 'work' });
  assert.deepEqual(w.pins, [[CLAUDE, 'work']]);
  assert.equal(w.credentials.choiceOf(CLAUDE)?.login, 'work');
  assert.throws(() => w.credentials.setLogin({ chatId: CLAUDE, login: 'nobody' }), refused('login_unavailable'));
  assert.throws(() => w.credentials.setLogin({ chatId: CLAUDE, login: 'old' }), refused('login_signed_out'));
  assert.throws(() => w.credentials.setLogin({ chatId: '019a-thread', login: 'a' }), refused('not_supported'));
  assert.deepEqual(w.pins, [[CLAUDE, 'work']], 'a refused pin touched nothing');
  assert.equal(w.credentials.choiceOf(CLAUDE)?.login, 'work');
});

test('letting a pin go gives the choice back to the agent, and a chat with none has nothing to release', () => {
  const w = world();
  assert.deepEqual(w.credentials.setLogin({ chatId: CLAUDE, login: null }), { login: null });
  assert.deepEqual(w.pins, []);
  w.credentials.setLogin({ chatId: CLAUDE, login: 'work' });
  assert.deepEqual(w.credentials.setLogin({ chatId: CLAUDE, login: null }), { login: null });
  assert.deepEqual(w.pins, [
    [CLAUDE, 'work'],
    [CLAUDE, null],
  ]);
  assert.equal(w.credentials.choiceOf(CLAUDE)?.login, undefined);
});

test('a start that names a login pins it, every message re-checks it, and a login that signed out refuses the turn, never runs it on another', () => {
  const w = world();
  w.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'own', login: 'work' } });
  assert.deepEqual(w.pins, [[CLAUDE, 'work']]);
  assert.doesNotThrow(() => w.credentials.check(CLAUDE, 'claude'));
  LIST[1].state = 'signedOut';
  try {
    assert.throws(() => w.credentials.check(CLAUDE, 'claude'), refused('login_signed_out'));
  } finally {
    LIST[1].state = 'ok';
  }
  assert.deepEqual(
    w.credentials.loginsOf('claude')?.map((l) => l.id),
    ['default', 'work', 'old'],
  );
  assert.equal(w.credentials.loginsOf('codex'), null);
  assert.equal(harnessOfChat(CLAUDE), 'claude');
});

test('chat.login is a Host method: parsed with its epoch and key, refused by a Host without the feature, and served by the handler that pins', () => {
  const p = { chatId: CLAUDE, epoch: 1, key: 'req-0000001' };
  assert.equal(S.parseParams('chat.login', { ...p, login: 'work' }).login, 'work');
  assert.equal(S.parseParams('chat.login', { ...p, login: null }).login, null);
  assert.equal(S.parseParams('chat.login', p).login, null);
  assert.throws(() => S.parseParams('chat.login', { ...p, login: 'bad id!' }));
  assert.throws(
    () => S.requireFeatures('chat.login', { features: ['epoch', 'dedupe'] }),
    (e: any) => e.missing.includes(LOGINS_FEATURE),
  );
  assert.doesNotThrow(() => S.requireFeatures('chat.login', { features: [...S.FEATURES] }));
  const w = world();
  const own = Object.assign(createOwnRuns(), { chatCredentials: w.credentials });
  const { effects } = loadHandlers({ ownRuns: own });
  assert.deepEqual(effects['chat.login']({ chatId: CLAUDE, login: 'work' }), { login: 'work' });
  const none = loadHandlers({ ownRuns: createOwnRuns() });
  assert.throws(() => none.effects['chat.login']({ chatId: CLAUDE, login: null }), refused('unsupported'));
  assert.throws(() => loadHandlers({ ownRuns: null }).effects['chat.login']({ chatId: CLAUDE, login: null }), refused('unsupported'));
});

test('the Host reports Claude Code’s logins and that it can hold several; an agent with none reports none, and an older caller’s record is unchanged', async () => {
  const leases = createCredentialLeases();
  const credentials = createChatCredentials({ leases });
  const sessions = {
    modelsOf: () => [],
    loginsOf: (h: string) => (h === 'claude' ? [{ id: 'default', label: 'This machine', state: 'ok' }] : []),
  };
  const io = { codex: { models: async () => [] }, sessions, leases, credentials };
  const claude: any = await reportedHarness({ id: 'claude', detected: true, signedIn: true }, io);
  assert.deepEqual([claude.logins.length, claude.loginsSupported], [1, true]);
  const codex: any = await reportedHarness({ id: 'codex', detected: true, signedIn: true }, io);
  assert.equal('logins' in codex, false);
  const empty: any = await reportedHarness(
    { id: 'claude', detected: true, signedIn: true },
    { ...io, sessions: { ...sessions, loginsOf: () => [] } },
  );
  assert.equal('logins' in empty, false);
  const older: any = await reportedHarness({ id: 'claude', detected: true, signedIn: true }, { ...io, sessions: { modelsOf: () => [] } });
  assert.equal('logins' in older, false);
});

test('on the Host: Claude Code’s family lists the logins of its account list, and a pin to a signed-out one is refused through the real chain, writing nothing', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const leases = createCredentialLeases();
  const ownRuns = createOwnCredentials({ leases, dataDir: dir });
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
  try {
    const chatId = `claude:${crypto.randomUUID()}`;
    await sessions.chatRuntime.send({ key: chatId, text: 'hello', cwd: dir });
    const listed = family.logins();
    assert.deepEqual(
      listed.map((l: any) => [l.id, l.label, l.state, l.active]),
      [['default', 'This machine', 'signedOut', true]],
      'a machine whose CLI is not signed in lists its own login as signed out',
    );
    assert.deepEqual(sessions.loginsOf('codex'), []);
    assert.deepEqual(sessions.loginsOf('claude'), listed);
    assert.deepEqual(ownRuns.chatCredentials.loginsOf('claude'), listed);
    assert.throws(
      () => ownRuns.chatCredentials.setLogin({ chatId, login: 'default' }),
      (e: any) => e.code === 'login_signed_out',
    );
    assert.notEqual(sessions.chats.records.get(chatId)?.meta?.account?.pinned, true, 'the refused pin wrote nothing');
    // a list asked for before the CLI's own login was read asks for the read (a Host has no window to), once per ask
    let reads = 0;
    family.claude.turnApi.readCliLogin = async () => void reads++;
    const view = { active: 'default', accounts: [{ id: 'default', isDefault: true, loggedIn: false, checked: false }] };
    family.claude.turnApi.accounts = () => view;
    family.logins();
    assert.equal(reads, 1);
    view.accounts[0].checked = true;
    family.logins();
    assert.equal(reads, 1, 'a login that was read is not read again');
    // a read that fails is not the list's failure
    family.claude.turnApi.readCliLogin = async () => {
      reads++;
      throw new Error('no cli');
    };
    view.accounts[0].checked = false;
    assert.doesNotThrow(() => family.logins());
    await new Promise((r) => setImmediate(r));
    assert.equal(reads, 2);
    view.accounts[0].checked = true;
    // once the harness lists the login as signed in, a pin is kept in the chat's own file, where the adapter reads the login a chat runs on
    family.claude.turnApi.accounts = () => ({ active: 'default', accounts: [{ id: 'default', isDefault: true, loggedIn: true }] });
    assert.deepEqual(ownRuns.chatCredentials.setLogin({ chatId, login: 'default' }), { login: 'default' });
    assert.deepEqual(sessions.chats.records.get(chatId)?.meta?.account, { id: 'default', pinned: true });
    assert.deepEqual(ownRuns.chatCredentials.setLogin({ chatId, login: null }), { login: null });
    assert.equal(sessions.chats.records.get(chatId)?.meta?.account, null, 'letting the pin go clears it from the chat');
  } finally {
    sessions.close();
    runtime.close();
    await family?.close();
    restore();
  }
});

test('a Host that runs no Claude Code family reports no logins', () => {
  const dir = fs.mkdtempSync(path.join(base, 'n-'));
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {} });
  const make = (claude: any) =>
    createHostSessions({ paths: createPaths({ dataDir: dir, env: {} }), env: {}, runtime, families: claude ? { claude } : {} });
  const without = make(null);
  try {
    assert.deepEqual(without.loginsOf('claude'), []);
  } finally {
    without.close();
    runtime.close();
  }
});
