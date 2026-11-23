// A window (src/session/harness/acp.ts) shows the items main translated (electron/harness/items/acp.cjs), leaves the
// events to main, still offers another harness or tells of a quit from what main says was running, and reads a chat's
// history as main's turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');
// window.native.acp's types: nothing imports them at runtime, and they say what these reads answer
await import('../src/lib/native/acp.ts');

test("the window applies main's items and translates nothing itself", async () => {
  reset();
  (globalThis as any).window = new EventTarget();
  let onEvent: any;
  let onItems: any;
  const asked: any[] = [];
  const turns = [{ id: 't1', status: 'inProgress', items: [] }];
  const fromMain = { page: new TextEncoder().encode(JSON.stringify({ turns, olderCursor: null })), activeTurnId: 't1', diffs: {} };
  fx.native.acp = {
    onEvent: (h: any) => (onEvent = h),
    onItems: (h: any) => (onItems = h),
    onHarnesses() {},
    harnesses: async () => [],
    onSignIns() {},
    signIns: async () => ({}),
    list: async () => [],
    turns: async (...a: any[]) => (asked.push(a), fromMain),
  };
  acp.startAcp();
  await tick();
  const chat = 'acp:kimi:e';
  fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', recencyAt: 1 };

  // main's items are shown
  onItems({
    chatId: chat,
    key: chat,
    method: 'turn/started',
    params: { threadId: chat, turn: { id: 't1', status: 'inProgress', items: [] } },
  });
  assert.deepEqual(
    called('applyNotification').map((c: any[]) => c[0]),
    ['turn/started'],
  );
  // a delta waits for its frame, and a read about to replace its turn lets it land first: the page has it already
  onItems({
    chatId: chat,
    key: chat,
    method: 'item/agentMessage/delta',
    params: { threadId: chat, turnId: 't1', itemId: 'm', delta: 'x' },
  });
  assert.equal(called('applyNotification').length, 1);
  acp.flushAcpDisplay();
  assert.equal(called('applyNotification').at(-1)?.[0], 'item/agentMessage/delta');

  // the events themselves are main's to translate
  const user = { id: 'u', clientId: 'c', content: [] };
  onEvent({ kind: 'turnStart', key: chat, turnId: 't1', user, human: true });
  onEvent({
    kind: 'update',
    key: chat,
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
  });
  onEvent({ kind: 'turnEnd', key: chat, turnId: 't1', stopReason: 'end_turn', error: null, running: true });
  assert.equal(called('applyNotification').length, 2);
  // a turn that was running and ran out of quota offers another harness; a late end does not
  onEvent({ kind: 'turnEnd', key: chat, turnId: 't1', stopReason: 'end_turn', error: 'You exceeded your current quota', running: false });
  assert.deepEqual(called('suggestOtherHarness'), []);
  onEvent({ kind: 'turnEnd', key: chat, turnId: 't1', stopReason: 'end_turn', error: 'You exceeded your current quota', running: true });
  assert.deepEqual(called('suggestOtherHarness'), [[chat, 'acp']]);
  // a harness that quit while working is told; one that quit idle is not
  const toasts = called('toast').length;
  onEvent({ kind: 'closed', key: chat, error: 'gone', working: false });
  assert.equal(called('toast').length, toasts);
  onEvent({ kind: 'closed', key: chat, error: 'gone', working: true });
  assert.match(String(called('toast').at(-1)?.[0]), /quit while working/);

  // the history is main's turns, with the turn main runs
  assert.deepEqual(await acp.readAcpTurns(chat, chat, '/w'), { turns, olderCursor: null, activeTurnId: 't1' });
  assert.deepEqual(asked, [[chat, chat, '/w', {}]]);
});
