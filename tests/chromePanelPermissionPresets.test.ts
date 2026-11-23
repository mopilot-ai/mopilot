// The Chrome panel presents mapped ACP permission presets semantically while retaining native mode IDs for selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');
const quirks = require('../electron/harness/quirks/opencode.cjs');

test('ACP permission presets hide transport names in the panel while picks retain their native IDs', async () => {
  const config = JSON.parse(quirks.env.OPENCODE_CONFIG_CONTENT);
  const options = [
    { value: 'build', name: 'build' },
    ...Object.entries(config.agent).map(([value, a]: [string, any]) => ({ value, name: value, description: a.description })),
    { value: 'plan', name: 'plan' },
  ];
  const catalog = { configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options }] };
  const calls: any[] = [];
  const menus = createPanelOptions({
    live: {
      acpAdmission: { list: () => [{ id: 'opencode', catalog, permissionModes: quirks.permissionModes }] },
      patchPrefs: (patch: any) => calls.push(patch),
    },
    prefs: () => ({}),
    kindOf: () => 'acp:opencode',
    labelOf: () => 'opencode',
  });
  const now = await menus.options({ harness: 'acp:opencode' });
  assert.deepEqual(now.permission.rows, [
    { id: 'build', label: 'build', detail: '' },
    { id: 'mopilot-ask', label: 'Ask for approval', detail: config.agent['mopilot-ask'].description },
    { id: 'mopilot-full', label: 'Full access', detail: config.agent['mopilot-full'].description },
    { id: 'plan', label: 'Read-only', detail: '' },
  ]);
  await menus.permit({ harness: 'acp:opencode', value: now.permission.rows[2].id });
  assert.deepEqual(calls, [{ basicDefaults: { opencode: { mode: 'mopilot-full' } } }]);
});
