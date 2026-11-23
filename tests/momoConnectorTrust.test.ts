// How the connector hub's calls reach MoMo's trust layer (electron/momo/sourceTrust.cjs connectorDecide / connectorAudit, #2999 C0): each call decided by the sentinel as a private source at Read & ask to change under the connector's own source id and label, a change asking and a read running; the audit log gets a refusal, or an intent and its outcome, with the chat's identity and never the provider's answer. The hub wired in createMomoSources refuses calls with no trust layer and has no browser without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-fixtures.ts';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { connectorDecide, connectorAudit, connectorSource } = require('../electron/momo/sourceTrust.cjs');
const { createMomoSources } = require('../electron/momo/sources/index.cjs');

const call = { kind: 'change', connector: 'fake', label: 'Fake', tool: 'send', chatId: 'mc', summary: 'send one', args: { to: 'x' } };

test('connectorDecide: the connector is a private source at Read & ask to change, the call named by tool and identity', async () => {
  const seen: any[] = [];
  const sentinel = {
    setSource: (id: string, s: any) => seen.push(['source', id, s]),
    decide: async (c: any) => (seen.push(['decide', c]), c.kind === 'read' ? { allow: true } : { allow: false, reason: 'denied' }),
  };
  const decide = connectorDecide(sentinel, () => ({ harness: 'claude', account: 'acc' }));
  assert.deepEqual(await decide(call), { allow: false, reason: 'denied' });
  assert.deepEqual(await decide({ ...call, kind: 'read', args: undefined }), { allow: true });
  assert.deepEqual(seen[0], ['source', 'connector:fake', { level: 'ask', private: true, name: 'Fake' }]);
  // a proxied MCP tool names its own source and tool
  await decide({ ...call, toolName: 'momo_mcp_x_y', source: 'mcp:claude:x' });
  assert.deepEqual(seen.at(-2), ['source', 'mcp:claude:x', { level: 'ask', private: true, name: 'Fake' }]);
  assert.equal(seen.at(-1)[1].tool, 'momo_mcp_x_y');
  assert.equal(seen.at(-1)[1].source, 'mcp:claude:x');
  // the account's own level when the hub gives one (a paused or read-only account)
  await decide({ ...call, level: 'read' });
  assert.deepEqual(seen.at(-2), ['source', 'connector:fake', { level: 'read', private: true, name: 'Fake' }]);
  assert.deepEqual(seen[1][1], {
    chatId: 'mc',
    tool: 'momo_fake_send',
    source: 'connector:fake',
    kind: 'change',
    summary: 'send one',
    args: { action: 'send', args: { to: 'x' } },
    // a change that names people sends to them (recipients.cjs)
    egress: { recipients: ['x'] },
    reaches: true,
    harness: 'claude',
    account: 'acc',
  });
  assert.deepEqual(seen[3][1].args, { action: 'send', args: null });
  assert.equal(connectorSource('gmail'), 'connector:gmail');
  // without an identity
  assert.deepEqual(await connectorDecide(sentinel)({ ...call, kind: 'read' }), { allow: true });
});

test('connectorAudit: a refusal, or an intent and its outcome (done or not sent with why), with identity', async () => {
  const log: any[] = [];
  const audit = {
    refusal: async (f: any) => log.push(['refusal', f]),
    intent: async (f: any) => (log.push(['intent', f]), { id: 'e1' }),
    outcome: async (id: string, o: any) => log.push(['outcome', id, o]),
  };
  const a = connectorAudit(audit, () => ({ harness: 'codex' }));
  await a.append({ connector: 'fake', tool: 'send', chatId: 'mc', decision: 'read-only', args: { to: 'x' } });
  await a.append({ connector: 'fake', tool: 'list', chatId: 'mc', decision: 'allowed', result: 'done' });
  await a.append({ connector: 'fake', tool: 'list', chatId: 'mc', decision: 'allowed', result: 'failed', reason: 'stale' });
  await connectorAudit(audit).append({ connector: 'fake', tool: 'list', chatId: 'mc', decision: 'allowed', result: 'failed' });
  assert.deepEqual(log[0], [
    'refusal',
    { action: 'fake.send', chatId: 'mc', harness: 'codex', args: { action: 'send', args: { to: 'x' } }, decision: 'read-only' },
  ]);
  assert.deepEqual(log[1][1], {
    action: 'fake.list',
    chatId: 'mc',
    harness: 'codex',
    args: { action: 'list', args: null },
    decision: 'allowed',
  });
  assert.deepEqual(log[2], ['outcome', 'e1', { result: 'done', note: '' }]);
  assert.deepEqual(log[4], ['outcome', 'e1', { result: 'not sent', note: 'stale' }]);
  assert.deepEqual(log[6], ['outcome', 'e1', { result: 'not sent', note: '' }]);
});

test('createMomoSources builds the connector hub over the vault; without a trust layer it refuses and has no browser', async () => {
  const s = createMomoSources({ dir: scratch(), safeStorage: fakeSafe(), allowed: () => true, decide: null, audit: null, helper: null });
  assert.equal(s.connectorHub.vault, s.connectorVault);
  assert.equal(s.connectorHub.decide, null);
  await assert.rejects(Promise.resolve(s.connectorHub.openExternal('https://x.example')), /No browser/);
  const opened: string[] = [];
  const wired = createMomoSources(
    { dir: scratch(), safeStorage: fakeSafe(), allowed: () => true, decide: null, audit: null, helper: null },
    { decide: async () => ({ allow: true }), audit: { append: () => undefined }, openExternal: (u: string) => void opened.push(u) },
  );
  wired.connectorHub.openExternal('u');
  assert.deepEqual(opened, ['u']);
  assert.notEqual(wired.connectorHub.decide, null);
});

test('createMomoSources registers the test connector only when asked (E2E runs), and reads MCP configs only when given', async () => {
  const base = { dir: scratch(), safeStorage: fakeSafe(), allowed: () => true, decide: null, audit: null, helper: null };
  const plain = createMomoSources(base, { decide: null, audit: null, openExternal: () => {} });
  assert.deepEqual(plain.connectorHub.list(), []);
  // no coding-side configs given: no MCP servers
  assert.deepEqual(await plain.mcpProxy.catalog(), []);
  const dir = scratch();
  const withMcp = createMomoSources(
    { ...base, dir },
    {
      decide: null,
      audit: null,
      openExternal: () => {},
      mcp: { plugins: async () => [], claudeConfig: `${dir}/none.json`, codexConfig: `${dir}/none.toml` },
    },
  );
  assert.deepEqual(await withMcp.mcpProxy.catalog(), []);
  const s = createMomoSources({ ...base, dir: scratch() }, { decide: null, audit: null, openExternal: () => {}, fake: true });
  assert.deepEqual(
    s.connectorHub.list().map((c: any) => c.id),
    ['test-account', 'test-mail-home', 'test-mail-work'],
  );
});

test('in main, the connector hub opens the system browser and is wired to the trust layer', async () => {
  const w = world({ allowed: true });
  await w.m.sources.connectorHub.openExternal('https://consent.example/');
  assert.ok(w.opened.includes('https://consent.example/'));
  assert.notEqual(w.m.sources.connectorHub.decide, null);
  assert.notEqual(w.m.sources.connectorHub.audit, null);
  await w.m.close();
});
