// The `artifacts` capability (publishing pages, slides and designs to claude.ai): Claude Code's Artifact tool through
// its config binding, none on Codex and ACP, and the account, flag and session layers that turn it off with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CapsService, flagsFor } = require('../electron/session/caps.cjs');
const { codexBindings, claudeBindings, acpBindings } = require('../electron/harness/bindings.cjs');
const { accountGate, flagGate, sessionGate } = require('../shared/caps.mjs');
const { WHY } = await import('../src/harness/copy.ts');
const { FEATURE_LABEL, whyText } = await import('../src/harness/caps.ts');

const inst = (harness: string, o: any = {}) => ({
  id: `${harness}:default`,
  harness,
  account: 'default',
  billing: 'subscription',
  active: true,
  status: 'ok',
  provider: { id: harness === 'codex' ? 'openai' : 'anthropic', wires: [], baseUrl: '', firstParty: true },
  ...o,
});

/** A Claude chat (c2), a Codex chat (c1) and an ACP chat (k1), with what main reads of the Artifact tool. */
function service(o: any = {}) {
  const chats: Record<string, any> = {
    c1: { kind: 'codex', key: 'tid' },
    c2: { kind: 'claude', key: 'claude:sid' },
    k1: { kind: 'acp:kimi', key: 'k' },
  };
  const seen: any[] = [];
  const s = new CapsService({
    ref: (id: string) => chats[id] ?? null,
    record: (id: string) => ({ meta: {}, segments: [{ kind: chats[id]?.kind, model: null }] }),
    session: (id: string) => ('session' in o ? o.session : { turn: 'idle', acp: null }),
    isEnabled: o.isEnabled ?? (() => true),
    codex: async () => ({ version: '0.162.0', models: [], negotiated: { probes: {}, flags: {} } }),
    claude: {
      version: () => '2.1.295',
      probeInfo: () => ({ models: [], fastBlocked: null }),
      appliedOf: () => null,
      ...('art' in o
        ? {
            artifactsOf: (key: string | null, account?: string) => (seen.push([key, account]), o.art),
          }
        : {}),
    },
    instances: (h: string) => o.instances?.[h] ?? [inst(h)],
    prefs: () => ({}),
  });
  return { s, seen };
}

const art = async (o: any, chat = 'c2', hint?: any) => (await service(o).s.get(chat, hint)).caps.artifacts;
const ON = { on: true, tool: null, claudeAi: true };

test('Claude Code binds the Artifact tool through its variable; Codex and ACP have none, with a reason', () => {
  assert.deepEqual(claudeBindings().artifacts, { via: 'config', option: 'CLAUDE_CODE_ARTIFACT', value: true });
  const none = { via: 'none', why: { layer: 'harness', code: 'harness.noArtifacts' } };
  assert.deepEqual(codexBindings(null).artifacts, none);
  assert.deepEqual(acpBindings(null).artifacts, none);
  assert.equal(WHY['harness.noArtifacts'], "This chat's harness can't publish artifacts or designs.");
  assert.equal(FEATURE_LABEL.artifacts, 'artifacts and designs');
});

test('the gates: a non-claude.ai login, the user switch after a kill, and a process without the tool', () => {
  assert.deepEqual(accountGate({ billing: 'apiKey', perChat: true, fast: true, artifacts: false }).artifacts, {
    layer: 'account',
    code: 'account.artifactsNeedClaudeAi',
  });
  assert.equal(accountGate({ billing: 'subscription', perChat: true, fast: true, artifacts: true }).artifacts, undefined);
  assert.deepEqual(flagGate({ 'user.artifacts': false }).artifacts, { layer: 'flag', code: 'flag.artifactsUserOff', fix: 'enableFeature' });
  // a kill wins over the user's own switch
  assert.equal(flagGate({ 'user.artifacts': false, 'sage.artifacts': false }).artifacts.code, 'flag.killed');
  assert.equal(flagGate({ 'user.artifacts': true }).artifacts, undefined);
  assert.deepEqual(sessionGate({ turn: 'idle', runningElsewhere: false, artifacts: false }).artifacts, {
    layer: 'session',
    code: 'session.artifactsOff',
  });
  assert.equal(sessionGate({ turn: 'idle', runningElsewhere: false, artifacts: true }).artifacts, undefined);
  // another app running the chat says so instead
  assert.equal(sessionGate({ turn: 'idle', runningElsewhere: true, artifacts: false }).artifacts.code, 'session.runningElsewhere');
  for (const code of ['account.artifactsNeedClaudeAi', 'flag.artifactsUserOff', 'session.artifactsOff']) assert.ok(WHY[code], code);
  assert.equal(
    whyText({ layer: 'flag', code: 'flag.artifactsUserOff' }, { semantic: 'artifacts', label: 'Claude Code' }),
    'Artifacts and designs are off in Claude Code · Turn them on in Settings',
  );
});

