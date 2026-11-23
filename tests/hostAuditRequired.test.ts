// `audit.required` (host/src/audit.mjs, policy.mjs, approvals.mjs, plan W3 and scenario S6): a governed action runs only after its line was written; a failed write refuses it with `audit_unavailable` and the next action tries again; without it, one report and the action goes on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAudit } from '../host/src/audit.mjs';
// @ts-ignore: plain ESM without declarations
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore: plain ESM without declarations
import { createApprovals } from '../host/src/approvals.mjs';
// @ts-ignore: plain ESM without declarations
import { auditFor } from '../host/src/auditWiring.mjs';
// @ts-ignore: plain ESM without declarations
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import methodFile from '../host/src/methods/audit.mjs';

const world = (t: any, required = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-req-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let failing = false;
  const io: any = {
    ...fs,
    appendFileSync: (...a: any[]) => {
      if (failing) throw new Error('disk full');
      return (fs.appendFileSync as any)(...a);
    },
  };
  const reports: string[] = [];
  const audit = createAudit({ dir: path.join(dir, 'audit'), io, settings: () => ({ required }), report: (m: string) => reports.push(m) });
  return { dir, audit, reports, fail: (v: boolean) => (failing = v) };
};
const WHO = { fingerprint: 'f'.repeat(64), name: 'Pocket iPhone', kind: 'phone' };

test('W2: a failed write refuses a governed action with audit_unavailable, and the next one succeeds and is marked', (t) => {
  const w = world(t);
  w.audit.governed({ kind: 'chat.started', chat: 'a' });
  w.fail(true);
  assert.throws(
    () => w.audit.governed({ kind: 'chat.message', chat: 'b' }),
    (e: any) => e.code === 'audit_unavailable' && /not done/.test(e.message),
  );
  w.fail(false);
  assert.equal(w.audit.governed({ kind: 'chat.message', chat: 'c' }), true);
  const { lines } = w.audit.read();
  assert.deepEqual(
    lines.map((l: any) => [l.seq, l.chat]),
    [
      [1, 'a'],
      [2, 'c'],
    ],
  );
  assert.equal(lines[1].segment, 'recovered');
  assert.equal(w.reports.length, 1);
});

test('without audit.required a failure is reported once and the action goes on', (t) => {
  const w = world(t, false);
  w.fail(true);
  assert.equal(w.audit.governed({ kind: 'chat.message' }), false);
  assert.equal(w.audit.governed({ kind: 'chat.message' }), false);
  w.audit.note({ kind: 'chat.message' });
  assert.equal(w.reports.length, 1);
  w.fail(false);
  assert.equal(w.audit.governed({ kind: 'chat.message' }), true);
  w.fail(true);
  w.audit.note({ kind: 'chat.message' });
  assert.equal(w.reports.length, 2, 'reported again after a success');
});

test('a write failing before anything was written marks the first line', (t) => {
  const w = world(t);
  w.fail(true);
  assert.throws(() => w.audit.governed({ kind: 'chat.message' }), { code: 'audit_unavailable' });
  w.fail(false);
  w.audit.note({ kind: 'chat.message' });
  assert.equal(w.audit.read().lines[0].segment, 'recovered');
});

test('S6: the policy writes the line before a start, a send and a mode change run; a refusal is noted; a failed write stops the action', (t) => {
  const w = world(t);
  const managedFile = {
    effectivePolicy: () => ({
      state: 'valid',
      doc: { permission: { max: 'default' }, audit: { required: true } },
      organization: null,
      problem: null,
    }),
  };
  const policy = createPolicy({ managedFile, audit: w.audit });
  policy.checkRequest('chat.start', { chatId: 'c1', harness: 'claude', permission: 'default' }, 'phone', WHO);
  policy.checkRequest('chat.send', { chatId: 'c1', text: 'secret prompt' }, 'phone', WHO);
  policy.checkRequest('chat.permit', { chatId: 'c1', value: 'read-only' }, 'phone', WHO);
  assert.throws(() => policy.checkRequest('chat.permit', { chatId: 'c1', value: 'full-access' }, 'phone', WHO), { code: 'policy_refused' });
  policy.checkRequest('chat.start', { chatId: 'c2', harness: 'claude' }, 'desktop');
  policy.checkRequest('chat.answer', { chatId: 'c1' }, 'phone', WHO);
  const { lines } = w.audit.read();
  assert.deepEqual(
    lines.map((l: any) => l.kind),
    ['chat.started', 'permission.set', 'chat.message', 'permission.set', 'permission.set', 'chat.started'],
  );
  const refused = lines[4];
  assert.deepEqual(refused.what, { decision: 'refused', code: 'policy_refused', key: 'permissionMax' });
  assert.deepEqual(refused.by, { fingerprint: WHO.fingerprint, name: 'Pocket iPhone', kind: 'phone' });
  assert.deepEqual(lines[5].by, { kind: 'desktop' });
  assert.equal(JSON.stringify(lines).includes('secret prompt'), false);
  w.fail(true);
  assert.throws(() => policy.checkRequest('chat.send', { chatId: 'c1' }, 'phone', WHO), { code: 'audit_unavailable' });
});

