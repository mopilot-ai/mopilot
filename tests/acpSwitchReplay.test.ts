// A switch's divider through the renderer event entrypoint: it precedes the ACP optimistic input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, tick } from './support/harness-logic-fakes.ts';
const acp = await import('../src/session/harness/acp.ts');

test('a switch divider precedes the ACP optimistic input', async () => {
  reset();
  (globalThis as any).window = new EventTarget();
  let event: any;
  const key = 'acp:opencode:joined',
    chat = 'stable';
  fx.state.segments[chat] = [{ harness: 'acp:opencode', nativeId: key, start: 0, count: null }];
  fx.state.threads[chat] = { cwd: '/repo' };
  fx.native.acp = {
    onEvent: (f: any) => (event = f),
    onItems() {},
    onHarnesses() {},
    onSignIns() {},
    signIns: async () => ({}),
    harnesses: async () => [],
    list: async () => [],
  };
  acp.startAcp();
  await tick();
  event({
    kind: 'turnStarting',
    key,
    chatId: chat,
    clientId: 'joined',
    text: 'continue',
    attachments: [],
    note: { kind: 'switch', text: 'Codex → opencode', handoff: 'context' },
  });
  assert.equal(fx.state.runtime[chat].turns[0].items[0].kind, 'switch');
});
