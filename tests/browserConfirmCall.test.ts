// The per-call "can't be undone" card for a JavaScript run or an upload in a browser (browserSiteTables.cjs
// confirmCall): it names its browser, so the card reads as the browser's and says which one (#1840).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { confirmCall } = require('../electron/app/browserSiteTables.cjs');

function live(decision: string | null) {
  const asked: any[] = [];
  return {
    asked,
    controller: { ref: () => ({ kind: 'claude' }) },
    computerUse: {
      broker: { ask: async (chatId: string, kind: string, params: any) => (asked.push([chatId, kind, params]), decision && { decision }) },
    },
  };
}

test('an upload or a script asks with a card naming its browser, and only Allow lets it run', async () => {
  const l = live('allow');
  assert.equal(
    await confirmCall(l, 'iab')({ chatId: 'c1' }, { tool: 'upload', origin: 'https://shop.test', summary: 'Upload a.txt' }),
    true,
  );
  assert.equal(await confirmCall(l, 'chrome')({ chatId: 'c1' }, { tool: 'JavaScript', origin: 'https://shop.test' }), true);
  assert.deepEqual(l.asked, [
    [
      'c1',
      'computerConfirm',
      {
        harness: 'claude',
        browser: 'iab',
        app: { bundleId: 'https://shop.test', name: 'https://shop.test' },
        verb: 'upload files',
        summary: 'Upload a.txt',
        tool: 'upload',
      },
    ],
    [
      'c1',
      'computerConfirm',
      {
        harness: 'claude',
        browser: 'chrome',
        app: { bundleId: 'https://shop.test', name: 'https://shop.test' },
        verb: 'run JavaScript',
        summary: undefined,
        tool: 'JavaScript',
      },
    ],
  ]);
  assert.equal(await confirmCall(live('deny'), 'iab')({ chatId: 'c1' }, { tool: 'upload', origin: 'https://shop.test' }), false);
  assert.equal(await confirmCall(live(null), 'iab')({ chatId: 'c1' }, { tool: 'upload', origin: 'https://shop.test' }), false);
});
