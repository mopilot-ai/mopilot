// Automatic model intent survives side-panel effort edits, new chats and pending switches across harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PanelMenus } from '../electron/chrome-extension/src/panelMenus.mjs';
import { el } from './support/side-panel-page.ts';
import { tick, deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
const { applySettings } = require('../electron/harness/acp/settings.cjs');
const { applyInitialConfig } = require('../electron/harness/acp/initialConfig.cjs');

function world(harness: string, pendingSwitch?: any) {
  let prefs: any = { model: 'old', claudeSelection: { model: 'old' } };
  const record: any = { meta: { config: { model: null } } };
  let pending = pendingSwitch;
  const live: any = {
    chats: {
      records: new Map([['chat', record]]),
      get: () => record,
      patchMeta(_id: string, patch: any) {
        record.meta = { ...record.meta, ...patch };
        return true;
      },
    },
    controller: {
      state: {
        get: () => ({ pendingSwitch: pending }),
        patch: (_id: string, p: any) => {
          pending = p.pendingSwitch;
        },
      },
      ref: () => ({ kind: harness, key: 'native' }),
    },
    codex: {
      modelList: async () => ({
        data: [
          { model: 'old', displayName: 'Old' },
          {
            model: 'new',
            displayName: 'New',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high',
          },
        ],
      }),
    },
    claudeTurns: {
      settings: () => ({ model: 'new', selectionModel: record.meta.config.model }),
      setOwn() {},
      pickOf: () => null,
    },
    acpAdmission: {
      list: () => [
        {
          id: 'agent',
          catalog: {
            configOptions: [
              { id: 'model', category: 'model', type: 'select', currentValue: 'new', options: [{ value: 'new' }, { value: 'old' }] },
              {
                id: 'effort',
                category: 'thought_level',
                type: 'select',
                currentValue: 'low',
                options: [{ value: 'low' }, { value: 'high' }],
              },
            ],
          },
        },
      ],
    },
    patchPrefs(patch: any) {
      prefs = { ...prefs, ...patch };
    },
  };
  const claude = {
    probeInfo: () => ({
      models: [
        { value: 'default', resolvedModel: 'new' },
        { value: 'old', displayName: 'Old' },
        { value: 'new', displayName: 'New', supportedEffortLevels: ['high'] },
      ],
    }),
  };
  const menus = createPanelOptions({
    live,
    claude,
    prefs: () => prefs,
    kindOf: () => harness,
    labelOf: () => harness,
    usable: async () => true,
  });
  const els: Record<string, any> = {};
  const requests: any[] = [];
  const panel = new PanelMenus({
    document: { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) },
    request: async (method: string, p: any) => {
      requests.push([method, p]);
      return menus[method](p);
    },
    onError: (text: string) => assert.fail(text),
    onHarness() {},
  });
  const click = async (label: string) => {
    const row = els['model-rows'].children.find((r: any) => r.attrs.role === 'menuitemradio' && r.children[0]?.textContent === label);
    assert.ok(row, `missing ${label}`);
    row.listeners.click();
    await tick();
    await tick();
    return row;
  };
  return { menus, panel, record, els, click, requests, live, prefs: () => prefs, pending: () => pending };
}

for (const harness of ['codex', 'claude'])
  test(`${harness}: effort-only edits retain Automatic; explicit model picks and choosing Automatic remain distinct`, async () => {
    const w = world(harness);
    await w.panel.load({ chatId: 'chat' });
    assert.equal(w.panel.now?.model, 'new');
    assert.equal(w.panel.now?.automatic, true);
    await w.click('High');
    assert.deepEqual(w.requests.at(-1), ['choose', { chatId: 'chat', model: null, effort: 'high' }]);
    assert.equal(w.record.meta.config.model, null);
    assert.equal(w.record.meta.config.effort, 'high');
    w.panel.view = 'list';
    w.panel.render();
    assert.equal((await w.click('Automatic')).attrs['aria-checked'], 'true');
    await w.click('Old');
    assert.equal(w.record.meta.config.model, 'old');
    await w.click('Automatic');
    assert.equal(w.record.meta.config.model, null);
    await w.panel.load({ harness });
    assert.deepEqual(w.panel.pick, { model: null, effort: 'high' }, 'a new message carries intent rather than a snapshot pin');
  });

test('a pending Automatic switch keeps its effective model and efforts despite a pinned new-chat default', async () => {
  const w = world('codex', { harness: 'codex', model: null });
  await w.panel.load({ chatId: 'chat' });
  assert.equal(w.panel.now?.model, 'new');
  assert.equal(w.panel.now?.automatic, true);
  await w.click('High');
  assert.equal(w.pending().model, null);
  assert.equal(w.pending().modelLabel, 'New');
});

