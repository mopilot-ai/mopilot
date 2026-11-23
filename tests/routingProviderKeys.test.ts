// electron/routing/providerKeys.cjs: one encrypted key per provider slot in a 0600 file shared with Host key lending; a server the user names keeps its key for its origin only; a file that can't be read is kept and changes are refused (W3); every store over the file hears every write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProviderKeys, KEYS_FILE } = require('../electron/routing/providerKeys.cjs');
const { createApiKeys } = require('../electron/host/apiKeys.cjs');

const KEY = 'sk-or-dummy-0000-test-key-wxyz';
const safe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
  decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
});
const fileIn = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', KEYS_FILE);
};

test('a key is kept encrypted in a 0600 file, read back, shown by its last four and forgotten', (t) => {
  const file = fileIn(t);
  const keys = createProviderKeys({ file, safeStorage: safe() });
  assert.deepEqual([keys.has('openrouter'), keys.get('openrouter'), keys.readable()], [false, null, true]);
  assert.equal(keys.set('openrouter', `  ${KEY}\n`), '…wxyz');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sk-or-dummy/, 'never in the clear on disk');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual([keys.has('openrouter'), keys.get('openrouter')], [true, KEY]);
  assert.equal(keys.remove('openrouter'), true);
  assert.equal(keys.remove('openrouter'), false);
  assert.deepEqual([keys.has('openrouter'), keys.get('openrouter')], [false, null]);
});

test('a server the user names keeps a short key for its origin only; other slots are refused without repeating the key', (t) => {
  const keys = createProviderKeys({ file: fileIn(t), safeStorage: safe() });
  assert.equal(keys.set('custom:http://localhost:8000', 'token-abc1'), '…abc1', 'vLLM’s --api-key may be short');
  assert.equal(keys.get('custom:http://localhost:8000'), 'token-abc1');
  assert.equal(keys.has('custom:http://localhost:11434'), false, 'another server has none');
  assert.throws(
    () => keys.set('openrouter', 'short'),
    (e: any) => e.code === 'invalid' && e.message === 'That is not an API key.',
  );
  assert.throws(
    () => keys.set('custom:http://localhost:8000', 'has space'),
    (e: any) => e.code === 'invalid',
  );
  for (const slot of ['mistral', 'custom', 'custom:http://evil.example', 'custom:http://localhost:8000/v1', 7, null])
    assert.throws(
      () => keys.set(slot, KEY),
      (e: any) => e.code === 'invalid' && e.message === 'That provider takes no key here.' && !e.message.includes(KEY),
    );
  assert.deepEqual([keys.has('mistral'), keys.get(7)], [false, null]);
  assert.deepEqual(keys.removeAll([7, 'mistral']), []);
});

test('no encryption keeps nothing; a key from another Mac or one that is not a key reads as none', (t) => {
  const file = fileIn(t);
  const locked = createProviderKeys({ file, safeStorage: safe(false) });
  assert.throws(
    () => locked.set('openrouter', KEY),
    (e: any) => e.code === 'unavailable',
  );
  assert.equal(fs.existsSync(file), false, 'nothing written');
  const keys = createProviderKeys({ file, safeStorage: safe() });
  keys.set('openrouter', KEY);
  const other = createProviderKeys({
    file,
    safeStorage: {
      ...safe(),
      decryptString: () => {
        throw new Error('bad key');
      },
    },
  });
  assert.deepEqual([other.has('openrouter'), other.get('openrouter')], [true, null]);
  fs.writeFileSync(file, JSON.stringify({ keys: { openrouter: Buffer.from('x').toString('base64'), deepseek: 7 } }));
  assert.deepEqual([keys.get('openrouter'), keys.get('deepseek'), keys.has('deepseek')], [null, null, false]);
});

