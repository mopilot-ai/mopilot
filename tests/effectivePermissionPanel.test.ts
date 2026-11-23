// The Chrome panel shares native permission projection and saves explicit choices at the chat's scope before changing defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

for (const family of ['codex', 'claude']) {
  test(`${family}: panel reports Plan mode and native recovery, then preserves independent chat settings on selection`, async () => {
    const record: any = { meta: { config: { model: 'own', effort: 'high', permission: 'full-access' } } };
    const state: any = { permission: 'plan' };
    let save = true;
    let prefs: any = { permission: 'default' };
    const menus = createPanelOptions({
      live: {
        chats: {
          records: new Map([['chat', record]]),
          patchMeta: (_id: string, patch: any) => {
            if (save) Object.assign(record.meta, patch);
            return save;
          },
        },
        controller: { state: { get: () => state } },
        codex: { modelList: async () => ({ data: [] }) },
        patchPrefs: (patch: any) => {
          prefs = { ...prefs, ...patch };
        },
      },
      claude: { probeInfo: () => ({ models: [] }) },
      prefs: () => prefs,
      kindOf: () => family,
      labelOf: (k: string) => k,
    });
    const now = () => menus.options({ chatId: 'chat' });
    assert.equal((await now()).permission.value, 'plan');
    assert.equal((await now()).permission.rows[0].label, 'Plan mode');
    assert.match((await now()).permission.rows[0].detail, /after Plan mode ends/);
    state.permission = 'dontAsk';
    state.acp = { modes: { currentModeId: 'own' }, anchors: { own: 'full' } };
    assert.equal((await now()).permission.value, 'read-only');
    state.permission = 'bypassPermissions';
    assert.equal((await now()).permission.value, 'full-access');
    state.permission = null;
    await menus.permit({ chatId: 'chat', value: 'auto-review' });
    assert.deepEqual(record.meta.config, { model: 'own', effort: 'high', permission: 'auto-review' });
    assert.equal((await now()).permission.value, 'auto-review');
    save = false;
    await assert.rejects(menus.permit({ chatId: 'chat', value: 'read-only' }), /could not be saved/);
    assert.equal(prefs.permission, 'auto-review');
    assert.equal(record.meta.config.permission, 'auto-review');
    state.pendingSwitch = { harness: family === 'codex' ? 'claude' : 'codex' };
    state.permission = 'plan';
    prefs.permission = 'full-access';
    assert.equal((await now()).permission.value, 'auto-review', 'pending destinations retain the chat permission before global defaults');
    save = true;
    await menus.permit({ chatId: 'chat', value: 'read-only' });
    assert.equal(record.meta.config.permission, 'read-only');
  });
}

test('picking the permission the chat already has is saved, not reported as a failed save', async () => {
  const record: any = { meta: { config: { permission: 'read-only' } } };
  let prefs: any = { permission: 'default' };
  const menus = createPanelOptions({
    live: {
      chats: { records: new Map([['chat', record]]), patchMeta: () => false },
      controller: { state: { get: () => ({}) } },
      codex: { modelList: async () => ({ data: [] }) },
      patchPrefs: (patch: any) => {
        prefs = { ...prefs, ...patch };
      },
    },
    claude: { probeInfo: () => ({ models: [] }) },
    prefs: () => prefs,
    kindOf: () => 'codex',
    labelOf: (k: string) => k,
  });
  await menus.permit({ chatId: 'chat', value: 'read-only' });
  assert.equal(prefs.permission, 'read-only');
});
