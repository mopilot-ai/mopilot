// Main-owned automatic inputs never become human retry drafts when a harness refuses them; human inputs retain their normal queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick, selectSegment } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { guardInput } = require('../electron/session/contract/inputGuard.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');

for (const family of ['codex', 'claude', 'acp'] as const) {
  for (const automatic of [false, true]) {
    test(`${family}: refused ${automatic ? 'automatic' : 'human'} input keeps the correct retry owner`, async () => {
      const h = setup();
      const kind = family === 'acp' ? 'acp:gemini' : family;
      selectSegment(h.c, h.chats, 'chat', [[kind, 'native']]);
      const adapter = family === 'codex' ? h.c.codex : family === 'claude' ? h.c.claudeTurns : h.c.acpTurns;
      adapter.startTurn = async () => ({ started: false, error: 'transport refused' });
      const item = queueItem({ text: 'input', attachments: [], opts: {} }, null);
      if (automatic) guardInput(item, () => true);
      await h.c.startOrKeep('chat', item);
      assert.equal(h.s('chat').crashed, 'transport refused');
      assert.deepEqual(
        h.s('chat').queue.map((q: any) => q.text),
        automatic ? [] : ['input'],
      );
    });

    test(`${family}: unavailable harness retains only ${automatic ? 'its automatic service retry' : 'human input'}`, async () => {
      const h = setup();
      selectSegment(h.c, h.chats, 'chat', [[family === 'acp' ? 'acp:gemini' : family, 'native']]);
      h.c.killed = () => 'harness unavailable';
      const item = queueItem({ text: 'input', attachments: [], opts: {} }, null);
      if (automatic) guardInput(item, () => true);
      await h.c.startOrKeep('chat', item);
      await tick();
      assert.equal(h.s('chat').crashed, 'harness unavailable');
      assert.deepEqual(
        h.s('chat').queue.map((q: any) => q.text),
        automatic ? [] : ['input'],
      );
    });
  }
}
