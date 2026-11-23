// The IPC for organization access (#3361 Tier 2): channels call through to the service, which is made on first use; a change redraws windows and a sign-in lets waiting messages go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerOrgAccess } = require('../electron/app/ipc/hostOrgAccess.cjs');
const { managedPolicy, managedOrgAccess } = require('../electron/platform/managedPolicy.cjs');

function world(opts: { remote?: () => any; state?: string; storage?: () => unknown; failManaged?: boolean } = {}) {
  const handlers = new Map<string, (...a: any[]) => unknown>();
  const broadcasts: [string, unknown][] = [];
  const log: string[] = [];
  const created: any[] = [];
  let listener: () => void = () => undefined;
  const state = { value: opts.state ?? 'signedIn' };
  const service = {
    view: () => ({ state: state.value }),
    configure: async (c: unknown) => (log.push(`configure:${JSON.stringify(c)}`), 'configured'),
    remove: async () => (log.push('remove'), 'removed'),
    signIn: async () => (log.push('signIn'), 'in'),
    signOut: async () => (log.push('signOut'), 'out'),
    lend: async (h: unknown, harness: string) => (log.push(`lend:${harness}`), true),
    covers: (h: string) => h === 'claude',
    identity: () => 'id-1',
    onChange: (fn: () => void) => (listener = fn),
    dispose: () => log.push('dispose'),
    managedChanged: async () => {
      log.push('managedChanged');
      if (opts.failManaged) throw new Error('could not apply');
    },
  };
  const api = registerOrgAccess({
    handle: (channel: string, fn: any) => handlers.set(channel, fn),
    userData: () => '/tmp/user-data',
    safeStorage: opts.storage ?? (() => ({})),
    openExternal: () => undefined,
    broadcast: (c: string, p: unknown) => broadcasts.push([c, p]),
    remote: opts.remote ?? (() => null),
    create: (o: any) => (created.push(o), service),
  });
  return { handlers, broadcasts, log, created, api, state, fire: () => listener() };
}

test('the encryption lookup stays lazy and retryable, and the created service is reused', () => {
  const storage = {};
  let lookups = 0;
  let failure: Error | null = new Error('encryption not ready');
  const w = world({
    storage: () => {
      lookups++;
      if (failure) throw failure;
      return storage;
    },
  });
  w.api.dispose();
  assert.equal(lookups, 0, 'registration and unused disposal leave the dependency untouched');
  assert.throws(() => w.handlers.get('host:orgAccess')?.(), /encryption not ready/);
  assert.equal(w.created.length, 0, 'a failed lookup does not create or cache a service');
  failure = null;
  assert.deepEqual(w.handlers.get('host:orgAccess')?.(), { state: 'signedIn' });
  assert.equal(w.created[0].safeStorage, storage);
  assert.equal(lookups, 2);
  assert.equal(w.api.covers('claude'), true);
  assert.equal(w.created.length, 1);
  assert.equal(lookups, 2, 'later calls reuse the service');
});

test('every channel calls through to the service, which is made once on first use', async () => {
  const w = world();
  assert.deepEqual(
    [...w.handlers.keys()],
    ['host:orgAccess', 'host:setOrgAccess', 'host:removeOrgAccess', 'host:orgSignIn', 'host:orgSignOut'],
  );
  assert.equal(w.created.length, 0);
  assert.deepEqual(w.handlers.get('host:orgAccess')?.(), { state: 'signedIn' });
  assert.equal(await w.handlers.get('host:setOrgAccess')?.({ issuer: 'x' }), 'configured');
  assert.equal(await w.handlers.get('host:removeOrgAccess')?.(), 'removed');
  assert.equal(await w.handlers.get('host:orgSignIn')?.(), 'in');
  assert.equal(await w.handlers.get('host:orgSignOut')?.(), 'out');
  assert.equal(w.created.length, 1);
  assert.match(w.created[0].file, /host-org-access\.json$/);
  assert.equal(typeof w.created[0].oidc.signIn, 'function');
  assert.doesNotThrow(() => w.created[0].report(new Error('x')));
  assert.deepEqual(w.log, ['configure:{"issuer":"x"}', 'remove', 'signIn', 'signOut']);
});

test('lend, covers, signOut, identity and dispose delegate; dispose before the service exists is safe', async () => {
  const w = world();
  assert.doesNotThrow(() => w.api.dispose());
  assert.equal(w.created.length, 0);
  assert.equal(await w.api.lend({}, 'codex'), true);
  assert.deepEqual([w.api.covers('claude'), w.api.covers('codex'), w.api.identity()], [true, false, 'id-1']);
  assert.equal(await w.api.signOut(), 'out');
  w.api.dispose();
  assert.deepEqual(w.log, ['lend:codex', 'signOut', 'dispose']);
});

test('a change is broadcast; a sign-in also lets waiting messages go, and a failure there or no remote is fine', async () => {
  let sent = 0;
  let fail = false;
  const w = world({ remote: () => ({ orgSignedIn: () => (sent++, fail ? Promise.reject(new Error('down')) : Promise.resolve()) }) });
  w.api.covers('claude');
  w.fire();
  assert.deepEqual(w.broadcasts, [['host:orgAccess', { state: 'signedIn' }]]);
  assert.equal(sent, 1);
  // still signed in: not a new sign-in, nothing more to send
  w.fire();
  assert.equal(sent, 1);
  w.state.value = 'signedOut';
  w.fire();
  assert.equal(sent, 1);
  // signing in again is one, and a failure sending is swallowed
  fail = true;
  w.state.value = 'signedIn';
  w.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent, 2);
  assert.equal(w.broadcasts.length, 4);

  const none = world({ remote: () => null });
  none.api.covers('claude');
  assert.doesNotThrow(() => none.fire());
  assert.equal(none.broadcasts.length, 1);
});

test('W4: the service reads the managed policy, which is watched; a change of it is applied, a failure there is swallowed, and dispose stops following', async (t) => {
  const mp = managedPolicy();
  const { watch, onChange } = mp;
  let heard: () => void = () => undefined;
  let watched = 0;
  let stopped = 0;
  mp.watch = () => void watched++;
  mp.onChange = (fn: () => void) => ((heard = fn), () => void stopped++);
  t.after(() => Object.assign(mp, { watch, onChange }));
  const w = world();
  w.api.covers('claude');
  assert.equal(watched, 1);
  assert.equal(w.created[0].managed, managedOrgAccess);
  heard();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    w.log.filter((l) => l === 'managedChanged'),
    ['managedChanged'],
  );
  w.api.dispose();
  assert.equal(stopped, 1);
});

test('W4: a managed change that cannot be applied is noted, never thrown', async (t) => {
  const mp = managedPolicy();
  const { watch, onChange } = mp;
  let heard: () => void = () => undefined;
  mp.watch = () => undefined;
  mp.onChange = (fn: () => void) => ((heard = fn), () => undefined);
  t.after(() => Object.assign(mp, { watch, onChange }));
  const w = world({ failManaged: true });
  w.api.covers('claude');
  assert.doesNotThrow(() => heard());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    w.log.filter((l) => l === 'managedChanged'),
    ['managedChanged'],
  );
});