test('a pending Automatic pick retains a readable label if discovery loses its catalog before the pick is saved', async () => {
  const w = world('codex', { harness: 'codex', model: 'old' });
  w.live.codex.modelList = async () => ({ data: [] });
  await w.menus.choose({ chatId: 'chat', model: null, effort: null });
  assert.equal(w.pending().modelLabel, 'Automatic');
  assert.equal(w.pending().model, null);
});

for (const order of ['old-first', 'new-first', 'old-rejects', 'replaced'] as const)
  test(`pending model picks retain only the latest attempt on their exact switch (${order})`, async () => {
    const w = world('codex', { harness: 'codex', model: 'old' });
    const old = deferred<any>();
    const fresh = deferred<any>();
    const reads = [old, fresh];
    w.live.codex.modelList = () => reads.shift()!.promise;
    const older = w.menus.choose({ chatId: 'chat', model: null, effort: 'high' });
    const newer = w.menus.choose({ chatId: 'chat', model: 'new', effort: 'high' });
    const catalog = { data: [{ model: 'new', displayName: 'New', isDefault: true }] };
    await tick();
    if (order === 'old-first') {
      old.resolve(catalog);
      await older;
      assert.equal(w.pending().model, 'old', 'the obsolete result cannot write while its replacement is pending');
    } else if (order === 'old-rejects') {
      old.reject(new Error('obsolete label read'));
      await assert.rejects(older, /obsolete label read/);
    } else if (order === 'replaced') {
      w.live.controller.state.patch('chat', { pendingSwitch: { harness: 'codex', model: 'replacement' } });
    }
    fresh.resolve(catalog);
    await newer;
    if (order === 'new-first' || order === 'replaced') {
      old.resolve(catalog);
      await older;
    }
    assert.equal(w.pending().model, order === 'replaced' ? 'replacement' : 'new');
  });

test('ACP effort-only edits never create a model default; an explicit model pick still does', async () => {
  const w = world('acp:agent');
  await w.panel.load({ harness: 'acp:agent' });
  await w.click('high');
  assert.deepEqual(w.prefs().basicDefaults.agent.config, { effort: 'high' });
  assert.deepEqual(w.panel.pick, {}, 'a new ACP session owns its current defaults, not the panel snapshot');
  w.panel.view = 'list';
  w.panel.render();
  await w.click('old');
  assert.deepEqual(w.prefs().basicDefaults.agent.config, { model: 'old', effort: 'high' });
});

for (const pinned of [false, true])
  test(`starting ACP from a panel snapshot preserves ${pinned ? 'an explicit saved model' : 'the current native default'}`, async () => {
    const w = world('acp:agent');
    await w.panel.load({ harness: 'acp:agent' });
    if (pinned) {
      w.panel.view = 'list';
      w.panel.render();
      await w.click('old');
    }
    const chat: any = {
      key: 'native',
      harness: 'agent',
      sessionId: 'session',
      state: {
        configOptions: [
          { id: 'model', category: 'model', type: 'select', currentValue: 'fresh', options: [{ value: 'old' }, { value: 'fresh' }] },
        ],
      },
    };
    const requests: any[] = [];
    chat.agent = {
      request: async (...args: any[]) => {
        requests.push(args);
        return {};
      },
    };
    const host = {
      assertChatCurrent() {},
      now: () => 0,
      items: { readAsync: async () => [], append() {} },
      label: () => 'Agent',
      setConfigOption: async (...args: any[]) => requests.push(args),
    };
    await applySettings(host, chat, w.prefs().basicDefaults?.agent);
    await applyInitialConfig(host, chat, w.panel.pick);
    assert.equal(chat.state.configOptions[0].currentValue, pinned ? 'old' : 'fresh');
    assert.equal(requests.length, pinned ? 1 : 0, 'only an explicit saved pick may override the new session default');
  });

test('the panel transport admits explicit Automatic and still refuses a missing model choice', async () => {
  const choices: any[] = [];
  const panel = new ChromePanel({ choose: async (p: any) => choices.push(p) });
  const replies: any[] = [];
  for (const [id, params] of [
    [1, { harness: 'codex', model: null }],
    [2, { harness: 'codex' }],
  ] as const)
    await panel.handle({ id, method: 'choose', params }, (reply: any) => replies.push(reply));
  assert.deepEqual(choices, [{ harness: 'codex', model: null, effort: null }]);
  assert.equal(replies[0].result.chosen, true);
  assert.ok(replies[1].error);
});
