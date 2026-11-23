// electron/app/sessionSettings.cjs: a chat's model, effort, fast mode and permission as main reads and changes them for the
// session-management tools, on Codex, Claude Code and an ACP agent, with a window open or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionSettings } = require('../electron/app/sessionSettings.cjs');

const MODES = { availableModes: [{ id: 'ask' }, { id: 'edit' }, { id: 'yolo' }, { id: 'mystery' }], currentModeId: 'ask' };
const ANCHORS = { ask: 'ask', edit: 'auto', yolo: 'full' };
const acpState = (o: Record<string, any> = {}) => ({
  acp: {
    modes: MODES,
    anchors: ANCHORS,
    configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'k2', options: [{ value: 'k2' }, { value: 'k3' }] },
      { id: 'think', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'deep' }] },
    ],
    ...o,
  },
});

function setup(
  o: { kinds?: Record<string, string>; states?: Record<string, any>; config?: Record<string, any>; prefs?: any; savePatch?: boolean } = {},
) {
  const kinds: Record<string, string> = { cx: 'codex', cl: 'claude', ap: 'acp:kimi', ...o.kinds };
  const states: Record<string, any> = { cx: {}, cl: {}, ap: acpState(), ...o.states };
  const configs = new Map<string, any>(Object.entries({ cx: {}, cl: {}, ap: {}, ...o.config }));
  const calls: any[] = [];
  const claudeSettings: Record<string, any> = { model: 'opus', effort: 'high', permission: 'acceptEdits', fast: false };
  const probe: any = {
    models: [
      { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'high', 'max'], supportsFastMode: true },
      { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: [] },
    ],
  };
  const live: any = {
    controller: {
      ref: (id: string) => {
        if (!kinds[id]) throw new Error('unknown chat');
        return { kind: kinds[id], id: `native-${id}`, key: `key-${id}` };
      },
      state: { get: (id: string) => states[id] },
    },
    chats: {
      records: { get: (id: string) => (configs.has(id) ? { meta: { config: configs.get(id) } } : undefined) },
      patchMeta: (id: string, patch: any) => {
        if (o.savePatch === false) return false;
        configs.set(id, patch.config);
        calls.push(['patch', id, patch.config]);
        return true;
      },
    },
    codex: {
      modelList: async () => ({
        data: [
          { model: 'gpt-5', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
          { model: 'gpt-mini', supportedReasoningEfforts: [] },
          { model: 'gpt-bare' },
          { model: 'secret', hidden: true },
        ],
      }),
    },
    claudeTurns: {
      fastBlocked: null,
      settings: () => claudeSettings,
      probeInfo: () => probe,
      accountOf: () => 'acct',
      pickOf: () => 'pick',
      setOwn: (...a: any[]) => calls.push(['own', ...a]),
      permissionChanged: async (id: string) => calls.push(['permissionChanged', id]),
    },
    acpHost: {
      setConfigOption: async (...a: any[]) => calls.push(['config', ...a]),
      setMode: async (...a: any[]) => calls.push(['mode', ...a]),
    },
  };
  const prefs = o.prefs ?? { model: 'gpt-5', effort: 'low', permission: 'default', serviceTier: null };
  const settings = createSessionSettings({ live, prefs: () => prefs });
  return { settings, calls, live, claudeSettings, probe, configs, states };
}

