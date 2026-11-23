// Sign out everywhere (electron/host/signOut.cjs, machines.cjs signOutEverywhere, host:signOutEverywhere): the app's keys go first, then every machine takes the key back and signs Claude Code and Codex out; each machine's result says what happened, an offline or unreachable one is never reported as signed out (A: order, W: an older Host, B: failures, timeouts, I: per machine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { signOutEverywhere } = require('../electron/host/signOut.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const row = (id: string, status: string, ids: string[]) => ({
  id,
  name: id,
  status,
  harnesses: ids.map((h) => ({ id: h, detected: true })),
});
const old = () => Object.assign(new Error('old'), { code: 'feature_missing' });

/** A remote Host whose answers come from `o`; `calls` records what it was asked. */
function fakeHost(o: { connect?: () => Promise<unknown>; modelKey?: (p: any) => any; logout?: (p: any) => any } = {}) {
  const calls: any[] = [];
  return {
    calls,
    connect: o.connect ?? (async () => undefined),
    modelKey: async (p: any) => (calls.push(['modelKey', p]), o.modelKey ? o.modelKey(p) : { held: false }),
    logout: async (p: any) => (calls.push(['logout', p]), o.logout ? o.logout(p) : { harness: p.harness, signedOut: true, error: null }),
  };
}

test('an online machine takes the key back first, then signs out each CLI agent it has; basic agents are left to the machine', async () => {
  const host = fakeHost();
  const [r] = await signOutEverywhere({ machines: [row('mini', 'online', ['claude', 'codex', 'gemini'])], hostFor: () => host });
  assert.deepEqual(host.calls, [
    ['modelKey', { harness: 'claude', key: null }],
    ['modelKey', { harness: 'codex', key: null }],
    ['modelKey', { harness: 'gemini', key: null }],
    ['modelKey', { harness: 'grok', key: null }],
    ['modelKey', { harness: 'dsh', key: null }],
    ['logout', { harness: 'claude' }],
    ['logout', { harness: 'codex' }],
  ]);
  assert.deepEqual(r, {
    id: 'mini',
    name: 'mini',
    state: 'done',
    error: null,
    agents: [
      { id: 'claude', label: 'Claude Code', signedOut: true, error: null },
      { id: 'codex', label: 'Codex', signedOut: true, error: null },
    ],
  });
});

test('offline, unreachable, no Host and slow machines are listed as not signed out, each with why', async () => {
  const never = fakeHost({ connect: () => new Promise(() => undefined) });
  const down = fakeHost({ connect: async () => Promise.reject(new Error('Could not reach the machine over SSH.')) });
  const results = await signOutEverywhere({
    machines: [
      row('off', 'offline', ['claude']),
      row('down', 'online', ['claude']),
      row('none', 'online', ['claude']),
      row('slow', 'online', ['claude']),
    ],
    hostFor: (id: string) => (id === 'down' ? down : id === 'slow' ? never : null),
    reachMs: 10,
  });
  assert.deepEqual(
    results.map((r: any) => [r.id, r.state, r.error]),
    [
      ['off', 'offline', "Couldn't reach off. Sign out there when it's back."],
      ['down', 'offline', 'Could not reach the machine over SSH.'],
      ['none', 'offline', 'Host is not available for this account.'],
      ['slow', 'offline', "Couldn't reach slow."],
    ],
  );
  assert.deepEqual([down.calls, never.calls], [[], []]);
});

