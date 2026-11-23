// What a chat can do, computed in main (electron/session/caps.cjs) from the chat's segment and what
// the harness negotiated, and how a window runs a semantic from it (src/store/session/runSemantic.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNativeStub } from './support/ports/native.ts';

const require = createRequire(import.meta.url);
const {
  CapsService,
  computeCaps,
  flagsFor,
  codexModelInfo,
  claudeModelInfo,
  providerProfile,
  gatewayEntry,
  acpNegotiated,
  negotiated,
} = require('../electron/session/caps.cjs');
const { codexBindings, claudeBindings, acpBindings } = require('../electron/harness/bindings.cjs');
const { SEMANTICS } = require('../shared/caps.mjs');
const adapter = await import('../src/harness/adapter.ts');

// a stand-in for the window's native bridge, before runSemantic loads it
const calls: any[] = [];
let fakeCaps: any = null;
(globalThis as any).window = {
  native: {
    session: {
      caps: async () => fakeCaps,
      send: async (...a: any[]) => (calls.push(a), { action: 'started', id: 'x' }),
    },
  },
};
// the window's bridge, installed in the native port (src/lib/native.ts)
installNativeStub((globalThis as any).window.native);
const { runSemantic, fillTemplate, refusalText } = await import('../src/store/session/runSemantic.ts');
const { registerSemantic } = await import('../src/harness/adapters/semantics.ts');

const codexModel = (o: any = {}) => ({
  model: 'gpt-x',
  id: 'gpt-x',
  displayName: 'GPT X',
  isDefault: true,
  inputModalities: ['text', 'image'],
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
  serviceTiers: [{ id: 'priority' }],
  ...o,
});
const claudeModel = (o: any = {}) => ({
  value: 'opus',
  displayName: 'Opus',
  supportedEffortLevels: ['low', 'high'],
  supportsFastMode: true,
  ...o,
});
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

function service(o: any = {}) {
  const chats: Record<string, any> = o.chats ?? { c1: { kind: 'codex', key: 'tid' }, c2: { kind: 'claude', key: 'claude:sid' } };
  return new CapsService({
    ref: (id: string) => chats[id] ?? null,
    record: (id: string) => ({ meta: o.meta?.[id] ?? {}, segments: [{ kind: chats[id]?.kind, model: o.segModel?.[id] ?? null }] }),
    session: (id: string) => o.session?.[id] ?? { turn: 'idle', acp: null },
    isEnabled: o.isEnabled ?? (() => true),
    codex: async () => ('codex' in o ? o.codex : { version: '0.162.0', models: [codexModel()], negotiated: { probes: {}, flags: {} } }),
    claude: {
      version: () => '2.1.295',
      probeInfo: () => ('probe' in o ? o.probe : { models: [claudeModel()], fastBlocked: null }),
      appliedOf: () => o.applied ?? null,
    },
    instances: (h: string) => o.instances?.[h] ?? [inst(h)],
    chatInstance: o.chatInstance,
    codexAuth: o.codexAuth,
    modelCaps: async () => o.modelCaps ?? null,
    prefs: () => o.prefs ?? {},
    acpQuirks: o.acpQuirks,
  });
}

test('every harness takes a position on every semantic', () => {
  for (const b of [codexBindings(null), claudeBindings(null), acpBindings(null)]) {
    assert.deepEqual(Object.keys(b).sort(), [...SEMANTICS].sort());
  }
  assert.deepEqual([...adapter.SEMANTICS], [...SEMANTICS]);
});

test('voice requires a ChatGPT lane; keys, credits and expired accounts keep dictation', async () => {
  for (const account of [
    inst('codex', { billing: 'apiKey' }),
    inst('codex', { billing: 'credits' }),
    inst('codex', { status: 'expired' }),
  ]) {
    const r = await service({ instances: { codex: [account] }, codexAuth: () => 'chatgpt' }).get('c1');
    assert.equal(r.caps.voiceChat.state, 'disabled');
    assert.equal(r.caps.voiceChat.why.code, 'account.voiceChatRequiresChatGPT');
    assert.equal(r.caps.dictation.state, 'sage');
  }
  assert.equal((await service({ codexAuth: () => 'apiKey' }).get('c1')).caps.voiceChat.state, 'disabled');
  assert.equal((await service({ codexAuth: () => 'chatgpt' }).get('c1')).caps.voiceChat.state, 'native');
});

