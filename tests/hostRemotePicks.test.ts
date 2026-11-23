// Remote message snapshots bind both model and permissions to their machine/harness before queueing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hostPermissionOf, isHostMode, isHostPermission } from '../shared/host/permissions.mjs';
const require = createRequire(import.meta.url);
const { remotePicks } = require('../electron/host/remotePicks.cjs');
test('permission scope and accepted anchors exclude arbitrary modes and other identities', () => {
  for (const value of ['default', 'read-only', 'auto-review', 'full-access']) assert.equal(isHostPermission(value), true);
  for (const p of [
    null,
    {},
    'plan',
    { hostId: 'other', harness: 'claude', value: 'full-access' },
    { hostId: 'box', harness: 'codex', value: 'default' },
    { hostId: 'box', harness: 'claude', value: 'plan' },
  ])
    assert.equal(hostPermissionOf(p, 'box', 'claude'), null);
  assert.equal(hostPermissionOf({ hostId: 'box', harness: 'claude', value: 'read-only' }, 'box', 'claude'), 'read-only');
});
test('native picks are snapshot once, strip unscoped/internal input, and preserve explicit model overrides', () => {
  const base = {
    chatId: 'acp:host-claude:c',
    hostId: 'box',
    opts: {},
    model: { hostId: 'box', harness: 'claude', model: 'remote', effort: 'high' },
    permission: { hostId: 'box', harness: 'claude', value: 'read-only' },
  };
  assert.deepEqual(remotePicks(base), { model: 'remote', effort: 'high', hostMode: 'read-only' });
  assert.deepEqual(
    remotePicks({
      ...base,
      opts: {
        hostSelection: { ...base.model, model: 'window' },
        hostPermission: { ...base.permission, value: 'full-access' },
        hostMode: 'plan',
      },
    }),
    { model: 'window', effort: 'high', hostMode: 'full-access' },
  );
  assert.deepEqual(remotePicks({ ...base, opts: { model: 'explicit' } }), { model: 'explicit', hostMode: 'read-only' });
  assert.deepEqual(remotePicks({ ...base, hostId: 'other', chat: { permission: 'auto-review' } }), { hostMode: 'auto-review' });
  assert.deepEqual(remotePicks({ chatId: 'local-native', hostId: 'box', opts: {}, chat: { permission: 'plan' } }), {});
  assert.deepEqual(
    remotePicks({ chatId: 'acp:kimi:c', hostId: 'box', opts: {}, model: { hostId: 'box', harness: 'kimi', model: 'm', effort: null } }),
    { model: 'm' },
  );
});

test('continued native ids and current adapter kinds resolve the permission scope without borrowing another harness', () => {
  for (const [chatId, kind, harness] of [
    ['claude:native', undefined, 'claude'],
    ['native', undefined, 'codex'],
    ['old-id', 'claude', 'claude'],
    ['old-id', 'codex', 'codex'],
    ['old-id', 'acp:host-claude', 'claude'],
    ['old-id', 'acp:kimi', 'kimi'],
  ]) {
    assert.deepEqual(remotePicks({ chatId, kind, hostId: 'box', opts: {}, permission: { hostId: 'box', harness, value: 'read-only' } }), {
      hostMode: 'read-only',
    });
  }
});

test('a recognized first-tier chat freezes its displayed default while ACP keeps its own modes', () => {
  for (const [chatId, kind] of [
    ['acp:host-claude:c', undefined],
    ['acp:host-codex:c', undefined],
    ['claude:native', undefined],
    ['native', 'claude'],
    ['native', 'codex'],
  ])
    assert.deepEqual(remotePicks({ chatId, kind, hostId: 'box', opts: {} }), { hostMode: 'default' });
  assert.deepEqual(remotePicks({ chatId: 'acp:kimi:c', hostId: 'box', opts: {} }), {});
  assert.deepEqual(remotePicks({ chatId: 'claude:old', kind: 'acp:kimi', hostId: 'box', opts: {} }), {});
  assert.deepEqual(remotePicks({ chatId: 'acp:kimi:old', kind: 'codex', hostId: 'box', opts: {} }), { hostMode: 'default' });
});

test('an ACP kind with no agent named falls back to the chat id for the scope', () => {
  assert.deepEqual(
    remotePicks({
      chatId: 'acp:host-claude:c',
      kind: 'acp:',
      hostId: 'box',
      opts: {},
      permission: { hostId: 'box', harness: 'claude', value: 'read-only' },
    }),
    { hostMode: 'read-only' },
  );
});

test('Plan on a message becomes the mode the Host holds when its machine takes Plan for the agent, and stays on the message when it does not', () => {
  const planOk = (harness: string) => harness === 'codex';
  // the Host takes it: the message carries Plan as its mode, over a picked mode (which rides along as its base), and no longer has `plan` to refuse
  assert.deepEqual(
    remotePicks({
      chatId: 'c',
      kind: 'codex',
      hostId: 'box',
      opts: { plan: true },
      permission: { hostId: 'box', harness: 'codex', value: 'read-only' },
      planOk,
    }),
    { hostMode: 'plan', hostBase: 'read-only' },
  );
  // Plan off: the mode the chat has, so a send after Plan leaves it
  assert.deepEqual(
    remotePicks({ chatId: 'c', kind: 'codex', hostId: 'box', opts: { plan: false }, chat: { permission: 'auto-review' }, planOk }),
    {
      plan: false,
      hostMode: 'auto-review',
    },
  );
  assert.deepEqual(remotePicks({ chatId: 'c', kind: 'codex', hostId: 'box', opts: {}, planOk }), { hostMode: 'default' });
  // another agent of the same machine, a Host that does not say it, and no word at all keep Plan for the send to refuse
  assert.deepEqual(remotePicks({ chatId: 'c', kind: 'claude', hostId: 'box', opts: { plan: true }, planOk }), {
    plan: true,
    hostMode: 'default',
  });
  assert.deepEqual(remotePicks({ chatId: 'c', kind: 'codex', hostId: 'box', opts: { plan: true } }), { plan: true, hostMode: 'default' });
});

test('a message may carry a permission anchor or Plan to a Host, and nothing else', () => {
  for (const value of ['default', 'read-only', 'auto-review', 'full-access', 'plan']) assert.equal(isHostMode(value), true);
  for (const value of ['bogus', '', null, undefined, 7, {}]) assert.equal(isHostMode(value), false);
  assert.equal(isHostPermission('plan'), false, 'Plan is not a pick of the permission menu');
});

test('a message with Plan on carries the mode the person had picked as its base; a base from the caller, none picked, or Plan itself carries none', () => {
  const o = {
    chatId: 'acp:host-codex:c',
    hostId: 'box',
    opts: { plan: true },
    permission: { hostId: 'box', harness: 'codex', value: 'auto-review' },
    planOk: () => true,
  };
  assert.deepEqual(remotePicks(o), { hostMode: 'plan', hostBase: 'auto-review' });
  // a base put in the options by a caller is never taken
  assert.deepEqual(remotePicks({ ...o, opts: { plan: true, hostBase: 'full-access' } }), { hostMode: 'plan', hostBase: 'auto-review' });
  // nothing picked: the Host keeps the mode the chat was in
  assert.deepEqual(remotePicks({ ...o, permission: undefined }), { hostMode: 'plan' });
  // without Plan there is no base
  assert.deepEqual(remotePicks({ ...o, opts: {} }), { hostMode: 'auto-review' });
});
