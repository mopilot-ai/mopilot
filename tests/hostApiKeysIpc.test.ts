// host:apiKeys, host:setApiKey, host:removeApiKey (electron/app/ipc/host.cjs): the window lists the providers with a key as their last four characters, keeps and forgets one, each change sends the machine list again (an agent's readiness depends on it), and the key reaches the machines service only to be lent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
  decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
};

test('a key is kept, listed by its last four, forgotten, and each change re-sends the machine list; the service reads it to lend', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-keys-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const sent: unknown[][] = [];
  let given: any = null;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: (...a: unknown[]) => void sent.push(a) },
    {
      create: (o: any) => ((given = o.apiKeys), { list: () => ({ machines: ['m'], resolved: true }) }),
      createFolders: () => ({}),
      allowed: () => true,
      safeStorage,
    },
  );
  const call = (c: string, ...a: unknown[]) => handlers.get(c)({}, ...a);
  assert.deepEqual(await call('host:apiKeys'), { value: {} });
  assert.deepEqual(await call('host:setApiKey', 'anthropic', KEY), { value: '…abcd' });
  assert.deepEqual(await call('host:apiKeys'), { value: { anthropic: '…abcd' } });
  assert.deepEqual(sent.at(-1), ['host:machines', { machines: ['m'], resolved: true }]);
  assert.deepEqual([given.hasFor('claude'), given.forHarness('claude')], [true, KEY]);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'host-api-keys.json'), 'utf8'), /sk-ant-dummy/);
  const bad = await call('host:setApiKey', 'anthropic', 'nope');
  assert.deepEqual(bad, { error: { message: 'That is not an API key.', code: 'invalid' } });
  assert.deepEqual(await call('host:removeApiKey', 'anthropic'), { value: true });
  assert.equal(sent.length, 2);
  assert.deepEqual(await call('host:apiKeys'), { value: {} });
  assert.equal(given.hasFor('claude'), false);
});

test('without a safeStorage given, Electron’s is used: a Mac with no key file lists none', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-keys-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => ({ list: () => ({ machines: [], resolved: true }) }), createFolders: () => ({}), allowed: () => true },
  );
  assert.deepEqual(await handlers.get('host:apiKeys')({}), { value: {} });
});