test('settingsOf reads each harness’s own model, effort, permission and fast mode, and nothing for an unknown chat', () => {
  const s = setup({ config: { cx: { model: 'gpt-mini', effort: null, permission: 'full-access', serviceTier: 'priority' } } });
  assert.deepEqual(s.settings.settingsOf('cx'), {
    kind: 'codex',
    family: 'codex',
    model: 'gpt-mini',
    effort: null,
    permission: 'full-access',
    fast: true,
  });
  // the user's defaults where the chat has none of its own; plan wins; Codex's reported permission wins over the saved one
  const d = setup();
  assert.deepEqual(d.settings.settingsOf('cx'), {
    kind: 'codex',
    family: 'codex',
    model: 'gpt-5',
    effort: 'low',
    permission: 'default',
    fast: false,
  });
  d.states.cx = { plan: true };
  assert.equal(d.settings.settingsOf('cx').permission, 'plan');
  d.states.cx = { permission: 'dontAsk' };
  assert.equal(d.settings.settingsOf('cx').permission, 'read-only');
  const bare = setup({ prefs: {} });
  assert.deepEqual(bare.settings.settingsOf('cx'), {
    kind: 'codex',
    family: 'codex',
    model: null,
    effort: null,
    permission: 'default',
    fast: false,
  });
  assert.deepEqual(s.settings.settingsOf('cl'), {
    kind: 'claude',
    family: 'claude',
    model: 'opus',
    effort: 'high',
    permission: 'default',
    fast: false,
  });
  s.claudeSettings.model = undefined;
  s.claudeSettings.effort = undefined;
  s.claudeSettings.permission = 'weird';
  s.claudeSettings.fast = true;
  assert.deepEqual(s.settings.settingsOf('cl'), {
    kind: 'claude',
    family: 'claude',
    model: null,
    effort: null,
    permission: null,
    fast: true,
  });
  s.states.cl = { plan: true };
  assert.equal(s.settings.settingsOf('cl').permission, 'plan');
  s.states.cl = { permission: 'bypassPermissions' };
  assert.equal(s.settings.settingsOf('cl').permission, 'full-access');
  assert.deepEqual(s.settings.settingsOf('ap'), {
    kind: 'acp:kimi',
    family: 'acp',
    model: 'k2',
    effort: 'low',
    permission: 'default',
    fast: undefined,
  });
  s.states.ap = { acp: { configOptions: [], modes: MODES } };
  assert.deepEqual(s.settings.settingsOf('ap'), {
    kind: 'acp:kimi',
    family: 'acp',
    model: null,
    effort: null,
    permission: null,
    fast: undefined,
  });
  s.states.ap = {};
  assert.equal(s.settings.settingsOf('ap').model, null);
  assert.equal(s.settings.settingsOf('nobody'), null);
});

test('setModel picks from what the harness offers, matching case, and keeps the chat’s other settings', async () => {
  const s = setup({ config: { cx: { effort: 'low' } } });
  assert.deepEqual(await s.settings.setModel('cx', 'GPT-MINI'), { model: 'gpt-mini' });
  assert.deepEqual(s.calls.pop(), ['patch', 'cx', { effort: 'low', model: 'gpt-mini' }]);
  await assert.rejects(s.settings.setModel('cx', 'secret'), /Unknown model "secret"\. Available: "gpt-5", "gpt-mini", "gpt-bare"\./);
  assert.deepEqual(await s.settings.setModel('cl', 'haiku'), { model: 'haiku' });
  assert.deepEqual(s.calls.splice(0), [
    ['own', 'cl', { model: 'haiku', effort: 'high', account: 'pick' }],
    ['patch', 'cl', { model: 'haiku' }],
  ]);
  s.claudeSettings.effort = undefined;
  await s.settings.setModel('cl', 'opus');
  assert.equal(s.calls[0][2].effort, null);
  await assert.rejects(s.settings.setModel('cl', 'sonnet'), /Unknown model "sonnet"\. Available: "opus", "haiku"\./);
  assert.deepEqual(await s.settings.setModel('ap', 'K3'), { model: 'k3' });
  assert.deepEqual(s.calls.pop(), ['config', 'key-ap', 'model', 'k3']);
  await assert.rejects(s.settings.setModel('ap', 'k9'), /Unknown model "k9"\. Available: "k2", "k3"\./);
  s.states.ap = acpState({ configOptions: [] });
  await assert.rejects(s.settings.setModel('ap', 'k3'), /declares no model setting/);
  s.probe.models = [];
  await assert.rejects(s.settings.setModel('cl', 'opus'), /not reported its Claude model list/);
  s.live.claudeTurns.probeInfo = () => null;
  await assert.rejects(s.settings.setModel('cl', 'opus'), /not reported its Claude model list/);
  await assert.rejects(setup({ savePatch: false }).settings.setModel('cx', 'gpt-5'), /could not be saved/);
});

