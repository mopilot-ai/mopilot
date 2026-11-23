// The Chrome side panel's model, effort and permission menus from main (electron/app/chromePanelOptions.cjs) and their requests (electron/capabilities/browser/chromePanel.cjs): each harness family's models and pick, a pick applied to the chat and as the default for new chats, and what is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PanelMenus } from '../electron/chrome-extension/src/panelMenus.mjs';
import { el } from './support/side-panel-page.ts';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');

const CODEX_LIST = {
  data: [
    {
      model: 'gpt-6.1-sol',
      displayName: 'gpt-6.1-sol',
      description: 'Frontier',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
      defaultReasoningEffort: 'high',
      isDefault: true,
    },
    { model: 'gpt-6.1-mini', displayName: 'GPT-6.1-Mini', supportedReasoningEfforts: [], defaultReasoningEffort: null },
    { model: 'old', displayName: 'old', hidden: true, supportedReasoningEfforts: [] },
  ],
};
const CLAUDE_MODELS = [
  { value: 'default', displayName: 'Default' },
  {
    value: 'opus',
    displayName: 'Opus',
    description: 'Opus 5.5 · Best for complex work',
    supportedEffortLevels: ['low', 'high', 'max'],
    supportsAutoMode: true,
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Sonnet 5.5 · Fast',
    supportedEffortLevels: ['low', 'medium'],
    supportsAutoMode: false,
  },
  { value: 'claude-opus-4-1', displayName: 'Opus 4.1', description: 'Older', supportedEffortLevels: [] },
];
const ACP_CATALOG = {
  configOptions: [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: 'm1',
      options: [
        { value: 'm1', name: 'Model one' },
        { value: 'm2', name: 'Model two', description: 'Bigger' },
      ],
    },
    {
      id: 'think',
      category: 'thought_level',
      type: 'select',
      currentValue: 'lo',
      options: [
        { value: 'lo', name: 'Low' },
        { value: 'hi', name: 'High' },
      ],
    },
  ],
  modes: {
    currentModeId: 'ask',
    availableModes: [
      { id: 'ask', name: 'Ask', description: 'Asks first' },
      { id: 'auto', name: 'Auto' },
    ],
  },
};

function world(
  o: {
    codex?: any;
    turns?: any;
    prefs?: any;
    probe?: any;
    probed?: any;
    bin?: string | null;
    records?: [string, any][];
    state?: [string, any][];
    kinds?: Record<string, string>;
  } = {},
) {
  const calls: any[] = [];
  let prefs = { ...o.prefs };
  const records = new Map(o.records ?? []);
  const live = {
    codex: { modelList: async () => ('codex' in o ? o.codex : CODEX_LIST) },
    // the Claude Code chats' own pick, read for the account their menu reports
    identity: { instances: () => [], driver: () => ({ perChat: true }) },
    chats: {
      records,
      get: (id: string) => ({ meta: records.get(id)?.meta }),
      patchMeta: (id: string, patch: any) => {
        calls.push(['patchMeta', id, patch]);
        return true;
      },
    },
    controller: { state: new Map(o.state ?? []), ref: (id: string) => ({ key: `key-${id}` }) },
    acpAdmission: { list: () => [{ id: 'gemini', catalog: ACP_CATALOG }, { id: 'bare' }] },
    acpHost: {
      setConfigOption: async (...a: any[]) => calls.push(['setConfigOption', ...a]),
      setMode: async (...a: any[]) => calls.push(['setMode', ...a]),
    },
    claudeTurns: o.turns,
    patchPrefs: (set: any) => {
      calls.push(['patchPrefs', set]);
      prefs = { ...prefs, ...set };
      return true;
    },
  };
  const claude = {
    probeInfo: () => o.probed ?? null,
    findBinary: async () => (o.bin === undefined ? '/bin/claude' : o.bin),
    probe: async (bin: string) => {
      calls.push(['probe', bin]);
      return o.probe ?? { models: CLAUDE_MODELS };
    },
  };
  const kinds = o.kinds ?? {};
  const menus = createPanelOptions({
    live,
    claude,
    prefs: () => prefs,
    kindOf: (id: string) => kinds[id] ?? null,
    labelOf: (k: string | null) => (k ? `label:${k}` : null),
  });
  return { menus, calls, live, prefs: () => prefs };
}

