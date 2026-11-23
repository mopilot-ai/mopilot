// Capability resolution and presentation: every layer, every CapState.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveCaps, present, whyText, POLYFILLS } = await import('../src/harness/caps.ts');
const { SEMANTICS, WHY_LAYERS } = await import('../src/harness/adapter.ts');
type Binding = import('../src/harness/adapter.ts').Binding;
type Semantic = import('../src/harness/adapter.ts').Semantic;
type CapsInput = import('../src/harness/caps.ts').CapsInput;

const allNative = (): Record<Semantic, Binding> =>
  Object.fromEntries(SEMANTICS.map((s) => [s, { via: 'rpc', method: s }])) as Record<Semantic, Binding>;
const harnessNone = (code = 'harness.undeclared'): Binding => ({ via: 'none', why: { layer: 'harness', code } });
const base = (o: Partial<CapsInput> = {}): CapsInput => ({ tier: 'first', bindings: allNative(), ...o });

const negotiated = (probes: Record<string, boolean>) => ({ probes }) as unknown as CapsInput['negotiated'];
const model = (o: Partial<NonNullable<CapsInput['model']>> = {}) =>
  ({
    id: 'm',
    label: 'M',
    input: ['text', 'image'],
    efforts: ['low', 'high'],
    ultra: true,
    serviceTiers: ['priority'],
    ...o,
  }) as NonNullable<CapsInput['model']>;
const provider = (id: string, drops: string[]) =>
  ({ id, wires: ['anthropic'], baseUrl: '', firstParty: false, models: [], drops }) as NonNullable<CapsInput['provider']>;
const session = (o: Partial<NonNullable<CapsInput['session']>> = {}) =>
  ({
    rev: 1,
    turn: 'idle',
    runningElsewhere: false,
    config: [],
    modes: [],
    mode: 'default',
    plan: false,
    commands: [],
    goal: null,
    tasks: [],
    context: null,
    ...o,
  }) as NonNullable<CapsInput['session']>;

test('with nothing in the way every semantic keeps the adapter binding', () => {
  const caps = resolveCaps(base());
  for (const s of SEMANTICS) assert.deepEqual(caps[s], { via: 'rpc', method: s });
});

test('an undeclared semantic counts as a harness-layer none', () => {
  const b = allNative();
  delete (b as Partial<typeof b>).cloud;
  assert.deepEqual(resolveCaps(base({ bindings: b })).cloud, { via: 'none', why: { layer: 'harness', code: 'harness.undeclared' } });
});

test('harness layer: a none from the adapter stays when no polyfill applies', () => {
  const b = { ...allNative(), voiceChat: harnessNone() };
  assert.equal(resolveCaps(base({ bindings: b })).voiceChat.via, 'none');
});

test('polyfill replaces a harness-layer none on the first tier', () => {
  const b = { ...allNative(), init: harnessNone(), shell: harnessNone() };
  const caps = resolveCaps(base({ bindings: b }));
  assert.deepEqual(caps.init, { via: 'polyfill', engine: 'init' });
  assert.deepEqual(caps.shell, { via: 'polyfill', engine: 'shell' });
  assert.deepEqual(Object.keys(POLYFILLS).sort(), ['archive', 'init', 'search', 'shell']);
});

test('polyfill never serves the basic tier', () => {
  const b = { ...allNative(), init: harnessNone() };
  assert.equal(resolveCaps(base({ tier: 'basic', bindings: b })).init.via, 'none');
});

test('polyfill waits for its preconditions', () => {
  const b = { ...allNative(), init: harnessNone() };
  const caps = resolveCaps(base({ bindings: b, polyfillReady: (engine) => engine !== 'init' }));
  assert.deepEqual(caps.init, b.init);
});

test('polyfill replaces only a harness-layer none, not one the adapter put on another layer', () => {
  const flagged: Binding = { via: 'none', why: { layer: 'flag', code: 'flag.off.init' } };
  const caps = resolveCaps(base({ bindings: { ...allNative(), init: flagged } }));
  assert.deepEqual(caps.init, flagged);
});

test('a polyfilled semantic can still be blocked by a later layer', () => {
  const b = { ...allNative(), search: harnessNone() };
  const caps = resolveCaps(base({ bindings: b, flags: { 'sage.search': false } }));
  assert.equal(caps.search.via, 'none');
  assert.equal((caps.search as { why: { layer: string } }).why.layer, 'flag');
});