test('setEffort checks the level against the model’s own and applies it on the chat’s harness', async () => {
  const s = setup({ config: { cx: { model: 'gpt-5' } } });
  assert.deepEqual(await s.settings.setEffort('cx', 'high'), { effort: 'high' });
  assert.deepEqual(s.calls.pop(), ['patch', 'cx', { model: 'gpt-5', effort: 'high' }]);
  await assert.rejects(s.settings.setEffort('cx', 'max'), /Effort max is not offered for "gpt-5"; it offers low, high\./);
  s.configs.set('cx', { model: 'gpt-mini' });
  assert.deepEqual(await s.settings.setEffort('cx', 'max'), { effort: 'max' }, 'a model that lists none takes any');
  s.configs.set('cx', { model: 'not-listed' });
  assert.deepEqual(await s.settings.setEffort('cx', 'max'), { effort: 'max' }, 'a model the list lacks takes any');
  assert.deepEqual(await s.settings.setEffort('cl', 'max'), { effort: 'max' });
  assert.deepEqual(s.calls.splice(-2), [
    ['own', 'cl', { model: 'opus', effort: 'max', account: 'pick' }],
    ['patch', 'cl', { effort: 'max' }],
  ]);
  s.claudeSettings.model = 'haiku';
  assert.deepEqual(await s.settings.setEffort('cl', 'low'), { effort: 'low' }, 'haiku lists none');
  s.claudeSettings.model = 'opus';
  await assert.rejects(s.settings.setEffort('cl', 'medium'), /Effort medium is not offered for "opus"; it offers low, high, max\./);
  assert.deepEqual(await s.settings.setEffort('ap', 'DEEP'), { effort: 'deep' });
  assert.deepEqual(s.calls.pop(), ['config', 'key-ap', 'think', 'deep']);
  await assert.rejects(s.settings.setEffort('ap', 'max'), /Effort max is not offered by this agent; it offers low, deep\./);
  s.states.ap = acpState({ configOptions: [] });
  await assert.rejects(s.settings.setEffort('ap', 'low'), /declares no thought-level setting/);
});

test('setFast turns fast mode on or off where the harness has it and says why it cannot', async () => {
  const s = setup();
  assert.equal(await s.settings.setFast('cx', true), true);
  assert.deepEqual(s.calls.pop(), ['patch', 'cx', { serviceTier: 'priority' }]);
  assert.equal(await s.settings.setFast('cx', false), false);
  assert.deepEqual(s.calls.pop(), ['patch', 'cx', { serviceTier: null }]);
  assert.equal(await s.settings.setFast('cl', true), true);
  assert.deepEqual(s.calls.pop(), ['patch', 'cl', { fast: true }]);
  assert.equal(await s.settings.setFast('cl', false), false);
  s.claudeSettings.model = 'haiku';
  await assert.rejects(s.settings.setFast('cl', true), /"haiku" does not offer fast mode/);
  assert.equal(await s.settings.setFast('cl', false), false, 'off needs no model that offers it');
  s.claudeSettings.model = 'unlisted';
  assert.equal(await s.settings.setFast('cl', true), true, 'a model the probe does not list is not refused');
  s.live.claudeTurns.fastBlocked = 'the plan does not include it';
  await assert.rejects(s.settings.setFast('cl', true), /cannot serve fast mode: the plan does not include it\./);
  s.live.claudeTurns.fastBlocked = null;
  s.probe.fastBlocked = 'org policy';
  await assert.rejects(s.settings.setFast('cl', true), /org policy/);
  await assert.rejects(s.settings.setFast('ap', true), /Fast mode is not available for acp:kimi\./);
});

