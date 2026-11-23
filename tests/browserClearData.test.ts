import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clearBrowsingData } = require('../electron/capabilities/browser/clearData.cjs');

test('clearing browsing data wipes storage, cache and the back/forward history of the browser session tabs only', async () => {
  const calls: string[] = [];
  const ses = { clearStorageData: async () => calls.push('storage'), clearCache: async () => calls.push('cache') };
  const other = {};
  const page = (name: string, session: object, destroyed = false) => ({
    session,
    isDestroyed: () => destroyed,
    navigationHistory: { clear: () => calls.push(`history:${name}`) },
  });
  await clearBrowsingData(ses, [page('tab', ses), page('app', other), page('closed', ses, true), page('tab2', ses)]);
  assert.deepEqual(calls, ['storage', 'cache', 'history:tab', 'history:tab2']);
});
