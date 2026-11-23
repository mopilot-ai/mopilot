// The dev host's Mac stand-in names the agent a chat runs on in its menus, as the real app's options.get does (#4909): without it a phone cannot say why a machine cannot take the chat's agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';

test('a chat of the seeds, a new chat and an unlisted agent are named; nothing is named when nothing says', async () => {
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 5_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const named = async (target: object) => {
    const r = await app.ops.options(target);
    return [r.harnessId, r.harness];
  };
  assert.deepEqual(await named({ chatId: 'dev-seed-readme' }), ['claude', 'Claude Code']);
  assert.deepEqual(await named({ harness: 'codex' }), ['codex', 'Codex']);
  assert.deepEqual(
    await named({ harness: 'acp:unlisted' }),
    ['acp:unlisted', 'acp:unlisted'],
    'an agent the list does not know is named by its id',
  );
  assert.deepEqual(await named({}), [undefined, undefined]);
});
