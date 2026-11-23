// A linked chat can leave its inherited plan mode without losing its own saved permission or directory grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { effectivePermission as chatPermission } from '../shared/effectivePermission.mjs';
const require = createRequire(import.meta.url);
const { leaveLinkedPlan, appPermission } = require('../electron/session/linkedPlan.cjs');
test('leaving plan saves only the real base or explicitly reported native permission', () => {
  let saved = true;
  const records = new Map<string, any>();
  const chats = {
    records,
    patchMeta: (id: string, meta: any) => {
      if (!saved) return false;
      records.set(id, { meta });
      return true;
    },
  };
  assert.equal(leaveLinkedPlan(chats, 'missing'), false);
  records.set('p', { meta: { config: { permission: 'default' } } });
  assert.equal(leaveLinkedPlan(chats, 'p'), false);
  const reset = (extra = {}) => records.set('p', { meta: { config: { permission: 'plan', additionalDirectories: ['/notes'], ...extra } } });
  reset();
  assert.equal(leaveLinkedPlan(chats, 'p', 'plan'), false);
  assert.equal(leaveLinkedPlan(chats, 'p', 'unknown'), false);
  assert.equal(leaveLinkedPlan(chats, 'p', 'toString'), false);
  assert.equal(leaveLinkedPlan(chats, 'p'), true);
  assert.deepEqual(records.get('p').meta.config, { permission: 'default', additionalDirectories: ['/notes'] });
  reset({ planBasePermission: 'read-only' });
  assert.equal(leaveLinkedPlan(chats, 'p'), true);
  assert.equal(records.get('p').meta.config.permission, 'read-only');
  for (const [mode, expected] of Object.entries({
    default: 'default',
    acceptEdits: 'default',
    bypassPermissions: 'full-access',
    dontAsk: 'read-only',
    auto: 'auto-review',
  })) {
    reset();
    leaveLinkedPlan(chats, 'p', mode);
    assert.equal(records.get('p').meta.config.permission, expected);
  }
  assert.equal(appPermission('plan'), 'plan');
  assert.equal(appPermission('read-only'), 'read-only');
  assert.equal(appPermission('full-access'), 'full-access');
  assert.equal(appPermission('auto-review'), 'auto-review');
  reset();
  saved = false;
  assert.throws(() => leaveLinkedPlan(chats, 'p'), /could not save/);
});
test('permission controls retain saved mode fallbacks before the global default, including explicit Plan mode', () => {
  assert.equal(chatPermission(undefined, 'default'), 'default');
  assert.equal(chatPermission(null, 'default'), 'default');
  assert.equal(chatPermission({}, 'default'), 'default');
  assert.equal(chatPermission({ permission: null }, 'default'), 'default');
  assert.equal(chatPermission({ permission: 'plan' }, 'full-access'), 'plan');
  assert.equal(chatPermission({ permission: 'read-only' }, 'full-access'), 'read-only');
});

test('only the current native Claude session can persist leaving the initial plan', async () => {
  const { setup, selectSegment } = await import('./support/controller/fixture.ts');
  const { c, chats, state } = setup();
  const chat = 'linked';
  selectSegment(c, chats, chat, [['claude', 'native']]);
  state.patch(chat, { plan: false });
  chats.patchMeta(chat, { config: { permission: 'plan', planBasePermission: 'read-only' } });
  const ref = c.ref(chat);
  const event = (subtype: string, permissionMode: string, key = ref.key) =>
    c.onClaudeEvent({ key, kind: 'message', msg: { type: 'system', subtype, permissionMode } });
  event('init', 'plan');
  assert.equal(state.get(chat).plan, true);
  event('status', 'default', 'claude:old-session');
  assert.equal(chats.records.get(chat).meta.config.permission, 'plan');
  event('status', 'default');
  assert.equal(chats.records.get(chat).meta.config.permission, 'default');
  assert.equal(state.get(chat).plan, false);
  chats.patchMeta(chat, { config: { permission: 'plan' } });
  chats.patchMeta = () => false;
  event('status', 'default');
  assert.equal(chats.records.get(chat).meta.config.permission, 'plan', 'a failed metadata write stays conservative for restart');
});