test('W/B: an older Host, a CLI still signed in, a refused key and a failed sign-out read as partial or failed with their words', async () => {
  const [older] = await signOutEverywhere({
    machines: [row('older', 'online', ['claude'])],
    hostFor: () =>
      fakeHost({
        modelKey: () => Promise.reject(old()),
        logout: () => Promise.reject(old()),
      }),
  });
  assert.deepEqual([older.state, older.error, older.agents[0].error], ['failed', null, 'Update this machine to sign out from here.']);
  const [mixed] = await signOutEverywhere({
    machines: [row('mixed', 'online', ['claude', 'codex'])],
    hostFor: () =>
      fakeHost({
        logout: (p: any) =>
          p.harness === 'claude'
            ? { harness: 'claude', signedOut: false, error: 'keychain locked' }
            : Promise.reject(new Error('timed out')),
      }),
  });
  assert.deepEqual([mixed.state, mixed.agents.map((a: any) => a.error)], ['failed', ['keychain locked', 'timed out']]);
  const [half] = await signOutEverywhere({
    machines: [row('half', 'online', ['claude', 'codex'])],
    hostFor: () => fakeHost({ logout: (p: any) => (p.harness === 'codex' ? {} : { signedOut: true }) }),
  });
  assert.deepEqual([half.state, half.agents[1].error], ['partial', 'Still signed in.']);
  const [kept] = await signOutEverywhere({
    machines: [row('kept', 'online', [])],
    hostFor: () => fakeHost({ modelKey: () => Promise.reject(new Error('The machine did not answer.')) }),
  });
  assert.deepEqual([kept.state, kept.error, kept.agents], ['failed', 'The machine did not answer.', []]);
  // a Host from before Gemini and Grok took keys refuses those two as invalid: it never held them, so that is not a failure
  const [prior] = await signOutEverywhere({
    machines: [row('prior', 'online', [])],
    hostFor: () =>
      fakeHost({
        modelKey: (p: any) =>
          p.harness === 'gemini' || p.harness === 'grok' || p.harness === 'dsh'
            ? Promise.reject(Object.assign(new Error('That agent takes no key.'), { code: 'invalid' }))
            : { held: false },
      }),
  });
  assert.equal(prior.error, null);
  // a failure that is not an Error is told as it is
  const [bare] = await signOutEverywhere({
    machines: [row('bare', 'online', ['claude'])],
    hostFor: () => fakeHost({ logout: () => Promise.reject('socket closed') }),
  });
  assert.equal(bare.agents[0].error, 'socket closed');
  const [keyLeft] = await signOutEverywhere({
    machines: [row('keyLeft', 'online', ['claude'])],
    hostFor: () => fakeHost({ modelKey: () => Promise.reject(new Error('busy')) }),
  });
  assert.equal(keyLeft.state, 'partial', 'signed out, but the key may still be held there');
});

test('host:signOutEverywhere forgets the keys here before any machine is asked, and returns each machine’s result', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-signout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const order: string[] = [];
  let keysSeen: any = null;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: (c: string) => void order.push(c) },
    {
      create: (o: any) => (
        (keysSeen = o.apiKeys),
        {
          list: () => ({ machines: [], resolved: true }),
          signOutEverywhere: async () => (order.push(`machines (key kept: ${keysSeen.hasFor('claude')})`), [{ id: 'mini', state: 'done' }]),
        }
      ),
      createFolders: () => ({}),
      allowed: () => true,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
        decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
      },
    },
  );
  await handlers.get('host:setApiKey')({}, 'anthropic', 'sk-ant-dummy-0000-test-key-abcd');
  order.length = 0;
  assert.deepEqual(await handlers.get('host:signOutEverywhere')({}), { value: [{ id: 'mini', state: 'done' }] });
  assert.deepEqual(order, ['host:machines', 'machines (key kept: false)']);
});

test('the machines service signs out every machine in the list and reads the list again after', async (t) => {
  const { createMachines } = require('../electron/host/machines.cjs');
  const { createRegistry } = require('../electron/host/registry.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-signout-m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const registry = createRegistry({
    file: path.join(dir, 'r.json'),
    status: async () => (reads++, Promise.reject(new Error('Could not reach the machine over SSH.'))),
  });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: [] });
  const m = createMachines({ dir, allowed: () => true, watch: () => undefined, registry, installer: {}, pool: { get: () => ({}) } });
  t.after(() => m.dispose());
  const results = await m.signOutEverywhere();
  assert.deepEqual(
    results.map((r: any) => [r.id, r.state]),
    [['ssh:box', 'offline']],
  );
  assert.equal(reads, 1, 'read again after');
});

test('with an org identity, each machine is told to drop that identity’s leases for Claude Code, Codex and basic agents; without one, none is sent', async () => {
  const identity = 'c'.repeat(32);
  const withLease = (orgLease: (p: any) => any) => ({ ...fakeHost(), orgLease });
  const asked: any[] = [];
  const host = withLease(async (p) => void asked.push(p));
  const [r] = await signOutEverywhere({ machines: [row('mini', 'online', ['claude'])], hostFor: () => host, orgIdentity: identity });
  assert.deepEqual(asked, [
    { harness: 'claude', identity, token: null },
    { harness: 'codex', identity, token: null },
    { harness: 'acp', identity, token: null },
  ]);
  assert.equal(r.state, 'done');
  asked.length = 0;
  await signOutEverywhere({ machines: [row('mini', 'online', ['claude'])], hostFor: () => host });
  assert.deepEqual(asked, [], 'no identity signed in here: nothing to take back');
  const [older] = await signOutEverywhere({
    machines: [row('old', 'online', ['claude'])],
    hostFor: () => withLease(() => Promise.reject(old())),
    orgIdentity: identity,
  });
  assert.equal(older.error, null, 'an older Host holds no lease');
  const [failed] = await signOutEverywhere({
    machines: [row('bad', 'online', ['claude'])],
    hostFor: () => withLease(() => Promise.reject(new Error('The machine did not answer.'))),
    orgIdentity: identity,
  });
  assert.equal(failed.error, 'The machine did not answer.');
});
