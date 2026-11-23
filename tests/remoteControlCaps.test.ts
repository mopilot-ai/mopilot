// The `remoteControl` capability: the SDK's enableRemoteControl (a session's link to claude.ai) for Claude Code, the app-server's
// remoteControl/* (the computer's link to the user's devices) for Codex, none on ACP with a reason, and the account layer that
// turns it off for a login that is not a claude.ai subscription (Claude Code) or a signed-in ChatGPT one (Codex).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CapsService } = require('../electron/session/caps.cjs');
const { codexBindings, claudeBindings, acpBindings } = require('../electron/harness/bindings.cjs');
const { accountGate, SEMANTICS } = require('../shared/caps.mjs');
const { WHY } = await import('../src/harness/copy.ts');
const { FEATURE_LABEL, whyText } = await import('../src/harness/caps.ts');

const inst = (harness: string) => ({
  id: `${harness}:default`,
  harness,
  account: 'default',
  billing: 'subscription',
  active: true,
  status: 'ok',
  provider: { id: harness === 'codex' ? 'openai' : 'anthropic', wires: [], baseUrl: '', firstParty: true },
});

function service(claudeAi: boolean, codexAuth?: () => string, probes: Record<string, boolean> = {}) {
  const chats: Record<string, any> = {
    c1: { kind: 'codex', key: 'tid' },
    c2: { kind: 'claude', key: 'claude:sid' },
    k1: { kind: 'acp:kimi', key: 'k' },
  };
  return new CapsService({
    ref: (id: string) => chats[id] ?? null,
    record: (id: string) => ({ meta: {}, segments: [{ kind: chats[id]?.kind, model: null }] }),
    session: () => ({ turn: 'idle', acp: null }),
    isEnabled: () => true,
    codex: async () => ({ version: '0.162.0', models: [], negotiated: { probes, flags: {} } }),
    claude: {
      version: () => '2.1.295',
      probeInfo: () => ({ models: [], fastBlocked: null }),
      appliedOf: () => null,
      artifactsOf: () => ({ on: true, tool: null, claudeAi }),
    },
    instances: (h: string) => [inst(h)],
    prefs: () => ({}),
    ...(codexAuth ? { codexAuth } : {}),
  });
}

test('Claude Code asks the live session, Codex its app-server; ACP has none, with the harness reason', () => {
  assert.deepEqual(claudeBindings().remoteControl, { via: 'rpc', method: 'enableRemoteControl' });
  assert.deepEqual(codexBindings(null).remoteControl, { via: 'rpc', method: 'remoteControl/enable' });
  const none = { via: 'none', why: { layer: 'harness', code: 'harness.noRemoteControl' } };
  assert.deepEqual(acpBindings(null).remoteControl, none);
  assert.ok(SEMANTICS.includes('remoteControl'));
  assert.equal(FEATURE_LABEL.remoteControl, 'Remote Control');
  assert.equal(WHY['harness.noRemoteControl'], 'Not available for this chat');
});

test('a login that is not a claude.ai subscription is turned off with its reason', () => {
  assert.deepEqual(accountGate({ billing: 'apiKey', perChat: true, fast: true, remoteControl: false }).remoteControl, {
    layer: 'account',
    code: 'account.remoteControlNeedsClaudeAi',
  });
  assert.equal(accountGate({ billing: 'subscription', perChat: true, fast: true, remoteControl: true }).remoteControl, undefined);
  assert.equal(
    whyText({ layer: 'account', code: 'account.remoteControlNeedsClaudeAi' }, { semantic: 'remoteControl' }),
    'Remote Control needs a claude.ai Pro, Max, Team or Enterprise login. Choose one in Accounts.',
  );
});

test('a Codex login that is not a signed-in ChatGPT subscription is turned off with its reason', async () => {
  assert.deepEqual(accountGate({ billing: 'subscription', perChat: true, fast: true, remoteControlChatGPT: false }).remoteControl, {
    layer: 'account',
    code: 'account.remoteControlNeedsChatGPT',
  });
  assert.equal(accountGate({ billing: 'subscription', perChat: true, fast: true, remoteControlChatGPT: true }).remoteControl, undefined);
  assert.equal(
    whyText({ layer: 'account', code: 'account.remoteControlNeedsChatGPT' }, { semantic: 'remoteControl' }),
    'Remote Control needs a signed-in ChatGPT account. Choose one in Accounts.',
  );
  assert.equal((await service(true).get('c1')).caps.remoteControl.state, 'native');
  const apiKey = (await service(true, () => 'apikey').get('c1')).caps.remoteControl;
  assert.equal(apiKey.state, 'disabled');
  assert.equal(apiKey.why.code, 'account.remoteControlNeedsChatGPT');
});

test('each chat sees its own harness: native on a claude.ai login, disabled on another login, absent on ACP', async () => {
  const on = await service(true).get('c2');
  assert.equal(on.caps.remoteControl.state, 'native');
  const off = await service(false).get('c2');
  assert.equal(off.caps.remoteControl.state, 'disabled');
  assert.equal(off.caps.remoteControl.why.code, 'account.remoteControlNeedsClaudeAi');
  const acp = (await service(true).get('k1')).caps.remoteControl;
  assert.equal(acp.state, 'absent');
  assert.equal(acp.why.code, 'harness.noRemoteControl');
});

test('a Codex whose app-server has no remoteControl/* is told apart by the probe, and one that has it is not', async () => {
  const missing = (await service(true, undefined, { 'codex.remoteControl': false }).get('c1')).caps.remoteControl;
  assert.notEqual(missing.state, 'native');
  const present = (await service(true, undefined, { 'codex.remoteControl': true }).get('c1')).caps.remoteControl;
  assert.equal(present.state, 'native');
});