test('menu ownership uses native identities and actual controls rather than repeated account or harness labels', async () => {
  const kinds = { chat: 'codex' };
  const record: any = { meta: { account: { id: 'A' }, config: { model: 'sol', effort: 'high' } } };
  let own: any = { model: 'opus', effort: 'low' };
  const w = world({ kinds, records: [['chat', record]], turns: { settings: () => own, setOwn: () => {}, pickOf: () => null } });
  let key: string | null = 'native:one';
  let instance: string | null = null;
  (w.live.controller as any).ref = () => (key === null ? null : { key, instance });
  const first = w.menus.owner('chat');
  assert.equal(w.menus.owner('chat'), first);
  instance = 'separate-native-instance';
  assert.notEqual(w.menus.owner('chat'), first);
  key = 'native:two';
  assert.notEqual(w.menus.owner('chat'), first);
  const second = w.menus.owner('chat');
  record.meta.account.id = 'B';
  assert.notEqual(w.menus.owner('chat'), second);
  record.meta = {};
  key = null;
  assert.ok(w.menus.owner('chat'));
  kinds.chat = 'claude';
  const claude = w.menus.owner('chat');
  own = null;
  await w.menus.choose({ chatId: 'chat', model: 'sonnet', effort: 'high' });
  assert.notEqual(w.menus.owner('chat'), claude);
  await w.menus.permit({ chatId: 'chat', value: 'full-access' });
  const full = w.menus.owner('chat');
  await w.menus.permit({ chatId: 'chat', value: 'default' });
  assert.notEqual(w.menus.owner('chat'), full);
  kinds.chat = 'acp:gemini';
  const acp = { acp: structuredClone(ACP_CATALOG) };
  w.live.controller.state.set('chat', acp);
  const before = w.menus.owner('chat');
  await w.menus.choose({ harness: 'codex', model: 'other', effort: 'low' });
  assert.equal(w.menus.owner('chat'), before, 'another harness default is not this ACP menu owner');
  acp.acp.configOptions[0].currentValue = 'm2';
  assert.notEqual(w.menus.owner('chat'), before);
  kinds.chat = 'acp:bare';
  w.live.controller.state.delete('chat');
  assert.ok(w.menus.owner('chat'));
});

for (const harness of ['codex', 'claude', 'acp:gemini'])
  test(`real ${harness} permission rows drive the panel without guessing native mode identities`, async () => {
    const w = world();
    const els: Record<string, any> = {};
    const requests: any[] = [];
    const panel = new PanelMenus({
      document: { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) },
      request: async (method: string, p: any) => {
        if (method === 'options') return w.menus.options(p);
        requests.push(p);
        await w.menus.permit(p);
        return {};
      },
      onError: (reason: string) => assert.fail(reason),
      onHarness: () => assert.fail('no harness row is picked here'),
    });
    await panel.load({ harness });
    const permission = panel.now?.permission;
    assert.ok(permission);
    if (harness === 'acp:gemini') {
      assert.deepEqual(
        permission.rows.map((r: any) => r.id),
        ['ask', 'auto'],
      );
      await panel.permit('auto');
      assert.deepEqual(requests, [{ harness, value: 'auto' }], 'ACP custom modes preserve their native meaning; no full-access claim');
    } else {
      assert.ok(permission.rows.some((r: any) => r.id === 'full-access'));
      await panel.permit('full-access');
      assert.equal(requests.length, 0);
      assert.match(els['perm-menu'].textContent, /Enable Full access/);
      await panel.permit('full-access', true);
      assert.deepEqual(requests, [{ harness, value: 'full-access' }]);
    }
  });

