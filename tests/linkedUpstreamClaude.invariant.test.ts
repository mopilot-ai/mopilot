// Upstream MoMo model ownership and linked-session persistence share one main settings and renderer push contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHAT, ref, setup, item } from './support/claude-adapter.ts';
import { createOwnSettingsSync } from '../src/harness/claude/ownSettings.ts';
import { claudeOwnOf, ownInputsChanged } from '../src/harness/claude/own.ts';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/', 'src/harness/'];

const require = createRequire(import.meta.url);
const { createAppState } = require('../electron/app/appState.cjs');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('the main-owned model pin wins over stale renderer and saved picks while linked native settings survive', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus', effort: 'high' } } });
  h.adapter.savedSettings = () => ({ model: 'opus', effort: 'high', permission: 'auto-review', additionalDirectories: ['/notes'] });
  h.adapter.pinnedModel = () => 'sonnet';
  h.adapter.setOwn(CHAT, { model: 'opus', effort: 'max', account: 'default' });
  h.adapter.setOwn(CHAT, { account: 'default' });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  assert.equal(h.sent[0].opts.model, 'sonnet');
  assert.equal(h.sent[0].opts.effort, 'high', 'effort chosen for the stale model cannot move onto the pin');
  assert.equal(h.sent[0].opts.permission, 'default', 'the actual pinned model controls auto-review support');
  assert.deepEqual(h.sent[0].opts.additionalDirectories, ['/notes']);
  assert.equal(h.adapter.settings(CHAT, { model: 'haiku' }).model, 'haiku', 'a scheduled input still owns its explicit override');
  h.adapter.setOwn(CHAT, { model: 'sonnet', effort: 'low' });
  assert.equal(h.adapter.settings(CHAT, {}).effort, 'low');
  h.adapter.pinnedModel = () => null;
  assert.equal(h.adapter.settings(CHAT, {}).model, 'sonnet', 'ordinary linked chats retain their own model');
});

test('unread renderer values omit models, saved linked values remain usable and MoMo changes trigger the same sync', async () => {
  const calls: any[] = [];
  const h = setup();
  h.adapter.setOwn(CHAT, { model: 'sonnet', effort: 'low', account: 'default' });
  const sync = createOwnSettingsSync({
    familyOf: () => 'claude',
    send: async (id, own) => {
      calls.push(own);
      h.adapter.setOwn(id, own);
    },
  });
  const state: any = { runtime: {}, chatConfig: {}, claudeChats: { [CHAT]: { id: 'default' } }, claude: { models: [] } };
  sync(state);
  assert.deepEqual(calls.at(-1), { account: 'default' });
  assert.equal(h.adapter.own.get(CHAT).model, 'sonnet');
  state.claude.models = [{ id: 'sonnet' }, { id: 'opus' }];
  state.chatConfig = { [CHAT]: { model: 'sonnet', effort: 'low' } };
  assert.equal(ownInputsChanged(state, { ...state, chatConfig: {} }), true);
  sync(state);
  assert.deepEqual(calls.at(-1), { model: 'sonnet', effort: 'low', account: 'default' });
  state.momoModels = { [CHAT]: 'opus' };
  sync(state);
  assert.equal(calls.at(-1).model, 'opus');
  assert.deepEqual(claudeOwnOf({ ...state, runtime: {}, chatConfig: {} }, CHAT), { model: 'opus', effort: null, account: 'default' });
  state.runtime[CHAT] = { settings: { model: null } };
  state.momoModels = {};
  sync(state);
  assert.deepEqual(calls.at(-1), { model: null, effort: null, account: 'default' }, 'explicit none still clears a known pick');
});

test('partial saved and runtime settings cannot clear main model knowledge; known saved picks fill unread runtime models', async (t) => {
  for (const [config, runtime, expected] of [
    [{ permission: 'read-only' }, undefined, { account: 'default' }],
    [{ permission: 'read-only' }, { settings: { permission: 'read-only' } }, { account: 'default' }],
    [{ model: 'opus', effort: 'high' }, { settings: { permission: 'read-only' } }, { model: 'opus', effort: 'high', account: 'default' }],
    [{ model: 'opus', effort: 'high' }, { settings: { model: null } }, { model: null, effort: null, account: 'default' }],
  ] as const) {
    await t.test(JSON.stringify({ config, runtime }), () => {
      const h = setup({ prefs: { claudeSelection: { model: 'opus', effort: 'high' } } });
      h.adapter.savedSettings = () => config;
      h.adapter.setOwn(CHAT, { model: 'sonnet', effort: 'low', account: 'default' });
      const calls: unknown[] = [];
      const sync = createOwnSettingsSync({
        familyOf: () => 'claude',
        send: async (id, own) => {
          calls.push(own);
          h.adapter.setOwn(id, own);
        },
      });
      sync({
        runtime: runtime ? { [CHAT]: runtime } : {},
        chatConfig: { [CHAT]: config },
        claudeChats: { [CHAT]: { id: 'default' } },
        claude: { models: [{ id: 'sonnet' }, { id: 'opus' }] },
      } as any);
      assert.deepEqual(calls, [expected]);
      assert.equal(h.adapter.settings(CHAT, {}).model, 'model' in expected ? 'opus' : 'sonnet');
      assert.equal(h.adapter.settings(CHAT, {}).effort, 'model' in expected ? 'high' : 'low');
    });
  }
});

