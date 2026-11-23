// The organization access wiring in the Host IPC (electron/app/ipc/host.cjs, #3361 Tier 2): the machines service lends the organization's lease and reads its coverage, a chat starts keyed when the organization covers its agent, sign out everywhere names the identity before it is forgotten, and a change redraws the machines.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { appIdPrefix } from '../shared/host/chatIds.mjs';

const require = createRequire(import.meta.url);
const state = {
  opts: null as any,
  covers: false,
  identity: 'a'.repeat(32) as string | null,
  signOut: async () => undefined as unknown,
  order: [] as string[],
  disposed: 0,
};
const fake = {
  lend: async (_h: unknown, harness: string) => (state.order.push(`lend ${harness}`), true),
  covers: () => state.covers,
  signOut: () => (state.order.push('org signOut'), state.signOut()),
  identity: () => (state.order.push('identity'), state.identity),
  dispose: () => void state.disposed++,
};
mock.module('../electron/app/ipc/hostOrgAccess.cjs', {
  namedExports: { registerOrgAccess: (o: any) => ((state.opts = o), fake) },
});
// Electron's own encryption, the one the organization service gets when none is injected: read only on its first use
const electronSafeStorage = { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: String };
mock.module('electron', { exports: { safeStorage: electronSafeStorage } });
const { register } = require('../electron/app/ipc/host.cjs');

function setup(t: any, harness: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-org-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const sent: unknown[][] = [];
  const quits: (() => void)[] = [];
  let given: any = null;
  const begun: unknown[] = [];
  let signedOutWith: unknown = 'unset';
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => dir, once: (_e: string, fn: () => void) => quits.push(fn) },
      shellEnv: { childEnv: () => ({}) },
      shell: { openExternal: (url: string) => void state.order.push(`open ${url}`) },
      broadcastAll: (...a: unknown[]) => void sent.push(a),
      live: {},
    },
    {
      create: (o: any) => (
        (given = o),
        {
          list: () => ({ machines: ['m'], resolved: true }),
          row: () => ({ id: 'm', name: 'box', harnesses: [{ id: 'claude', detected: true, signedIn: false, ...harness }] }),
          signOutEverywhere: async (identity: unknown) => ((signedOutWith = identity), []),
          dispose: () => undefined,
        }
      ),
      createFolders: () => ({ bind: () => undefined }),
      makeRemoteSend: () => () => ({
        begin: (...a: unknown[]) => begun.push(a),
        dispose: () => undefined,
        orgSignedIn: async () => undefined,
      }),
      allowed: () => true,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (v: string) => Buffer.from(v),
        decryptString: (b: Buffer) => b.toString(),
      },
    },
  );
  const call = (c: string, ...a: unknown[]) => handlers.get(c)({}, ...a);
  return { call, sent, quits, begun, given: () => given, signedOutWith: () => signedOutWith, handlers };
}
const startArgs = { chatId: `${appIdPrefix('claude')}x`, hostId: 'm', folder: '/w', harness: 'claude' };

test('the machines service is given the organization to lend from and to read coverage from', async (t) => {
  const w = setup(t, { takesOrg: true });
  await w.call('host:apiKeys');
  await w.call('host:machines');
  state.covers = true;
  state.order.length = 0;
  assert.equal(await w.given().orgAccess.lend({}, 'claude'), true);
  assert.equal(w.given().orgAccess.covers('claude'), true);
  assert.deepEqual(state.order, ['lend claude']);
});

test('a chat starts when the organization covers an agent that takes a lease, and refuses otherwise', async (t) => {
  state.covers = true;
  const w = setup(t, { takesOrg: true });
  assert.deepEqual(await w.call('host:startChat', startArgs), { value: { chatId: startArgs.chatId } });
  state.covers = false;
  const refused = await w.call('host:startChat', startArgs);
  assert.equal(refused.error.code, 'harness_not_configured');
  state.covers = true;
  const old = setup(t, {});
  assert.equal((await old.call('host:startChat', startArgs)).error.code, 'harness_not_configured', 'an older Host takes no lease');
});

test('sign out everywhere names the identity before the org sign-out, and passes it to the machines', async (t) => {
  state.identity = 'b'.repeat(32);
  state.order.length = 0;
  const w = setup(t, {});
  await w.call('host:signOutEverywhere');
  assert.deepEqual(state.order, ['identity', 'org signOut']);
  assert.equal(w.signedOutWith(), 'b'.repeat(32));
});

test('a sign-out of the organization that fails does not stop the machines from signing out', async (t) => {
  state.signOut = async () => Promise.reject(new Error('IdP down'));
  const w = setup(t, {});
  const out = await w.call('host:signOutEverywhere');
  state.signOut = async () => undefined;
  assert.deepEqual(out, { value: [] });
  assert.equal(w.signedOutWith(), state.identity);
});

test('a change in the organization access redraws the machines once they exist; quitting disposes it', async (t) => {
  const w = setup(t, {});
  state.opts.broadcast('host:orgAccess', { configured: false });
  assert.deepEqual(w.sent, [['host:orgAccess', { configured: false }]], 'no machines yet');
  await w.call('host:machines');
  w.sent.length = 0;
  state.opts.broadcast('host:orgAccess', { configured: true });
  assert.deepEqual(w.sent, [
    ['host:orgAccess', { configured: true }],
    ['host:machines', { machines: ['m'], resolved: true }],
  ]);
  assert.equal(state.opts.userData().includes('host-org-wiring-'), true);
  assert.equal(typeof state.opts.safeStorage().isEncryptionAvailable, 'function');
  assert.equal(typeof state.opts.remote().orgSignedIn, 'function');
  const before = state.disposed;
  for (const quit of w.quits) quit();
  assert.equal(state.disposed, before + 1);
});

test('a key alone also keys a chat that takes one', async (t) => {
  state.covers = false;
  const w = setup(t, { takesKey: true });
  assert.equal((await w.call('host:startChat', startArgs)).error.code, 'harness_not_configured');
  await w.call('host:setApiKey', 'anthropic', 'sk-ant-dummy-0000-test-key-abcd');
  assert.deepEqual(await w.call('host:startChat', startArgs), { value: { chatId: startArgs.chatId } });
});

test('the IdP’s sign-in page opens in the system browser', async (t) => {
  setup(t, {});
  state.order.length = 0;
  await state.opts.openExternal('https://idp.example.test/auth');
  assert.deepEqual(state.order, ['open https://idp.example.test/auth']);
});

test('without an injected encryption the organization service gets Electron’s, read when it is first made', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-org-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  register(
    { handle: () => undefined },
    {
      app: { getPath: () => dir, once: () => undefined },
      shellEnv: { childEnv: () => ({}) },
      shell: { openExternal: () => undefined },
      broadcastAll: () => undefined,
      live: {},
    },
    { allowed: () => true },
  );
  assert.equal(typeof state.opts.safeStorage, 'function', 'a lookup, not Electron loaded at registration');
  assert.equal(state.opts.safeStorage(), electronSafeStorage);
});
