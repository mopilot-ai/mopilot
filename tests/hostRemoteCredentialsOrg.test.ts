// The organization's lease before a model key (electron/host/remoteCredentials.cjs, #3361 Tier 2): lent first, falls back to the key on an older Host, a lapsed sign-in stops the message, and a row reads keyed when the organization covers the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withCredentials, keyedHarnesses, NO_ORG, NO_KEYS } = require('../electron/host/remoteCredentials.cjs');

const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const code = (c: string) => Object.assign(new Error(c), { code: c });

function world(lend: (host: unknown, harness: string) => Promise<boolean>) {
  const calls: unknown[][] = [];
  const lent: string[] = [];
  const host = {
    start: async (...a: unknown[]) => void calls.push(['start', ...a]),
    send: async (...a: unknown[]) => void calls.push(['send', ...a]),
    modelKey: async (p: unknown) => void calls.push(['modelKey', p]),
  };
  const keys = { forHarness: () => KEY, hasFor: () => true };
  const wrapped = withCredentials(host, keys, {
    lend: async (h: unknown, harness: string) => (lent.push(harness), lend(h, harness)),
  });
  return { calls, lent, host, wrapped };
}

test('an organization lease that is lent means no model key is sent', async () => {
  const w = world(async () => true);
  await w.wrapped.send('claude:1', { text: 'a' });
  assert.deepEqual(w.lent, ['claude']);
  assert.deepEqual(
    w.calls.map((c) => c[0]),
    ['send'],
  );
});

test('no lease for the harness: the key goes as before', async () => {
  const w = world(async () => false);
  await w.wrapped.send('claude:1', { text: 'a' });
  assert.deepEqual(
    w.calls.map((c) => c[0]),
    ['modelKey', 'send'],
  );
});

test('a Host without the feature falls back to the key; any other refusal stops the message', async () => {
  const old = world(async () => Promise.reject(code('feature_missing')));
  await old.wrapped.start('c', { harness: 'claude' });
  assert.deepEqual(
    old.calls.map((c) => c[0]),
    ['modelKey', 'start'],
  );
  const ended = world(async () => Promise.reject(code('org_signin_required')));
  await assert.rejects(ended.wrapped.send('claude:1', { text: 'a' }), { code: 'org_signin_required' });
  await assert.rejects(ended.wrapped.start('c', { harness: 'claude' }), { code: 'org_signin_required' });
  assert.deepEqual(ended.calls, []);
});

test('a basic agent start lends for the acp family; a start without a harness lends for none', async () => {
  const w = world(async () => true);
  await w.wrapped.start('c', { harness: 'acp:gemini' });
  await w.wrapped.start('c', { harness: 42 });
  await w.wrapped.start('c', undefined);
  assert.deepEqual(w.lent, ['acp', '', '']);
});

test('a machine service with no organization access lends nothing and covers nothing', async () => {
  assert.equal(await NO_ORG.lend({}, 'claude'), false);
  assert.equal(NO_ORG.covers('claude'), false);
  const calls: string[] = [];
  const host = {
    start: async () => undefined,
    send: async () => void calls.push('send'),
    modelKey: async () => void calls.push('modelKey'),
  };
  await withCredentials(host, { forHarness: () => KEY, hasFor: () => true }).send('claude:1', {});
  assert.deepEqual(calls, ['modelKey', 'send']);
});

test('a row reads keyed while the organization covers an agent that takes a lease', () => {
  const rows = [{ id: 'claude', takesOrg: true }, { id: 'codex', takesOrg: true }, { id: 'gemini' }, { id: 'other', takesOrg: 'yes' }];
  const out = keyedHarnesses(rows, NO_KEYS, { covers: (id: string) => id !== 'codex' && id !== 'other' });
  assert.deepEqual(
    out.map((r: any) => r.keyed === true),
    [true, false, false, false],
  );
  assert.equal(keyedHarnesses([{ id: 'claude', takesOrg: true }], NO_KEYS)[0].keyed, undefined);
});

test('a key and a lease both make a row keyed, and the key alone is enough', () => {
  const out = keyedHarnesses([{ id: 'claude', takesKey: true }], { forHarness: () => KEY, hasFor: () => true }, NO_ORG);
  assert.equal(out[0].keyed, true);
});

test('orgLease is one control call on the Host', async () => {
  const { signinCalls } = require('../electron/host/remoteSignin.cjs');
  const control: unknown[][] = [];
  const lease = { harness: 'claude', identity: 'f'.repeat(32), token: null };
  await signinCalls(async (method: string, params: object) => (control.push([method, params]), { held: false })).orgLease(lease);
  assert.deepEqual(control, [['host.orgLease', lease]]);
});
