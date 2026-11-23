// Which credential a machine chat runs on (host/src/chatCredentials.mjs): the sources an agent has and the one a chat started now uses, a choice admitted or refused per agent, kept across a restart and checked on every message, and what the Host reports of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatCredentials, harnessOfChat } from '../host/src/chatCredentials.mjs';
import { createOwnCredentials, createOwnRuns } from '../host/src/ownCredentials.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { createChatEffects } from '../host/src/chatEffects.mjs';
import { reportedHarness } from '../host/src/harnessState.mjs';
import { DEFAULT_ORDER, LENT_FIRST_ORDER, usingOf } from '../shared/host/logins.mjs';

const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-chatcred-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const dir = () => {
  const d = path.join(base, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const lease = (identity = '0'.repeat(32)) => ({
  harness: 'claude',
  identity,
  token: 'tok-0000000000000000',
  gateways: { anthropic: 'https://gw.example/anthropic' },
  expiresAt: Date.now() + 3_600_000,
});
const codexLease = () => ({
  harness: 'codex',
  identity: '1'.repeat(32),
  token: 'tok-1111111111111111',
  gateways: { openai: 'https://gw.example/v1' },
  expiresAt: Date.now() + 3_600_000,
});
const refused = (code: string) => (e: any) => e.code === code;
/** A credential refusal with the cause the app words it by (shared/host/refusalWords.mjs). */
const because = (cause: string) => (e: any) => e.code === 'credential_unavailable' && e.details?.cause === cause;
const CLAUDE = 'claude:11111111-1111-4111-8111-111111111111';

function world(dataDir?: string) {
  const leases = createCredentialLeases();
  const ownRuns = createOwnRuns();
  return { leases, ownRuns, credentials: createChatCredentials({ leases, ownRuns, dataDir }) };
}

test('a side chat inherits the parent’s effective credential for its current agent', () => {
  const { credentials } = world();
  credentials.stateOf('claude', true);
  credentials.admit({ chatId: CLAUDE, harness: 'claude' });
  assert.deepEqual(credentials.sideChatChoice(CLAUDE, 'claude'), { source: 'own' });
  credentials.setLogin({ chatId: CLAUDE, login: 'default' });
  assert.deepEqual(credentials.sideChatChoice(CLAUDE, 'claude'), { source: 'own', login: 'default' });
  assert.equal(credentials.sideChatChoice(CLAUDE, 'codex'), undefined);
  assert.equal(credentials.sideChatChoice('unknown', 'claude'), undefined);
});

test('a chat started now uses the machine’s own login first, then a lease, then a key; an agent that shares one process uses what is lent', () => {
  const w = world();
  assert.deepEqual(w.credentials.stateOf('claude', true), { sources: { own: true, key: false, org: false }, using: 'own' });
  w.leases.set('claude', KEY);
  assert.deepEqual(
    w.credentials.stateOf('claude', true),
    { sources: { own: true, key: true, org: false }, using: 'own' },
    'signed in: the subscription, not the key',
  );
  assert.deepEqual(
    w.credentials.stateOf('claude', false),
    { sources: { own: false, key: true, org: false }, using: 'key' },
    'no usable login: the key',
  );
  w.leases.setOrg(lease(), Date.now());
  assert.deepEqual(w.credentials.stateOf('claude', true).using, 'own');
  assert.deepEqual(w.credentials.stateOf('claude', false), { sources: { own: false, key: true, org: true }, using: 'org' });
  // a basic agent: the lease is the family's, a key is its own and only for an agent that takes one
  w.leases.set('gemini', KEY);
  assert.equal(w.credentials.stateOf('acp:gemini', true).using, 'key');
  assert.equal(w.credentials.stateOf('acp:other', true).using, 'own');
  w.leases.set('codex', KEY);
  assert.equal(w.credentials.stateOf('codex', false).using, 'key');
  assert.equal(
    w.credentials.stateOf('codex', true).using,
    'own',
    'Codex has an app-server for each credential, so a signed-in machine runs a new chat on its own login though a key is lent (H3)',
  );
  assert.equal(
    w.credentials.stateOf('acp:gemini', true).using,
    'key',
    'a basic agent still runs every chat in one process, which uses what is lent, and it says so',
  );
});

test('Claude Code: own puts the chat on the machine’s login whatever is lent; a key or lease must be the one in use', () => {
  const w = world();
  w.leases.set('claude', KEY);
  w.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'own' } });
  assert.equal(w.ownRuns.has(CLAUDE), true);
  w.credentials.admit({ chatId: 'claude:other', harness: 'claude', credential: { source: 'key' } });
  assert.equal(w.ownRuns.has('claude:other'), false);
  const nokey = world();
  assert.throws(() => nokey.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'key' } }), because('key'));
  assert.throws(() => nokey.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'org' } }), because('org'));
  w.leases.setOrg(lease(), Date.now());
  assert.throws(
    () => w.credentials.admit({ chatId: 'claude:x', harness: 'claude', credential: { source: 'key' } }),
    because('lease_in_use'),
  );
  w.credentials.admit({ chatId: 'claude:y', harness: 'claude', credential: { source: 'org' } });
  assert.equal(w.credentials.choiceOf('claude:y')?.source, 'org');
  assert.equal(w.credentials.choiceOf('claude:nobody'), null);
});

