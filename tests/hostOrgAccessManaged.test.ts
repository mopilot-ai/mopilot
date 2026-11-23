// Organization sign-in from the managed policy (electron/host/orgAccess/service.cjs, platform/managedPolicy.cjs, plan W4 and scenario S7): the policy's `orgAccess` replaces the typed settings, shows locked, and a change takes every lease back, also during a sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, ISSUER, id, REFRESH } from './support/orgAccessKit.ts';

const require = createRequire(import.meta.url);
const { createManagedPolicy } = require('../electron/platform/managedPolicy.cjs');

const BLOCK = {
  issuer: ISSUER,
  clientId: 'managed-client',
  scopes: ['openid', 'email'],
  gateways: { anthropic: 'https://gw.acme.example/a', openai: 'https://gw.acme.example/o' },
  leaseHours: 6,
};
const policy = (orgAccess: unknown, extra: object = {}) => ({ orgAccess, organization: 'Acme', problem: null, ...extra });

test('S7: a fresh Mac with the managed file shows the settings filled in and locked, and only needs Sign in', async (t) => {
  const s = setup(t, { managed: policy(BLOCK) });
  const v = s.svc.view();
  assert.equal(v.configured, true);
  assert.equal(v.state, 'signedOut');
  assert.deepEqual(v.managed, { organization: 'Acme', problem: '' });
  assert.deepEqual(v.config, {
    issuer: ISSUER,
    clientId: 'managed-client',
    scopes: 'openid email',
    leaseHours: 6,
    access: { kind: 'gateway', gateways: BLOCK.gateways },
  });
  assert.equal((await s.svc.signIn()).state, 'signedIn');
  assert.equal(s.svc.covers('claude'), true);
  const h = s.host();
  assert.equal(await s.svc.lend(h, 'claude'), true);
  assert.deepEqual(h.calls[0].gateways, { anthropic: BLOCK.gateways.anthropic });
});

test('typed settings cannot change or remove what the policy decides; it names who manages it', async (t) => {
  const s = setup(t, { managed: policy(BLOCK) });
  await assert.rejects(s.svc.configure({ issuer: ISSUER }), { code: 'managed', message: 'Managed by Acme.' });
  await assert.rejects(s.svc.remove(), { code: 'managed' });
  const anon = setup(t, { managed: policy(BLOCK, { organization: null }) });
  await assert.rejects(anon.svc.configure({}), { message: 'Managed by your organization.' });
  assert.deepEqual(anon.svc.view().managed, { organization: '', problem: '' });
});

test('with no orgAccess block the typed settings apply, and the view says it is not managed', async (t) => {
  for (const m of [null, { organization: 'Acme', problem: null }]) {
    const s = setup(t, { managed: m });
    assert.equal(s.svc.view().managed, null);
    assert.equal(s.svc.view().configured, false);
  }
});

test('a changed block ends the sign-in, takes every lease back and tells the IdP; the same block changes nothing', async (t) => {
  const s = setup(t, { managed: policy(BLOCK) });
  await s.svc.signIn();
  const h = s.host();
  await s.svc.lend(h, 'claude');
  const before = s.changes.count;
  await s.svc.managedChanged();
  assert.equal(s.svc.view().state, 'signedIn');
  assert.equal(h.calls.length, 1, 'nothing taken back');
  assert.equal(s.changes.count, before + 1);
  s.managedState.value = policy({ ...BLOCK, clientId: 'managed-client-2' });
  await s.svc.managedChanged();
  assert.equal(s.svc.view().state, 'signedOut');
  assert.equal(s.svc.view().config.clientId, 'managed-client-2');
  assert.deepEqual(h.calls.at(-1), { harness: 'claude', identity: id(), token: null });
  assert.deepEqual(s.o.revokes, [REFRESH]);
});

