// The audit record holds no content (plan W3, D11): every request, card and tool the Host governs is given text, a command, a path and a secret, and the whole audit folder is searched for them afterwards.
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
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore: plain ESM without declarations
import { createToolRelay } from '../host/src/toolRelay.mjs';

const PLANTED = [
  'MESSAGE-TEXT-9f3a',
  'rm -rf /srv/PLANTED-CMD',
  '/home/alice/PLANTED-PATH/secret.txt',
  'sk-ant-PLANTED-KEY',
  'PLANTED-TOKEN',
  'alice@PLANTED.example',
];

const folderText = (dir: string) =>
  fs
    .readdirSync(dir)
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
    .join('\n');

test('no planted message, command, path, key or identity reaches the audit folder at the default detail', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-content-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'audit');
  const audit = createAudit({ dir });
  const by = { fingerprint: 'a'.repeat(64), name: 'Pocket iPhone', kind: 'phone' };
  const policy = createPolicy({ audit });
  policy.checkRequest('chat.start', { chatId: 'c1', harness: 'claude', text: PLANTED[0], cwd: PLANTED[2] }, 'phone', by);
  policy.checkRequest('chat.send', { chatId: 'c1', text: PLANTED[0], images: [{ path: PLANTED[2] }] }, 'phone', by);
  const leases = createCredentialLeases(undefined, audit);
  leases.set('claude', PLANTED[3]);
  leases.setOrg({ harness: 'claude', identity: PLANTED[5], token: PLANTED[4], gateways: {}, expiresAt: Date.now() + 60_000 }, Date.now());
  let now = 0;
  const engine: any = createApprovals({
    record: () => undefined,
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 1,
    familyOf: () => 'claude',
    now: () => now,
    after: () => () => undefined,
    audit,
  });
  engine.seen('c1', {
    kind: 'permission',
    requestId: 'r1',
    turnId: 't1',
    toolCall: { title: PLANTED[1], kind: 'execute', rawInput: { command: PLANTED[1], path: PLANTED[2] } },
    options: [{ optionId: 'allow', name: PLANTED[0], kind: 'allow_once' }],
  });
  engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by });
  const relay = createToolRelay({ registry: { abortChat() {} } as any, audit });
  assert.ok(relay, 'the relay takes the audit port');
  audit.note({
    kind: 'tool.relayed',
    chat: 'c1',
    what: { tool: 'screenshot', outcome: 'ok', arguments: PLANTED[2], result: PLANTED[0], command: PLANTED[1] },
  });
  const pairing = createPairing({ configDir: path.join(base, 'cfg'), audit: (e: any) => audit.note(e) });
  const { publicKey } = (await import('node:crypto')).generateKeyPairSync('ed25519');
  pairing.add(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), { name: 'Pocket iPhone', kind: 'phone' });
  const text = folderText(dir);
  assert.ok(text.length > 400, 'the record is not empty');
  for (const planted of PLANTED) assert.equal(text.includes(planted), false, `${planted} must not be recorded`);
});

test('at full detail only the bounded one-line summary is added, never the raw input', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-content-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const audit = createAudit({ dir: path.join(base, 'audit'), settings: () => ({ detail: 'full' }) });
  audit.note({ kind: 'approval.asked', what: { tool: 'execute', summary: 'git push origin main'.padEnd(400, '!'), rawInput: PLANTED[1] } });
  const text = folderText(path.join(base, 'audit'));
  assert.ok(text.includes('git push origin main'));
  assert.equal(text.includes(PLANTED[1]), false);
  assert.ok(JSON.parse(text.trim()).what.summary.length <= 160);
});