test('a family with one shared process runs a chat on what the process uses, and refuses a different choice', () => {
  const w = world();
  w.leases.set('gemini', KEY);
  assert.throws(
    () => w.credentials.admit({ chatId: 'acp:gemini:1', harness: 'acp:gemini', credential: { source: 'own' } }),
    refused('credential_unavailable'),
  );
  w.credentials.admit({ chatId: 'acp:gemini:1', harness: 'acp:gemini', credential: { source: 'key' } });
  const plain = world();
  plain.credentials.admit({ chatId: 'acp:gemini:2', harness: 'acp:gemini', credential: { source: 'own' } });
  assert.throws(
    () => plain.credentials.admit({ chatId: 'acp:gemini:3', harness: 'acp:gemini', credential: { source: 'key' } }),
    refused('credential_unavailable'),
  );
});

test('Codex runs a chat on the credential it chose whatever is lent, and a start without a choice begins on the default', () => {
  const w = world();
  w.leases.set('codex', KEY);
  w.credentials.stateOf('codex', true);
  assert.doesNotThrow(() => w.credentials.admit({ chatId: 'thread-1', harness: 'codex', credential: { source: 'own' } }));
  assert.doesNotThrow(() => w.credentials.admit({ chatId: 'thread-2', harness: 'codex', credential: { source: 'key' } }));
  w.credentials.admit({ chatId: 'thread-3', harness: 'codex' });
  assert.equal(w.credentials.sourceOf('thread-3'), 'own', 'a signed-in machine: its own login first');
  w.leases.setOrg(codexLease(), Date.now());
  assert.doesNotThrow(
    () => w.credentials.admit({ chatId: 'thread-4', harness: 'codex', credential: { source: 'key' } }),
    'no one process serves it, so a lease does not stand in for it',
  );
  const bare = world();
  assert.throws(
    () => bare.credentials.admit({ chatId: 'thread-5', harness: 'codex', credential: { source: 'org' } }),
    refused('credential_unavailable'),
  );
  assert.equal(bare.credentials.sourceOf('thread-5'), null);
  // what it began on is checked on every message, chosen or not: its app-server for a credential that is gone would start with none
  w.credentials.stateOf('codex', false);
  w.credentials.admit({ chatId: 'thread-6', harness: 'codex' });
  assert.equal(w.credentials.sourceOf('thread-6'), 'org', 'the machine is signed out and a lease is lent: the lease');
  w.leases.clear();
  assert.throws(() => w.credentials.check('thread-6', 'codex'), refused('credential_unavailable'));
  assert.throws(() => w.credentials.check('thread-2', 'codex'), refused('credential_unavailable'));
  assert.doesNotThrow(
    () => w.credentials.check('thread-3', 'codex'),
    'the machine’s own login is not a lent credential that can be taken back',
  );
});