test('setPermission saves it for a started Codex or Claude chat and picks the closest mode an ACP agent declares', async () => {
  const s = setup();
  assert.deepEqual(await s.settings.setPermission('cx', 'read-only'), { mode: 'read-only' });
  assert.deepEqual(s.calls.splice(0), [['patch', 'cx', { permission: 'read-only' }]]);
  assert.deepEqual(await s.settings.setPermission('cl', 'auto-review'), { mode: 'auto-review' });
  assert.deepEqual(s.calls.splice(0), [
    ['patch', 'cl', { permission: 'auto-review' }],
    ['permissionChanged', 'cl'],
  ]);
  // ACP: a mode with the anchor asked for, else the highest one below it; one the chat is on needs no call
  assert.deepEqual(await s.settings.setPermission('ap', 'full-access'), { mode: 'full-access' });
  assert.deepEqual(s.calls.splice(0), [['mode', 'key-ap', 'yolo']]);
  assert.deepEqual(await s.settings.setPermission('ap', 'default'), { mode: 'default' });
  assert.deepEqual(s.calls.splice(0), [], 'already on ask');
  assert.deepEqual(await s.settings.setPermission('ap', 'auto-review'), { mode: 'auto-review' });
  s.calls.length = 0;
  await assert.rejects(
    s.settings.setPermission('ap', 'read-only'),
    /no mode that maps to that permission/,
    'ask is the lowest mode it has',
  );
  s.states.ap = acpState({ modes: { availableModes: [{ id: 'edit' }, { id: 'yolo' }], currentModeId: 'yolo' } });
  await assert.rejects(s.settings.setPermission('ap', 'default'), /no mode that maps to that permission/);
  assert.deepEqual(await s.settings.setPermission('ap', 'full-access'), { mode: 'full-access' });
  assert.deepEqual(s.calls.splice(0), [], 'already on the mode');
  assert.deepEqual(await s.settings.setPermission('ap', 'auto-review'), { mode: 'auto-review' });
  assert.deepEqual(s.calls.splice(0), [['mode', 'key-ap', 'edit']]);
  // a mode set through a config option, as opencode declares it
  s.states.ap = acpState({
    modes: undefined,
    configOptions: [{ id: 'perm', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask' }, { value: 'yolo' }] }],
  });
  assert.deepEqual(await s.settings.setPermission('ap', 'full-access'), { mode: 'full-access' });
  assert.deepEqual(s.calls.splice(0), [['config', 'key-ap', 'perm', 'yolo']]);
  s.states.ap = acpState({ modes: undefined, configOptions: [] });
  await assert.rejects(s.settings.setPermission('ap', 'default'), /declares no permission modes/);
  s.states.ap = { acp: { modes: MODES } };
  await assert.rejects(s.settings.setPermission('ap', 'default'), /no mode that maps/, 'an agent that declares no anchors has none to map');
});

test('setPermission leaves plan mode to the user’s composer', async () => {
  const s = setup();
  await assert.rejects(s.settings.setPermission('cx', 'plan'), /Plan mode is switched from the chat’s composer/);
  s.states.cl = { plan: true };
  await assert.rejects(s.settings.setPermission('cl', 'default'), /Plan mode is switched/);
  assert.deepEqual(s.calls, []);
});

test('a value the chat already has is saved, not reported as a failed save (every harness that keeps it in the chat’s config)', async () => {
  const s = setup({
    config: {
      cx: { model: 'gpt-5', effort: 'low', permission: 'auto-review', serviceTier: null },
      cl: { model: 'opus', effort: 'high', permission: 'default', fast: false },
    },
  });
  assert.deepEqual(await s.settings.setEffort('cx', 'low'), { effort: 'low' });
  assert.deepEqual(await s.settings.setModel('cx', 'gpt-5'), { model: 'gpt-5' });
  assert.deepEqual(await s.settings.setPermission('cx', 'auto-review'), { mode: 'auto-review' });
  assert.equal(await s.settings.setFast('cx', false), false);
  assert.deepEqual(await s.settings.setEffort('cl', 'high'), { effort: 'high' });
  assert.deepEqual(await s.settings.setModel('cl', 'opus'), { model: 'opus' });
  assert.deepEqual(await s.settings.setPermission('cl', 'default'), { mode: 'default' });
  assert.equal(await s.settings.setFast('cl', false), false);
  assert.equal(s.calls.filter((c: any[]) => c[0] === 'patch').length, 0, 'nothing was written for a no-op');
  // a real failure still is one: a different value that cannot be saved
  await assert.rejects(
    setup({ savePatch: false, config: { cx: { effort: 'low' } } }).settings.setEffort('cx', 'high'),
    /could not be saved/,
  );
});

test('switchHarness records the switch the chat’s next message settles, checked against the target', async () => {
  const s = setup({ states: { cx: { goal: { status: 'active', objective: 'ship it' } } }, prefs: { claudeSelection: { model: 'opus' } } });
  const patches: any[] = [];
  s.live.controller.state.patch = (id: string, patch: any) => {
    patches.push([id, patch]);
    s.states[id] = { ...s.states[id], ...patch };
  };
  assert.deepEqual(await s.settings.switchHarness('cx', { harness: 'claude', model: 'HAIKU', effort: null }), {
    harness: 'claude',
    model: 'haiku',
    effort: null,
    cancelled: false,
  });
  assert.deepEqual(patches.at(-1), [
    'cx',
    {
      pendingSwitch: {
        harness: 'claude',
        model: 'haiku',
        modelLabel: 'Haiku',
        effort: null,
        mode: 'auto',
        goal: 'ship it',
        multiAgent: false,
        account: null,
      },
    },
  ]);
  assert.deepEqual(s.settings.pendingSwitchOf('cx'), { harness: 'claude', model: 'haiku', effort: null });
  // a basic agent's switch names no model, and one the picker recorded has no effort
  const picked = setup({ states: { ap: { pendingSwitch: { harness: 'codex', model: '' } } } });
  assert.deepEqual(picked.settings.pendingSwitchOf('ap'), { harness: 'codex', model: null, effort: null });
  // a setting saved now would belong to the harness the chat is leaving
  await assert.rejects(s.settings.setModel('cx', 'gpt-5'), /moves to claude.*set_session_harness/);
  await assert.rejects(s.settings.setEffort('cx', 'low'), { code: 'switch_pending' });
  assert.throws(() => s.settings.refuseWhileSwitching('cx'), { code: 'switch_pending' });
  // the session's own harness cancels; with nothing waiting it changes nothing
  assert.deepEqual(await s.settings.switchHarness('cx', { harness: 'codex' }), { harness: 'codex', cancelled: true });
  assert.equal(s.settings.pendingSwitchOf('cx'), null);
  const count = patches.length;
  await s.settings.switchHarness('cx', { harness: 'codex' });
  assert.equal(patches.length, count);

  // a switch the user already picked for that harness keeps its handoff, account and goal; a new model clears nothing else
  s.states.cx = {
    pendingSwitch: {
      harness: 'claude',
      model: 'opus',
      modelLabel: 'Opus',
      effort: 'low',
      mode: 'summary',
      goal: 'g',
      multiAgent: true,
      account: 'work',
    },
  };
  assert.deepEqual(await s.settings.switchHarness('cx', { harness: 'claude', model: 'haiku' }), {
    harness: 'claude',
    model: 'haiku',
    effort: 'low',
    cancelled: false,
  });
  assert.deepEqual(s.states.cx.pendingSwitch, {
    harness: 'claude',
    model: 'haiku',
    modelLabel: 'Haiku',
    effort: 'low',
    mode: 'summary',
    goal: 'g',
    multiAgent: true,
    account: 'work',
  });
  assert.deepEqual(await s.settings.switchHarness('cx', { harness: 'claude' }), {
    harness: 'claude',
    model: 'haiku',
    effort: 'low',
    cancelled: false,
  });
  // another target replaces it; a goal the user paused stays paused
  s.states.cl = { goal: { status: 'paused', objective: 'held' }, pendingSwitch: { harness: 'acp:kimi', model: '', mode: 'summary' } };
  await s.settings.switchHarness('cl', { harness: 'codex' });
  assert.equal(s.states.cl.pendingSwitch.goal, null);
  assert.equal(s.states.cl.pendingSwitch.mode, 'auto');
  s.states.cl = {};
  await assert.rejects(s.settings.setFast('cx', false), { code: 'switch_pending' });
  s.states.cx = {};

  // this session's level goes along only where the model offers it
  assert.equal((await s.settings.switchHarness('cl', { harness: 'codex', model: 'gpt-5', inheritedEffort: 'high' })).effort, 'high');
  s.states.cl = {};
  assert.equal((await s.settings.switchHarness('cl', { harness: 'codex', model: 'gpt-5', inheritedEffort: 'max' })).effort, null);
  s.states.cl = {};

  // the target's configured default when none is named, with no need for its model list; a finished goal stays behind
  s.states.cl = { goal: { status: 'complete', objective: 'done' } };
  s.live.codex.modelList = async () => {
    throw new Error('codex is down');
  };
  assert.deepEqual(await s.settings.switchHarness('cl', { harness: 'codex' }), {
    harness: 'codex',
    model: null,
    effort: null,
    cancelled: false,
  });
  assert.equal(s.states.cl.pendingSwitch.goal, null);
  assert.equal(s.states.cl.pendingSwitch.modelLabel, '');
  const defaulted = await s.settings.switchHarness('cx', { harness: 'claude' });
  assert.equal(defaulted.model, 'opus');
});

test('switchHarness refuses what the target does not offer and a session it cannot move', async () => {
  const s = setup();
  s.live.controller.state.patch = () => assert.fail('nothing is recorded');
  await assert.rejects(s.settings.switchHarness('cx', { harness: 'nonsense:' }), { code: 'unknown_harness' });
  await assert.rejects(s.settings.switchHarness('cx', { harness: 'claude', model: 'gpt-5' }), { code: 'unknown_model' });
  await assert.rejects(s.settings.switchHarness('cl', { harness: 'codex', model: 'gpt-5', effort: 'max' }), { code: 'unknown_effort' });
  await assert.rejects(s.settings.switchHarness('cl', { harness: 'acp:kimi', model: 'k2' }), { code: 'unavailable' });
  await assert.rejects(s.settings.switchHarness('cl', { harness: 'acp:kimi', effort: 'low' }), { code: 'unavailable' });
  s.probe.models = [];
  await assert.rejects(s.settings.switchHarness('cx', { harness: 'claude', model: 'opus' }), /model list/);

  s.live.hostOwnership = { get: () => ({ hostId: 'mac-mini' }) };
  await assert.rejects(s.settings.switchHarness('cl', { harness: 'codex' }), /another machine/);
  s.live.hostOwnership = { get: () => ({ hostId: 'local' }) };

  const down = createSessionSettings({ live: s.live, prefs: () => ({}), usable: async () => false });
  await assert.rejects(down.switchHarness('cl', { harness: 'codex' }), /can’t take a session now/);

  // the chat moved while the target's model list was read
  const moving = setup();
  moving.live.controller.state.patch = () => assert.fail('nothing is recorded');
  const list = moving.live.codex.modelList;
  moving.live.codex.modelList = async () => {
    const out = await list();
    const ref = moving.live.controller.ref;
    moving.live.controller.ref = (id: string) => ({ ...ref(id), kind: 'acp:kimi' });
    return out;
  };
  await assert.rejects(moving.settings.switchHarness('cl', { harness: 'codex', model: 'gpt-5' }), { code: 'harness_changed' });

  // a basic agent keeps its own, so its switch names none
  assert.equal(setup().settings.selectsModel('acp:kimi'), false);
  assert.equal(setup().settings.selectsModel('claude'), true);
  const acp = setup();
  const seen: any[] = [];
  acp.live.controller.state.patch = (_id: string, p: any) => seen.push(p.pendingSwitch);
  assert.deepEqual(await acp.settings.switchHarness('cl', { harness: 'acp:kimi' }), {
    harness: 'acp:kimi',
    model: null,
    effort: null,
    cancelled: false,
  });
  assert.equal(seen[0].model, '');
});
