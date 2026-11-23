// Harness-agnostic views over the store (src/session/harness/select.ts): status, models, selection, accounts.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';
import { defined } from './support/defined.ts';

const claudeCalls: any[] = [];
mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: Object.fromEntries(
    ['addClaudeAccount', 'pinClaudeChat', 'reloginClaudeAccount', 'removeClaudeAccount', 'switchClaudeAccount', 'recheckClaude'].map(
      (n) => [n, (...a: any[]) => claudeCalls.push([n, ...a])],
    ),
  ),
});
const sel = await import('../src/session/harness/select.ts');
const { applyClaudeKey } = await import('../src/session/harness/billing.ts');
const { claudeThreadId } = await import('../src/harness/types.ts');

const CL = claudeThreadId('sel');
beforeEach(() => {
  reset();
  claudeCalls.length = 0;
  // the Claude key is known (so the hooks don't ask main for it)
  fx.native.claude = { apiKey: () => new Promise(() => {}) };
});

test('window labels and ChatGPT plan names', () => {
  assert.deepEqual([null, 0, 300, 10080, 2880].map(sel.windowLabel), ['Limit', 'Limit', '5h', 'Weekly', '2d']);
  const plan = (planType: any) =>
    sel.codexStatus({ conn: 'ready', account: { type: 'chatgpt', planType }, accounts: { accounts: [], active: null } } as any).plan;
  assert.equal(plan(null), 'ChatGPT');
  assert.equal(plan('unknown'), 'ChatGPT');
  assert.equal(plan('pro'), 'ChatGPT Pro');
  assert.equal(plan('self_serve_business_usage_based'), 'ChatGPT Business Usage Based');
});

test('codexStatus: detecting, missing, broken, incompatible, signed out, API key, ready', () => {
  const st = (s: any) => sel.codexStatus({ accounts: { accounts: [], active: null }, ...s });
  assert.equal(st({ conn: 'connecting' }).state, 'detecting');
  assert.equal(st({ conn: 'idle' }).state, 'detecting');
  const missing = st({ conn: 'error', connError: 'spawn codex ENOENT', codexBin: '/x' });
  assert.deepEqual([missing.state, missing.bin, missing.error], ['missing', null, 'File or program not found.']);
  assert.equal(st({ conn: 'error' }).state, 'error');
  // a copy that keeps quitting as it starts is named on the row
  const copy = { path: '/opt/homebrew/bin/codex', version: '0.163.0', via: 'brew', from: 'Homebrew' };
  assert.equal(
    st({ conn: 'error', connError: 'exited (101)', codexQuit: { copy, pinned: false } }).error,
    'Codex 0.163.0 from Homebrew keeps quitting.',
  );
  const bad = st({ conn: 'ready', codexCompat: { versionStatus: 'tooOld', cliVersion: '0.1.0' } });
  assert.equal(bad.state, 'error');
  assert.match(bad.error!, /0\.1\.0/);
  assert.equal(st({ conn: 'ready', requiresAuth: true }).state, 'signin');
  const key = st({ conn: 'ready', account: { type: 'apiKey' }, codexBin: '/a', codexBinInUse: '/b' });
  assert.deepEqual([key.state, key.plan, key.bin, key.email], ['apikey', 'API key', '/b', null]);
  const ready = st({
    conn: 'ready',
    codexBin: '/a',
    userAgent: 'codex_cli_rs/0.150.2 (Mac)',
    account: { type: 'chatgpt', email: 'a@x' },
    rateLimits: {
      rateLimitsByLimitId: {
        codex: {
          planType: 'plus',
          primary: { windowDurationMins: 300, usedPercent: 41.6, resetsAt: 9 },
          secondary: { windowDurationMins: 10080 },
        },
      },
    },
  });
  assert.deepEqual(
    [ready.state, ready.bin, ready.version, ready.plan, ready.email, ready.error],
    ['ready', '/a', '0.150.2', 'ChatGPT Plus', 'a@x', null],
  );
  assert.deepEqual(ready.usage!.windows, [
    { label: '5h', usedPercent: 42, resetsAt: 9 },
    { label: 'Weekly', usedPercent: 0, resetsAt: null },
  ]);
  const odd = st({ conn: 'ready', userAgent: 'something else', rateLimits: {} });
  assert.deepEqual([odd.version, odd.plan, odd.usage], [null, null, null]);
});