test('only the machine’s one login can be named until it lists several, and a start without a choice is untouched', () => {
  const w = world();
  assert.throws(
    () => w.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'own', login: 'work' } }),
    refused('not_supported'),
  );
  w.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'own', login: 'default' } });
  w.credentials.admit({ chatId: 'claude:none', harness: 'claude' });
  assert.equal(w.credentials.choiceOf('claude:none'), null);
  assert.doesNotThrow(() => w.credentials.check('claude:none', 'claude'));
});

test('every message re-checks the choice: a key taken back or a lease ended refuses the turn, never runs it on another credential', () => {
  const w = world();
  w.leases.set('claude', KEY);
  w.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'key' } });
  assert.doesNotThrow(() => w.credentials.check(CLAUDE, 'claude'));
  w.leases.set('claude', null);
  assert.throws(() => w.credentials.check(CLAUDE, 'claude'), because('key'));
});

test('a choice survives a restart: the file is kept private, Claude Code chats are put back on their own login, a damaged file is ignored, forgetting removes it', () => {
  const d = dir();
  const first = world(d);
  first.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'own' } });
  first.credentials.admit({ chatId: 'thread-9', harness: 'codex', credential: { source: 'own' } });
  assert.equal(fs.statSync(path.join(d, 'chat-credentials.json')).mode & 0o077, 0);
  const again = world(d);
  assert.equal(again.ownRuns.has(CLAUDE), false);
  again.credentials.restore();
  assert.equal(again.ownRuns.has(CLAUDE), true);
  assert.equal(again.ownRuns.has('thread-9'), false);
  assert.equal(again.credentials.choiceOf('thread-9')?.source, 'own');
  again.credentials.forget(CLAUDE);
  again.credentials.forget('never-chose');
  assert.equal(again.ownRuns.has(CLAUDE), false);
  assert.equal(world(d).credentials.choiceOf(CLAUDE), null);
  fs.writeFileSync(path.join(d, 'chat-credentials.json'), '{not json');
  assert.equal(world(d).credentials.choiceOf('thread-9'), null);
  const memory = world();
  memory.credentials.admit({ chatId: CLAUDE, harness: 'claude', credential: { source: 'own' } });
  memory.credentials.forget(CLAUDE);
  const own = createOwnCredentials({ leases: createCredentialLeases(), dataDir: d });
  assert.equal(typeof own.chatCredentials.admit, 'function');
  assert.equal(own.has('x'), false);
});

test('a chat id names its agent', () => {
  assert.deepEqual(
    [harnessOfChat(CLAUDE), harnessOfChat('acp:gemini:abc'), harnessOfChat('019a-thread')],
    ['claude', 'acp:gemini', 'codex'],
  );
});

test('the Host reports the sources and the one in use per agent, and that an ACP agent has one sign-in', async () => {
  const w = world();
  w.leases.set('claude', KEY);
  const io = { codex: { models: async () => [] }, sessions: { modelsOf: () => [] }, leases: w.leases, credentials: w.credentials };
  const claude = await reportedHarness({ id: 'claude', detected: true, signedIn: true }, io);
  assert.deepEqual([claude.sources, claude.using, 'loginsSupported' in claude], [{ own: true, key: true, org: false }, 'own', false]);
  const codex = await reportedHarness({ id: 'codex', detected: true, signedIn: false }, io);
  assert.deepEqual([codex.sources, codex.using], [{ own: false, key: false, org: false }, 'own']);
  // Codex and Claude Code say the Host takes Plan for them (chat.permit); no other agent's row carries the field
  assert.deepEqual(
    [
      (codex as { planMode?: boolean }).planMode,
      'planMode' in claude,
      'planMode' in (await reportedHarness({ id: 'gemini', detected: true, signedIn: true }, io)),
    ],
    [true, true, false],
  );
  const gemini = await reportedHarness({ id: 'gemini', detected: true, signedIn: true }, io);
  assert.deepEqual([gemini.using, gemini.loginsSupported], ['own', false]);
  // an older caller that passes no credentials gets today's record
  assert.equal(
    'using' in (await reportedHarness({ id: 'claude', detected: true, signedIn: true }, { ...io, credentials: undefined })),
    false,
  );
});

