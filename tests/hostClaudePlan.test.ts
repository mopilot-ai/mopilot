// Plan for Claude Code on a Host (#4898, host/src/claudeFamily.mjs): chat.permit takes `plan` and keeps the mode the chat was in as the one its tools return to, the CLI runs its turn in Plan, and the CLI entering or leaving Plan on its own is written back to the chat's mode and to the state lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, keyOf, idle, until } from './support/host/claudeKit.ts';

const status = (h: any, key: string, permissionMode: string) =>
  h.family.claudeTurns.observe({ kind: 'message', key, msg: { type: 'system', subtype: 'status', permissionMode } });
const lane = (h: any, key: string) => h.events.filter((e: any) => e.kind === 'state' && e.chatId === key).map((e: any) => e.patch);

test('Plan keeps the mode the chat was in, the turn runs in plan, and a CLI that leaves or re-enters Plan on its own is written back', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'claude', cwd: h.dir });
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'full-access' });
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'plan' });
    const config = () => h.sessions.chats.records.get(key).meta.config;
    assert.deepEqual([config().permission, config().planBasePermission], ['plan', 'full-access']);
    await h.sessions.chatRuntime.send({ key, text: 'plan it', cwd: h.dir });
    await idle(h, key);
    assert.equal(h.fake.queries[0].options.permissionMode, 'plan');
    // the CLI's first report of Plan (no mode before it) does not replace the base the chat saved
    assert.deepEqual([config().permission, config().planBasePermission], ['plan', 'full-access']);
    // the plan was approved: the CLI says it is back in the mode before Plan
    status(h, key, 'bypassPermissions');
    assert.deepEqual([config().permission, lane(h, key).at(-1)], ['full-access', { permission: 'full-access', plan: false }]);
    // the model entered Plan itself
    status(h, key, 'plan');
    assert.deepEqual(
      [config().permission, config().planBasePermission, lane(h, key).at(-1)],
      ['plan', 'full-access', { permission: 'plan', plan: true }],
    );
    // a report of the mode it is already in changes nothing
    const before = lane(h, key).length;
    status(h, key, 'plan');
    assert.equal(lane(h, key).length, before);
  } finally {
    await h.close();
  }
});

test('Plan from a chat with no mode picked returns to Ask for approval, and a mode the Host does not know is still refused', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'claude', cwd: h.dir });
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'plan' });
    assert.equal(h.sessions.chats.records.get(key).meta.config.planBasePermission, 'default');
    await assert.rejects(h.sessions.chatRuntime.setMode({ chatId: key, value: 'god-mode' }), /not one this host knows/);
    // a report for a chat this Host no longer has creates no record
    h.family.claudeTurns.modeChanged('claude:gone', 'default', 'plan');
    assert.equal(h.sessions.chats.records.has('claude:gone'), false);
  } finally {
    await h.close();
  }
});

test('the CLI entering Plan on its own keeps the mode it left as the base, or the saved one when it names none, and leaving returns to it', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'claude', cwd: h.dir });
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'default' });
    const config = () => h.sessions.chats.records.get(key).meta.config;
    h.family.claudeTurns.modeChanged(key, 'acceptEdits', 'plan');
    assert.deepEqual([config().permission, config().planBasePermission], ['plan', 'acceptEdits']);
    h.family.claudeTurns.modeChanged(key, 'plan', 'acceptEdits');
    assert.equal(config().permission, 'acceptEdits');
    h.family.claudeTurns.modeChanged(key, undefined, 'plan');
    assert.deepEqual([config().permission, config().planBasePermission], ['plan', 'acceptEdits']);
    // a chat whose file names no mode returns to Ask for approval
    h.sessions.chats.patchMeta(key, { config: {} });
    h.family.claudeTurns.modeChanged(key, undefined, 'plan');
    assert.deepEqual([config().permission, config().planBasePermission], ['plan', 'default']);
  } finally {
    await h.close();
  }
});

test('the plan card shows the plan as written, and approving it still answers the CLI with the tool input', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'PLANCARD', cwd: h.dir });
    const [card] = await until(() => h.of('permission', key).length && h.of('permission', key));
    assert.equal(card.toolCall.rawInput, '1. Do it');
    assert.deepEqual(
      card.options.map((o: any) => o.name),
      ['Approve plan', 'Keep planning'],
    );
    assert.equal(h.sessions.chatRuntime.permit({ requestId: card.requestId, optionId: 'allow' }), true);
    await idle(h, key);
    assert.equal(h.text(key), 'plan approved');
  } finally {
    await h.close();
  }
});