test("voice reads the live native-thread pin, else the active account, never Claude's saved login", async () => {
  const seen: any[] = [];
  const pinned = inst('codex', { account: 'pinned', active: false });
  const active = inst('codex', { billing: 'apiKey' });
  const s = service({
    instances: { codex: [active, pinned] },
    meta: { c1: { account: { id: 'default', pinned: false } } },
    chatInstance: (h: string, key: string) => {
      seen.push([h, key]);
      return pinned;
    },
  });
  assert.equal((await s.get('c1')).caps.voiceChat.state, 'native');
  assert.deepEqual(seen, [['codex', 'tid']]);
  const keyed = service({ chatInstance: () => active });
  assert.equal((await keyed.get('c1')).caps.voiceChat.state, 'disabled');
  assert.equal((await service({ chatInstance: () => null }).get('c1')).caps.voiceChat.state, 'native');
  // a login saved by a Claude segment of the same chat never stands for its Codex account
  assert.equal(
    (await service({ instances: { codex: [active, pinned] }, meta: { c1: { account: { id: 'pinned', pinned: true } } } }).get('c1')).caps
      .voiceChat.state,
    'disabled',
  );
  assert.equal((await service({ instances: { codex: [] } }).get('c1')).caps.voiceChat.state, 'native');
  await s.get(null, { kind: 'codex' });
  assert.deepEqual(seen.at(-1), ['codex', null]);
});

test('Claude and ACP keep shared dictation while accurately refusing native realtime', async () => {
  for (const kind of ['claude', 'acp:kimi']) {
    const r = await service({
      chats: { source: { kind, key: 'source-key' } },
      instances: { claude: [inst('claude', { billing: 'credits', provider: { id: 'mopilot', firstParty: false } })] },
    }).get('source');
    assert.deepEqual(r.caps.voiceChat, { state: 'absent', via: 'none', why: { layer: 'harness', code: 'harness.noVoiceConversation' } });
    assert.equal(r.caps.dictation.state, 'sage');
  }
});

test('a Codex chat: goals by rpc, Init polyfilled, feedback by rpc, voice native', async () => {
  const r = await service().get('c1');
  assert.equal(r.kind, 'codex');
  assert.equal(r.tier, 'first');
  assert.deepEqual(r.caps.goal, { state: 'native', via: 'rpc' });
  assert.deepEqual(r.caps.init, { state: 'sage', via: 'polyfill', engine: 'init' });
  assert.equal(r.caps.feedback.state, 'native');
  assert.equal(r.caps.voiceChat.state, 'native');
  assert.equal(r.caps.speed.state, 'native');
  assert.equal(r.caps.computerUse.state, 'sage');
  assert.equal(r.caps.shell.via, 'rpc');
});

test('a Claude chat: goals pass through, shell and archive are Sage, feedback and voice are not offered here', async () => {
  const r = await service().get('c2');
  assert.equal(r.kind, 'claude');
  assert.deepEqual(r.caps.goal, { state: 'native', via: 'passthrough', template: '/goal {args}' });
  assert.equal(r.caps.shell.state, 'sage');
  assert.equal(r.caps.archive.state, 'sage');
  assert.equal(r.caps.feedback.state, 'absent');
  assert.deepEqual(r.caps.feedback.why, { layer: 'harness', code: 'harness.feedbackTerminalOnly' });
  // Every entry uses this current-chat capability; none moves the user to another harness.
  assert.deepEqual(r.caps.voiceChat, { state: 'absent', via: 'none', why: { layer: 'harness', code: 'harness.noVoiceConversation' } });
  assert.equal(r.caps.init.via, 'passthrough');
});