test('a start that chose a credential it cannot have never reaches the harness, a failed start lets the choice go, and every message is checked', async () => {
  const w = world();
  const calls: string[] = [];
  const effects = createChatEffects({
    runtime: { prepare: async () => void calls.push('prepare'), send: async () => ({ turnId: 't1' }) },
    handoffs: null,
    finish: () => undefined,
    record: () => undefined,
    endedTurns: new Set(),
    images: null,
    tools: null,
    check: () => undefined,
    faults: { clear: () => undefined, fail: () => undefined },
    approvals: { resume: () => null },
    credentials: w.credentials,
  } as any);
  const start = { chatId: CLAUDE, harness: 'claude', text: 'go', key: 'req-0000001' };
  await assert.rejects(
    Promise.resolve(effects['chat.start']({ ...start, credential: { source: 'key' } })),
    refused('credential_unavailable'),
  );
  assert.deepEqual(calls, []);
  assert.equal(w.credentials.choiceOf(CLAUDE), null);
  await effects['chat.start']({ ...start, credential: { source: 'own' } });
  assert.equal(w.credentials.choiceOf(CLAUDE)?.source, 'own');
  w.leases.set('claude', KEY);
  await effects['chat.send']({ chatId: CLAUDE, text: 'next', key: 'req-0000002' });
  const side = `claude:side-chat-${crypto.randomUUID()}`;
  await effects['chat.start']({
    ...start,
    chatId: side,
    key: 'req-side-0001',
    sideChat: { sourceId: CLAUDE, epoch: 0 },
    credential: { source: 'key' },
  });
  assert.equal(w.credentials.choiceOf(side)?.source, 'own', 'the side chat uses the parent’s credential');
  await assert.rejects(effects['chat.start']({ ...start, chatId: 'claude:no-uuid' }) as Promise<unknown>, /a UUID/);
  // a choice that is gone refuses the next message
  const gone = world();
  gone.leases.set('claude', KEY);
  gone.credentials.admit({ chatId: 'claude:g', harness: 'claude', credential: { source: 'key' } });
  gone.leases.set('claude', null);
  const e2 = createChatEffects({
    runtime: { send: async () => ({}) },
    handoffs: null,
    finish: () => undefined,
    record: () => undefined,
    endedTurns: new Set(),
    images: null,
    tools: null,
    check: () => undefined,
    faults: { clear: () => undefined },
    approvals: { resume: () => null },
    credentials: gone.credentials,
  } as any);
  await assert.rejects(
    Promise.resolve(e2['chat.send']({ chatId: 'claude:g', text: 'x', key: 'req-0000003' })),
    refused('credential_unavailable'),
  );
  // a start that fails after its choice was admitted lets the choice go
  const failing = createChatEffects({
    runtime: {
      prepare: async () => {
        throw new Error('no session');
      },
    },
    handoffs: null,
    finish: () => undefined,
    record: () => undefined,
    endedTurns: new Set(),
    images: null,
    tools: null,
    check: () => undefined,
    faults: {},
    approvals: {},
    credentials: w.credentials,
  } as any);
  await assert.rejects(
    Promise.resolve(
      failing['chat.start']({ ...start, chatId: 'claude:22222222-2222-4222-8222-222222222222', credential: { source: 'own' } }),
    ),
    /no session/,
  );
  assert.equal(w.credentials.choiceOf('claude:22222222-2222-4222-8222-222222222222'), null);
});

