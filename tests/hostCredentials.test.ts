// The user's model key lent to a Host (#3361 Tier 1): the app keeps it encrypted (electron/host/apiKeys.cjs) and sends it before each message on the control channel (remoteCredentials.cjs); the Host holds it in memory (host/src/credentialLease.mjs) and gives it only to the Claude Code CLI's environment (claudeFamily.mjs). A: lent before the message, taken back; W: an older Host; B: bad keys and stores; I: only the harness that reads it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
import { isKey, keyHint, KEYED, PROVIDERS } from '../shared/host/credentials.mjs';
import { agentsOf } from '../shared/host/agentReadiness.mjs';

const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');
const { createApiKeys } = require('../electron/host/apiKeys.cjs');
const { withCredentials, harnessOfChat, keyedHarnesses, NO_KEYS } = require('../electron/host/remoteCredentials.cjs');
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';

/** A dummy key: never a real one. */
const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-cred-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
/** safeStorage stand-in: the stored bytes are the key reversed, so a plain key never appears in the file. */
const safe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from([...s].reverse().join('')),
  decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
});

test('the shared table: Claude Code reads ANTHROPIC_API_KEY from the anthropic key; a key is printable, 20 to 512 characters', () => {
  assert.deepEqual(KEYED.claude, { env: 'ANTHROPIC_API_KEY', provider: 'anthropic', via: 'env' });
  assert.deepEqual(KEYED.codex, { env: 'OPENAI_API_KEY', provider: 'openai', via: 'login' });
  assert.deepEqual(PROVIDERS, { anthropic: 'claude', openai: 'codex', google: 'gemini', xai: 'grok', deepseek: 'dsh' });
  assert.equal(isKey(KEY), true);
  for (const bad of ['short', `${KEY} x`, `${KEY}\n`, 'x'.repeat(513), 42, null]) assert.equal(isKey(bad), false);
  assert.equal(keyHint(KEY), '…abcd');
});

test('the Host holds a lent key in memory for its harness only, and gives it up when taken back or cleared', () => {
  const leases = createCredentialLeases();
  assert.deepEqual([leases.has('claude'), leases.envFor('claude')], [false, {}]);
  assert.deepEqual(leases.set('claude', KEY), { held: true });
  assert.deepEqual(leases.envFor('claude'), { ANTHROPIC_API_KEY: KEY });
  assert.deepEqual(leases.envFor('codex'), {}, 'another harness gets nothing');
  assert.equal(leases.loginKey('claude'), null, 'Claude Code reads its key from the env, never a login');
  leases.set('codex', KEY);
  assert.deepEqual(
    [leases.envFor('codex'), leases.loginKey('codex'), leases.loginKey('acp:x')],
    [{}, KEY, null],
    'Codex is told its key, never given it in the env',
  );
  leases.set('codex', null);
  assert.equal(leases.loginKey('codex'), null);
  leases.set('acp:other', KEY);
  assert.deepEqual(leases.envFor('acp:other'), {}, 'a harness with no env name gets nothing even if one were held');
  assert.deepEqual(leases.set('claude', null), { held: false });
  assert.deepEqual(leases.envFor('claude'), {});
  leases.set('claude', KEY);
  leases.clear();
  assert.equal(leases.has('claude'), false);
});

test('a change of key is told once per change: lent, lent again (nothing), taken back, cleared; a listener that left hears nothing', () => {
  const leases = createCredentialLeases();
  const heard: string[] = [];
  const off = leases.onChange((h) => heard.push(h));
  leases.set('claude', KEY);
  leases.set('claude', KEY);
  leases.set('claude', `${KEY}2`);
  leases.set('claude', null);
  leases.set('claude', null);
  leases.set('claude', KEY);
  leases.clear();
  leases.clear();
  assert.deepEqual(heard, ['claude', 'claude', 'claude', 'claude', 'claude']);
  off();
  leases.set('claude', KEY);
  assert.equal(heard.length, 5);
});