test('credentials lent are recorded by kind, an organization lease by identity hash only; a failed write refuses the lending', (t) => {
  const w = world(t);
  const leases = createCredentialLeases(undefined, w.audit);
  const gateways = { anthropic: 'https://x.example', openai: 'https://y.example' };
  const org = { harness: 'claude', identity: 'alice@acme.example', gateways, expiresAt: Date.now() + 60_000 };
  leases.set('claude', 'sk-ant-secret');
  leases.set('claude', null);
  leases.setOrg({ ...org, token: 'tok-secret' }, Date.now());
  leases.setOrg({ harness: 'claude', identity: 'alice@acme.example', token: null }, Date.now());
  const { lines } = w.audit.read();
  assert.deepEqual(
    lines.map((l: any) => [l.kind, l.what.kind]),
    [
      ['credential.lent', 'key'],
      ['credential.lent', 'org'],
    ],
  );
  const text = JSON.stringify(lines);
  for (const secret of ['sk-ant-secret', 'tok-secret', 'alice@acme.example']) assert.equal(text.includes(secret), false);
  assert.match(lines[1].org, /^[0-9a-f]{16}$/);
  w.fail(true);
  assert.throws(() => leases.set('codex', 'sk-other'), { code: 'audit_unavailable' });
  assert.equal(leases.has('codex'), false, 'a key that could not be recorded is not held');
});

test('a scheduled run is recorded before it starts, and a policy replace is noted', (t) => {
  const w = world(t);
  const policy = createPolicy({ audit: w.audit, dataDir: path.join(w.dir, 'p') });
  policy.checkScheduled({ harness: 'claude' });
  policy.replace(
    { doc: { version: 1, permissionMax: 'default', approvals: { remindMinutes: 10, pauseMinutes: 30 }, notify: {} } },
    'desktop',
  );
  const { lines } = w.audit.read();
  assert.deepEqual(
    lines.map((l: any) => l.kind),
    ['chat.started', 'policy.changed'],
  );
  assert.match(lines[1].what.generation, /^[0-9a-f]{64}$/);
  assert.equal(policy.auditSettings().required, undefined);
});

test('S6: a card answered is recorded with who, the tool and the wait; with audit.required a failed write leaves the card waiting', (t) => {
  const w = world(t);
  let now = 1_000;
  const engine: any = createApprovals({
    record: () => undefined,
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 1,
    familyOf: () => 'claude',
    now: () => now,
    after: () => () => undefined,
    audit: w.audit,
  });
  const card = (id: string) => ({
    kind: 'permission',
    requestId: id,
    turnId: 't1',
    toolCall: { title: 'git push', kind: 'execute' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });
  engine.seen('c1', card('r1'));
  engine.seen('c1', card('r2'));
  now += 41_000;
  const claim = engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by: WHO });
  assert.equal(claim.optionKind, 'allow');
  w.fail(true);
  assert.throws(() => engine.claim({ chatId: 'c1', requestId: 'r2', optionId: 'allow', by: WHO }), { code: 'audit_unavailable' });
  w.fail(false);
  const again = engine.claim({ chatId: 'c1', requestId: 'r2', optionId: 'allow', by: WHO });
  assert.ok(again, 'the card still waited, so the answer is taken now');
  const lines = w.audit.read().lines;
  assert.deepEqual(
    lines.map((l: any) => l.kind),
    ['approval.asked', 'approval.asked', 'approval.answered', 'approval.answered'],
  );
  assert.deepEqual(lines[2].what, { tool: 'execute', decision: 'allow', waitedMs: 41_000, cardKind: 'permission' });
  assert.equal(lines[2].by.name, 'Pocket iPhone');
  assert.equal(lines[2].turn, 't1');
  assert.equal(JSON.stringify(lines).includes('git push'), false);
});

test('a card that expires or is skipped is noted without waiting for anyone', (t) => {
  const w = world(t);
  let now = 0;
  const timers: Array<() => void> = [];
  const engine: any = createApprovals({
    record: () => undefined,
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 1,
    familyOf: () => 'claude',
    now: () => now,
    after: (fn: () => void) => (timers.push(fn), () => undefined),
    audit: w.audit,
    times: () => ({ remindMs: 10, pauseMs: 20 }),
  });
  const card = (id: string) => ({ kind: 'permission', requestId: id, toolCall: { title: 'x', kind: 'edit' }, options: [] });
  engine.seen('c1', card('r1'));
  now = 20;
  timers[1]();
  engine.scheduled('c2', 'skip');
  engine.seen('c2', card('r9'));
  const kinds = w.audit.read().lines.map((l: any) => `${l.kind}:${l.what.status ?? l.what.waitedMs ?? ''}`);
  assert.deepEqual(kinds, ['approval.asked:', 'approval.expired:20', 'approval.expired:skipped']);
});

test('host.auditRead serves desktop and cli clients, refuses a phone, and says when there is no record', (t) => {
  const w = world(t);
  w.audit.note({ kind: 'chat.message' });
  const { handlers } = (methodFile as any)({ audit: w.audit });
  const read = handlers['host.auditRead'];
  assert.equal(read({ after: 0, limit: 10 }, 'desktop').lines.length, 1);
  assert.equal(read({ after: 0, limit: 10 }, 'cli').lines.length, 1);
  assert.throws(() => read({ after: 0, limit: 10 }, 'phone'), { code: 'forbidden' });
  assert.throws(() => (methodFile as any)({}).handlers['host.auditRead']({}, 'desktop'), /no audit record/);
});

test('auditFor builds the writer from the policy, its settings and its generation', (t) => {
  const w = world(t);
  const policy = createPolicy({
    managedFile: {
      effectivePolicy: () => ({ state: 'valid', doc: { audit: { required: true, retentionDays: 7 } }, organization: null, problem: null }),
    },
  });
  const wired = auditFor({ dataDir: w.dir, report: () => undefined, policy: () => policy });
  wired.note({ kind: 'chat.message' });
  assert.equal(wired.read().lines[0].policy, policy.generation());
  assert.deepEqual(policy.auditSettings(), { required: true, retentionDays: 7 });
});