test('codexModels: visible models with their efforts and tiers', () => {
  const models = sel.codexModels({
    models: [
      {
        model: 'gpt-5',
        displayName: 'gpt-5',
        description: 'd',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        defaultReasoningEffort: 'low',
        isDefault: true,
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
      },
      {
        model: 'mini',
        displayName: 'mini',
        description: '',
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        isDefault: false,
      },
      { model: 'old', hidden: true },
    ],
  } as any);
  assert.deepEqual(
    models.map((m) => [m.id, m.efforts, m.fast, m.tiers!.length, m.isDefault]),
    [
      ['gpt-5', ['low'], true, 1, true],
      ['mini', [], false, 0, false],
    ],
  );
});

test('status, models and selection per harness, from the store by default', () => {
  fx.state.conn = 'ready';
  fx.state.claude = { status: { state: 'signin' }, models: [{ id: 'opus' }] };
  fx.state.prefs = {
    ...fx.state.prefs,
    model: 'gpt-5',
    effort: 'high',
    serviceTier: 'priority',
    claudeSelection: { model: 'opus', effort: 'max', fast: true },
  };
  assert.equal(sel.harnessStatus('codex').state, 'ready');
  assert.equal(sel.harnessStatus('claude').state, 'signin');
  assert.deepEqual(sel.harnessModels('codex'), []);
  assert.deepEqual(sel.harnessModels('claude'), [{ id: 'opus' }]);
  assert.deepEqual(sel.selectionFor('codex'), { model: 'gpt-5', effort: 'high', fast: true });
  assert.deepEqual(sel.selectionFor('claude'), { model: 'opus', effort: 'max', fast: true });
});