test('the wire: host.credentials parses a harness that takes a key and a key or null; a refusal never repeats the key', async (t) => {
  assert.deepEqual(S.parseParams('host.modelKey', { harness: 'claude', key: KEY, extra: 1 }), { harness: 'claude', key: KEY });
  assert.deepEqual(S.parseParams('host.modelKey', { harness: 'claude', key: null }), { harness: 'claude', key: null });
  assert.throws(() => S.parseParams('host.modelKey', { harness: 'acp:gemini', key: KEY }), /That agent takes no key\./);
  for (const key of [`${KEY} oops`, 'short', undefined]) {
    assert.throws(
      () => S.parseParams('host.modelKey', { harness: 'claude', key }),
      (e: any) => e.message === 'That is not an API key.' && !String(e.message).includes(String(key)),
    );
  }
  assert.deepEqual(S.REQUIRES['host.modelKey'], ['credentials']);
  const dir = fs.mkdtempSync(path.join(base, 'p-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const leases = createCredentialLeases();
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), leases }).connection(() => undefined);
  await conn.call('host.hello', S.helloParams());
  assert.deepEqual(await conn.call('host.modelKey', { harness: 'claude', key: KEY }), { held: true });
  assert.equal(leases.has('claude'), true);
  // nothing of the request is kept on disk: no ledger, no epoch file holds it
  const onDisk = fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  assert.doesNotMatch(onDisk, /sk-ant-dummy/);
  const old = createProtocol({ runtime, epochs, guard, status: () => ({}), leases }).connection(() => undefined);
  await old.call('host.hello', { ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'credentials') });
  await assert.rejects(old.call('host.modelKey', { harness: 'claude', key: null }), (e: any) => e.code === 'feature_missing');
  const none = createProtocol({ runtime, epochs, guard, status: () => ({}) }).connection(() => undefined);
  await none.call('host.hello', S.helloParams());
  await assert.rejects(none.call('host.modelKey', { harness: 'claude', key: null }), (e: any) => e.code === 'unsupported');
});

test('the app keeps a key encrypted in a 0600 file, shows its last four only, and forgets it on Remove', () => {
  const file = path.join(fs.mkdtempSync(path.join(base, 'k-')), 'host-api-keys.json');
  const keys = createApiKeys({ file, safeStorage: safe() });
  let changes = 0;
  const off = keys.onChange(() => changes++);
  assert.deepEqual([keys.list(), keys.hasFor('claude'), keys.forHarness('claude')], [{}, false, null]);
  assert.equal(keys.set('anthropic', `  ${KEY}\n`), '…abcd', 'pasted with spaces around');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sk-ant-dummy/, 'never in the clear on disk');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(keys.list(), { anthropic: '…abcd' });
  assert.deepEqual(
    [keys.hasFor('claude'), keys.hasFor('codex'), keys.forHarness('claude'), keys.forHarness('codex')],
    [true, false, KEY, null],
  );
  assert.equal(keys.get('openai'), null);
  assert.equal(keys.get('mistral'), null);
  assert.equal(keys.remove('anthropic'), true);
  assert.equal(keys.remove('anthropic'), false);
  assert.equal(keys.remove(7), false);
  assert.deepEqual([keys.list(), changes], [{}, 2]);
  off();
  keys.set('anthropic', KEY);
  assert.equal(changes, 2, 'a listener that left hears nothing');
});

test('B: a key that is not one, a provider that takes none, no encryption, a damaged file and another Mac’s file', () => {
  const dir = fs.mkdtempSync(path.join(base, 'b-'));
  const file = path.join(dir, 'k.json');
  const keys = createApiKeys({ file, safeStorage: safe() });
  assert.throws(
    () => keys.set('anthropic', 'nope'),
    (e: any) => e.code === 'invalid' && e.message === 'That is not an API key.',
  );
  assert.throws(
    () => keys.set('anthropic', 42),
    (e: any) => e.code === 'invalid',
  );
  assert.throws(
    () => keys.set('mistral', KEY),
    (e: any) => e.code === 'invalid' && !e.message.includes(KEY),
  );
  const locked = createApiKeys({ file, safeStorage: safe(false) });
  assert.throws(
    () => locked.set('anthropic', KEY),
    (e: any) => e.code === 'unavailable',
  );
  assert.equal(fs.existsSync(file), false, 'nothing written');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(keys.list(), {});
  fs.writeFileSync(file, JSON.stringify({ keys: { anthropic: 7 } }));
  assert.equal(keys.forHarness('claude'), null);
  // encrypted on another Mac: it cannot be decrypted here
  const other = createApiKeys({
    file,
    safeStorage: {
      ...safe(),
      decryptString: () => {
        throw new Error('bad key');
      },
    },
  });
  fs.writeFileSync(file, JSON.stringify({ keys: { anthropic: 'AAAA' } }));
  assert.equal(other.forHarness('claude'), null);
  // decrypts to something that is not a key
  fs.writeFileSync(file, JSON.stringify({ keys: { anthropic: Buffer.from('x').toString('base64') } }));
  assert.equal(keys.forHarness('claude'), null);
});