test('Codex: the listed models (none hidden), the efforts shown in Settings, and the chat’s own pick before the defaults', async () => {
  const { menus } = world({ prefs: { visibleEfforts: ['low', 'high'] } });
  const now = await menus.options({ harness: 'codex' });
  assert.equal(now.harness, 'label:codex');
  assert.deepEqual(
    now.models.map((m: any) => [m.id, m.label, m.description, m.efforts.map((e: any) => e.label), m.defaultEffort]),
    [
      ['gpt-6.1-sol', 'GPT-6.1 Sol', 'Frontier', ['Low', 'High'], 'high'],
      ['gpt-6.1-mini', 'GPT-6.1 Mini', null, [], null],
    ],
  );
  // no pick yet: the default model at its default effort
  assert.deepEqual([now.model, now.effort], ['gpt-6.1-sol', 'high']);
  assert.equal(now.permission.title, 'What MoPilot can do');
  assert.equal(now.permission.value, 'default');
  assert.deepEqual(
    now.permission.rows.map((r: any) => r.label),
    ['Read-only', 'Ask for approval', 'Approve for me', 'Full access'],
  );

  const chat = world({
    prefs: { model: 'gpt-6.1-mini', effort: 'low', permission: 'full-access' },
    records: [['th-1', { meta: { config: { model: 'gpt-6.1-sol', effort: 'ultra' } } }]],
    kinds: { 'th-1': 'codex' },
  });
  const own = await chat.menus.options({ chatId: 'th-1' });
  assert.deepEqual([own.model, own.effort, own.permission.value], ['gpt-6.1-sol', 'ultra', 'full-access']);
  // a new chat: the defaults
  const next = await chat.menus.options({ harness: 'codex' });
  assert.deepEqual([next.model, next.effort], ['gpt-6.1-mini', 'low']);
  // a chat with no record yet takes the defaults too
  const fresh = world({ kinds: { 'th-2': 'codex' } });
  assert.equal((await fresh.menus.options({ chatId: 'th-2' })).model, 'gpt-6.1-sol');
});

