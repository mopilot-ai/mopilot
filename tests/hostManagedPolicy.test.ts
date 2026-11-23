// The managed layer on the Host (host/src/policy.mjs, shared/host/managedLayer.mjs, plan W2): what each key refuses, where, and what `host.status` reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createPolicy } from '../host/src/policy.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore: plain ESM without declarations
import { hostLayerOf, harnessAllowed, harnessKey } from '../shared/host/managedLayer.mjs';

const filed = (doc: any, extra: any = {}) => {
  const snap = { state: doc ? 'valid' : 'none', doc, organization: doc?.organization ?? null, problem: null as string | null, ...extra };
  return { effectivePolicy: () => snap, snap };
};
const mk = (doc: any, o: any = {}) => createPolicy({ managedFile: filed(doc), ...o });
const refusal = (key: string) => (e: any) => e.code === 'policy_refused' && e.details?.key === key;

test('the layer carries only what the document sets', () => {
  assert.deepEqual(hostLayerOf({}), {});
  assert.deepEqual(
    hostLayerOf({ permission: { max: 'default' }, hosts: { approvals: { pauseMinutesMax: 60 } }, spend: { dayUsdMax: 5, chatUsdMax: 2 } }),
    {
      permissionMax: 'default',
      approvals: { pauseMinutes: 60 },
      spend: { dayUsd: 5, chatUsd: 2 },
    },
  );
  assert.deepEqual(hostLayerOf({ spend: {} }), { spend: {} });
  assert.deepEqual(hostLayerOf({ spend: { dayUsdMax: 1 } }).spend, { dayUsd: 1 });
});

test('harness names: an ACP agent is `acp:<id>` on the wire', () => {
  assert.equal(harnessKey('acp:kimi'), 'kimi');
  assert.equal(harnessKey('claude'), 'claude');
  assert.equal(harnessAllowed(null, 'x'), true);
  assert.equal(harnessAllowed({}, 'x'), true);
  assert.equal(harnessAllowed({ harnesses: { allow: ['kimi'] } }, 'acp:kimi'), true);
  assert.equal(harnessAllowed({ harnesses: { allow: ['kimi'] } }, 'codex'), false);
});

test('harnesses.allow refuses chat.start for each harness not listed', () => {
  const p = mk({ harnesses: { allow: ['claude', 'kimi'] } });
  p.checkRequest('chat.start', { harness: 'claude' }, 'desktop');
  p.checkRequest('chat.start', { harness: 'acp:kimi' }, 'phone');
  assert.throws(() => p.checkRequest('chat.start', { harness: 'codex' }, 'desktop'), refusal('harnesses.allow'));
  assert.throws(() => p.checkRequest('chat.start', { harness: 'acp:other' }, 'desktop'), refusal('harnesses.allow'));
});

test('S5: permission.max stops a start and a switch to Full access from every client, per harness', () => {
  const p = mk({ permission: { max: 'default' } });
  for (const harness of ['claude', 'codex', 'acp:kimi']) {
    for (const kind of ['desktop', 'phone', 'cli']) {
      p.checkRequest('chat.start', { harness, permission: 'default' }, kind);
      assert.throws(() => p.checkRequest('chat.start', { harness, permission: 'full-access' }, kind), { code: 'policy_refused' });
      assert.throws(() => p.checkRequest('chat.permit', { chatId: 'c', value: 'full-access' }, kind), { code: 'policy_refused' });
    }
  }
  assert.deepEqual(p.status().locked, ['permissionMax']);
  assert.equal(p.status().managed, true);
});

test('a person with no file is unconstrained and not managed', () => {
  const p = mk(null);
  p.checkRequest('chat.start', { harness: 'codex', permission: 'full-access' }, 'desktop');
  p.checkRequest('host.clientAdd', { kind: 'phone' }, 'desktop');
  p.checkRequest('host.modelKey', { key: 'k' }, 'desktop');
  assert.equal(p.status().managed, false);
  assert.equal(p.roots(), undefined);
});

test('hosts.clients.phone false refuses a phone, not a desktop', () => {
  const p = mk({ hosts: { clients: { phone: false } } });
  assert.throws(() => p.checkRequest('host.clientAdd', { kind: 'phone' }, 'desktop'), refusal('hosts.clients.phone'));
  p.checkRequest('host.clientAdd', { kind: 'desktop' }, 'desktop');
  mk({ hosts: { clients: { phone: true } } }).checkRequest('host.clientAdd', { kind: 'phone' }, 'desktop');
});

test('hosts.credentials.orgOnly refuses a lent key, a chat without an organization lease, and the machine login', () => {
  const doc = { hosts: { credentials: { orgOnly: true } } };
  const without = mk(doc);
  assert.throws(
    () => without.checkRequest('host.modelKey', { harness: 'claude', key: 'k' }, 'desktop'),
    refusal('hosts.credentials.orgOnly'),
  );
  without.checkRequest('host.modelKey', { harness: 'claude', key: null }, 'desktop');
  assert.throws(() => without.checkRequest('chat.start', { harness: 'claude' }, 'desktop'), /Organization sign-in required/);
  const withLease = mk(doc, { hasOrgLease: (h: string) => h === 'claude' });
  withLease.checkRequest('chat.start', { harness: 'claude' }, 'desktop');
  assert.throws(() => withLease.checkRequest('chat.start', { harness: 'codex' }, 'desktop'), refusal('hosts.credentials.orgOnly'));
  assert.throws(() => withLease.checkScheduled({ harness: 'claude' }), refusal('hosts.credentials.orgOnly'));
});