test('A: a message lends its agent’s key on the control channel first, never in the message; no key lends none; an older Host runs it on its own sign-in', async () => {
  const calls: any[] = [];
  let key: string | null = KEY;
  let refuse: any = null;
  const host = {
    modelKey: async (p: any) => {
      calls.push(['modelKey', p]);
      if (refuse) throw refuse;
      return { held: p.key !== null };
    },
    start: async (chatId: string, item: any) => (calls.push(['start', chatId, item]), 'started'),
    send: async (chatId: string, item: any) => (calls.push(['send', chatId, item]), 'sent'),
    stop: () => 'kept',
  };
  const wrapped = withCredentials(host, { forHarness: () => key });
  assert.equal(await wrapped.start('claude:1', { harness: 'claude', text: 'hi' }), 'started');
  assert.equal(await wrapped.send('claude:1', { text: 'again' }), 'sent');
  assert.deepEqual(calls, [
    ['modelKey', { harness: 'claude', key: KEY }],
    ['start', 'claude:1', { harness: 'claude', text: 'hi' }],
    ['modelKey', { harness: 'claude', key: KEY }],
    ['send', 'claude:1', { text: 'again' }],
  ]);
  assert.equal(wrapped.stop(), 'kept', 'everything else is the Host’s own');
  calls.length = 0;
  // a Codex thread lends Codex's key, a basic agent that takes no key none; a key removed is taken back
  await wrapped.send('thread-1', { text: 'x' });
  await wrapped.start('acp:opencode:1', { harness: 'acp:opencode' });
  key = null;
  await wrapped.send('claude:1', { text: 'y' });
  assert.deepEqual(
    calls.filter((c) => c[0] === 'modelKey'),
    [
      ['modelKey', { harness: 'codex', key: KEY }],
      ['modelKey', { harness: 'claude', key: null }],
    ],
  );
  // an older Host: the message still goes; any other failure stops it (it would run without the key the user asked for)
  calls.length = 0;
  refuse = Object.assign(new Error('old'), { code: 'feature_missing' });
  assert.equal(await wrapped.send('claude:1', { text: 'z' }), 'sent');
  // a Host that takes keys, but none for Codex yet
  refuse = Object.assign(new Error('That agent takes no key.'), { code: 'invalid' });
  assert.equal(await wrapped.send('thread-1', { text: 'z' }), 'sent');
  refuse = Object.assign(new Error('The machine did not answer.'), { code: 'unreachable' });
  await assert.rejects(wrapped.send('claude:1', { text: 'w' }), /did not answer/);
  assert.equal(calls.filter((c) => c[0] === 'send').length, 2);
  assert.deepEqual([harnessOfChat('claude:x'), harnessOfChat('acp:a:b'), harnessOfChat('abc')], ['claude', 'acp', 'codex']);
});

test('I: an agent the user gave a key for reads ready on a Host that takes keys, and only there; what the machine said stays as it said', () => {
  const harnesses = [
    { id: 'claude', detected: true, signedIn: false, takesKey: true },
    { id: 'codex', detected: true, signedIn: false },
  ];
  const keyed = keyedHarnesses(harnesses, { hasFor: (h: string) => h === 'claude' });
  assert.deepEqual(keyed[0], { ...harnesses[0], keyed: true });
  assert.equal(keyed[1], harnesses[1]);
  assert.deepEqual(
    agentsOf(keyed, 'mini').map((a) => a.state),
    ['ready', 'signin'],
  );
  // an older Host never says it takes a key: the user's key does not make it ready
  const old = keyedHarnesses([{ id: 'claude', detected: true, signedIn: false }], { hasFor: () => true });
  assert.equal(agentsOf(old, 'mini')[0].state, 'signin');
  // not installed stays missing, key or not
  assert.equal(
    agentsOf(keyedHarnesses([{ id: 'claude', detected: false, signedIn: false, takesKey: true }], { hasFor: () => true }), 'mini')[0].state,
    'missing',
  );
});

test('the remote Host lends a key through the wire, and an older Host is refused before anything is written; no store lends none', async (t) => {
  assert.deepEqual([NO_KEYS.forHarness('claude'), NO_KEYS.hasFor('claude')], [null, false]);
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const writes = w.net.last.written.length;
  await assert.rejects(host.modelKey({ harness: 'claude', key: KEY }), (e: any) => e.code === 'feature_missing');
  assert.equal(w.net.last.written.length, writes);
  const n = hostWorld(t);
  n.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: [...S.FEATURES] });
  n.net.handlers['host.modelKey'] = (p: any) => ({ held: p.key !== null });
  const fresh = await onlineRemote(n);
  assert.deepEqual(await fresh.host.modelKey({ harness: 'claude', key: KEY }), { held: true });
});

test('B: a key file with no keys in it holds none', () => {
  const file = path.join(fs.mkdtempSync(path.join(base, 'e-')), 'k.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1 }));
  assert.deepEqual(createApiKeys({ file, safeStorage: safe() }).list(), {});
});
