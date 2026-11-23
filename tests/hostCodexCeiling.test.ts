// The owner's permission ceiling on a Codex chat's tools (host/src/codexFamily.mjs `chatConfig`, shared/host/policy.mjs clampToCeiling): what a turn takes as the chat's mode never exceeds it, however and whenever the mode was set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexFamily } from '../host/src/codexFamily.mjs';

/** The family over a stand-in chat store, with the ceiling read through `ceiling` each time. */
function setup(o: { ceiling: () => string | undefined }) {
  const metas = new Map<string, any>();
  const controller: any = { chatOf: (id: string) => id, ref: () => ({ kind: 'codex', id: 'th', key: 'th' }), invalidate: () => undefined };
  const ctx: any = {
    paths: { dataDir: '/data' },
    state: { has: () => true, get: () => ({ approvals: [], turn: 'idle' }), all: () => [] },
    chats: {
      records: new Map(),
      metas,
      get: (id: string) => (metas.has(id) ? { meta: { config: metas.get(id) } } : null),
      patchMeta: (id: string, patch: any) => void metas.set(id, patch.config),
      commit: () => true,
    },
    controller: () => controller,
    emit: () => undefined,
    ceiling: o.ceiling,
  };
  const family = createCodexFamily({ env: {}, which: () => '/bin/codex', probe: (async () => true) as any, now: () => 1000 })(ctx);
  family.codex.server.send = () => undefined;
  family.codex.server.stop = () => undefined;
  return { ctx, family, adapter: family.codex };
}

test('the owner’s ceiling: the mode a chat’s tools run under (its own, or the one Plan was entered from) is clamped to it each time a turn takes its config, so a ceiling lowered later holds the running chat too', async () => {
  let max: string | undefined = 'full-access';
  const s = setup({ ceiling: () => max });
  const config = () => s.adapter.chatConfig('chat');
  await s.family.setPermission('chat', 'full-access');
  await s.family.setPermission('chat', 'plan');
  assert.deepEqual(config(), { permission: 'plan', planBasePermission: 'full-access' });
  // the ceiling is lowered after the base was set: Plan's tools run under the ceiling from the next turn
  max = 'read-only';
  assert.deepEqual(config(), { permission: 'plan', planBasePermission: 'read-only' });
  // the stored config is untouched: a raised ceiling gives the chat its own mode back
  assert.equal(s.ctx.chats.get('chat').meta.config.planBasePermission, 'full-access');
  max = 'auto-review';
  assert.equal(config().planBasePermission, 'auto-review');
  // a chat that is not in Plan, and Plan entered from no mode (it runs under the default one)
  await s.family.setPermission('chat', 'full-access');
  assert.equal(config().permission, 'auto-review');
  s.ctx.chats.patchMeta('fresh', { config: { permission: 'plan' } });
  max = 'read-only';
  assert.deepEqual(s.adapter.chatConfig('fresh'), { permission: 'plan', planBasePermission: 'read-only' });
  max = 'full-access';
  assert.deepEqual(s.adapter.chatConfig('fresh'), { permission: 'plan' });
  // a chat with no config or no mode runs under the default one: held to the ceiling when that is above it
  max = 'read-only';
  assert.deepEqual(s.adapter.chatConfig('none'), { permission: 'read-only' });
  // no ceiling known, a chat with no config, or a mode already within it: left as it is
  max = undefined;
  assert.equal(config().permission, 'full-access');
  assert.equal(s.adapter.chatConfig('none'), null);
});