test('a renderer push cannot relabel another model effort as owned by the main model pin', () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus', effort: 'high' } } });
  h.adapter.savedSettings = () => ({ model: 'opus', effort: 'high' });
  h.adapter.pinnedModel = () => 'sonnet';
  h.adapter.setOwn(CHAT, { model: 'opus', effort: 'max', account: 'default' });
  const assertPick = () => assert.deepEqual([h.adapter.settings(CHAT, {}).model, h.adapter.settings(CHAT, {}).effort], ['sonnet', 'high']);
  assertPick();
  const sync = createOwnSettingsSync({ familyOf: () => 'claude', send: async (id, own) => h.adapter.setOwn(id, own) });
  const state: any = {
    runtime: { [CHAT]: { settings: { model: 'opus', effort: 'max' } } },
    chatConfig: { [CHAT]: { model: 'opus', effort: 'high' } },
    momoModels: { [CHAT]: 'sonnet' },
    claudeChats: { [CHAT]: { id: 'default' } },
    claude: { models: [{ id: 'sonnet' }, { id: 'opus' }] },
  };
  sync(state);
  assertPick();
  state.runtime[CHAT] = { settings: { model: 'sonnet', effort: 'low' } };
  sync(state);
  assert.equal(h.adapter.settings(CHAT, {}).effort, 'low', 'an effort actually chosen for the pinned model still applies');
});

test('a committed MoMo model change reconciles only its native permission capability without another user turn', async (t) => {
  for (const completesBeforeOwn of [false, true])
    await t.test(`old control completes before renderer receipt: ${completesBeforeOwn}`, async (t) => {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-upstream-model-'));
      t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
      const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
      const live = { claudeTurns: h.adapter, controller: { invalidate() {} } };
      const main = createAppState({
        app: { getPath: () => folder, getVersion: () => '9.9.9' },
        live,
        claude: { retireChat() {}, setChatNames() {} },
        isFlagEnabled: () => false,
      });
      main.openChats();
      h.adapter.savedSettings = (id: string) => main.chats.records.get(id)?.meta.config;
      h.adapter.pinnedModel = (id: string) => main.chats.records.get(id)?.meta.momoModel ?? null;
      main.chats.patchMeta(CHAT, { momo: 'main', momoModel: 'opus', config: { model: 'opus', permission: 'auto-review' } });
      const other = 'claude:unrelated';
      main.chats.patchMeta(other, { config: { model: 'opus', permission: 'full-access' } });
      await h.adapter.startTurn(CHAT, ref(CHAT), item());
      await h.adapter.startTurn(other, ref(other), item());
      const state: any = {
        runtime: { [CHAT]: { settings: { model: 'opus' } } },
        chatConfig: { [CHAT]: { model: 'opus', permission: 'auto-review' } },
        momoModels: { [CHAT]: 'opus' },
        claudeChats: { [CHAT]: { id: 'default' } },
        claude: { models: [{ id: 'sonnet' }, { id: 'opus' }] },
      };
      const sync = createOwnSettingsSync({ familyOf: () => 'claude', send: async (id, own) => h.adapter.setOwn(id, own) });
      sync(state);
      const pending = deferred<void>();
      h.api.control = async (key: string, method: string, permission: unknown) => {
        h.controls.push([key, method, permission]);
        if (permission === 'default') await pending.promise;
      };
      main.chats.patchMeta(CHAT, { momoModel: 'sonnet' });
      state.momoModels = { [CHAT]: 'sonnet' };
      sync(state);
      await tick();
      assert.deepEqual(h.controls, [[CHAT, 'setPermissionMode', 'default']]);
      assert.equal(h.adapter.live.get(other).permission, 'full-access');
      main.chats.patchMeta(CHAT, { momoModel: null });
      await tick();
      assert.equal(h.controls.length, 1, 'the newer model choice waits behind the first native control');
      if (completesBeforeOwn) {
        pending.resolve();
        await tick();
      }
      state.momoModels = {};
      sync(state);
      pending.resolve();
      await tick();
      assert.equal(h.adapter.live.get(CHAT).permission, 'auto-review', 'removing the pin restores the saved model capability');
      assert.deepEqual(h.controls, [
        [CHAT, 'setPermissionMode', 'default'],
        [CHAT, 'setPermissionMode', 'auto-review'],
      ]);
    });
});

test('own model changes and explicit clears reconcile native capability, while account-only same-capability receipts do not', async () => {
  const h = setup({ prefs: { permission: 'auto-review', claudeSelection: { model: 'opus' } } });
  h.adapter.setOwn(CHAT, { model: 'sonnet', effort: 'low', account: 'default' });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  h.adapter.setOwn(CHAT, { account: 'default' });
  await tick();
  assert.deepEqual(h.controls, []);
  h.adapter.setOwn(CHAT, null);
  await tick();
  assert.deepEqual(h.controls, [[CHAT, 'setPermissionMode', 'auto-review']]);
  assert.equal(h.adapter.settings(CHAT, {}).model, 'opus');
  h.adapter.setOwn(CHAT, { model: 'sonnet' });
  await tick();
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
  assert.deepEqual(h.controls.at(-1), [CHAT, 'setPermissionMode', 'default']);
});

test('a failed own-model capability reconciliation is diagnosed without rejecting the synchronous settings receipt', async () => {
  const h = setup({ prefs: { permission: 'auto-review', claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  h.api.isLive = () => {
    throw new Error('native lifetime unavailable');
  };
  assert.equal(h.adapter.setOwn(CHAT, { model: 'sonnet' }), true);
  await tick();
  const { recentIgnored } = require('../electron/ignored.cjs');
  assert.ok(
    recentIgnored().some(
      (entry: any) => entry.context === 'apply the chat model permission capability' && entry.message === 'native lifetime unavailable',
    ),
  );
});