test('the kill flag native.claude.artifacts turns the semantic off', () => {
  assert.equal(flagsFor((k: string) => k !== 'native.claude.artifacts', {}, 'claude')['sage.artifacts'], false);
  assert.equal(flagsFor(() => true, {}, 'claude')['sage.artifacts'], undefined);
});

test('a Claude chat on a claude.ai subscription has it natively, and main is asked with its session key and login', async () => {
  const { s, seen } = service({ art: ON });
  const c = (await s.get('c2')).caps.artifacts;
  assert.equal(c.state, 'native');
  assert.equal(c.via, 'config');
  assert.deepEqual(seen, [['claude:sid', 'default']]);
  // a new chat has no session key yet; MoPilot's own keys are asked for with no login
  const fresh = service({ art: ON, instances: { claude: [inst('claude', { account: 'apiKey', kind: 'sageKey', billing: 'apiKey' })] } });
  assert.equal((await fresh.s.get(null, { kind: 'claude' })).caps.artifacts.state, 'native');
  assert.deepEqual(fresh.seen, [[null, undefined]]);
  // a build whose Claude section can't say keeps the binding
  assert.equal((await art({})).state, 'native');
});

test('an API key, MoPilot credits or a cloud route is not a claude.ai subscription', async () => {
  for (const billing of ['apiKey', 'credits']) {
    const c = await art({
      art: { ...ON, claudeAi: false },
      instances: { claude: [inst('claude', { billing, kind: 'sageKey', account: billing })] },
    });
    assert.equal(c.state, 'disabled');
    assert.equal(c.why.code, 'account.artifactsNeedClaudeAi');
  }
  // no instance at all: no account layer to say so
  assert.equal((await art({ art: { ...ON, claudeAi: false }, instances: { claude: [] } })).state, 'native');
});

test("the live process's init tools decide the session layer", async () => {
  assert.equal((await art({ art: { ...ON, tool: true } })).state, 'native');
  const off = await art({ art: { ...ON, tool: false } });
  assert.equal(off.state, 'disabled');
  assert.equal(off.why.code, 'session.artifactsOff');
  // a process that started before the switch was turned on says so, not that the user's settings turned it off
  assert.deepEqual((await art({ art: { ...ON, tool: false, stale: true } })).why, {
    layer: 'session',
    code: 'session.artifactsStarted',
    fix: 'newChat',
  });
  // no session in the store: nothing to read, unless another app runs it
  assert.equal((await art({ art: { ...ON, tool: false }, session: null })).state, 'native');
  assert.equal((await art({ art: { ...ON, tool: false }, session: null }, 'c2', { elsewhere: true })).why.code, 'session.runningElsewhere');
});

test('the user switch and the kill flag turn it off, each with its own reason', async () => {
  const user = await art({ art: { ...ON, on: false } });
  assert.equal(user.state, 'disabled');
  assert.deepEqual(user.why, { layer: 'flag', code: 'flag.artifactsUserOff', fix: 'enableFeature' });
  assert.equal(user.fix, 'enableFeature');
  const killed = await art({ art: { ...ON, on: false }, isEnabled: (k: string) => k !== 'native.claude.artifacts' });
  assert.equal(killed.why.code, 'flag.killed');
});

test('Codex and ACP chats show it as absent with the harness reason, whatever main reads', async () => {
  for (const chat of ['c1', 'k1']) {
    const c = await art({ art: ON }, chat);
    assert.equal(c.state, 'absent');
    assert.deepEqual(c.why, { layer: 'harness', code: 'harness.noArtifacts' });
  }
});