test('Codex model layer: Ultra and Fast follow the chat model', async () => {
  const noUltra = codexModel({ supportedReasoningEfforts: [{ reasoningEffort: 'low' }], serviceTiers: [] });
  const r = await service({ codex: { version: '1', models: [noUltra], negotiated: { probes: {}, flags: {} } } }).get('c1');
  assert.equal(r.caps.multiAgent.state, 'disabled');
  assert.equal(r.caps.multiAgent.why.code, 'model.noMultiAgent');
  assert.equal(r.caps.speed.why.code, 'model.noFast');
  assert.equal(r.caps.speed.fix, 'switchModel');
  // the chat's own model wins over the default
  const other = codexModel({ model: 'gpt-y', id: 'gpt-y', isDefault: false, serviceTiers: [] });
  const s = service({
    codex: { version: '1', models: [codexModel(), other], negotiated: { probes: {}, flags: {} } },
    meta: { c1: { config: { model: 'gpt-y' } } },
  });
  assert.equal((await s.get('c1')).caps.speed.state, 'disabled');
  assert.equal(
    (await service({ codex: { version: '1', models: [codexModel(), other], negotiated: { probes: {}, flags: {} } } }).get('c1')).caps.speed
      .state,
    'native',
  );
});

test('Automatic capabilities follow the recommendation ahead of stale segments and defaults, for either first-tier harness', async () => {
  const codex = {
    version: '0.162.0',
    models: [codexModel({ model: 'old', isDefault: false, serviceTiers: [] }), codexModel()],
    negotiated: { probes: {}, flags: {} },
  };
  const probe = {
    models: [{ value: 'default', resolvedModel: 'sonnet' }, claudeModel({ supportsFastMode: false }), claudeModel({ value: 'sonnet' })],
  };
  for (const [chat, pinned] of [
    ['c1', 'old'],
    ['c2', 'opus'],
  ]) {
    const s = service({
      codex,
      probe,
      meta: { [chat]: { config: { model: null } } },
      segModel: { [chat]: pinned },
      prefs: { model: 'old', claudeSelection: { model: 'opus' } },
    });
    assert.equal((await s.get(chat)).caps.speed.state, 'native');
    assert.equal((await s.get(chat, { model: pinned })).caps.speed.state, 'disabled', 'an explicit window pick can precede its save');
    assert.equal((await s.get(chat, { model: null })).caps.speed.state, 'native', 'an explicit Automatic hint is not a stale receipt');
  }
});

test('Claude capabilities retain explicit brain pins and imported native picks until Automatic is chosen', async () => {
  const probe = { models: [claudeModel(), claudeModel({ value: 'brain', supportsFastMode: false })] };
  const brain = service({ probe, meta: { c2: { momo: 'main', momoModel: 'brain', config: { model: null } } } });
  assert.equal(
    (await brain.get('c2', { model: 'opus' })).caps.speed.state,
    'disabled',
    'the brain pin owns execution over an ordinary pick',
  );
  const legacy = service({ probe, segModel: { c2: 'brain' }, prefs: { claudeSelection: { model: 'opus' } } });
  assert.equal((await legacy.get('c2')).caps.speed.state, 'disabled');
  const automatic = service({ probe, segModel: { c2: 'brain' }, meta: { c2: { config: { model: null } } } });
  assert.equal((await automatic.get('c2')).caps.speed.state, 'native');
});

test('Codex flag layer: goals turned off in Codex, and a remote kill switch', async () => {
  const r = await service({
    codex: {
      version: '1',
      models: [codexModel()],
      negotiated: { probes: {}, flags: { 'features.goals': false, 'features.memories': true } },
    },
  }).get('c1');
  assert.equal(r.caps.goal.state, 'disabled');
  assert.deepEqual(r.caps.goal.why, { layer: 'flag', code: 'flag.off.goal', fix: 'enableFeature' });
  assert.equal(r.caps.memory.state, 'native');
  const killed = await service({ isEnabled: (k: string) => k !== 'shared.computerUse.enabled' }).get('c1');
  assert.equal(killed.caps.computerUse.state, 'disabled');
  assert.equal(killed.caps.computerUse.why.code, 'flag.killed');
  // a browser channel that is still on keeps browser control
  const one = await service({ isEnabled: (k: string) => k !== 'shared.browser.extension' }).get('c1');
  assert.equal(one.caps.browser.state, 'sage');
});