test('W3: a damaged key file reads as none and reports itself; a new key keeps it aside first; one that can’t be read at all refuses every change', (t) => {
  const file = fileIn(t);
  const keys = createProviderKeys({ file, safeStorage: safe() });
  keys.set('openrouter', KEY);
  const heard: string[][] = [];
  keys.onChange((slots: string[]) => heard.push(slots));
  for (const bad of ['{not json', '[1,2]', 'null']) {
    fs.writeFileSync(file, bad);
    assert.deepEqual([keys.readable(), keys.has('openrouter'), keys.get('openrouter')], [false, false, null], bad);
    assert.equal(keys.remove('openrouter'), false, 'a damaged file holds no key to forget');
    assert.deepEqual(keys.removeAll(['openrouter', 'deepseek']), []);
    assert.equal(fs.readFileSync(file, 'utf8'), bad, 'not written over by a remove');
  }
  assert.deepEqual(heard, [], 'no change was announced');
  // a new key starts a fresh file once the damaged one is kept aside; an earlier copy is the one kept
  fs.writeFileSync(`${file}.unreadable`, '{first damage');
  assert.equal(keys.set('deepseek', KEY), '…wxyz');
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{first damage');
  assert.deepEqual([keys.readable(), keys.get('deepseek'), keys.has('openrouter')], [true, KEY, false]);
  for (const f of fs.readdirSync(path.dirname(file)))
    if (f.startsWith(`${KEYS_FILE}.unreadable`)) fs.rmSync(path.join(path.dirname(file), f));
  fs.writeFileSync(file, '{not json');
  keys.set('deepseek', KEY);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{not json', 'what it held is kept');
  assert.deepEqual(heard, [['deepseek'], ['deepseek']]);
  heard.length = 0;
  // damaged again later: that damage is kept too, beside the first, and no copy is written over
  fs.writeFileSync(file, '{second damage');
  keys.set('deepseek', KEY);
  const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${KEYS_FILE}.unreadable`));
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map((f) => fs.readFileSync(path.join(path.dirname(file), f), 'utf8')).sort(), ['{not json', '{second damage']);
  for (const f of fs.readdirSync(path.dirname(file)))
    if (f.startsWith(`${KEYS_FILE}.unreadable`)) fs.rmSync(path.join(path.dirname(file), f));
  // `keys` that are not a record are damage too, kept before a new key
  fs.writeFileSync(file, JSON.stringify({ keys: ['enc'] }));
  assert.deepEqual([keys.readable(), keys.removeAll(['deepseek'])], [false, []]);
  // no copy can be made (the folder is read-only): the damaged file is not written over
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    assert.throws(
      () => keys.set('deepseek', KEY),
      (e: any) => e.code === 'unreadable' && !e.message.includes(KEY),
    );
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ keys: ['enc'] }));
  // a key this Mac can't encrypt makes no copy and changes nothing
  assert.throws(
    () => createProviderKeys({ file, safeStorage: safe(false) }).set('deepseek', KEY),
    (e: any) => e.code === 'unavailable',
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${KEYS_FILE}.unreadable`)),
    [],
  );
  keys.set('deepseek', KEY);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), JSON.stringify({ keys: ['enc'] }), 'its bytes are kept aside');
  assert.equal(keys.get('deepseek'), KEY);
  for (const f of fs.readdirSync(path.dirname(file)))
    if (f.startsWith(`${KEYS_FILE}.unreadable`)) fs.rmSync(path.join(path.dirname(file), f));
  // a file that can't be read at all may hold keys: every change is refused and it is left as it is
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(keys.readable(), false);
  assert.throws(
    () => keys.set('deepseek', KEY),
    (e: any) => e.code === 'unreadable',
  );
  assert.throws(
    () => keys.remove('deepseek'),
    (e: any) => e.code === 'unreadable',
  );
  assert.equal(fs.statSync(file).isDirectory(), true);
  fs.rmSync(file, { recursive: true });
  // a file with no keys record holds none and is readable
  fs.writeFileSync(file, JSON.stringify({ version: 1 }));
  assert.deepEqual([keys.readable(), keys.has('openrouter')], [true, false]);
  assert.deepEqual(heard, [['deepseek'], ['deepseek']], 'each later damage’s recovery');
  // a newer version's fields beside the keys are written back as they were
  fs.writeFileSync(file, JSON.stringify({ v: 2, meta: { a: 1 }, keys: {} }));
  keys.set('openrouter', KEY);
  keys.remove('openrouter');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2, meta: { a: 1 }, keys: {} });
});

test('W1: two stores over one file (Host lending and routed chats) keep both writes and each hears the other’s', (t) => {
  const file = fileIn(t);
  const routing = createProviderKeys({ file, safeStorage: safe() });
  const host = createApiKeys({ file, safeStorage: safe() });
  const heard: string[] = [];
  const offRouting = routing.onChange(() => heard.push('routing'));
  host.onChange(() => heard.push('host'));
  routing.set('openrouter', KEY);
  host.set('anthropic', 'sk-ant-dummy-0000-test-key-abcd');
  assert.deepEqual([routing.get('openrouter'), routing.get('anthropic')], [KEY, 'sk-ant-dummy-0000-test-key-abcd'], 'one key entered once');
  assert.deepEqual(host.list(), { anthropic: '…abcd' }, 'the Host lists only the keys it lends');
  assert.deepEqual(
    [host.hasFor('nobody'), host.forHarness('nobody'), host.get('openrouter')],
    [false, null, null],
    'no harness takes a routed-only key',
  );
  // the Host hears only of keys it may lend
  assert.deepEqual(heard, ['routing', 'routing', 'host']);
  // the Host's sign-out forgets only what a Host is lent, in one write
  assert.deepEqual(host.removeAll(), ['anthropic']);
  assert.equal(routing.get('openrouter'), KEY);
  assert.deepEqual(heard.slice(3), ['routing', 'host']);
  offRouting();
  assert.equal(host.remove('openrouter'), false, 'a key no Host is lent is not the Host’s to remove');
  assert.throws(
    () => host.set('openrouter', KEY),
    (e: any) => e.code === 'invalid',
  );
  routing.remove('openrouter');
  routing.set('openai', 'sk-proj-dummy-0000-test-key-efgh');
  assert.deepEqual(heard.slice(5), ['host'], 'a listener that left hears nothing; the Host hears a routed write of a key it lends');
  // a key file that can't be read lends nothing: the Host's sign-out forgets none and leaves it as it is
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(host.removeAll(), []);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});
