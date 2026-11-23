// The own-first default never keeps a chat on a guess (#4667): not while the machine's sign-in state is unknown (a Host just restarted), not while nothing can run, and a record that stops being usable moves by the same order and shows what the chat actually uses. An expired login is not usable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatCredentials } from '../host/src/chatCredentials.mjs';
import { createOwnRuns } from '../host/src/ownCredentials.mjs';
import { credentialKeyOf, signInProbe } from '../host/src/harnessState.mjs';
import { createChatEffects } from '../host/src/chatEffects.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';

const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-ownfirst-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const dir = () => fs.mkdtempSync(path.join(base, `d${++n}-`));
const CHAT = 'claude:11111111-1111-4111-8111-111111111111';

function world(dataDir?: string) {
  const leases = createCredentialLeases();
  const ownRuns = createOwnRuns();
  const credentials = createChatCredentials({ leases, ownRuns, dataDir, doubtMs: 0 });
  return { leases, ownRuns, credentials };
}

test('after a restart the sign-in state is unknown: a chat is not kept on anything until a status says, and then it is the machine’s login, not the lent key', async () => {
  const dataDir = dir();
  const w = world(dataDir);
  w.leases.set('claude', KEY);
  // a start before any status: nothing is kept (the key would be a guess)
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), null);
  // the Host asks for a status once, however many chats start at once, and the machine turns out to be signed in
  let asked = 0;
  w.credentials.setProbe(async () => {
    asked++;
    w.credentials.stateOf('claude', true);
  });
  await Promise.all([w.credentials.ready('claude'), w.credentials.ready('claude')]);
  await w.credentials.ready('claude');
  assert.equal(asked, 1, 'a known state is not asked for again');
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), 'own');
  assert.equal(w.ownRuns.has(CHAT), true);
  // the next restart: the record is read back, not decided again
  const again = world(dataDir);
  again.leases.set('claude', KEY);
  assert.equal(again.credentials.sourceOf(CHAT), 'own');
  assert.doesNotThrow(() => again.credentials.check(CHAT, 'claude'), 'a kept record is not dropped while the state is unknown');
  assert.equal(again.credentials.sourceOf(CHAT), 'own');
});

test('a status that cannot be had leaves a chat unkept, and a probe that fails does not fail the message', async () => {
  const w = world();
  await w.credentials.ready('claude');
  w.credentials.setProbe(async () => {
    throw new Error('no status');
  });
  await w.credentials.ready('claude');
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), null);
});

test('with nothing usable nothing is kept, and a key lent later is what the chat then uses (a new chat follows the default order, not the one of a chat that began before it)', () => {
  const w = world();
  w.credentials.stateOf('claude', false);
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), null, 'the machine’s login is not recorded as a fallback when it cannot sign in');
  w.leases.set('claude', KEY);
  w.credentials.check(CHAT, 'claude');
  assert.equal(w.credentials.sourceOf(CHAT), 'key');
  // the machine signs in meanwhile, before the first message of another new chat: its own login wins over the lent key
  const other = 'claude:22222222-2222-4222-8222-222222222222';
  const x = world();
  x.credentials.stateOf('claude', false);
  x.leases.set('claude', KEY);
  x.credentials.admit({ chatId: other, harness: 'claude' });
  assert.equal(x.credentials.sourceOf(other), 'key', 'a key is usable, so it is kept');
  const y = world();
  y.credentials.stateOf('claude', false);
  y.credentials.admit({ chatId: other, harness: 'claude' });
  y.credentials.stateOf('claude', true);
  y.leases.set('claude', KEY);
  y.credentials.check(other, 'claude');
  assert.equal(y.credentials.sourceOf(other), 'own');
  y.credentials.forget(other);
  assert.equal(y.credentials.sourceOf(other), null);
});

test('a chat kept on the key whose key is taken back moves by the same order, and what is kept is what it runs on', () => {
  const w = world();
  w.credentials.stateOf('claude', false);
  w.leases.set('claude', KEY);
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), 'key');
  assert.equal(w.ownRuns.has(CHAT), false);
  // the key is taken back and the machine is signed in: the chat is on the machine's login, and its CLI is given nothing lent
  w.leases.clear();
  w.credentials.stateOf('claude', true);
  assert.doesNotThrow(() => w.credentials.check(CHAT, 'claude'));
  assert.equal(w.credentials.sourceOf(CHAT), 'own');
  assert.equal(w.ownRuns.has(CHAT), true);
  // nothing usable: the record goes, and a later message settles it on what can run then
  w.credentials.stateOf('claude', false);
  w.credentials.check(CHAT, 'claude');
  assert.equal(w.credentials.sourceOf(CHAT), null);
  assert.equal(w.ownRuns.has(CHAT), false);
  w.leases.set('claude', KEY);
  w.credentials.check(CHAT, 'claude');
  assert.equal(w.credentials.sourceOf(CHAT), 'key');
  // a chat that began on another agent is not kept on a source that was that agent's
  const moved = world();
  moved.credentials.stateOf('claude', true);
  moved.credentials.admit({ chatId: 'thread-1', harness: 'claude' });
  moved.credentials.check('thread-1', 'acp:gemini');
  assert.equal(moved.credentials.sourceOf('thread-1'), null);
});

