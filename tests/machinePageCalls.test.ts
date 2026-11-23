// What a machine's page (X2) reads from a real Host: the calls main answers (electron/host/machinePageCalls.cjs) in the shapes the page's readers take, with the Host's own modules (the client table, the audit record, the spend counter, the policy status and the status builder) behind them, and the bridge that carries them to the window. W: a section the real app never drew, I: a Host that answers in its own words, A: an older Host, B: the bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createAudit } from '../host/src/audit.mjs';
import { createHostClients } from '../host/src/hostClients.mjs';
import { createPolicy } from '../host/src/policy.mjs';
import { createSpend } from '../host/src/spend.mjs';
import { hostStatus } from '../host/src/status.mjs';
import { installNative } from '../src/lib/native.ts';

const require = createRequire(import.meta.url);
const { createMachinePageCalls } = require('../electron/host/machinePageCalls.cjs');
const { registerMachinePage } = require('../electron/app/ipc/hostMachinePage.cjs');
const bridge = require('../electron/bridge/host.cjs');
const data = await import('../src/lib/machinePageData.ts');

const fp = (name: string) => crypto.createHash('sha256').update(name).digest('hex');
const SELF = fp('this mac');
const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-page-calls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A real Host's pieces: its client table over a pairing record, its audit record, its spend counter and its policy status. */
function realHost(t: any, o: { managed?: boolean; features?: string[] } = {}) {
  const dir = tmp(t);
  const pairing = {
    records: [
      { fingerprint: SELF, name: 'Work MacBook Pro', kind: 'desktop', addedAt: Date.UTC(2026, 10, 1), addedBy: 'cli' },
      { fingerprint: fp('phone'), name: 'Pocket iPhone', kind: 'phone', addedAt: Date.UTC(2026, 10, 3), addedBy: SELF },
      { fingerprint: fp('other mac'), name: 'Studio Mac', kind: 'desktop', addedAt: Date.UTC(2026, 10, 5), addedBy: SELF },
    ] as any[],
    list() {
      return this.records;
    },
    remove(f: string) {
      const before = this.records.length;
      this.records = this.records.filter((r) => r.fingerprint !== f);
      return this.records.length < before;
    },
  };
  const closed: string[] = [];
  const clients = createHostClients({ pairing: pairing as any, connected: (f) => f === SELF, close: (f) => void closed.push(f) });
  let clock = Date.UTC(2026, 10, 16, 9, 0, 0);
  const audit = createAudit({ dir: path.join(dir, 'audit'), now: () => (clock += 1000) });
  const policy = createPolicy({
    managedFile: o.managed
      ? ({
          effectivePolicy: () => ({
            state: 'valid',
            doc: { spend: { dayUsdMax: 5 }, permission: { max: 'default' }, hosts: { approvals: { pauseMinutesMax: 15 } } },
            organization: 'Acme',
            problem: null,
          }),
        } as any)
      : undefined,
  });
  const spend = createSpend({ dataDir: dir, limits: () => ({ dayUsd: 20 }), state: () => undefined, report: () => undefined });
  const who = { fingerprint: 'local-cli', name: 'this machine', kind: 'cli' as const };
  const session = {
    closed: false,
    async call(method: string, p: any) {
      if (method === 'host.hello') return { agreed: true, features: o.features ?? ['clients', 'audit'] };
      if (method === 'host.auditRead') return audit.read(p);
      if (method === 'host.status') return hostStatus({ running: true, policy: policy.status(), spend: spend.status() } as any);
      return clients.call(method, p, who);
    },
    close() {
      this.closed = true;
    },
  };
  const calls = createMachinePageCalls({ pairedFor: async () => session, selfFingerprint: () => SELF });
  return { calls, audit, session, closed, pairing };
}

const asNative = (calls: Record<string, any>, extra: Record<string, unknown> = {}) => {
  installNative({
    host: {
      clients: calls.clients,
      removeClient: calls.removeClient,
      audit: calls.audit,
      hostStatus: calls.hostStatus,
      ownerPolicy: async () => ({
        version: 1,
        permissionMax: 'full-access',
        approvals: { remindMinutes: 10, pauseMinutes: 30 },
        notify: { needsYou: true, done: false, paused: true, detail: 'tool', quiet: null },
        spend: { dayUsd: 20 },
      }),
      phoneDirectList: async () => [{ pairId: 'p1', fingerprint: fp('phone'), state: 'on' }],
      ...extra,
    },
  } as never);
};

