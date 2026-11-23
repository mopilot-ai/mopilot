// A basic-tier chat's name in the renderer (src/session/harness/acp.ts, #2150): the first words name an unnamed chat, and the
// title its agent wrote replaces only those words, never a name given since.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, tick } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');

test("the agent's title replaces the first words it names, never a name given since", async () => {
  reset();
  let onEvent: any;
  (globalThis as any).window = new EventTarget();
  fx.native.session = { acpNew: async () => true, acpCancel: async () => true };
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
  const chat = 'acp:kimi:t';
  fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', recencyAt: 1 };
  const name = (e: object) => (onEvent({ kind: 'threadName', key: chat, chatId: chat, ...e }), fx.state.threads[chat].name);
  assert.equal(name({ name: 'fix the build' }), 'fix the build');
  // not the words it names (the user renamed it meanwhile), or no words named at all: the name stays
  assert.equal(name({ name: 'Build fix', provisional: 'other words' }), 'fix the build');
  assert.equal(name({ name: 'Build fix' }), 'fix the build');
  assert.equal(name({ name: 'Build fix', provisional: 'fix the build' }), 'Build fix');
  // a chat this window doesn't list is left alone
  onEvent({ kind: 'threadName', key: 'x', chatId: 'acp:kimi:nothere', name: 'N', provisional: 'N' });
  assert.equal(fx.state.threads['acp:kimi:nothere'], undefined);
});
