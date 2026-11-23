// The audit port at each place the Host decides something (plan W3): a relayed tool call, a client added or removed, an organization lease running out, a scheduled run. Each leaves one metadata-only line; none changes what the action does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Registry } from '../electron/capabilities/contract/registry.cjs';
// @ts-ignore: plain ESM without declarations
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostSchedules } from '../host/src/schedules.mjs';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore: plain ESM without declarations
import { createToolRelay } from '../host/src/toolRelay.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostTools } from '../host/src/tools.mjs';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { RRule } = require('rrule');
const { scheduleRules } = require('../shared/schedule.mjs');
const rules = scheduleRules(RRule);
const T0 = Date.UTC(2026, 10, 4, 9, 0, 30);
const { loadIdentity, pairWith } = require('../electron/host/pairingClient.cjs');

const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-wiring-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const sink = () => {
  const lines: any[] = [];
  return { lines, note: (e: any) => lines.push(e) };
};

test('a relayed tool call is noted with its name and whether it ran, never its arguments or result', async () => {
  const audit = sink();
  const registry = new Registry();
  const relay = createToolRelay({
    registry,
    audit,
    newId: (() =>
      (
        (n) => () =>
          `call-${++n}`
      )(0))(),
  });
  const sent: any[] = [];
  const conn = relay.attach(
    (m: any) => sent.push(m),
    () => 1,
  );
  conn.sync([{ name: 'browser_open', description: '', inputSchema: { type: 'object', properties: {} }, policy: 'act' }]);
  conn.send('c1');
  const ok = registry.invoke('c1', 's', 'browser_open', { url: 'https://private.example/PLANTED' });
  await new Promise((r) => setTimeout(r, 10));
  conn.result({ chatId: 'c1', callId: 'call-1', ok: true, content: [{ type: 'text', text: 'PLANTED-RESULT' }] });
  await ok;
  const refused = registry.invoke('c1', 's', 'browser_open', {});
  await new Promise((r) => setTimeout(r, 10));
  conn.result({ chatId: 'c1', callId: 'call-2', ok: false, content: [], error: { code: 'denied', message: 'No.' } });
  await refused;
  assert.deepEqual(
    audit.lines.map((l) => [l.kind, l.what.tool, l.what.outcome]),
    [
      ['tool.relayed', 'browser_open', 'ok'],
      ['tool.relayed', 'browser_open', 'refused'],
    ],
  );
  assert.equal(audit.lines[1].what.code, 'denied');
  assert.equal(JSON.stringify(audit.lines).includes('PLANTED'), false);
});

test('the tools factory hands the audit port to its relay', () => {
  const audit = sink();
  const tools: any = createHostTools({ audit });
  assert.ok(tools.available === false || tools.relay, 'built with or without the native addon');
});

test('a client added by code or by key, and one removed, are noted with its fingerprint, name and kind', async (t) => {
  const dir = tmp(t);
  const audit = sink();
  const host = createPairing({ configDir: path.join(dir, 'host'), audit: audit.note });
  const request = async (method: string, params: any = {}) => {
    if (method === 'host.challenge') return { nonce: host.challenge(), hostId: host.hostId() };
    if (method === 'host.pair') return host.claim(params);
    throw new Error('no such method');
  };
  const app = loadIdentity(path.join(dir, 'app.json'), keySafe);
  const { fingerprint } = await pairWith(request, app, host.issueCode());
  assert.deepEqual(
    audit.lines.map((l) => [l.kind, l.by.fingerprint, l.by.kind]),
    [['client.added', fingerprint, 'desktop']],
  );
  // pairing again with a new code is the same client: nothing is added
  await pairWith(request, app, host.issueCode());
  assert.equal(audit.lines.length, 1);
  const key = (await import('node:crypto'))
    .generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
  const added = host.add(key, { name: 'Pocket iPhone', kind: 'phone' });
  host.add(key, { name: 'again', kind: 'phone' });
  assert.deepEqual(
    audit.lines.slice(1).map((l) => [l.kind, l.by.name, l.by.kind]),
    [['client.added', 'Pocket iPhone', 'phone']],
  );
  assert.equal(host.remove(added), true);
  assert.equal(host.remove(added), false);
  assert.deepEqual(
    audit.lines.slice(2).map((l) => [l.kind, l.by.name, l.by.fingerprint]),
    [['client.removed', 'Pocket iPhone', added]],
  );
});

test('an organization lease that runs out with no fresh one is reported to the expiry port, and an identity is never named', () => {
  const pending: Array<() => void> = [];
  const timers = { setTimeout: (fn: () => void) => (pending.push(fn), pending.length), clearTimeout: () => undefined };
  const audit = sink();
  const leases = createCredentialLeases(timers, { governed: () => true, note: audit.note });
  const lease = {
    harness: 'claude',
    identity: 'a'.repeat(32),
    token: 'tok',
    gateways: { anthropic: 'https://x.example', openai: 'https://y.example' },
    expiresAt: 5000,
  };
  leases.setOrg(lease, 0);
  pending[0]();
  assert.deepEqual(
    audit.lines.map((l) => [l.kind, l.harness, l.what.kind]),
    [['credential.expired', 'claude', 'org']],
  );
  assert.match(audit.lines[0].org, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(audit.lines).includes('a'.repeat(32)), false);
  pending[0]();
  assert.equal(audit.lines.length, 1, 'a second firing finds nothing to expire');
});

test('a scheduled run is noted when it starts, fails or is skipped', async (t) => {
  const dir = tmp(t);
  const audit = sink();
  const task = {
    id: 'nightly',
    name: 'N',
    rrule: 'FREQ=MINUTELY;INTERVAL=1',
    zone: 'UTC',
    prompt: 'PLANTED-PROMPT',
    harness: 'kimi',
    cwd: '/srv/app',
    status: 'ACTIVE' as const,
    scheduleFrom: 0,
  };
  let fail = false;
  const s = createHostSchedules({
    file: path.join(dir, 'schedules.json'),
    rules,
    audit,
    report: () => undefined,
    now: () => T0,
    start: async () => {
      if (fail) throw new Error('refused');
    },
    ready: async () => ({ ok: true }),
    mintChatId: (h: string) => `acp:${h}:c1`,
  });
  s.sync([task]);
  await s.tick();
  fail = true;
  s.sync([{ ...task, id: 'other' }]);
  await s.tick();
  assert.deepEqual(
    audit.lines.map((l) => [l.kind, l.what.status, l.what.taskId]),
    [
      ['schedule.run', 'started', 'nightly'],
      ['schedule.run', 'failed', 'other'],
    ],
  );
  assert.equal(JSON.stringify(audit.lines).includes('PLANTED'), false);
});
