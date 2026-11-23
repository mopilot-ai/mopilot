// Read-only recovery strips follow the current native permission owner, including retained state after harness switches.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockStore, render, settle, setStore, resetStore } from './support/thread-kit.ts';
import { iconStubs, mockSource, taggedIcon } from './support/stubs.ts';
const sent: unknown[] = [];
mockStore({
  chatOf: (id: string) => id,
  chatBasicHarness: (id: string, state: any) => state.basicOf?.[id] ?? null,
  sendMessage: async (...args: unknown[]) => {
    sent.push(args);
    return true;
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs(taggedIcon));
const { createElement } = await import('react');
const { BlockedStrip } = await import('../src/components/thread/BlockedStrip.tsx');
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
afterEach(() => {
  useSessions.setState({ sessions: {}, loaded: {} });
  resetStore();
  sent.length = 0;
});
const refusal = (tool: string, args: unknown, text: string, reason: string) => ({
  id: 'step',
  type: 'mcpToolCall',
  tool,
  arguments: args,
  status: 'failed',
  error: { message: `${text}\n<refusal reason="${reason}" retryable="false">\nnext: x\n</refusal>` },
});
const turn = (...items: unknown[]) => setStore({ runtime: { chat: { turns: [{ id: 'turn', items }] } } });
const strip = () => render(createElement(BlockedStrip, { threadId: 'chat' }));

test('a Plan-mode refusal names the actual restriction and disappears after a native permission acknowledgment', async () => {
  turn(
    refusal('desktop_app_click', { app: 'Claude' }, 'This chat is in a read-only mode: desktop control can only look', 'chat_read_only'),
  );
  useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, permission: 'plan' } } });
  const v = await strip();
  assert.equal(v.$('.elsewhere-title')!.textContent, 'Plan mode is on: computer use can only look.');
  await settle(() => setStore({ chatConfig: { chat: { permission: 'full-access' } } }));
  assert.ok(v.$('.blocked-strip'), 'a desired setting alone does not resolve a native restriction');
  await settle(() => useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, permission: 'bypassPermissions' } } }));
  assert.equal(v.$('.blocked-strip'), null);
  await settle(() => useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, permission: 'dontAsk' } } }));
  assert.ok(v.$('.blocked-strip'), 'a newly active read-only restriction is still explained');
  assert.deepEqual(sent, [], 'state changes never send an unrequested continuation');
});

test('ACP read-only refusals clear on the current native mode, without hiding unrelated refusals', async () => {
  setStore({ basicOf: { chat: 'opencode' } });
  const acp = (anchor: 'readOnly' | 'full') => ({
    modes: { currentModeId: 'own', availableModes: [{ id: 'own', name: 'Own' }] },
    anchors: { own: anchor },
    configOptions: null,
    commands: null,
    usage: null,
  });
  useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, acp: acp('readOnly') } } });
  turn(refusal('browser_click', {}, 'This chat is in a read-only mode.', 'chat_read_only'));
  const v = await strip();
  assert.ok(v.$('.blocked-strip'));
  await settle(() => {
    setStore({ basicOf: {} });
    useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, acp: acp('full'), permission: 'dontAsk' } } });
  });
  assert.ok(v.$('.blocked-strip'), 'a previous ACP mode cannot resolve the current first-tier restriction');
  await settle(() => {
    setStore({ basicOf: { chat: 'opencode' } });
    useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, acp: acp('full'), permission: 'dontAsk' } } });
  });
  assert.equal(v.$('.blocked-strip'), null, 'a previous first-tier mode cannot restrict the current ACP session');
  await settle(() => useSessions.setState({ sessions: { chat: { ...EMPTY_SESSION, acp: acp('full') } } }));
  assert.equal(v.$('.blocked-strip'), null);
  await settle(() => turn(refusal('browser_navigate', { url: 'https://a.test' }, 'Not allowed', 'site_permission_denied')));
  assert.ok(v.$('.blocked-strip'));
});
