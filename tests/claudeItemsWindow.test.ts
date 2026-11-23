// A window (src/session/harness/claude.ts) shows the items main translated (electron/harness/items/claude.cjs) and
// translates no message, start, steer, stop or quit itself, and opening a chat mid-turn adopts nothing, since main's
// history read names the running turn by its live id: the
// copy streaming here since the turn started stays, and what streamed while the chat was read joins the transcript's copy.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';
import { pageBytes } from './support/claude-translate.ts';

const realInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));
const { startClaude } = await import('../src/session/harness/claude.ts');
// window.native.claude's types: nothing imports them at runtime
await import('../src/lib/native/claude.ts');
const { openLatestClaudeTurns } = await import('../src/session/harness/claude/history.ts');

test("the window applies main's items and translates nothing itself", () => {
  reset();
  let onEvent: any;
  let onItems: any;
  fx.native.claude = {
    onEvent: (h: any) => (onEvent = h),
    onItems: (h: any) => (onItems = h),
    onAccountsEvent: () => {},
    onCatalog: () => {},
    accounts: async () => ({ active: 'default', accounts: [] }),
    detect: async () => ({ state: 'signin', bin: null }),
    presence: async () => ({}),
  };
  startClaude();
  const chat = 'claude:s1';
  fx.state.threads[chat] = { id: chat, cwd: '/w', name: 'x', preview: '', recencyAt: 1 };

  onItems({
    chatId: chat,
    key: chat,
    method: 'turn/started',
    params: { threadId: chat, turn: { id: 'ct-c1', status: 'inProgress', items: [] } },
  });
  assert.deepEqual(
    called('applyNotification').map((c: any[]) => c[0]),
    ['turn/started'],
  );
  const before = called('applyNotification').length;
  onEvent({ kind: 'turnStarting', key: chat, chatId: chat, turnId: 'ct-c1', clientId: 'c1', text: 'hi', attachments: [], opts: {} });
  onEvent({
    kind: 'message',
    key: chat,
    msg: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] }, parent_tool_use_id: null },
  });
  onEvent({ kind: 'steered', key: chat, chatId: chat, clientId: 'c2', text: 'more', attachments: [] });
  onEvent({ kind: 'steerFailed', key: chat, chatId: chat, clientId: 'c2' });
  onEvent({ kind: 'interrupting', key: chat });
  onEvent({ kind: 'turnFailed', key: chat, error: 'no' });
  onEvent({ kind: 'closed', key: chat });
  assert.equal(called('applyNotification').length, before, 'the window translated nothing itself');
});

test('a chat opened mid-turn keeps the copy streaming here, or adds to the read what streamed meanwhile', async () => {
  const ID = 'claude:s2';
  const item = (type: string, id: string, text = '') => ({ type, id, text, content: [] });
  const read = [
    { id: 'h-p0', status: 'completed', items: [] },
    { id: 'ct-c1', status: 'inProgress', items: [item('userMessage', 'c1'), item('agentMessage', 'm1', 'Hel')] },
  ];
  const open = async (here: any[]) => {
    reset();
    fx.native.session = { snapshot: async () => ({ turn: 'running', runningElsewhere: false }) };
    fx.native.claude = { turns: async () => pageBytes({ turns: read, olderCursor: null, closedTail: null }) };
    fx.state.threads[ID] = { id: ID, cwd: '/w' };
    fx.state.runtime[ID] = { turns: [{ id: 'ct-c1', status: 'inProgress', items: here }] };
    await openLatestClaudeTurns(ID, () => {});
    const rt = fx.state.runtime[ID];
    assert.deepEqual(
      rt.turns.map((t: any) => t.id),
      ['h-p0', 'ct-c1'],
    );
    assert.equal(rt.activeTurnId, 'ct-c1');
    return rt.turns[1].items.map((i: any) => `${i.id}:${i.text}`);
  };
  // this window had the turn from its start: its copy is newer than the transcript's
  assert.deepEqual(
    await open([
      { ...item('userMessage', 'u-c1'), clientId: 'c1' },
      item('agentMessage', 'm1', 'Hello'),
      item('agentMessage', 'm2', 'Wor'),
    ]),
    ['u-c1:', 'm1:Hello', 'm2:Wor'],
  );
  // reloaded mid-turn: only what streamed during the read is here, and it follows the transcript's copy
  assert.deepEqual(await open([item('agentMessage', 'm2', 'Wor')]), ['c1:', 'm1:Hel', 'm2:Wor']);
  // A reloaded window can hold only a suffix for a known item; the read supplies its complete text.
  assert.deepEqual(await open([item('agentMessage', 'm1', 'el')]), ['c1:', 'm1:Hel']);
});