test('a policy change during a sign-in ends that sign-in', async (t) => {
  const s = setup(t, { managed: policy(BLOCK) });
  let release: () => void = () => undefined;
  // the sign-in resolves at once, so the policy change below lands while it is still waiting to be finished
  s.o.releaseSignIn = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const pending = s.svc.signIn();
  s.managedState.value = policy({ ...BLOCK, issuer: 'https://other.example.test/realm' });
  await s.svc.managedChanged();
  release();
  await gate;
  await assert.rejects(pending, { code: 'invalid', message: /changed its sign-in settings/ });
  assert.equal(s.svc.view().state, 'signedOut');
});

test('an invalid rewrite keeps the last good block and says why; with none it is not configured and says why', async (t) => {
  const s = setup(t, { managed: policy(BLOCK) });
  s.managedState.value = policy({ issuer: 'http://insecure.example.test', clientId: 'x', gateways: {} });
  await s.svc.managedChanged();
  assert.equal(s.svc.view().config.clientId, 'managed-client', 'the last good block stays');
  assert.match(s.svc.view().managed.problem, /issuer/);
  s.managedState.value = policy(BLOCK, { problem: 'The managed policy file is not valid: x' });
  await s.svc.managedChanged();
  assert.match(s.svc.view().managed.problem, /not valid/);
  const never = setup(t, { managed: policy({ clientId: 'x' }) });
  assert.equal(never.svc.view().configured, false);
  assert.match(never.svc.view().managed.problem, /issuer/);
});

test('the policy going away frees the typed settings; the old sign-in ends', async (t) => {
  const s = setup(t, { managed: policy(BLOCK) });
  await s.svc.signIn();
  s.managedState.value = null;
  await s.svc.managedChanged();
  assert.equal(s.svc.view().configured, false);
  assert.equal(s.svc.view().managed, null);
  assert.equal(s.svc.view().state, 'off');
  assert.equal((await s.svc.configure({ issuer: ISSUER, clientId: 'typed', access: { gateways: BLOCK.gateways } })).state, 'signedOut');
});

test('the resolver feeds the service: a valid file gives its block, the strict fallback and no file give none', () => {
  const { managedOrgAccess } = require('../electron/platform/managedPolicy.cjs');
  assert.ok(managedOrgAccess() === null || typeof managedOrgAccess() === 'object');
  const make = (content: string | null) =>
    createManagedPolicy({
      file: '/etc/x/managed-policy.json',
      platform: 'linux',
      fs: {
        statSync: () => {
          if (content === null) throw Object.assign(new Error('x'), { code: 'ENOENT' });
          return { uid: 0, mode: 0o100644 };
        },
        readFileSync: () => content,
      },
    });
  assert.equal(
    make(JSON.stringify({ version: 1, organization: 'Acme', orgAccess: BLOCK })).effectivePolicy().doc.orgAccess.clientId,
    'managed-client',
  );
  assert.equal(make('{ nope').effectivePolicy().doc.orgAccess, undefined);
  assert.equal(make(null).effectivePolicy().doc, null);
});

test('a policy that appears after launch replaces the typed settings and ends their sign-in; remove names an unnamed organization', async (t) => {
  const s = setup(t);
  await s.svc.configure({ issuer: ISSUER, clientId: 'typed', access: { gateways: BLOCK.gateways } });
  await s.svc.signIn();
  s.managedState.value = policy(BLOCK, { organization: null });
  await s.svc.managedChanged();
  assert.equal(s.svc.view().state, 'signedOut');
  assert.equal(s.svc.view().config.clientId, 'managed-client');
  assert.deepEqual(s.o.revokes, [REFRESH]);
  await assert.rejects(s.svc.remove(), { message: 'Managed by your organization.' });
});

test('a service made without a policy view has typed settings only', async (t) => {
  const { createOrgAccess } = await import('../electron/host/orgAccess/service.cjs').then((m) => m.default ?? m);
  const s = setup(t);
  const bare = createOrgAccess({ file: s.file, safeStorage: s.storage, oidc: {} as any });
  assert.equal(bare.view().managed, null);
});