test('Codex: a pick goes on the chat (keeping its other settings) and becomes the default', async () => {
  const { menus, calls } = world({
    records: [['th-1', { meta: { config: { serviceTier: 'priority', model: 'x' } } }]],
    kinds: { 'th-1': 'codex', 'th-2': 'codex' },
  });
  await menus.choose({ chatId: 'th-1', model: 'gpt-6.1-mini', effort: null });
  assert.deepEqual(calls, [
    ['patchPrefs', { model: 'gpt-6.1-mini', effort: null }],
    ['patchMeta', 'th-1', { config: { serviceTier: 'priority', model: 'gpt-6.1-mini', effort: null } }],
  ]);
  // a chat main has no record of yet, or a new one: only the default
  calls.length = 0;
  await menus.choose({ chatId: 'th-2', model: 'gpt-6.1-sol', effort: 'high' });
  await menus.choose({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['patchPrefs', 'patchPrefs'],
  );
});

test('Claude Code: models as the app lists them, probed here when no window has; the effort a model lacks falls back', async () => {
  const { menus, calls } = world({ prefs: { claudeSelection: { model: 'sonnet', effort: 'max', fast: true } } });
  const now = await menus.options({ harness: 'claude' });
  assert.deepEqual(calls, [['probe', '/bin/claude']]);
  assert.deepEqual(
    now.models.map((m: any) => [m.id, m.label, m.more]),
    [
      ['opus', 'Opus 5.5', false],
      ['sonnet', 'Sonnet 5.5', false],
      ['claude-opus-4-1', 'Opus 4.1', true],
    ],
  );
  // sonnet has no "max": its own default
  assert.deepEqual([now.model, now.effort], ['sonnet', 'low']);
  // a model that can't auto-approve can't take "Approve for me"
  assert.equal(now.permission.rows.find((r: any) => r.id === 'auto-review').disabled, "This model can't auto-approve");
  assert.equal(now.permission.title, 'What MoPilot can do');

  // a probe a window made is used as it is; an effort the model has stays
  const probed = world({ probed: { models: CLAUDE_MODELS }, prefs: { claudeSelection: { effort: 'max' } } });
  const opus = await probed.menus.options({ harness: 'claude' });
  assert.deepEqual([opus.model, opus.effort], ['opus', 'max']);
  assert.equal(opus.permission.rows.find((r: any) => r.id === 'auto-review').disabled, undefined);
  assert.deepEqual(probed.calls, []);

  // no Claude Code installed: no models, and the menus still answer
  const none = world({ bin: null });
  const empty = await none.menus.options({ harness: 'claude' });
  assert.deepEqual([empty.models, empty.model, empty.effort], [[], null, null]);
  // a probe that found only pinned models: the first one
  const pinned = world({ probe: { models: [{ value: 'claude-fable-5-1[1m]', displayName: 'Fable' }] } });
  assert.equal((await pinned.menus.options({ harness: 'claude' })).model, 'claude-fable-5-1[1m]');
  const nothing = world({ probe: {} });
  assert.deepEqual((await nothing.menus.options({ harness: 'claude' })).models, []);
});

test('Claude Code: a chat’s menu shows its own pick, and a pick there stays the chat’s, on the login it runs on', async () => {
  const own: any[] = [];
  const turns = {
    settings: (id: string) =>
      id === 'claude:1' ? { model: 'sonnet', effort: 'low' } : { model: null, effort: null, attachments: [], skills: [] },
    setOwn: (...a: any[]) => own.push(a),
    pickOf: (id: string) => (id === 'claude:1' ? 'work' : null),
  };
  const { menus } = world({
    probed: { models: CLAUDE_MODELS },
    prefs: { claudeSelection: { model: 'opus', effort: 'high' } },
    kinds: { 'claude:1': 'claude', 'claude:2': 'claude' },
    turns,
  });
  // the chat picked Sonnet in the app: the panel shows that, not the default
  const chat = await menus.options({ chatId: 'claude:1' });
  assert.deepEqual([chat.model, chat.effort], ['sonnet', 'low']);
  // a chat with no pick of its own: the defaults' model at its default effort
  const plain = await menus.options({ chatId: 'claude:2' });
  assert.deepEqual([plain.model, plain.effort], ['opus', 'high']);
  await menus.choose({ chatId: 'claude:1', model: 'opus', effort: 'max' });
  assert.deepEqual(own, [['claude:1', { model: 'opus', effort: 'max', account: 'work' }]]);
  // before Claude Code's sessions are up: the defaults
  const early = world({ probed: { models: CLAUDE_MODELS }, kinds: { 'claude:1': 'claude' } });
  assert.equal((await early.menus.options({ chatId: 'claude:1' })).model, 'opus');
  await early.menus.choose({ chatId: 'claude:1', model: 'sonnet', effort: null });
});

test('Claude Code: a pick becomes the default selection, keeping Fast', async () => {
  const { menus, calls } = world({
    prefs: { claudeSelection: { model: 'opus', effort: 'high', fast: true } },
    kinds: { 'claude:1': 'claude' },
  });
  await menus.choose({ chatId: 'claude:1', model: 'sonnet', effort: 'low' });
  assert.deepEqual(calls, [['patchPrefs', { claudeSelection: { model: 'sonnet', effort: 'low', fast: true } }]]);
  const fresh = world();
  await fresh.menus.choose({ harness: 'claude', model: 'opus', effort: null });
  assert.deepEqual(fresh.calls, [['patchPrefs', { claudeSelection: { model: 'opus', effort: null } }]]);
});

test('a basic harness: its model and thought level options, its modes, the defaults new chats start with', async () => {
  const { menus } = world({ prefs: { basicDefaults: { gemini: { config: { model: 'm2' }, mode: 'auto' } } } });
  const now = await menus.options({ harness: 'acp:gemini' });
  assert.deepEqual(
    now.models.map((m: any) => [m.id, m.label, m.description, m.efforts.map((e: any) => e.label)]),
    [
      ['m1', 'Model one', null, ['Low', 'High']],
      ['m2', 'Model two', 'Bigger', ['Low', 'High']],
    ],
  );
  assert.deepEqual([now.model, now.effort], ['m2', 'lo']);
  assert.deepEqual(now.permission, {
    title: 'Mode',
    value: 'auto',
    rows: [
      { id: 'ask', label: 'Ask', detail: 'Asks first' },
      { id: 'auto', label: 'Auto', detail: '' },
    ],
  });
  // a chat's open session is what it shows
  const chat = world({
    state: [['acp:gemini:1', { acp: { configOptions: [], modes: { availableModes: [] } } }]],
    kinds: { 'acp:gemini:1': 'acp:gemini' },
  });
  const own = await chat.menus.options({ chatId: 'acp:gemini:1' });
  assert.deepEqual([own.models, own.model, own.effort, own.permission], [[], null, null, null]);
  // one with no catalog yet
  const bare = await world().menus.options({ harness: 'acp:bare' });
  assert.deepEqual([bare.models, bare.permission], [[], null]);
  const unknown = await world().menus.options({ harness: 'acp:nobody' });
  assert.deepEqual(unknown.models, []);
});

test('a basic harness: a pick goes to the chat’s open session and becomes the default; a mode the same', async () => {
  const session = { acp: ACP_CATALOG };
  const { menus, calls } = world({
    prefs: { basicDefaults: { gemini: { mode: 'ask' }, other: { mode: 'x' } } },
    state: [['acp:gemini:1', session]],
    kinds: { 'acp:gemini:1': 'acp:gemini' },
  });
  await menus.choose({ chatId: 'acp:gemini:1', model: 'm2', effort: 'hi' });
  assert.deepEqual(calls, [
    ['setConfigOption', 'key-acp:gemini:1', 'model', 'm2'],
    ['setConfigOption', 'key-acp:gemini:1', 'think', 'hi'],
    ['patchPrefs', { basicDefaults: { gemini: { mode: 'ask', config: { model: 'm2', think: 'hi' } }, other: { mode: 'x' } } }],
  ]);
  calls.length = 0;
  await menus.permit({ chatId: 'acp:gemini:1', value: 'auto' });
  assert.deepEqual(calls[0], ['setMode', 'key-acp:gemini:1', 'auto']);
  assert.deepEqual((calls[1] as any)[1].basicDefaults.gemini.mode, 'auto');

  // a new chat: only the defaults; an effort left out isn't set
  const fresh = world();
  await fresh.menus.choose({ harness: 'acp:gemini', model: 'm1', effort: null });
  await fresh.menus.permit({ harness: 'acp:gemini', value: 'ask' });
  assert.deepEqual(fresh.calls, [
    ['patchPrefs', { basicDefaults: { gemini: { config: { model: 'm1' } } } }],
    ['patchPrefs', { basicDefaults: { gemini: { config: { model: 'm1' }, mode: 'ask' } } }],
  ]);

  // a mode held as a config option goes through it
  const viaConfig = {
    configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }] }],
  };
  const cfg = world({ state: [['acp:gemini:2', { acp: viaConfig }]], kinds: { 'acp:gemini:2': 'acp:gemini' } });
  await cfg.menus.permit({ chatId: 'acp:gemini:2', value: 'b' });
  assert.deepEqual(cfg.calls[0], ['setConfigOption', 'key-acp:gemini:2', 'mode', 'b']);
  await assert.rejects(cfg.menus.permit({ chatId: 'acp:gemini:2', value: 'c' }), /That mode isn't one this harness has/);
  await assert.rejects(world().menus.permit({ harness: 'acp:bare', value: 'a' }), /That mode isn't one/);
});