test('an expired login is not usable and a limited one is: the lent key is used past the first, the login stays first while limited', () => {
  const w = world();
  let state = 'expired';
  w.credentials.bindLogins('claude', { list: () => [{ id: 'default', state }], pin: () => undefined });
  w.leases.set('claude', KEY);
  assert.deepEqual(w.credentials.stateOf('claude', true), { sources: { own: false, key: true, org: false }, using: 'key' });
  // a Host's list reads the CLI's own login once and can lag the status: signed in by the status, signed out in the list is still a login a chat can use
  state = 'signedOut';
  assert.deepEqual(w.credentials.stateOf('claude', true), { sources: { own: true, key: true, org: false }, using: 'own' });
  state = 'ok';
  assert.deepEqual(w.credentials.stateOf('claude', true), { sources: { own: true, key: true, org: false }, using: 'own' });
  // a machine whose listed logins have no default (an agent that lists none, or an added login only) follows the status
  w.credentials.bindLogins('claude', { list: () => [{ id: 'work', state: 'ok' }], pin: () => undefined });
  assert.equal(w.credentials.stateOf('claude', true).sources.own, true);
  assert.equal(w.credentials.stateOf('claude', false).sources.own, false);
});

test('through the chat methods: a start and a first message after a restart ask for the status before the chat is kept on anything', async () => {
  const w = world();
  w.leases.set('claude', KEY);
  const asked: string[] = [];
  w.credentials.setProbe(async () => {
    asked.push('status');
    w.credentials.stateOf('claude', true);
  });
  const effects = createChatEffects({
    runtime: { prepare: async () => undefined, send: async () => ({ turnId: 't1' }) },
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
  await effects['chat.start']({ chatId: CHAT, harness: 'claude', text: 'go', key: 'req-0000001' });
  assert.equal(w.credentials.sourceOf(CHAT), 'own', 'the machine is signed in, so not the lent key');
  const old = 'claude:33333333-3333-4333-8333-333333333333';
  const fresh = world();
  fresh.leases.set('claude', KEY);
  fresh.credentials.setProbe(async () => void fresh.credentials.stateOf('claude', true));
  const e2 = createChatEffects({
    runtime: { send: async () => ({ turnId: 't2' }) },
    handoffs: null,
    finish: () => undefined,
    record: () => undefined,
    endedTurns: new Set(),
    images: null,
    tools: null,
    check: () => undefined,
    faults: { clear: () => undefined },
    approvals: { resume: () => null },
    credentials: fresh.credentials,
  } as any);
  // a chat that began before chats were kept, whose first message after the restart is this one: it keeps what a lent key put it on
  await e2['chat.send']({ chatId: old, text: 'hi', key: 'req-0000002' });
  assert.equal(fresh.credentials.sourceOf(old), 'key');
  assert.deepEqual(asked, ['status']);
});

test('Codex after a restart: a start and a first message are kept on the machine’s login before the family looks at them, whatever is lent', async () => {
  const w = world();
  w.leases.set('codex', KEY);
  w.credentials.setProbe(async () => void w.credentials.stateOf('codex', true));
  const seen: (string | null)[] = [];
  const effects = createChatEffects({
    // what the Codex family's check reads when it runs for the start and for the message: the record the effects made first
    runtime: {
      prepare: async (p: any) => void seen.push(w.credentials.sourceOf(p.chatId)),
      send: async (p: any) => (seen.push(w.credentials.sourceOf(p.key)), { turnId: 't' }),
    },
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
  await effects['chat.start']({ chatId: 'thread-a', harness: 'codex', text: 'go', key: 'req-0000001' });
  assert.deepEqual(seen, ['own', 'own']);
  assert.equal(w.credentials.choiceOf('thread-a'), null, 'where it began is not a choice');
  // a chat from before chats were kept, first message after the restart: what the lent key put it on
  const old = world();
  old.leases.set('codex', KEY);
  old.credentials.setProbe(async () => void old.credentials.stateOf('codex', true));
  await old.credentials.ready('codex');
  old.credentials.check('thread-old', 'codex');
  assert.equal(old.credentials.sourceOf('thread-old'), 'key');
  // a thread that began on the key and whose key is taken back is refused: its app-server cannot move under it
  old.leases.clear();
  assert.throws(
    () => old.credentials.check('thread-old', 'codex'),
    (e: any) => e.code === 'credential_unavailable',
  );
});

test('the sign-in state is asked for after the agent’s own-login row was read, once however many chats ask', async () => {
  const w = world();
  const order: string[] = [];
  w.credentials.bindLogins('claude', {
    list: () => [{ id: 'default', state: 'signedOut' }],
    pin: () => undefined,
    refresh: async () => void order.push('read the login'),
  });
  w.credentials.setProbe(async () => {
    order.push('status');
    w.credentials.stateOf('claude', true);
  });
  await Promise.all([w.credentials.ready('claude'), w.credentials.ready('claude')]);
  assert.deepEqual(order, ['read the login', 'status']);
  // a read that fails does not stop the status
  const failing = world();
  failing.credentials.bindLogins('claude', {
    list: () => [],
    pin: () => undefined,
    refresh: async () => {
      throw new Error('no cli');
    },
  });
  failing.credentials.setProbe(async () => void failing.credentials.stateOf('claude', true));
  await failing.credentials.ready('claude');
  failing.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(failing.credentials.sourceOf(CHAT), 'own');
});

test('a signed-out answer with a key lent is asked once more before it counts, so a status that timed out does not put a chat on the key', async () => {
  const w = world();
  w.leases.set('claude', KEY);
  const answers = [false, true];
  w.credentials.setProbe(async () => void w.credentials.stateOf('claude', answers.shift() ?? true));
  await w.credentials.ready('claude');
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), 'own');
  assert.deepEqual(answers, []);
  // signed out twice: the key is what runs, and that is asked for no more than twice
  const out = world();
  out.leases.set('claude', KEY);
  let asked = 0;
  out.credentials.setProbe(async () => void (asked++, out.credentials.stateOf('claude', false)));
  await out.credentials.ready('claude');
  out.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(out.credentials.sourceOf(CHAT), 'key');
  assert.equal(asked, 2);
  // nothing lent: nothing to move onto, so one answer is enough
  const bare = world();
  let once = 0;
  bare.credentials.setProbe(async () => void (once++, bare.credentials.stateOf('claude', false)));
  await bare.credentials.ready('claude');
  assert.equal(once, 1);
});

test('a signed-out reading taken early (before the CLI answered) is not trusted at a chat’s start: it is read again, and two in a row are trusted for a minute', async () => {
  const w = world();
  w.leases.set('claude', KEY);
  // the status a Host answered right after it started read signed out, and a start came after it
  w.credentials.stateOf('claude', false);
  let asked = 0;
  const reads = [true];
  w.credentials.setProbe(async () => void (asked++, w.credentials.stateOf('claude', reads.shift() ?? false)));
  await w.credentials.ready('claude', CHAT);
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), 'own', 'the early reading did not decide');
  assert.equal(asked, 1);
  // a chat that is already kept is not asked about
  await w.credentials.ready('claude', CHAT);
  assert.equal(asked, 1);
  // a machine that really is signed out: two readings in a row, then not again for a minute
  const out = world();
  out.leases.set('claude', KEY);
  out.credentials.stateOf('claude', false);
  let n = 0;
  out.credentials.setProbe(async () => void (n++, out.credentials.stateOf('claude', false)));
  await out.credentials.ready('claude', CHAT);
  assert.equal(n, 2);
  out.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(out.credentials.sourceOf(CHAT), 'key');
  await out.credentials.ready('claude', 'claude:44444444-4444-4444-8444-444444444444');
  assert.equal(n, 2, 'confirmed signed out: the next new chat is not asked about');
});