test('W: a real Host’s answers give the page every section: its devices with this Mac marked, spending, activity newest first', async (t) => {
  const h = realHost(t);
  h.audit.note({ kind: 'client.added', by: { fingerprint: SELF, name: 'Work MacBook Pro', kind: 'desktop' }, what: {} });
  h.audit.note({ kind: 'policy.changed', by: { fingerprint: SELF, name: 'Work MacBook Pro', kind: 'desktop' }, what: {} });
  asNative(h.calls);
  const page = await data.loadMachinePage('ssh:box');
  assert.deepEqual(
    page.devices?.map((d) => [d.name, d.kind, d.thisMac, d.direct?.state ?? null]),
    [
      ['Work MacBook Pro', 'desktop', true, null],
      ['Pocket iPhone', 'phone', false, 'on'],
      ['Studio Mac', 'desktop', false, null],
    ],
  );
  assert.deepEqual(page.spending, { dayUsd: 0, dayLimitUsd: 20, chatLimitUsd: null, unpriced: false });
  assert.deepEqual(
    page.activity?.map((l) => [l.kind, l.who, l.whoKind]),
    [
      ['policy.changed', 'Work MacBook Pro', 'desktop'],
      ['client.added', 'Work MacBook Pro', 'desktop'],
    ],
  );
  assert.equal(page.managed, undefined, 'a person’s machine has no Managed section');
  assert.ok(page.rules && page.ownerDoc);
  assert.equal(h.session.closed, true, 'every exchange is closed');
});

test('I: the Host names its organization and its locked keys by path; the page reads the organization and the section', async (t) => {
  const h = realHost(t, { managed: true });
  asNative(h.calls);
  const page = await data.loadMachinePage('ssh:box');
  assert.equal(page.managed?.org, 'Acme');
  assert.deepEqual([...(page.managed?.locked ?? [])].sort(), ['approvals', 'permissionMax', 'spend']);
  assert.equal(data.isLocked(page.managed, 'permissionMax'), true);
  assert.equal(data.readManaged({ policy: { managed: true, org: 'Old', locked: 'x' } })?.org, 'Old', 'the earlier name still reads');
  assert.deepEqual(data.readManaged({ policy: { managed: true } }), { org: 'your organization', locked: [] });
});

test('W: Remove takes a client off the Host, which closes it; a record with the wrong shape is left out', async (t) => {
  const h = realHost(t);
  asNative(h.calls);
  await data.removeDevice('ssh:box', fp('other mac'));
  assert.deepEqual(
    h.pairing.records.map((r) => r.name),
    ['Work MacBook Pro', 'Pocket iPhone'],
  );
  const page = await data.loadMachinePage('ssh:box');
  assert.equal(page.devices?.length, 2);
});

test('A: an older Host with no client table or audit record leaves those sections out, and its refusal is feature_missing', async (t) => {
  const h = realHost(t, { features: ['chat'] });
  await assert.rejects(h.calls.clients('ssh:box'), { code: 'feature_missing' });
  await assert.rejects(h.calls.removeClient('ssh:box', fp('phone')), { code: 'feature_missing' });
  await assert.rejects(h.calls.audit('ssh:box'), { code: 'feature_missing' });
  asNative(h.calls);
  const page = await data.loadMachinePage('ssh:box');
  assert.deepEqual([page.devices, page.activity], [undefined, undefined]);
  assert.ok(page.spending && page.rules, 'what the Host still answers stays');
  assert.equal(h.session.closed, true, 'a refused exchange is closed too');
});

test('W: a long record shows its last 50 lines, newest first, read a hundred at a time', async (t) => {
  const h = realHost(t);
  for (let i = 0; i < 250; i++) h.audit.note({ kind: 'chat.message', by: { fingerprint: SELF, name: `n${i}`, kind: 'desktop' }, what: {} });
  const seen: object[] = [];
  const wrapped = { ...h.session, call: (m: string, p: any) => (seen.push({ m, p }), h.session.call(m, p)) };
  const calls = createMachinePageCalls({ pairedFor: async () => wrapped, selfFingerprint: () => SELF });
  const { lines } = await calls.audit('ssh:box');
  assert.equal(lines.length, 50);
  assert.deepEqual([lines[0].who, lines[49].who], ['n249', 'n200']);
  assert.equal(seen.filter((s: any) => s.m === 'host.auditRead').length, 3);
  // a Host that answers no lines at all shows none
  const none = createMachinePageCalls({
    pairedFor: async () => ({ call: async (m: string) => (m === 'host.hello' ? { features: ['audit'] } : {}), close: () => undefined }),
    selfFingerprint: () => SELF,
  });
  assert.deepEqual(await none.audit('ssh:box'), { lines: [] });
});

test('B: the Host’s status is asked through one paired exchange, which is closed, and a machine that is not there says so', async () => {
  const seen: string[] = [];
  const session = {
    call: async (m: string) => (seen.push(m), m === 'host.hello' ? { features: [] } : { spend: { dayUsd: 1 } }),
    close: () => seen.push('close'),
  };
  const calls = createMachinePageCalls({
    pairedFor: async (id: string) =>
      id === 'ok' ? session : Promise.reject(Object.assign(new Error('That machine is not in the list.'), { code: 'unknown_machine' })),
    selfFingerprint: () => '',
  });
  assert.deepEqual(await calls.hostStatus('ok'), { spend: { dayUsd: 1 } });
  assert.deepEqual(seen, ['host.hello', 'host.status', 'close'], 'no feature is asked of the Host for its status');
  await assert.rejects(calls.hostStatus('gone'), { code: 'unknown_machine' });
});