test('the default order is one constant: the machine’s own login, then a lease, then a key; only what the Host can give one chat follows it', () => {
  // the Host's side of the owner's decision: these lines are the answer, and these are its two ends
  assert.deepEqual([...DEFAULT_ORDER], ['own', 'org', 'key']);
  assert.deepEqual([...LENT_FIRST_ORDER], ['org', 'key', 'own']);
  assert.equal(usingOf({ own: true, key: true, org: false }), 'own');
  assert.equal(usingOf({ own: false, key: true, org: false }), 'key', 'no usable login: the key');
  assert.equal(usingOf({ own: false, key: true, org: true }), 'org');
  assert.equal(usingOf({ own: true, key: true, org: false }, LENT_FIRST_ORDER), 'key');
  assert.equal(
    usingOf({ own: false, key: false, org: false }),
    'own',
    'nothing exists: the machine’s own login, which then fails to sign in, never another credential',
  );
  const w = world();
  w.leases.set('claude', KEY);
  w.leases.set('codex', KEY);
  // before the first status is known nothing says the machine is signed in, so a chat that began before the default changed keeps the lent key
  assert.equal(w.credentials.ownByDefault(CLAUDE), false);
  assert.equal(w.credentials.stateOf('claude', true).using, 'own');
  assert.equal(w.credentials.stateOf('claude', false).using, 'key');
  assert.equal(w.credentials.stateOf('codex', true).using, 'own', 'Codex follows it too, with a process for each credential (H3)');
  w.leases.set('gemini', KEY);
  assert.equal(w.credentials.stateOf('acp:gemini', true).using, 'key', 'a shared process uses what is lent');
  w.credentials.stateOf('claude', true);
  w.credentials.admit({ chatId: 'claude:k', harness: 'claude', credential: { source: 'key' } });
  assert.equal(w.ownRuns.has('claude:k'), false, 'a chat that chose the key keeps it');
  assert.equal(w.credentials.ownByDefault('thread-1'), false);
  // the Host's own-run test: a chat that began before the default changed keeps the lent key, and one with nothing lent is on the machine's login
  const lent = createCredentialLeases();
  const own = createOwnCredentials({ leases: lent, dataDir: undefined });
  lent.set('claude', KEY);
  assert.equal(own.has('claude:unknown'), false, 'a key was lent and nothing says signed in: the chat keeps the key');
  own.add(CLAUDE);
  assert.equal(own.has(CLAUDE), true);
  assert.equal(
    createOwnCredentials({ leases: createCredentialLeases() }).has('claude:unknown'),
    true,
    'with nothing lent every Claude Code chat is on the machine’s login anyway',
  );
});

test('the refusal for one chat on the machine’s own login says why, in plain words, for an agent whose chats share one process', () => {
  const w = world();
  w.leases.set('gemini', KEY);
  assert.throws(
    () => w.credentials.admit({ chatId: 'acp:gemini:1', harness: 'acp:gemini', credential: { source: 'own' } }),
    (e: any) => /all its chats in one process/.test(e.message) && because('shared')(e),
  );
});

