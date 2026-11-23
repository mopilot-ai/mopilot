// A basic harness chat's last activity, renderer side (src/session/harness/acp.ts): a turn's start moves it up the sidebar (its
// end does through the shared turn/completed handler, tests/chatActivityStore.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, tick } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');

test("a basic harness turn's start is activity and leads the list; a side chat's stays out of it", async () => {
  reset();
  let onEvent: any;
  (globalThis as any).window = new EventTarget();
  fx.native.acp = {
    onEvent: (h: any) => (onEvent = h),
    onHarnesses: () => {},
    harnesses: async () => [],
    onSignIns: () => {},
    signIns: async () => ({}),
    list: async () => [],
  };
  acp.startAcp();
  await tick();
  const chat = 'acp:kimi:act';
  fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', updatedAt: 1, recencyAt: 1 };
  fx.state.threadOrder = ['other', chat];
  onEvent({ kind: 'turnStarted', key: chat, chatId: chat, text: 'hi' });
  assert.ok(fx.state.threads[chat].recencyAt > 1);
  assert.deepEqual(fx.state.threadOrder, [chat, 'other']);
  // a side chat's turn never puts it in the sidebar
  const side = 'acp:kimi:side';
  fx.state.threads[side] = { id: side, preview: '', ephemeral: true, updatedAt: 1 };
  const listed = fx.state.threadOrder;
  onEvent({ kind: 'turnStarted', key: side, chatId: side, text: 'x' });
  assert.equal(fx.state.threadOrder, listed);
  assert.ok(fx.state.threads[side].recencyAt > 1);
});