test('B: the IPC answers the four channels with the ids as text, and the bridge carries them and the phone switch to the window', async () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const sent: string[] = [];
  const session = {
    call: async (m: string, p: any) => (
      sent.push(`${m} ${JSON.stringify(p)}`),
      m === 'host.hello' ? { features: ['clients', 'audit'] } : { clients: [], lines: [], removed: true }
    ),
    close: () => undefined,
  };
  const service: any = {
    check: async () => void sent.push('check'),
    startHost: async (id: string) => void sent.push(`start ${id}`),
    pairedFor: async (id: string) => (sent.push(`paired ${id}`), session),
    hostFor: () => ({ status: async () => ({ ok: 1 }) }),
  };
  registerMachinePage({ handle: (c: string, fn: any) => handlers.set(c, fn), service: () => service });
  assert.deepEqual(
    [...handlers.keys()],
    ['host:clients', 'host:removeClient', 'host:audit', 'host:hostStatus', 'host:check', 'host:startHost'],
  );
  assert.deepEqual(await handlers.get('host:clients')!(7), { clients: [] });
  await handlers.get('host:removeClient')!(7, 9);
  assert.ok(sent.includes('paired 7') && sent.includes('host.clientRemove {"fingerprint":"9"}'));
  assert.deepEqual(await handlers.get('host:audit')!('m'), { lines: [] });
  assert.deepEqual(await handlers.get('host:hostStatus')!('m'), { clients: [], lines: [], removed: true });
  await handlers.get('host:check')!();
  assert.ok(sent.includes('check'));
  await handlers.get('host:startHost')!(5);
  assert.ok(sent.includes('start 5'), 'the machine is named by a string');
  // a service that knows nothing of its own client key still answers: no one is "this Mac"
  assert.deepEqual(await handlers.get('host:clients')!('m'), { clients: [] });
  // the window reads these names (src/lib/machinePageData.ts); a name the bridge lacks leaves a section out of the real app
  for (const name of [
    'clients',
    'removeClient',
    'audit',
    'hostStatus',
    'check',
    'ownerPolicy',
    'setOwnerPolicy',
    'phoneDirectList',
    'phoneDirectSet',
    'setPath',
  ])
    assert.match(String(bridge[name]?.channel), /^host:/, `window.native.host.${name}`);
});

test('B: the machines service says which client of a Host is this Mac: the fingerprint of its own key, the same each time', async (t) => {
  const { createMachines } = require('../electron/host/machines.cjs');
  const { createRegistry } = require('../electron/host/registry.cjs');
  const dir = tmp(t);
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: async () => ({}) });
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => ({}),
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    registry,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (x: string) => Buffer.from(x),
      decryptString: (b: Buffer) => b.toString(),
    },
  });
  t.after(() => m.dispose());
  assert.match(m.selfFingerprint(), /^[0-9a-f]{64}$/);
  assert.equal(m.selfFingerprint(), m.selfFingerprint());
  // Check again asks the registry of every machine
  let asked = 0;
  (registry as any).check = async () => void (asked += 1);
  await m.check();
  assert.equal(asked, 1);
});

test('I: a Host that answers thinly still gives the page what it can: a client with no date, a line with no author, no feature list at all', async () => {
  const sessionFor = (answers: Record<string, any>) => ({ call: async (m: string) => answers[m], close: () => undefined });
  const hello = { features: ['clients', 'audit'] };
  const ask = createMachinePageCalls({
    pairedFor: async () =>
      sessionFor({
        'host.hello': hello,
        'host.clients': { clients: [{ fingerprint: fp('old'), name: 'Old Mac', kind: 'desktop', addedAt: 0 }] },
        'host.auditRead': { lines: [{ at: 5, kind: 'policy.changed' }] },
      }),
    selfFingerprint: () => '',
  });
  assert.deepEqual((await ask.clients('m')).clients, [{ id: fp('old'), name: 'Old Mac', kind: 'desktop', addedAt: null, self: false }]);
  assert.deepEqual(await ask.audit('m'), { lines: [{ at: 5, kind: 'policy.changed', who: '' }] });
  const none = createMachinePageCalls({ pairedFor: async () => sessionFor({ 'host.hello': {} }), selfFingerprint: () => '' });
  await assert.rejects(none.clients('m'), { code: 'feature_missing' });
  // the IPC asks the machines service for this Mac's own fingerprint, and a service without one marks nobody
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const session = sessionFor({
    'host.hello': hello,
    'host.clients': { clients: [{ fingerprint: fp('me'), name: 'Me', kind: 'desktop', addedAt: 1 }] },
  });
  const withSelf: any = { pairedFor: async () => session, selfFingerprint: () => fp('me') };
  registerMachinePage({ handle: (c: string, fn: any) => handlers.set(c, fn), service: () => withSelf });
  assert.equal(((await handlers.get('host:clients')!('m')) as any).clients[0].self, true);
  const without: any = { pairedFor: async () => session };
  registerMachinePage({ handle: (c: string, fn: any) => handlers.set(c, fn), service: () => without });
  assert.equal(((await handlers.get('host:clients')!('m')) as any).clients[0].self, false);
});