test('a scheduled run is checked as a chat start', () => {
  const p = mk({ harnesses: { allow: ['claude'] } });
  p.checkScheduled({ harness: 'claude' });
  assert.throws(() => p.checkScheduled({ harness: 'acp:kimi' }), refusal('harnesses.allow'));
});

test('A3: a card answered after the ceiling dropped is checked against the current ceiling', () => {
  const f = filed({ permission: { max: 'full-access' } });
  const p = createPolicy({ managedFile: f });
  p.checkRequest('chat.start', { harness: 'claude', chatId: 'c1', permission: 'full-access' }, 'desktop');
  p.checkRequest('chat.permit', { chatId: 'c2', value: 'default' }, 'desktop');
  p.checkRequest('chat.answer', { chatId: 'c1' }, 'desktop');
  p.checkRequest('chat.answer', { chatId: 'unknown' }, 'desktop');
  f.snap.doc = { permission: { max: 'default' } };
  assert.throws(() => p.checkRequest('chat.answer', { chatId: 'c1' }, 'desktop'), { code: 'policy_refused' });
  p.checkRequest('chat.answer', { chatId: 'c2' }, 'desktop');
  p.checkRequest('chat.start', { harness: 'claude', chatId: 'c3' }, 'desktop');
});

test('hosts.roots, approvals and spend clamp the owner; the owner can only be stricter', () => {
  const p = mk({ hosts: { roots: ['/srv/work'], approvals: { pauseMinutesMax: 10 } }, spend: { dayUsdMax: 5 } });
  assert.deepEqual(p.roots(), ['/srv/work']);
  assert.equal(p.approvalSettings().approvals.pauseMinutes, 10);
  p.set({
    version: 1,
    permissionMax: 'full-access',
    approvals: { remindMinutes: 10, pauseMinutes: 5 },
    notify: {},
    spend: { dayUsd: 50, chatUsd: 9 },
  });
  assert.equal(p.approvalSettings().approvals.pauseMinutes, 5);
  assert.deepEqual(p.effective().doc.spend, { dayUsd: 5, chatUsd: 9 });
});

test('status reports the organization, the keys the file decides and a problem', () => {
  const f = filed(
    {
      organization: 'Acme',
      harnesses: { allow: ['claude'] },
      hosts: { clients: { phone: false }, credentials: { orgOnly: false }, roots: ['/x'] },
      audit: { required: true },
    },
    { problem: 'The managed policy file is not valid.' },
  );
  const s = createPolicy({ managedFile: f }).status();
  assert.equal(s.organization, 'Acme');
  assert.deepEqual(s.locked, ['harnesses.allow', 'hosts.clients.phone', 'hosts.credentials.orgOnly', 'hosts.roots', 'audit']);
  assert.match(s.problem!, /not valid/);
  assert.equal(createPolicy({ managedFile: filed({}) }).status().locked.length, 0);
  assert.equal('organization' in createPolicy({ managedFile: filed({}) }).status(), false);
});

test('a layer from `managed` still works when there is no file', () => {
  const p = createPolicy({ managed: () => ({ permissionMax: 'read-only' }) });
  assert.throws(() => p.checkRequest('chat.permit', { chatId: 'c', value: 'default' }, 'desktop'), { code: 'policy_refused' });
  assert.equal(p.status().managed, true);
});

test('S5 on the protocol: a scheduled run on a harness the policy forbids is refused before it starts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-managed-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  let started = 0;
  const runtime: any = { host, familyOf: () => 'acp', permit: () => true, send: async () => (started++, { turnId: 't1' }) };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    dataDir: dir,
    ...quiet,
    policy: mk({ harnesses: { allow: ['claude'] } }),
  });
  const task = { prompt: 'p', cwd: '/srv', harness: 'kimi', onApproval: 'skip' };
  await assert.rejects(
    Promise.resolve().then(() => protocol.startScheduled({ chatId: 'acp:kimi:1', task } as any)),
    refusal('harnesses.allow'),
  );
  assert.equal(started, 0);
});

test('the owner rules read organization leases once the credentials are given, and own the managed file', async (t) => {
  const { createOwnerRules } = await import('../host/src/ownerRules.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-owner-rules-'));
  const rules = createOwnerRules({ dataDir: dir, report: () => undefined });
  t.after(() => {
    rules.managedFile.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(typeof rules.managedFile.effectivePolicy, 'function');
  assert.equal(rules.policy.roots(), undefined, 'this machine has no managed file');
  rules.managedFile.effectivePolicy = () => ({
    state: 'valid' as const,
    generation: 'g',
    doc: { hosts: { credentials: { orgOnly: true } } },
    organization: null,
    problem: null,
  });
  assert.throws(() => rules.policy.checkRequest('chat.start', { harness: 'claude' }, 'desktop'), /Organization sign-in required/);
  rules.attach({ leases: { hasOrg: (h: string) => h === 'claude' } });
  assert.doesNotThrow(() => rules.policy.checkRequest('chat.start', { harness: 'claude' }, 'desktop'));
  assert.throws(() => rules.policy.checkRequest('chat.start', { harness: 'codex' }, 'desktop'), /Organization sign-in required/);
});