test('a chat that chose nothing is kept on what it began on: a new chat on the machine’s login, a signed-out machine’s on the key, and neither moves when that changes', () => {
  const d = dir();
  const w = world(d);
  w.leases.set('claude', KEY);
  w.credentials.stateOf('claude', true);
  w.credentials.admit({ chatId: CLAUDE, harness: 'claude' });
  assert.equal(w.ownRuns.has(CLAUDE), true, 'signed in: a new chat runs on the machine’s own login, though a key is lent');
  assert.equal(w.credentials.choiceOf(CLAUDE), null, 'where it began is not a choice of its person’s');
  assert.doesNotThrow(() => w.credentials.check(CLAUDE, 'claude'));
  w.leases.set('claude', null);
  assert.doesNotThrow(() => w.credentials.check(CLAUDE, 'claude'), 'nothing is enforced for what began on the default');
  w.leases.set('claude', KEY);
  const keyed = 'claude:33333333-3333-4333-8333-333333333333';
  w.credentials.stateOf('claude', false);
  w.credentials.admit({ chatId: keyed, harness: 'claude' });
  assert.equal(w.ownRuns.has(keyed), false, 'no usable login: the lent key');
  w.credentials.stateOf('claude', true);
  assert.equal(w.ownRuns.has(keyed), false, 'the machine signing in later does not move a chat that has begun');
  assert.equal(w.ownRuns.has(CLAUDE), true);
  // a Host that restarts puts both back where they were
  const again = world(d);
  again.credentials.restore();
  assert.equal(again.ownRuns.has(CLAUDE), true);
  assert.equal(again.ownRuns.has(keyed), false);
  // Codex is kept on what it began on the same way; an agent whose one process is shared keeps no record: it uses what is lent
  w.credentials.stateOf('codex', true);
  w.credentials.admit({ chatId: 'thread-5', harness: 'codex' });
  assert.equal(w.credentials.sourceOf('thread-5'), 'own');
  assert.equal(w.credentials.choiceOf('thread-5'), null);
  w.credentials.admit({ chatId: 'acp:gemini:5', harness: 'acp:gemini' });
  assert.equal(w.credentials.sourceOf('acp:gemini:5'), null);
  // forgetting a chat forgets where it began
  w.credentials.forget(CLAUDE);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(d, 'chat-credentials.json'), 'utf8'))).includes(CLAUDE), false);
});

test('a chat that began before chats were kept keeps what it has been using: a lent key, else the machine’s own login, and a later key never moves it', () => {
  const w = world();
  w.credentials.stateOf('claude', true);
  w.leases.set('claude', KEY);
  const old = 'claude:44444444-4444-4444-8444-444444444444';
  assert.equal(w.credentials.ownByDefault(old), false, 'a key was lent when it began, and its process has been using it');
  w.credentials.check(old, 'claude');
  w.credentials.stateOf('claude', true);
  assert.equal(w.ownRuns.has(old), false);
  w.leases.set('claude', null);
  const quiet = 'claude:55555555-5555-4555-8555-555555555555';
  assert.equal(w.credentials.ownByDefault(quiet), true, 'nothing was lent: it has been on the machine’s own login');
  w.credentials.check(quiet, 'claude');
  w.leases.set('claude', KEY);
  assert.equal(w.ownRuns.has(quiet), true, 'a key lent later does not take it from its login');
  // a scheduled chat that is on the machine's login stays there
  const scheduled = 'claude:66666666-6666-4666-8666-666666666666';
  w.ownRuns.add(scheduled);
  w.credentials.check(scheduled, 'claude');
  assert.equal(w.ownRuns.has(scheduled), true);
  // a Host that keeps no own-run set still records where a chat is, and refuses nothing
  const bare = createChatCredentials({ leases: createCredentialLeases() });
  bare.stateOf('claude', true);
  assert.doesNotThrow(() => bare.check('claude:77777777-7777-4777-8777-777777777777', 'claude'));
  assert.doesNotThrow(() => bare.admit({ chatId: 'claude:88888888-8888-4888-8888-888888888888', harness: 'claude' }));
});

test('a choice is checked against the agent a chat is about to move to, and nothing is kept', () => {
  const w = world();
  w.leases.set('gemini', KEY);
  assert.doesNotThrow(() => w.credentials.checkChoice({ harness: 'acp:gemini' }));
  assert.doesNotThrow(() => w.credentials.checkChoice({ harness: 'acp:gemini', credential: { source: 'key' } }));
  assert.throws(
    () => w.credentials.checkChoice({ harness: 'acp:gemini', credential: { source: 'own' } }),
    refused('credential_unavailable'),
  );
  assert.throws(
    () => w.credentials.checkChoice({ harness: 'claude', credential: { source: 'own', login: 'work' } }),
    refused('not_supported'),
  );
  assert.doesNotThrow(() => w.credentials.checkChoice({ harness: 'codex', credential: { source: 'own' } }));
  assert.equal(w.credentials.sourceOf('anything'), null);
});