test('modelName: the label the harness list gives a model id, else the id made readable', () => {
  fx.state.models = [{ model: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol', supportedReasoningEfforts: [] }];
  fx.state.claude = { status: { state: 'ready' }, models: [{ id: 'sonnet', label: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' }] };
  assert.equal(sel.modelName('codex', 'gpt-6.1-sol'), 'GPT-6.1 Sol');
  // not listed (Codex not started yet): still not the raw id
  assert.equal(sel.modelName('codex', 'gpt-6.1-luna'), 'GPT-6.1 Luna');
  assert.equal(sel.modelName('claude', 'sonnet'), 'Sonnet 5.5');
  // the wire id a Claude segment may keep resolves to its picker entry
  assert.equal(sel.modelName('claude', 'claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(sel.modelName('claude', 'claude-other'), 'claude-other');
});

test('useModelsLoading: Codex starting or not yet listed, Claude Code being detected', () => {
  const at = (conn: string, modelsLoaded: boolean) => (
    (fx.state.conn = conn), (fx.state.modelsLoaded = modelsLoaded), sel.useModelsLoading('codex')
  );
  assert.equal(at('idle', false), true);
  assert.equal(at('connecting', true), true);
  // ready before model/list answered: the race that showed "No models" right after Codex started
  assert.equal(at('ready', false), true);
  assert.equal(at('ready', true), false);
  assert.equal(at('error', false), false);
  fx.state.claude = { status: { state: 'detecting' }, models: [] };
  assert.equal(sel.useModelsLoading('claude'), true);
  fx.state.claude = { status: { state: 'ready' }, models: [] };
  assert.equal(sel.useModelsLoading('claude'), false);
});

test('Claude choices become future defaults while retaining the chat selection', () => {
  fx.state.runtime[CL] = { settings: { model: 'sonnet' } };
  sel.setSelection('claude', { model: 'opus', fast: true }, CL);
  assert.equal(fx.state.runtime[CL].settings.model, 'opus');
  assert.equal(defined(called('setPrefs').at(-1))[0].claudeSelection.model, 'opus');
  sel.setSelection('claude', { effort: 'low' }, CL);
  assert.equal(defined(called('setPrefs').at(-1))[0].claudeSelection.effort, 'low');
  sel.setSelection('claude', { fast: false }, CL);
  fx.sessions[CL] = { pendingSwitch: { harness: 'codex' } };
  sel.setSelection('claude', { model: 'haiku' }, CL);
  sel.setSelection('claude', { model: 'haiku' }, null);
  assert.equal(defined(called('setPrefs').at(-1))[0].claudeSelection.model, 'haiku');
});

test('setSelection: Codex writes model, effort and tier to the chat or the defaults', () => {
  sel.setSelection('codex', { model: 'gpt-5', effort: 'high' });
  sel.setSelection('codex', { fast: true });
  sel.setSelection('codex', { fast: false });
  sel.setSelection('codex', { tier: 'flex' });
  sel.setSelection('codex', { tier: null });
  assert.deepEqual(
    called('setPrefs').map((c) => c[0]),
    [
      { model: 'gpt-5', effort: 'high' },
      { serviceTier: 'priority' },
      { serviceTier: 'default' },
      { serviceTier: 'flex' },
      { serviceTier: 'default' },
    ],
  );
  sel.setSelection('codex', { model: 'mini' }, 'cx');
  assert.equal(called('setChatConfig')[0][1].model, 'mini');
  assert.equal(defined(called('setPrefs').at(-1))[0].model, 'mini');
  // a Claude chat changing the Codex selection writes the default
  sel.setSelection('codex', { model: 'mini' }, CL);
  assert.deepEqual(called('setPrefs').at(-1), [{ model: 'mini' }]);
  // so does a basic harness's chat: it has no Codex selection of its own to write
  const configs = called('setChatConfig').length;
  sel.setSelection('codex', { model: 'nano' }, 'acp:kimi:1');
  assert.deepEqual([called('setChatConfig').length, called('setPrefs').at(-1)], [configs, [{ model: 'nano' }]]);
});

test("the composer targets a pending switch, the chat's harness, or the new-chat default", () => {
  assert.equal(sel.composerFirstTier('cx'), 'codex');
  assert.equal(sel.composerFirstTier(CL), 'claude');
  // a basic harness's chat has no first-tier harness
  assert.equal(sel.composerFirstTier('acp:kimi:1'), null);
  fx.sessions.cx = { pendingSwitch: { harness: 'claude' } };
  assert.equal(sel.composerFirstTier('cx'), 'claude');
  assert.equal(sel.isClaudeComposer('cx'), true);
  fx.state.newChatHarness = 'claude';
  assert.equal(sel.composerFirstTier(null), 'claude');
  // the family: a pending switch's harness, the chat's own (a basic harness's chat is ACP), or the new-chat default
  assert.equal(sel.composerFamily('cx'), 'claude');
  assert.equal(sel.composerFamily('acp:kimi:1'), 'acp');
  assert.equal(sel.composerFamily(CL), 'claude');
  fx.state.newChatFamily = 'acp';
  assert.equal(sel.composerFamily(null), 'acp');
  fx.sessions.cx = { pendingSwitch: { harness: 'acp:opencode' } };
  assert.equal(sel.composerFamily('cx'), 'acp');
  assert.equal(sel.composerFirstTier('cx'), null);
});

test('useHarnessStatus and useHarnessAccounts read the store for each harness', () => {
  fx.state.conn = 'ready';
  fx.state.account = { type: 'chatgpt', email: 'a@x' };
  fx.state.claude = { status: { state: 'ready', plan: 'Claude Max', usage: null, email: 'c@x' }, models: [] };
  assert.equal(sel.useHarnessStatus('codex').email, 'a@x');
  assert.equal(sel.useHarnessStatus('claude').email, 'c@x');
  assert.equal(sel.useHarnessAccounts('codex').active!.email, 'a@x');
  assert.equal(sel.useHarnessAccounts('claude').active!.email, 'c@x');
  assert.equal(sel.harnessAccounts('codex').active!.id, 'default');
  assert.equal(sel.harnessAccounts('claude').active!.plan, 'Claude Max');
});

test('chooseAccount signs a lapsed login in again or makes it the one in use', () => {
  fx.state.claudeAccounts = { active: 'a', accounts: [] };
  fx.state.accounts = { active: 'x', accounts: [] };
  const acc = (harness: string, id: string, status = 'ok') => ({ harness, id, status }) as any;
  sel.chooseAccount(acc('claude', 'b', 'signin'));
  sel.chooseAccount(acc('claude', 'b'));
  sel.chooseAccount(acc('claude', 'a'));
  assert.deepEqual(claudeCalls, [
    ['reloginClaudeAccount', 'b'],
    ['switchClaudeAccount', 'b'],
  ]);
  sel.chooseAccount(acc('codex', 'y', 'expired'));
  assert.deepEqual(called('login'), [[]]);
  fx.state.accounts.accounts = [{ id: 'x' }];
  sel.chooseAccount(acc('codex', 'y', 'expired'));
  assert.deepEqual(called('addAccount'), [['y']]);
  sel.chooseAccount(acc('codex', 'y'));
  sel.chooseAccount(acc('codex', 'x'));
  assert.deepEqual(called('switchAccount'), [['y']]);
});

test('verifyAccount signs a Claude login in again to confirm its account; a Codex login has nothing to confirm', () => {
  claudeCalls.length = 0;
  sel.verifyAccount({ harness: 'claude', id: 'default' } as any);
  sel.verifyAccount({ harness: 'codex', id: 'x' } as any);
  assert.deepEqual(claudeCalls, [['reloginClaudeAccount', 'default']]);
});

test('adding, removing and pinning accounts per harness', () => {
  sel.addHarnessAccount('claude');
  sel.addHarnessAccount('codex');
  sel.removeHarnessAccount({ harness: 'claude', id: 'b' } as any);
  sel.removeHarnessAccount({ harness: 'codex', id: 'y' } as any);
  sel.setChatAccount('claude', CL, 'b');
  sel.setChatAccount('codex', 'cx', null);
  assert.deepEqual(claudeCalls, [['addClaudeAccount'], ['removeClaudeAccount', 'b'], ['pinClaudeChat', CL, 'b']]);
  assert.deepEqual([called('addAccount'), called('removeAccount'), called('pinCodexChat')], [[[]], [['y']], [['cx', null]]]);
});

test("chatAccount: a Claude chat's own login while signed in, else the one in use; a Codex chat from the relay", () => {
  assert.equal(sel.chatAccount('claude', null), null);
  assert.equal(sel.chatAccount('claude', CL), null);
  fx.state.claudeAccounts = {
    active: 'a',
    accounts: [
      { id: 'a', loggedIn: true },
      { id: 'b', loggedIn: true },
      { id: 'c', loggedIn: false },
    ],
  };
  fx.state.claudeChats[CL] = { id: 'b', pinned: true };
  assert.deepEqual(sel.chatAccount('claude', CL), { id: 'b', pinned: true, serving: 'b' });
  fx.state.claudeChats[CL] = { id: 'c', pinned: false };
  assert.deepEqual(sel.chatAccount('claude', CL), { id: 'a', pinned: false, serving: 'a' });
  fx.state.claudeAccounts = { active: 'a', accounts: [] };
  fx.state.claudeChats[CL] = { id: 'default', pinned: true };
  assert.equal(sel.chatAccount('claude', CL)!.id, 'default');
  fx.state.claudeChats[CL] = { id: 'other', pinned: true };
  assert.equal(sel.useChatAccount('claude', CL)!.id, 'a');
  fx.state.claudeChats[CL] = { id: '', pinned: true };
  assert.equal(sel.chatAccount('claude', CL)!.id, 'a');
  fx.state.accounts = { active: 'x', accounts: [], chatAccounts: { cx: { id: 'y', pinned: true } } };
  assert.deepEqual(sel.chatAccount('codex', 'cx'), { id: 'y', pinned: true, serving: 'y' });
  assert.equal(sel.chatAccount('codex', 'other'), null);
  fx.state.accounts = { active: 'x', accounts: [] };
  assert.equal(sel.chatAccount('codex', 'cx'), null);
});

test("logoutRoute opens Accounts & billing on the chat's account row, when there is one", () => {
  fx.state.accounts = { active: null, accounts: [], chatAccounts: { cx: { id: 'y', pinned: true } } };
  assert.deepEqual(sel.logoutRoute('cx'), { name: 'settings', section: 'accounts', tab: 'row:codex:y' });
  fx.state.account = { type: 'chatgpt' };
  assert.deepEqual(sel.logoutRoute(null), { name: 'settings', section: 'accounts', tab: 'row:codex:default' });
  fx.state.account = null;
  assert.deepEqual(sel.logoutRoute(null), { name: 'settings', section: 'accounts' });
});

test("logoutRoute opens a basic chat's own harness row, never the Codex account", () => {
  fx.state.accounts = { active: { id: 'x' }, accounts: [{ id: 'x' }], chatAccounts: {} };
  fx.state.account = { type: 'chatgpt' };
  assert.deepEqual(sel.logoutRoute('acp:kimi:1'), { name: 'settings', section: 'other-harnesses' });
  // a new chat that starts on a picked basic harness
  fx.state.newChatFamily = 'acp';
  assert.deepEqual(sel.logoutRoute(null), { name: 'settings', section: 'other-harnesses' });
});

test('codexSubscriptions and canPinChats', () => {
  assert.deepEqual(
    sel.codexSubscriptions([{ id: 'a' }, { id: 'b', kind: 'apiKey' }, { id: 'c', kind: 'chatgpt' }] as any).map((a) => a.id),
    ['a', 'c'],
  );
  assert.equal(sel.canPinChats('claude'), true);
  assert.equal(sel.canPinChats('codex'), false);
  fx.state.accounts = { relay: true, accounts: [{ id: 'a' }] };
  assert.equal(sel.canPinChats('codex'), false);
  fx.state.accounts.accounts.push({ id: 'b' });
  assert.equal(sel.canPinChats('codex'), true);
});

const claudeModels = [
  {
    id: 'opus',
    label: 'Opus',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    fast: true,
    isDefault: true,
    resolved: 'claude-opus-5-5',
  },
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'], defaultEffort: null, fast: false },
];

test('useHarnessModels: on MoPilot credits Claude lists only what the gateway serves', async () => {
  fx.state.claude.models = claudeModels;
  fx.state.models = [{ model: 'gpt-5', displayName: 'gpt-5', supportedReasoningEfforts: [], defaultReasoningEffort: null }];
  assert.deepEqual(
    sel.useHarnessModels('codex').map((m) => m.id),
    ['gpt-5'],
  );
  assert.equal(sel.useHarnessModels('claude').length, 2);
  await applyClaudeKey(async () => ({ mode: 'mopilot', set: false }) as any);
  fx.mopilot.signedIn = true;
  fx.mopilot.modelCaps = { opus: { wires: ['anthropic'] }, sonnet: { wires: ['openai'] } };
  assert.deepEqual(
    sel.useHarnessModels('claude').map((m) => m.id),
    ['opus'],
  );
  await applyClaudeKey(async () => ({ mode: 'subscription', set: false }) as any);
});

test('useEffectiveSelection for a Claude chat: its own model and effort over the defaults', () => {
  fx.state.claude.models = claudeModels;
  fx.state.prefs.claudeSelection = { model: null, effort: 'max', fast: true };
  // a new chat: the default model and its default effort when the stored one is not offered
  let r = sel.useEffectiveSelection('claude', null);
  assert.deepEqual([r.modelId, r.effort, r.fast, r.fastUnavailable, r.tier], ['opus', 'max', true, null, null]);
  // the chat's own settings, an alias read back from its wire id
  fx.state.runtime[CL] = { settings: { model: 'claude-opus-5-5', effort: 'low' } };
  r = sel.useEffectiveSelection('claude', CL);
  assert.deepEqual([r.modelId, r.effort], ['opus', 'low']);
  fx.state.runtime[CL] = { settings: { model: null, effort: null } };
  r = sel.useEffectiveSelection('claude', CL);
  assert.deepEqual([r.modelId, r.effort], ['opus', 'max']);
  // an effort the chat saved is its own, even null (the model's default): the new-chat default, which another chat's
  // pick moves, doesn't reach it; one its session reports wins over it
  fx.state.chatConfig[CL] = { model: 'opus', effort: null };
  r = sel.useEffectiveSelection('claude', CL);
  assert.deepEqual([r.modelId, r.effort], ['opus', 'high']);
  fx.state.chatConfig[CL] = { model: 'opus', effort: 'low' };
  fx.state.prefs.claudeSelection = { model: 'sonnet', effort: 'max', fast: true };
  r = sel.useEffectiveSelection('claude', CL);
  assert.deepEqual([r.modelId, r.effort], ['opus', 'low']);
  fx.state.runtime[CL] = { settings: { model: 'claude-opus-5-5', effort: 'max' } };
  assert.equal(sel.useEffectiveSelection('claude', CL).effort, 'max');
  delete fx.state.chatConfig[CL];
  fx.state.prefs.claudeSelection = { model: null, effort: 'max', fast: true };
  // a variant the CLI didn't list takes its base model's efforts; an effort it lacks falls to the default
  fx.state.prefs.claudeSelection = { model: 'sonnet[1m]', effort: 'max', fast: false };
  r = sel.useEffectiveSelection('claude', null);
  assert.deepEqual([r.modelId, r.model?.id, r.efforts, r.effort, r.fast], ['sonnet[1m]', 'sonnet', ['low', 'high'], null, false]);
  fx.state.prefs.claudeSelection = { model: 'unknown', effort: null, fast: false };
  r = sel.useEffectiveSelection('claude', null);
  assert.deepEqual([r.model, r.efforts, r.effort], [null, [], null]);
  // no models at all
  fx.state.claude.models = [];
  fx.state.prefs.claudeSelection = { model: null, effort: null, fast: false };
  r = sel.useEffectiveSelection('claude', null);
  assert.equal(r.modelId, null);
  fx.state.claude.models = [{ id: 'haiku', efforts: [], defaultEffort: null }];
  assert.equal(sel.useEffectiveSelection('claude', null).modelId, 'haiku');
});

test("useEffectiveSelection: Fast unavailable says why, and asks caps only for the chat's own harness", () => {
  fx.state.claude.models = claudeModels;
  fx.state.prefs.claudeSelection = { model: 'opus', effort: null, fast: true };
  fx.caps = {
    loaded: true,
    caps: { speed: { state: 'none', why: { layer: 'account', code: 'account.fastBlocked' } } },
    provider: { label: 'Anthropic' },
  };
  let r = sel.useEffectiveSelection('claude', CL);
  assert.equal(r.fast, false);
  assert.equal(typeof r.fastUnavailable, 'string');
  assert.equal(r.fastHidden, true, 'an account that cannot have Fast leaves it out');
  assert.deepEqual(called('useChatCaps').at(-1), [CL, { kind: 'claude', model: 'opus' }]);
  fx.caps = { loaded: true, caps: { speed: { state: 'none', why: { layer: 'harness', code: 'harness.undeclared' } } }, provider: null };
  r = sel.useEffectiveSelection('claude', 'cx');
  assert.equal(typeof r.fastUnavailable, 'string');
  assert.equal(r.fastHidden, true, 'a harness without Fast leaves it out');
  assert.deepEqual(called('useChatCaps').at(-1), [null, { kind: 'claude', model: 'opus' }]);
  // a reason the user can act on (here: switch model) stays as a greyed toggle; usable or not known yet, it shows
  fx.caps = { loaded: true, caps: { speed: { state: 'disabled', why: { layer: 'model', code: 'model.noFast' } } }, provider: null };
  assert.deepEqual(
    [sel.useEffectiveSelection('claude', CL).fastHidden, typeof sel.useEffectiveSelection('claude', CL).fastUnavailable],
    [false, 'string'],
  );
  fx.caps = { loaded: false, caps: { speed: { state: 'absent' } }, provider: null };
  assert.equal(sel.useEffectiveSelection('claude', CL).fastHidden, false);
  // a cap with no reason (offered elsewhere, say) stays greyed rather than hidden
  fx.caps = { loaded: true, caps: { speed: { state: 'route', via: 'route' } }, provider: null };
  assert.equal(sel.useEffectiveSelection('claude', CL).fastHidden, false);
  fx.state.claude.models = [];
  fx.state.prefs.claudeSelection = { model: null, effort: null, fast: false };
  sel.useEffectiveSelection('claude', null);
  assert.deepEqual(called('useChatCaps').at(-1), [null, { kind: 'claude', model: undefined }]);
});

test('useEffectiveSelection for Codex: explicit picks win; Automatic follows recommendations ahead of thread and CLI defaults', () => {
  const tiers = [{ id: 'priority', name: 'Fast' }];
  fx.state.models = [
    {
      model: 'gpt-5',
      displayName: 'gpt-5',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
      isDefault: true,
      serviceTiers: tiers,
    },
    {
      model: 'mini',
      displayName: 'mini',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      defaultReasoningEffort: 'low',
      isDefault: false,
    },
  ];
  // defaults: the default model, its effort, Standard
  let r = sel.useEffectiveSelection('codex', null);
  assert.deepEqual([r.modelId, r.effort, r.tier, r.fast, r.efforts], ['gpt-5', 'high', null, false, ['low', 'high']]);
  // stored tier the model offers; visible efforts filter the list
  fx.state.prefs = { ...fx.state.prefs, serviceTier: 'priority', visibleEfforts: ['high'] };
  r = sel.useEffectiveSelection('codex', null);
  assert.deepEqual([r.tier, r.fast, r.efforts], ['priority', true, ['high']]);
  // Fast blocked by caps
  fx.caps = { loaded: true, caps: { speed: { state: 'none', why: { layer: 'account', code: 'account.fastBlocked' } } }, provider: null };
  assert.equal(sel.useEffectiveSelection('codex', 'cx').fast, false);
  fx.caps = { loaded: false, caps: { speed: { state: 'native' } }, provider: null };
  // a Codex chat's own explicit pick wins; receipts and CLI model pins cannot freeze Automatic
  fx.state.prefs = { ...fx.state.prefs, serviceTier: null, visibleEfforts: null };
  fx.state.chatConfig.cx = { model: 'mini', effort: 'low' };
  r = sel.useEffectiveSelection('codex', 'cx');
  assert.deepEqual([r.modelId, r.effort, r.tiers], ['mini', 'low', []]);
  fx.state.chatConfig.cx = {};
  fx.state.runtime.cx = { settings: { model: 'mini', effort: 'low' } };
  r = sel.useEffectiveSelection('codex', 'cx');
  assert.deepEqual([r.modelId, r.effort], ['gpt-5', 'low']);
  fx.state.runtime.cx = { settings: null };
  fx.state.config = { model: 'mini', model_reasoning_effort: 'minimal', service_tier: 'priority' };
  r = sel.useEffectiveSelection('codex', 'cx');
  assert.deepEqual([r.modelId, r.effort, r.tier], ['gpt-5', 'minimal', 'priority']);
  // nothing known at all
  fx.state.config = null;
  fx.state.models = [];
  r = sel.useEffectiveSelection('codex', null);
  assert.deepEqual([r.modelId, r.model, r.effort], [null, null, null]);
});

test('Claude falls back to defaults when its own recorded model and effort are absent', () => {
  fx.state.runtime[CL] = { settings: { model: null, effort: null } };
  sel.setSelection('claude', { fast: true }, CL);
  assert.equal(defined(called('setPrefs').at(-1))[0].claudeSelection.fast, true);
});

test('Automatic follows a refreshed Codex recommendation and survives a pending switch despite older pins', () => {
  const listed = (model: string, isDefault: boolean) => ({ model, displayName: model, isDefault, supportedReasoningEfforts: [] });
  fx.state.models = [listed('old', false), listed('new', true)];
  fx.state.config = { model: 'old' };
  fx.state.prefs.model = 'old';
  fx.state.chatConfig.cx = { model: null };
  fx.state.runtime.cx = { settings: { model: 'old' } };
  assert.deepEqual([sel.useEffectiveSelection('codex', 'cx').modelId, sel.useEffectiveSelection('codex', 'cx').automatic], ['new', true]);
  fx.state.models = [listed('new', false), listed('newest', true)];
  assert.equal(sel.useEffectiveSelection('codex', 'cx').modelId, 'newest');
  fx.sessions[CL] = { pendingSwitch: { harness: 'codex', model: null } };
  assert.deepEqual([sel.useEffectiveSelection('codex', CL).modelId, sel.useEffectiveSelection('codex', CL).automatic], ['newest', true]);
  fx.sessions[CL] = { pendingSwitch: { harness: 'codex', model: 'new' } };
  assert.deepEqual([sel.useEffectiveSelection('codex', CL).modelId, sel.useEffectiveSelection('codex', CL).automatic], ['new', false]);
  fx.state.chatConfig.cx = { model: 'old' };
  assert.deepEqual([sel.useEffectiveSelection('codex', 'cx').modelId, sel.useEffectiveSelection('codex', 'cx').automatic], ['old', false]);
});
