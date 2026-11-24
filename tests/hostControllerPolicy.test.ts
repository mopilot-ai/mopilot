// Managed policy and a kind this Host does not know, for a Mac paired by a code (R2b of #5576): an organization can switch controllers off and the code-pair service asks before it makes one; a client record of an unknown kind is `unknown`, which no kind check serves as an owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { STRICT_FALLBACK, parseManagedPolicy } from '../shared/managedPolicy.mjs';
// @ts-ignore
import { clientOf } from '../host/src/trustState.mjs';
// @ts-ignore
import { chatScopeOf } from '../host/src/chatScope.mjs';
// @ts-ignore
import { isOwner } from '../host/src/momoOwner.mjs';
// @ts-ignore
import { ceilingFor } from '../shared/host/policy.mjs';
// @ts-ignore
import { clientListOf } from '../shared/host/clients.mjs';

const bad = (m: string) => new Error(m);
const filed = (doc: any) => {
  const snap = { state: doc ? 'valid' : 'none', doc, organization: null, problem: null as string | null };
  return { effectivePolicy: () => snap, snap };
};

test('hosts.clients.controller is a switch: false keeps the Host from having one, absent allows, a non-flag is refused', () => {
  assert.equal(parseManagedPolicy({ version: 1, hosts: { clients: { controller: false } } }, bad).hosts.clients.controller, false);
  assert.deepEqual(parseManagedPolicy({ version: 1, hosts: { clients: { phone: false, controller: true } } }, bad).hosts.clients, {
    phone: false,
    controller: true,
  });
  assert.deepEqual(parseManagedPolicy({ version: 1, hosts: { clients: {} } }, bad).hosts.clients, {});
  assert.throws(() => parseManagedPolicy({ version: 1, hosts: { clients: { controller: 'x' } } }, bad), /controller/);
  assert.equal(STRICT_FALLBACK.hosts.clients.controller, false, 'a file that was never valid allows none');
  const off = createPolicy({ managedFile: filed({ hosts: { clients: { controller: false } } }) });
  assert.equal(off.allowsClient('controller'), false);
  assert.equal(off.allowsClient('phone'), true);
  const on = createPolicy({ managedFile: filed({ hosts: { clients: { controller: true, phone: false } } }) });
  assert.equal(on.allowsClient('controller'), true);
  assert.equal(on.allowsClient('phone'), false);
  assert.equal(createPolicy({ managedFile: filed(null) }).allowsClient('controller'), true, 'no managed policy allows');
});

test('a client record of a kind this Host does not know is `unknown`: no owner, no update key, its own chats, the lower ceiling', () => {
  const r = clientOf({ key: 'K', kind: 'robot' });
  assert.equal(r.kind, 'unknown');
  assert.equal(isOwner({ kind: r.kind }), false);
  assert.equal(ceilingFor('full-access', r.kind), 'auto-review');
  const scope = chatScopeOf(undefined)({ principal: () => ({ kind: r.kind, fingerprint: 'fp' }) });
  assert.equal(scope.sees('c1', { byFp: 'other' }), false);
  assert.equal(scope.sees('c1', { byFp: 'fp' }), true);
  const policy = createPolicy({ managedFile: filed(null) });
  assert.throws(() => policy.replace({ doc: {} }, r.kind), { code: 'policy_refused' });
  // it is listed, so it can be revoked
  assert.equal(clientListOf({ clients: [{ fingerprint: 'a'.repeat(64), name: 'x', kind: 'unknown' }] }).length, 1);
});