test('Codex version layer: a probe that failed greys out its capability only', async () => {
  const r = await service({
    codex: { version: '1', models: [codexModel()], negotiated: { probes: { 'codex.review': false, 'codex.goals': true }, flags: {} } },
  }).get('c1');
  assert.deepEqual(r.caps.review.why, { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' });
  assert.equal(r.caps.goal.state, 'native');
  assert.equal(r.caps.compact.state, 'native');
});

test('Codex app-server not up yet: no model or feature layer, bindings stand', async () => {
  const r = await service({ codex: null }).get('c1');
  assert.equal(r.caps.speed.state, 'native');
  assert.equal(r.caps.goal.state, 'native');
});

test('MoPilot credits: Fast follows the gateway table on Codex, and is off on Claude', async () => {
  const mopilot = { id: 'mopilot', wires: [], baseUrl: '', firstParty: false };
  const codexOn = service({
    instances: { codex: [inst('codex', { provider: mopilot, billing: 'credits' })] },
    modelCaps: { 'gpt-x': { fast: true } },
  });
  assert.equal((await codexOn.get('c1')).caps.speed.state, 'native');
  const codexOff = service({
    instances: { codex: [inst('codex', { provider: mopilot, billing: 'credits' })] },
    modelCaps: { 'gpt-x': { fast: false } },
  });
  assert.equal((await codexOff.get('c1')).caps.speed.why.code, 'provider.noFast.mopilot');
  const claudeMo = service({ instances: { claude: [inst('claude', { provider: mopilot, billing: 'credits' })] } });
  assert.deepEqual((await claudeMo.get('c2')).caps.speed.why, { layer: 'provider', code: 'provider.noFast.mopilot' });
  // a model the gateway table doesn't list: the gateway decides
  const unlisted = service({
    instances: { codex: [inst('codex', { provider: mopilot, billing: 'credits' })] },
    modelCaps: { other: { fast: false } },
  });
  assert.equal((await unlisted.get('c1')).caps.speed.state, 'native');
  // a custom endpoint is not first-party: Fast is dropped by the provider layer
  const custom = service({
    instances: {
      claude: [
        inst('claude', { provider: { id: 'custom:x.dev', wires: [], baseUrl: 'https://x.dev', firstParty: false }, billing: 'apiKey' }),
      ],
    },
  });
  assert.equal((await custom.get('c2')).caps.speed.why.code, 'provider.noFast');
});

test('MoPilot drops: the gateway table drops are mirrored and a Claude alias resolves to a gateway id', () => {
  const mo = { id: 'mopilot', wires: [], baseUrl: '', firstParty: false };
  const table = {
    'gpt-x': { wires: ['responses'], fast: true, drops: ['multiAgent'] },
    'claude-opus-4-1': { wires: ['anthropic'], fast: false, drops: ['speed', 'effort'] },
    'claude-opus-4-5': { wires: ['anthropic'], fast: false, drops: ['speed', 'deepReasoning'] },
  };
  assert.deepEqual(providerProfile({ harness: 'codex', provider: mo }, { id: 'gpt-x' }, table).drops, ['multiAgent']);
  assert.deepEqual(providerProfile({ harness: 'claude', provider: mo }, { id: 'opus[1m]' }, table).drops, ['speed', 'deepReasoning']);
  assert.equal(gatewayEntry(table, 'sonnet'), null);
  assert.equal(gatewayEntry(table, 'gpt-x'), table['gpt-x']);
  assert.deepEqual(providerProfile({ harness: 'codex', provider: mo }, { id: 'nope' }, table).drops, []);
});

test('Claude account layer: the CLI says why Fast is blocked', async () => {
  const r = await service({ probe: { models: [claudeModel()], fastBlocked: 'extra_usage_disabled' } }).get('c2');
  assert.equal(r.caps.speed.state, 'disabled');
  assert.equal(r.caps.speed.why.code, 'account.noFast.extra_usage_disabled');
  const noFastModel = await service({ probe: { models: [claudeModel({ supportsFastMode: false })], fastBlocked: null } }).get('c2');
  assert.equal(noFastModel.caps.speed.why.code, 'model.noFast');
  // the hint names the chat's own model before it has sent anything
  const haiku = claudeModel({ value: 'haiku', supportsFastMode: false });
  const s = service({ probe: { models: [claudeModel(), haiku], fastBlocked: null } });
  assert.equal((await s.get('c2')).caps.speed.state, 'native');
  assert.equal((await s.get('c2', { model: 'haiku' })).caps.speed.state, 'disabled');
  // a variant takes its base model's support
  assert.equal((await s.get('c2', { model: 'opus[1m]' })).caps.speed.state, 'native');
});

test('Claude version layer: getSettings missing greys out multi-agent only once a session says so', async () => {
  const before = await service().get('c2');
  assert.equal(before.caps.multiAgent.state, 'native');
  const missing = await service({ applied: { probe: 'missing', available: false } }).get('c2');
  assert.deepEqual(missing.caps.multiAgent.why, { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' });
  assert.equal(missing.caps.goal.state, 'native');
  const ok = await service({ applied: { probe: 'ok', available: true } }).get('c2');
  assert.equal(ok.caps.multiAgent.state, 'native');
});

test('session layer: a running turn allows queued compact; another app running the chat greys out the rest', async () => {
  const running = await service({ session: { c2: { turn: 'running' } } }).get('c2');
  assert.equal(running.caps.compact.state, 'native');
  assert.equal(running.caps.goal.state, 'native');
  const elsewhere = await service().get('c2', { elsewhere: true });
  assert.equal(elsewhere.caps.goal.why.code, 'session.runningElsewhere');
  assert.equal(elsewhere.caps.status.state, 'native');
  // main's own session state says so (reconcile.cjs), with no hint from the window, on every harness
  for (const id of ['c1', 'c2']) {
    const marked = await service({ session: { [id]: { turn: 'idle', runningElsewhere: true } } }).get(id);
    assert.equal(marked.caps.goal.why.code, 'session.runningElsewhere', id);
    assert.equal(marked.caps.compact.why.code, 'session.runningElsewhere', id);
  }
  const temp = await service().get('c1', { temporary: true });
  assert.equal(temp.caps.goal.why.code, 'session.temporaryGoal');
});

test('a chat that has not started takes its harness from the hint; no chat and no hint is null', async () => {
  const s = service();
  assert.equal((await s.get(null, { kind: 'claude' })).kind, 'claude');
  assert.equal(await s.get(null), null);
});

test('a basic harness: only what its command catalog and modes declare, no polyfills', async () => {
  const acp = {
    commands: [{ name: 'goal' }, { name: 'compress' }],
    modes: { availableModes: [{ id: 'a' }] },
    configOptions: [{ id: 'model', category: 'model' }],
  };
  const s = service({
    chats: { k1: { kind: 'acp:kimi', key: 'k' } },
    session: { k1: { turn: 'idle', acp } },
    acpQuirks: (kind: string) => (kind === 'acp:kimi' ? { plan: { mode: 'a' } } : null),
  });
  const r = await s.get('k1');
  assert.equal(r.tier, 'basic');
  assert.equal(r.caps.goal.via, 'passthrough');
  assert.equal(r.caps.compact.template, '/compress {args}');
  assert.equal(r.caps.permissions.state, 'native');
  assert.equal(r.caps.model.state, 'native');
  assert.equal(r.caps.review.state, 'absent');
  assert.equal(r.caps.init.state, 'absent');
  assert.equal(r.caps.shell.state, 'absent');
  assert.equal(r.caps.computerUse.state, 'sage');
  // its quirks' plan marker reaches the plan binding
  assert.equal(r.caps.plan.state, 'native');
  // the same modes as the agent's own are no permission modes (#1875)
  const own = service({
    chats: { k1: { kind: 'acp:kimi', key: 'k' } },
    session: { k1: { turn: 'idle', acp } },
    acpQuirks: () => ({ agentModes: ['a'] }),
  });
  assert.equal((await own.get('k1')).caps.permissions.state, 'absent');
  // nothing pushed yet: a bare harness only has the shared capabilities
  const bare = await service({ chats: { k1: { kind: 'acp:dsh', key: 'k' } } }).get('k1');
  assert.equal(bare.caps.goal.state, 'absent');
  assert.equal(bare.caps.browser.state, 'sage');
});

test('pure pieces: model info, provider drops and flags', () => {
  assert.deepEqual(codexModelInfo(codexModel({ serviceTiers: [{ id: 'priority' }, { id: 'flex' }, { id: 'default' }] })).serviceTiers, [
    'priority',
    'flex',
  ]);
  assert.equal(codexModelInfo(codexModel()).ultra, true);
  assert.equal(claudeModelInfo(claudeModel(), { available: false }).ultra, false);
  assert.equal(claudeModelInfo(null), null);
  assert.deepEqual(providerProfile(null, null, null), null);
  assert.deepEqual(
    flagsFor(() => true, { 'features.goals': true }),
    { 'features.goals': true },
  );
  assert.deepEqual(
    flagsFor((k: string) => !k.startsWith('shared.dictation'), {}),
    { 'sage.dictation': false },
  );
  const caps = computeCaps({ kind: 'codex', negotiated: null, provider: null, model: null, account: null, flags: {}, session: null });
  assert.equal(caps.goal.state, 'native');
});

test('runSemantic: refused with its reason, run by a harness handler, or passed through as text', async () => {
  const cap = (o: any) => ({ state: 'native', via: 'rpc', ...o });
  fakeCaps = {
    kind: 'acp:kimi',
    tier: 'basic',
    caps: {
      goal: cap({}),
      compact: { state: 'disabled', via: 'none', why: { layer: 'session', code: 'session.turnRunning' } },
      review: { state: 'absent', via: 'none' },
      init: cap({ via: 'passthrough', template: '/init' }),
      deepReasoning: cap({ via: 'passthrough', template: 'ultrathink {args}' }),
      skills: cap({ via: 'rpc' }),
    },
  };
  assert.deepEqual(await runSemantic('c1', 'compact'), {
    ok: false,
    state: 'disabled',
    why: { layer: 'session', code: 'session.turnRunning' },
    kind: 'acp:kimi',
  });
  assert.deepEqual(await runSemantic('c1', 'review'), { ok: false, state: 'absent', why: null, kind: 'acp:kimi' });
  // an rpc binding with no handler for this harness has no way to run
  assert.deepEqual(await runSemantic('c1', 'skills'), {
    ok: false,
    state: 'absent',
    why: { layer: 'harness', code: 'harness.undeclared' },
    kind: 'acp:kimi',
  });
  registerSemantic('acp:kimi', 'goal', ({ chatId, args }) => `${chatId}:${args}`);
  assert.deepEqual(await runSemantic('c1', 'goal', 'pause'), { ok: true, value: 'c1:pause' });
  const r: any = await runSemantic('c2', 'deepReasoning', 'think hard');
  assert.equal(r.ok, true);
  assert.deepEqual(calls.at(-1), ['c2', { text: 'ultrathink think hard', attachments: [], opts: { human: true } }]);
  assert.equal(fillTemplate('/goal {args}', ''), '/goal');
  assert.equal(fillTemplate('/goal {args}', 'Keep $$ and $& literally'), '/goal Keep $$ and $& literally');
  // what the user is told when it was refused
  assert.equal(
    refusalText({ ok: false, state: 'disabled', why: { layer: 'flag', code: 'flag.off.goal' }, kind: 'codex' }, 'goal'),
    'Goals are off in Codex · Turn on goals',
  );
  assert.equal(refusalText({ ok: false, state: 'absent', why: null, kind: 'acp:kimi' }, 'review'), "Kimi Code doesn't support code review");
  assert.equal(
    refusalText({ ok: false, state: 'disabled', why: { layer: 'provider', code: 'provider.noFast.mopilot' }, kind: 'codex' }, 'speed'),
    "Fast isn't available on MoPilot yet · Use your ChatGPT account",
  );
  fakeCaps = null;
  assert.deepEqual(await runSemantic('c1', 'goal'), { ok: false, state: 'absent', why: null });
});

test('a basic harness chat takes its account lane from the ACP identity driver', async () => {
  const seen: string[] = [];
  const s = service({ chats: { k1: { kind: 'acp:kimi', key: 'k' } } });
  s.o.accounts = (h: string) => (seen.push(h), { failover: 'none', perChat: false, usage: 'none' });
  const r = await s.get('k1');
  assert.deepEqual(seen, ['acp']);
  assert.equal(r.tier, 'basic');
  assert.deepEqual(acpNegotiated({ accounts: { failover: 'none', perChat: false, usage: 'none' } }).accounts, {
    failover: 'none',
    perChat: false,
    usage: 'none',
  });
  // the lane doesn't change what the chat can do
  assert.deepEqual(r.caps, (await service({ chats: { k1: { kind: 'acp:kimi', key: 'k' } } }).get('k1')).caps);
});

test('a harness kind this build does not know has no capabilities, and its negotiation and caps are errors', async () => {
  assert.equal(await service().get(null, { kind: 'gemini' }), null);
  assert.equal(await service({ chats: { g: { kind: 'gemini', key: 'g' } } }).get('g'), null);
  const bare = { negotiated: null, provider: null, model: null, account: null, flags: {}, session: null };
  assert.throws(() => computeCaps({ kind: 'gemini', ...bare }), /Unknown harness kind/);
  assert.throws(() => negotiated('gemini', {}), /Unknown harness kind/);
});

test("each family's negotiation comes from the one table: first-tier declarations, a basic harness's account lane", () => {
  const codex = negotiated('codex', { version: '1' });
  const claude = negotiated('claude', { version: '2' });
  assert.deepEqual(
    [codex.prompt.pdf, codex.session.fork, codex.session.ephemeral, codex.toolInjection, codex.events.tasks, codex.accounts.perChat],
    [false, 'whole', 'native', 'threadConfigMcp', 'cancelAll', false],
  );
  assert.deepEqual(
    [claude.prompt.pdf, claude.session.fork, claude.session.ephemeral, claude.toolInjection, claude.events.tasks, claude.accounts.perChat],
    [true, 'upToTurn', 'none', 'sdkMcp', 'stoppable', true],
  );
  assert.deepEqual(codex.ext, { realtimeVoice: true, cloudTasks: true, feedbackUpload: true });
  assert.deepEqual(claude.ext, { outputStyle: true });
  // each answer is its own copy: a caller that changes one can't change the declarations
  assert.notEqual(negotiated('codex', {}).ext, codex.ext);
  const lane = { failover: 'none', perChat: false, usage: 'none' };
  assert.deepEqual(negotiated('acp:kimi', { accounts: lane }), acpNegotiated({ accounts: lane }));
});

test('MoPilot credits on Claude: the gateway table decides Fast for the alias, with the MoPilot why-text', async () => {
  const { whyText } = await import('../src/harness/caps.ts');
  const mopilot = { id: 'mopilot', wires: [], baseUrl: '', firstParty: false };
  const claude = { instances: { claude: [inst('claude', { provider: mopilot, billing: 'credits' })] } };
  const on = service({ ...claude, modelCaps: { 'claude-opus-4-5': { wires: ['anthropic'], fast: true, drops: [] } } });
  assert.equal((await on.get('c2')).caps.speed.state, 'native');
  const off = service({ ...claude, modelCaps: { 'claude-opus-4-5': { wires: ['anthropic'], fast: false, drops: ['speed'] } } });
  const why = (await off.get('c2')).caps.speed.why;
  // as unknown: deepEqual's assertion signature would otherwise narrow `why` to the literal's type
  assert.deepEqual(why as unknown, { layer: 'provider', code: 'provider.noFast.mopilot' });
  assert.equal(whyText(why, { account: 'Claude subscription' }), "Fast isn't available on MoPilot yet · Use your Claude subscription");
});
