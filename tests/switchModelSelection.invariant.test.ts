// Automatic and legacy pending switches carry the destination model through real main-process switching and dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment } from './support/controller/fixture.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { configuredSwitchModel } from '../shared/switchModel.mjs';

const require = createRequire(import.meta.url);
const { LimitContinuation } = require('../electron/session/limitContinue.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { pickPendingModel } = require('../electron/session/pendingModel.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { switchAccount } = require('../electron/session/switchAccount.cjs');
const { claudeTurnSettings } = require('../electron/harness/claude/turnSettings.cjs');
const { mergeOwn } = require('../electron/harness/claude/own.cjs');
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

const CHAT = 'model-switch';

function rig(from = 'claude', prefs: any = { model: 'gpt-6.1-sol', claudeSelection: { model: 'opus' } }) {
  const h = setup();
  selectSegment(h.c, h.chats, CHAT, [[from, 'source-session']]);
  h.chats.patchMeta(CHAT, { config: { model: from === 'codex' ? 'source-codex' : 'source-claude' } });
  const starts: any[] = [];
  const events: any[] = [];
  const runner = new SwitchRunner({
    chats: h.chats,
    ref: (id: string) => h.c.ref(id),
    invalidate: () => h.c.invalidate(),
    claim: (key: string, id: string) => h.c.claim(key, id),
    unclaim: (key: string, id: string) => h.c.unclaim(key, id),
    changed() {},
    prefs: () => prefs,
    home: '/scratch',
    emit: (event: any) => events.push(event),
    git: { info: async () => null, status: async () => null },
    permissionParams: () => ({}),
    codex: {
      startThread: async (params: any, opts: any) => {
        starts.push(params);
        if (params.model === '')
          throw new Error('No models are available. Set `model` explicitly or check your model catalog configuration.');
        opts.onThread('destination-session');
        return { thread: { id: 'destination-session' } };
      },
      ensureResumed: async () => {},
      threadTurns: async () => ({ data: [], nextCursor: null }),
      cwdOf: () => '/scratch',
    },
    claude: { isFresh: () => true, cwdOf: () => '/scratch', registerSession() {} },
    acpHost: { chats: new Map(), history: async () => [] },
  });
  h.c.switcher = runner;
  const limit = new LimitContinuation({
    controller: h.c,
    prefs: () => prefs,
    resumeEnabled: () => true,
    switchEnabled: () => true,
    exhausted: () => true,
    choose: async () => null,
    resetAt: () => null,
    send: (chatId: string, item: any) => h.c.send(chatId, item, null, true),
  });
  const automatic = async (harness: string) => {
    const owner = { chatId: CHAT, kind: from, turnId: 'limited-turn', timer: null, itemId: null, afterSwitch: false };
    limit.owners.set(CHAT, owner);
    await limit.switchTo(owner, harness);
  };
  return { ...h, runner, limit, prefs, starts, events, automatic };
}

test('a usage-limit switch starts Codex on the selected model and dispatches Continue without a window', async () => {
  const t = rig();
  await t.automatic('codex');
  assert.equal(t.starts[0].model, 'gpt-6.1-sol');
  assert.equal(t.chats.record(CHAT).meta.config.model, 'gpt-6.1-sol');
  assert.equal(t.chats.record(CHAT).segments.at(-1).model, 'gpt-6.1-sol');
  assert.equal(t.execs.at(-1)?.item.text, 'Continue');
  assert.equal(t.execs.at(-1)?.ref.kind, 'codex');
  assert.equal(t.state.get(CHAT).queue.length, 0);
});

test('every source family automatically selects the destination model rather than its source model', async () => {
  for (const [from, to, expected] of [
    ['claude', 'codex', 'gpt-6.1-sol'],
    ['codex', 'claude', 'opus'],
    ['acp:kimi', 'codex', 'gpt-6.1-sol'],
    ['acp:kimi', 'claude', 'opus'],
  ]) {
    const t = rig(from);
    await t.automatic(to);
    assert.equal(t.chats.record(CHAT).meta.config.model, expected);
    assert.equal(t.events.find((e) => e.kind === 'switched').model, expected);
    assert.equal(t.execs.at(-1)?.ref.kind, to);
  }
});

test('legacy blank and missing pending models resolve before native start and persist the same choice', async () => {
  for (const model of ['', '  ', undefined, [], {}]) {
    const t = rig();
    const result = await t.runner.perform(CHAT, { harness: 'codex', model, mode: 'auto' });
    assert.equal(result.ready, true);
    assert.equal(t.starts[0].model, 'gpt-6.1-sol');
    assert.equal(t.chats.record(CHAT).meta.config.model, 'gpt-6.1-sol');
    assert.equal(t.chats.record(CHAT).segments.at(-1).model, 'gpt-6.1-sol');
  }
});

test('a concrete custom model needs no catalog and wins over configured defaults', async () => {
  const t = rig();
  await t.runner.perform(CHAT, { harness: 'codex', model: 'custom/provider-model', mode: 'auto' });
  assert.equal(t.starts[0].model, 'custom/provider-model');
  assert.equal(t.chats.record(CHAT).meta.config.model, 'custom/provider-model');
});

test('a genuine native default is null at startup, never an empty string or the source model', async () => {
  for (const prefs of [{}, { model: '' }, { model: null }, { model: ' ' }, { model: [] }]) {
    const t = rig('claude', prefs);
    await t.automatic('codex');
    assert.equal(t.starts[0].model, null);
    assert.equal(t.chats.record(CHAT).meta.config.model, null);
    assert.equal(t.chats.record(CHAT).segments.at(-1).model, null);
    assert.equal(t.execs.at(-1)?.ref.kind, 'codex');
  }
});

test('the pending switch snapshots its model before startup and ignores another chat changing defaults', async () => {
  const t = rig();
  const wait = deferred<any>();
  const original = t.runner.codex.startThread;
  let selected: any;
  t.runner.codex.startThread = async (params: any, opts: any) => {
    selected = { ...params };
    await wait.promise;
    return original(params, opts);
  };
  const pending = t.automatic('codex');
  await tick();
  assert.equal(selected.model, 'gpt-6.1-sol');
  t.prefs.model = 'another-chat-model';
  wait.resolve(null);
  await pending;
  assert.equal(t.starts[0].model, 'gpt-6.1-sol');
  assert.equal(t.chats.record(CHAT).meta.config.model, 'gpt-6.1-sol');
});

test('failed startup retains a user message and explicit model for a successful retry', async () => {
  const t = rig();
  const start = t.runner.codex.startThread;
  t.runner.codex.startThread = async () => {
    throw new Error('temporary transport failure');
  };
  t.state.patch(CHAT, { pendingSwitch: { harness: 'codex', model: 'picked-model', modelLabel: 'Picked', mode: 'auto' } });
  await t.c.send(CHAT, { text: 'continue my work', attachments: [], opts: { human: true } }, null, true);
  assert.equal(t.state.get(CHAT).queue[0].text, 'continue my work');
  assert.equal(t.state.get(CHAT).pendingSwitch.model, 'picked-model');
  assert.equal(t.chats.record(CHAT).segments.length, 1);
  t.prefs.model = 'another-chat-model';
  t.runner.codex.startThread = start;
  await t.c.sendNow(CHAT, t.state.get(CHAT).queue[0].id, null, true);
  assert.equal(t.starts[0].model, 'picked-model');
  assert.equal(t.execs.at(-1)?.item.text, 'continue my work');
  assert.equal(t.state.get(CHAT).queue.length, 0);
});

test('a failed legacy default switch retains its resolved model when another chat changes defaults before retry', async () => {
  const t = rig();
  const start = t.runner.codex.startThread;
  t.runner.codex.startThread = async () => {
    throw new Error('temporarily down');
  };
  t.state.patch(CHAT, { pendingSwitch: { harness: 'codex', model: '', modelLabel: '', mode: 'auto' } });
  await t.c.send(CHAT, { text: 'keep this request', attachments: [], opts: { human: true } }, null, true);
  assert.equal(t.state.get(CHAT).pendingSwitch.model, 'gpt-6.1-sol');
  t.prefs.model = 'other-chat-model';
  t.runner.codex.startThread = start;
  await t.c.sendNow(CHAT, t.state.get(CHAT).queue[0].id, null, true);
  assert.equal(t.starts[0].model, 'gpt-6.1-sol');
  assert.equal(t.chats.record(CHAT).meta.config.model, 'gpt-6.1-sol');
});

test('a captured native default stays null across failed startup and changed global defaults', async () => {
  const t = rig('claude', {});
  const start = t.runner.codex.startThread;
  t.runner.codex.startThread = async () => {
    throw new Error('temporarily down');
  };
  t.state.patch(CHAT, { pendingSwitch: { harness: 'codex', model: '', modelLabel: '', mode: 'auto' } });
  await t.c.send(CHAT, { text: 'keep native default', attachments: [], opts: { human: true } }, null, true);
  assert.equal(t.state.get(CHAT).pendingSwitch.model, null);
  t.prefs.model = 'other-chat-model';
  t.runner.codex.startThread = start;
  await t.c.sendNow(CHAT, t.state.get(CHAT).queue[0].id, null, true);
  assert.equal(t.starts[0].model, null);
  assert.equal(t.chats.record(CHAT).meta.config.model, null);
});

test('returning to an existing Codex segment applies the destination model without starting another native session', async () => {
  const t = rig();
  selectSegment(t.c, t.chats, CHAT, [
    ['codex', 'earlier-codex'],
    ['claude', 'current-claude'],
  ]);
  await t.automatic('codex');
  assert.deepEqual(t.starts, []);
  assert.equal(t.chats.record(CHAT).segments.at(-1).nativeId, 'earlier-codex');
  assert.equal(t.chats.record(CHAT).meta.config.model, 'gpt-6.1-sol');
});

test('host continuations use destination defaults, persist them for the first turn, and preserve same-harness choices', async () => {
  for (const [from, to, expected] of [
    ['claude', 'codex', 'gpt-6.1-sol'],
    ['codex', 'claude', 'opus'],
    ['codex', 'codex', 'source-codex'],
    ['claude', 'claude', 'source-claude'],
  ]) {
    const t = rig(from);
    const result = await t.runner.perform(CHAT, { continue: { harness: to, cwd: '/scratch', text: 'saved handoff' } });
    assert.equal(result.ready, true);
    assert.equal(t.chats.record(CHAT).meta.config.model, expected);
    assert.equal(t.chats.record(CHAT).segments.at(-1).model, expected);
    if (to === 'codex') assert.equal(t.starts[0].model, expected);
  }
});

test('a same-harness host continuation preserves an explicit native default instead of another chat default', async () => {
  for (const kind of ['codex', 'claude']) {
    const t = rig(kind);
    t.chats.patchMeta(CHAT, { config: { model: null, effort: 'high' } });
    const result = await t.runner.perform(CHAT, { continue: { harness: kind, cwd: '/scratch', text: 'saved handoff' } });
    assert.equal(result.ready, true);
    assert.equal(t.chats.record(CHAT).segments.at(-1).model, null);
    assert.equal(t.chats.record(CHAT).meta.config.model, null);
    assert.equal(t.chats.record(CHAT).meta.config.effort, 'high');
    if (kind === 'codex') assert.equal(t.starts[0].model, null);
  }
});

test('host continuation snapshots survive failed native starts and a new runner reading the saved chat', async () => {
  for (const prefs of [{ model: 'first-model' }, {}]) {
    const t = rig('claude', prefs);
    const start = t.runner.codex.startThread;
    const continuation = { harness: 'codex', cwd: '/scratch', text: 'saved handoff' };
    t.runner.codex.startThread = async () => {
      throw new Error('temporarily down');
    };
    assert.equal((await t.runner.perform(CHAT, { continue: continuation })).ready, false);
    const expected = prefs.model ?? null;
    assert.equal(t.chats.record(CHAT).meta.continueModel.model, expected);
    await t.chats.flush();
    const reloaded = new ChatsStore(t.chats.dir);
    assert.equal(reloaded.record(CHAT).meta.continueModel.model, expected);
    t.runner.chats = reloaded;
    t.prefs.model = 'other-chat-model';
    // A new object, as the inbox returns after a restart, still finds the durable snapshot.
    t.runner.codex.startThread = start;
    assert.equal((await t.runner.perform(CHAT, { continue: { ...continuation } })).ready, true);
    assert.equal(t.starts[0].model, expected);
    assert.equal(reloaded.record(CHAT).meta.config.model, expected);
    assert.equal(reloaded.record(CHAT).meta.continueModel, null);
  }
});

test('a different host handoff replaces an obsolete capture and an unsaved capture never starts native work', async () => {
  const t = rig();
  const start = t.runner.codex.startThread;
  t.runner.codex.startThread = async () => {
    throw new Error('temporarily down');
  };
  const continuation = { harness: 'codex', cwd: '/scratch', text: 'first handoff' };
  await t.runner.perform(CHAT, { continue: continuation });
  t.prefs.model = 'replacement-model';
  t.runner.codex.startThread = start;
  await t.runner.perform(CHAT, { continue: { ...continuation, text: 'replacement handoff' } });
  assert.equal(t.starts[0].model, 'replacement-model');
  const refused = rig();
  refused.chats.patchMeta = () => false;
  const result = await refused.runner.perform(CHAT, { continue: continuation });
  assert.equal(result.ready, false);
  assert.match(result.error, /could not save/);
  assert.deepEqual(refused.starts, []);
});

test('a corrupt captured model is replaced and a same-harness continuation with no own choice uses its configured default', async () => {
  const t = rig('codex');
  t.chats.patchMeta(CHAT, { config: {} });
  const start = t.runner.codex.startThread;
  t.runner.codex.startThread = async () => {
    throw new Error('temporarily down');
  };
  const continuation = { harness: 'codex', cwd: '/scratch', text: 'same handoff' };
  await t.runner.perform(CHAT, { continue: continuation });
  const captured = t.chats.record(CHAT).meta.continueModel;
  for (const model of [null, '', 123]) {
    t.chats.patchMeta(CHAT, { continueModel: { ...captured, model } });
    await t.runner.perform(CHAT, { continue: continuation });
    assert.equal(t.chats.record(CHAT).meta.continueModel.model, model === null ? null : 'gpt-6.1-sol');
  }
  t.runner.codex.startThread = start;
  await t.runner.perform(CHAT, { continue: continuation });
  assert.equal(t.starts[0].model, 'gpt-6.1-sol');
});

test('a model-only edit merges into current main state rather than overwriting another window account and mode', () => {
  const t = rig();
  t.state.patch(CHAT, { pendingSwitch: { harness: 'codex', model: 'first', modelLabel: 'First', account: 'a', mode: 'auto' } });
  const stale = t.state.snapshot(CHAT).pendingSwitch;
  t.state.patch(CHAT, { pendingSwitch: { ...stale, account: 'b', mode: 'summary' } });
  assert.equal(pickPendingModel(t.state, CHAT, stale.harness, 'new-model'), true);
  assert.deepEqual(t.state.get(CHAT).pendingSwitch, {
    ...stale,
    account: 'b',
    mode: 'summary',
    model: 'new-model',
    modelLabel: 'New Model',
    // a level recorded for the old model may not exist on this one
    effort: null,
  });
  assert.equal(pickPendingModel(t.state, CHAT, stale.harness, 'new-model', 'high'), true);
  assert.equal(t.state.get(CHAT).pendingSwitch.effort, 'high');
  assert.equal(pickPendingModel(t.state, CHAT, 'claude', 'wrong-target'), false);
  for (const [chatId, harness, model] of [
    [1, 'codex', 'x'],
    ['', 'codex', 'x'],
    [CHAT, 3, 'x'],
    [CHAT, 'codex', {}],
  ])
    assert.equal(pickPendingModel(t.state, chatId, harness, model), false);
  t.state.patch(CHAT, { pendingSwitch: null });
  assert.equal(pickPendingModel(t.state, CHAT, 'codex', 'retired'), false);
});

test('the first Claude turn after switching follows the captured model rather than a retired segment own selection', async () => {
  for (const automaticAccount of [false, true]) {
    for (const model of ['sonnet', null]) {
      const t = rig('codex');
      const adapter = {
        own: new Map([[CHAT, { model: 'opus', effort: 'max', account: 'prior-account' }]]),
        prefs: () => t.prefs,
        savedSettings: () => t.chats.record(CHAT).meta.config,
        pinnedModel: () => null,
        pinnedEffort: () => null,
        accountOf: () => 'default',
        probeInfo: () => ({ models: [] }),
        setOwn(id: string, selected: any) {
          this.own.set(id, mergeOwn(this.own.get(id), selected));
        },
      };
      t.runner.putAccount = switchAccount({ chats: t.chats, codex: () => null, claude: adapter, activateSelection: true });
      const result = await t.runner.perform(CHAT, { harness: 'claude', model, modelLabel: '', mode: 'auto', automaticAccount });
      assert.equal(result.ready, true);
      assert.equal(claudeTurnSettings(adapter, CHAT, {}).model, model);
      assert.equal(adapter.own.get(CHAT)?.account, automaticAccount ? null : 'prior-account');
    }
  }
});

test('the panel preserves a captured native default and accepts a concrete replacement without a model catalog', async () => {
  const t = rig();
  t.state.patch(CHAT, { pendingSwitch: { harness: 'codex', model: null, modelLabel: '', account: 'current', mode: 'summary' } });
  const menus = createPanelOptions({
    live: {
      controller: t.c,
      chats: t.chats,
      codex: { modelList: async () => ({ data: [] }) },
      patchPrefs: (p: any) => Object.assign(t.prefs, p),
    },
    claude: {},
    prefs: () => t.prefs,
    kindOf: () => 'claude',
    labelOf: (kind: string) => kind,
    usable: async () => true,
  });
  const captured = t.state.get(CHAT).pendingSwitch;
  t.state.patch(CHAT, { pendingSwitch: { ...captured, model: '' } });
  assert.equal((await menus.options({ chatId: CHAT })).model, 'gpt-6.1-sol', 'legacy blank choices show the destination default');
  t.state.patch(CHAT, { pendingSwitch: captured });
  assert.equal((await menus.options({ chatId: CHAT })).model, null);
  await menus.choose({ chatId: CHAT, model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(t.state.get(CHAT).pendingSwitch.model, 'gpt-6.1-sol');
  assert.equal(t.state.get(CHAT).pendingSwitch.account, 'current');
  assert.equal(t.state.get(CHAT).pendingSwitch.mode, 'summary');
});

test('the shared resolver preserves explicit ACP/custom choices without borrowing another harness default', () => {
  const prefs = { model: 'codex-model', claudeSelection: { model: 'sonnet' } };
  assert.equal(configuredSwitchModel('codex', null, prefs), 'codex-model');
  assert.equal(configuredSwitchModel('claude', '', prefs), 'sonnet');
  assert.equal(configuredSwitchModel('claude', null), null);
  assert.equal(configuredSwitchModel('codex', null, null), null);
  assert.equal(configuredSwitchModel('acp:kimi', null, prefs), null);
  assert.equal(configuredSwitchModel('acp:kimi', 'provider/model', prefs), 'provider/model');
  assert.equal(configuredSwitchModel('toString', null, prefs), null);
});