test('version layer: a failed probe greys out only its own capability', () => {
  const caps = resolveCaps(
    base({
      negotiated: negotiated({ 'claude.getSettings': false, 'claude.perTaskStop': true }),
      probesFor: { multiAgent: ['claude.getSettings'], tasks: ['claude.perTaskStop'] },
    }),
  );
  assert.deepEqual(caps.multiAgent, { via: 'none', why: { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' } });
  assert.equal(caps.tasks.via, 'rpc');
  assert.equal(caps.goal.via, 'rpc');
});

test('version layer: a probe that was never run counts as failed', () => {
  const caps = resolveCaps(base({ negotiated: negotiated({}), probesFor: { multiAgent: ['claude.getSettings'] } }));
  assert.equal(caps.multiAgent.via, 'none');
});

test('provider layer: gateway drops, with MoPilot getting its own Fast reason', () => {
  const ds = resolveCaps(base({ provider: provider('deepseek', ['speed', 'cloud']) }));
  assert.deepEqual(ds.speed, { via: 'none', why: { layer: 'provider', code: 'provider.noFast' } });
  assert.deepEqual(ds.cloud, { via: 'none', why: { layer: 'provider', code: 'provider.unsupported' } });
  const mp = resolveCaps(base({ provider: provider('mopilot', ['speed']) }));
  assert.equal((mp.speed as { why: { code: string } }).why.code, 'provider.noFast.mopilot');
});

test('model layer: no fast tier, no ultra, no efforts', () => {
  const caps = resolveCaps(base({ model: model({ serviceTiers: [], ultra: false, efforts: [] }) }));
  for (const [s, code] of [
    ['speed', 'model.noFast'],
    ['multiAgent', 'model.noMultiAgent'],
    ['effort', 'model.noEffort'],
    ['deepReasoning', 'model.noEffort'],
  ] as const)
    assert.deepEqual(caps[s], { via: 'none', why: { layer: 'model', code, fix: 'switchModel' } });
  assert.equal(resolveCaps(base({ model: model() })).speed.via, 'rpc');
});

test('account layer: fast blocked on the account keeps the reported reason', () => {
  const caps = resolveCaps(base({ account: { billing: 'subscription', perChat: true, fast: false, fastBlocked: 'extra_usage_disabled' } }));
  assert.deepEqual(caps.speed, { via: 'none', why: { layer: 'account', code: 'account.noFast.extra_usage_disabled' } });
  const unknown = resolveCaps(base({ account: { billing: 'apiKey', perChat: false, fast: false, fastBlocked: 'something_new' } }));
  assert.equal((unknown.speed as { why: { code: string } }).why.code, 'account.noFast.unavailable');
  assert.equal(resolveCaps(base({ account: { billing: 'apiKey', perChat: false, fast: true } })).speed.via, 'rpc');
  // on a model without Fast too, the account is the reason: switching model wouldn't turn it on
  const both = resolveCaps(
    base({ model: model({ serviceTiers: [] }), account: { billing: 'subscription', perChat: true, fast: false, fastBlocked: 'free' } }),
  );
  assert.deepEqual(both.speed, { via: 'none', why: { layer: 'account', code: 'account.noFast.free' } });
});

test('flag layer: a harness feature turned off and a remote kill switch', () => {
  const caps = resolveCaps(base({ flags: { 'features.goals': false, 'sage.computerUse': false, 'features.memories': true } }));
  assert.deepEqual(caps.goal, { via: 'none', why: { layer: 'flag', code: 'flag.off.goal', fix: 'enableFeature' } });
  assert.deepEqual(caps.computerUse, { via: 'none', why: { layer: 'flag', code: 'flag.killed' } });
  assert.equal(caps.memory.via, 'rpc');
});

test('session layer: temporary chat, running turn, another app', () => {
  assert.deepEqual(resolveCaps(base({ temporary: true })).goal, {
    via: 'none',
    why: { layer: 'session', code: 'session.temporaryGoal', fix: 'newChat' },
  });
  const running = resolveCaps(base({ session: session({ turn: 'running' }) }));
  assert.equal(running.compact.via, 'rpc');
  assert.equal((running.rewind as { why: { code: string } }).why.code, 'session.turnRunning');
  assert.equal(running.goal.via, 'rpc');
  const elsewhere = resolveCaps(base({ session: session({ runningElsewhere: true }) }));
  assert.equal((elsewhere.goal as { why: { code: string } }).why.code, 'session.runningElsewhere');
  assert.equal(elsewhere.status.via, 'rpc');
});

test('the first layer that says no supplies the Why', () => {
  const caps = resolveCaps(
    base({
      bindings: { ...allNative(), speed: { via: 'config', option: 'serviceTier', value: 'priority' } },
      negotiated: negotiated({ fast: false }),
      probesFor: { speed: ['fast'] },
      provider: provider('deepseek', ['speed']),
      model: model({ serviceTiers: [] }),
      account: { billing: 'apiKey', perChat: false, fast: false },
      flags: { 'sage.speed': false },
      session: session({ runningElsewhere: true }),
    }),
  );
  assert.equal((caps.speed as { why: { layer: string } }).why.layer, 'version');
  const order: string[] = [];
  const layered = (drop: number) => {
    const all: Partial<CapsInput> = {
      negotiated: negotiated({ fast: false }),
      probesFor: { speed: ['fast'] },
      provider: provider('x', ['speed']),
      model: model({ serviceTiers: [] }),
      account: { billing: 'apiKey', perChat: false, fast: false },
      flags: { 'sage.speed': false },
      session: session({ runningElsewhere: true }),
    };
    if (drop > 0) delete all.probesFor;
    if (drop > 1) delete all.provider;
    if (drop > 2) delete all.account;
    if (drop > 3) delete all.model;
    if (drop > 4) delete all.flags;
    return (resolveCaps(base(all)).speed as { why: { layer: string } }).why.layer;
  };
  for (let i = 0; i < 6; i++) order.push(layered(i));
  assert.deepEqual(order, WHY_LAYERS.slice(1));
});

test('present: native bindings', () => {
  for (const b of [
    { via: 'rpc', method: 'x' },
    { via: 'passthrough', template: '/goal {args}' },
    { via: 'config', option: 'o', value: 1 },
  ] as Binding[]) {
    assert.equal(present(b, { scope: 'context' }), 'native');
    assert.equal(present(b, { scope: 'global', installed: [] }), 'native');
  }
});

test('present: polyfill is sage', () => {
  assert.equal(present({ via: 'polyfill', engine: 'init' }, { scope: 'context' }), 'sage');
});

test('present: route binding only on a global entry with the target installed', () => {
  const b: Binding = { via: 'route', to: 'codex' };
  assert.equal(present(b, { scope: 'global', installed: ['codex', 'claude'] }), 'route');
  assert.equal(present(b, { scope: 'global', installed: ['claude'] }), 'absent');
  assert.equal(present(b, { scope: 'context' }), 'absent');
});

test('present: a harness-layer none hides context entries and routes global ones when someone else can', () => {
  const b = harnessNone();
  assert.equal(present(b, { scope: 'context' }), 'absent');
  assert.equal(present(b, { scope: 'global', installed: ['claude', 'codex'], capableElsewhere: ['claude'] }), 'route');
  assert.equal(present(b, { scope: 'global', installed: ['codex'], capableElsewhere: ['claude'] }), 'absent');
  assert.equal(present(b, { scope: 'global', installed: ['codex'] }), 'absent');
});

test('present: every other layer is disabled on every entry', () => {
  for (const layer of WHY_LAYERS.filter((l) => l !== 'harness')) {
    const b: Binding = { via: 'none', why: { layer, code: 'x' } };
    assert.equal(present(b, { scope: 'context' }), 'disabled');
    assert.equal(present(b, { scope: 'global', installed: ['codex', 'claude'], capableElsewhere: ['codex'] }), 'disabled');
  }
});

test('Why copy uses the design strings and covers every layer', () => {
  assert.equal(whyText({ layer: 'provider', code: 'provider.noFast' }, { provider: 'DeepSeek' }), "DeepSeek doesn't support Fast");
  assert.equal(
    whyText({ layer: 'provider', code: 'provider.noFast.mopilot' }),
    "Fast isn't available on MoPilot yet · Use your own subscription",
  );
  assert.equal(whyText({ layer: 'flag', code: 'flag.off.goal' }, { label: 'Codex' }), 'Goals are off in Codex · Turn on goals');
  assert.equal(whyText({ layer: 'session', code: 'session.temporaryGoal' }), "Temporary chats can't have goals · Start a regular chat");
  assert.equal(whyText({ layer: 'session', code: 'session.runningElsewhere' }), 'This chat is running in another app');
  assert.equal(whyText({ layer: 'session', code: 'session.turnRunning' }), 'Wait for this turn to finish');
  assert.equal(whyText({ layer: 'model', code: 'model.noAutoApprove' }), "This model can't auto-approve · Switch model");
  assert.equal(
    whyText({ layer: 'version', code: 'version.probeFailed' }, { label: 'Claude Code', version: '2.1.300', feature: 'ultracode' }),
    'Claude Code 2.1.300 changed how ultracode works · Update MoPilot',
  );
  assert.equal(whyText({ layer: 'account', code: 'account.noFast.free' }), 'Fast mode isn’t available on this plan');
  assert.equal(whyText({ layer: 'flag', code: 'flag.killed' }, { semantic: 'computerUse' }), 'Computer control is turned off for now');
  assert.equal(whyText({ layer: 'harness', code: 'nope' }, { label: 'dsh', semantic: 'review' }), "dsh doesn't support code review");
  for (const layer of WHY_LAYERS) assert.ok(whyText({ layer, code: 'not-in-the-table' }).length > 0);
});