test('the status probe tells each agent’s sign-in to the bookkeeping by the name it keeps them under; a start with no chat id named is asked about too', async () => {
  const seen: [string, boolean][] = [];
  const probe = signInProbe({ stateOf: (h: string, signedIn: boolean) => void seen.push([h, signedIn]) }, async () => [
    { id: 'claude', signedIn: true },
    { id: 'codex', signedIn: false },
    { id: 'gemini', signedIn: true },
  ]);
  await probe();
  assert.deepEqual(seen, [
    ['claude', true],
    ['codex', false],
    ['acp:gemini', true],
  ]);
  assert.equal(credentialKeyOf('claude'), 'claude');
  const w = world();
  w.leases.set('claude', KEY);
  w.credentials.stateOf('claude', false);
  let asked = 0;
  w.credentials.setProbe(async () => void (asked++, w.credentials.stateOf('claude', true)));
  await w.credentials.ready('claude');
  assert.equal(asked, 1, 'a signed-out reading with something lent is read again whoever asks');
});

test('a chat already kept is not asked about, even while the machine reads signed out with a key lent', async () => {
  const w = world();
  w.leases.set('claude', KEY);
  w.credentials.stateOf('claude', false);
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), 'key');
  let asked = 0;
  w.credentials.setProbe(async () => void asked++);
  await w.credentials.ready('claude', CHAT);
  assert.equal(asked, 0);
});

test('an organization lease alone (no key) is something lent too: a signed-out reading is read again before a chat is kept on it', async () => {
  const w = world();
  w.leases.setOrg(
    {
      harness: 'claude',
      identity: '0'.repeat(32),
      token: 'tok-0000000000000000',
      gateways: { anthropic: 'https://gw.example/anthropic' },
      expiresAt: Date.now() + 3_600_000,
    },
    Date.now(),
  );
  w.credentials.stateOf('claude', false);
  let asked = 0;
  w.credentials.setProbe(async () => void (asked++, w.credentials.stateOf('claude', true)));
  await w.credentials.ready('claude', CHAT);
  assert.equal(asked, 1);
  w.credentials.admit({ chatId: CHAT, harness: 'claude' });
  assert.equal(w.credentials.sourceOf(CHAT), 'own');
});