test('Codex and Claude Code: a permission is the app’s own; one MoPilot doesn’t have is refused', async () => {
  const { menus, calls } = world({ kinds: { 'claude:1': 'claude' } });
  await menus.permit({ chatId: 'claude:1', value: 'read-only' });
  await menus.permit({ harness: 'codex', value: 'full-access' });
  assert.deepEqual(calls, [
    ['patchPrefs', { permission: 'read-only' }],
    ['patchPrefs', { permission: 'full-access' }],
  ]);
  await assert.rejects(menus.permit({ harness: 'codex', value: 'everything' }), /That permission isn't one MoPilot has/);
  // a chat main doesn't know, or no harness
  await assert.rejects(menus.options({ chatId: 'gone' }), /That chat isn't in MoPilot/);
  await assert.rejects(menus.options({}), /Pick a harness/);
});

test('the requests: a chat or a harness, an option as MoPilot names one, and the pick a message goes with', async () => {
  const calls: any[] = [];
  const panel = new ChromePanel({
    options: async (t: any) => (calls.push(['options', t]), { models: [] }),
    choose: async (p: any) => calls.push(['choose', p]),
    permit: async (p: any) => calls.push(['permit', p]),
    usable: async () => true,
    start: async (p: any) => (calls.push(['start', p]), 'c1'),
    send: async (p: any) => calls.push(['send', p]),
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (m: any) => (out = m));
    return out.error ?? out.result;
  };
  assert.deepEqual(await ask('options', { chatId: 'claude:1' }), { models: [] });
  assert.deepEqual(await ask('options', { harness: 'acp:gemini' }), { models: [] });
  assert.equal(await ask('options', { harness: 'gemini' }), 'Pick a harness for the new chat.');
  assert.equal(await ask('options', {}), 'Pick a harness for the new chat.');
  assert.equal(await ask('options', { chatId: 'a b' }), "That chat isn't in MoPilot.");
  assert.deepEqual(await ask('choose', { harness: 'claude', model: 'claude-fable-5-1[1m]' }), { chosen: true });
  assert.deepEqual(await ask('choose', { chatId: 'th-1', model: 'gpt-6.1-sol', effort: 'xhigh' }), { chosen: true });
  assert.equal(await ask('choose', { harness: 'claude' }), "That option isn't one MoPilot has.");
  assert.equal(await ask('choose', { harness: 'claude', model: 'opus', effort: '<b>' }), "That option isn't one MoPilot has.");
  assert.deepEqual(await ask('permit', { harness: 'codex', value: 'read-only' }), { permitted: true });
  assert.equal(await ask('permit', { harness: 'codex', value: 7 }), "That option isn't one MoPilot has.");
  assert.deepEqual(await ask('start', { harness: 'claude', text: 'hi', model: 'opus', effort: 'high' }), { chatId: 'c1' });
  assert.deepEqual(await ask('send', { chatId: 'c1', text: 'more', model: 'sonnet' }), { sent: true });
  assert.equal(await ask('send', { chatId: 'c1', text: 'more', model: 'a b' }), "That option isn't one MoPilot has.");
  assert.deepEqual(calls, [
    ['options', { chatId: 'claude:1' }],
    ['options', { harness: 'acp:gemini' }],
    ['choose', { harness: 'claude', model: 'claude-fable-5-1[1m]', effort: null }],
    ['choose', { chatId: 'th-1', model: 'gpt-6.1-sol', effort: 'xhigh' }],
    ['permit', { harness: 'codex', value: 'read-only' }],
    ['start', { harness: 'claude', text: 'hi', projectId: null, model: 'opus', effort: 'high', attachments: [], skills: [] }],
    ['send', { chatId: 'c1', text: 'more', model: 'sonnet', effort: null, attachments: [], skills: [] }],
  ]);
});

test('answers that leave things out: no Codex list, a model with no efforts, values with no names, a session with only modes', async () => {
  const none = await world({ codex: null }).menus.options({ harness: 'codex' });
  assert.deepEqual([none.models, none.model, none.effort], [[], null, null]);
  const bare = await world({ codex: { data: [{ model: 'm', displayName: 'm' }] } }).menus.options({ harness: 'codex' });
  assert.deepEqual([bare.models[0].efforts, bare.models[0].defaultEffort], [[], null]);
  // a chat record with no settings of its own
  const { menus, calls } = world({ records: [['th-1', {}]], kinds: { 'th-1': 'codex' } });
  await menus.choose({ chatId: 'th-1', model: 'm', effort: null });
  assert.deepEqual(calls.at(-1), ['patchMeta', 'th-1', { config: { model: 'm', effort: null } }]);
  const unnamed = {
    configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a' }] },
      { id: 'think', category: 'thought_level', type: 'select', options: [{ value: 'x' }] },
    ],
  };
  const acp = world({
    state: [
      ['acp:g:1', { acp: unnamed }],
      ['acp:g:2', { acp: { modes: { availableModes: [{ id: 'k' }] } } }],
    ],
    kinds: { 'acp:g:1': 'acp:g', 'acp:g:2': 'acp:g' },
  });
  const named = await acp.menus.options({ chatId: 'acp:g:1' });
  assert.deepEqual([named.models[0].label, named.models[0].efforts], ['a', [{ id: 'x', label: 'x' }]]);
  const modesOnly = await acp.menus.options({ chatId: 'acp:g:2' });
  assert.deepEqual([modesOnly.models, modesOnly.permission.rows[0].label], [[], 'k']);
});
