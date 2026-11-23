// Every harness's events in the window land after the session patches main sent before them (src/store/session/useSession.ts
// holds patches for the next frame): a crash patch that came first is committed before the CLI's own end of the turn,
// so the turn shows the crash once (#2847). A streamed delta still waits for the frame. Codex: customProviderRenderer.test.ts.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';

// Claude's start polls presence: the poll is not this test's, and must not keep the file alive
const realInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));

const { startClaude } = await import('../src/session/harness/claude.ts');
const acp = await import('../src/session/harness/acp.ts');

const flushes = () => called('flushSessionPatches').length;

test('a Claude Code event commits the held session patches first, except a stream delta', () => {
  reset();
  let onEvent: any;
  fx.native.claude = {
    onEvent: (h: any) => (onEvent = h),
    onItems: () => {},
    onAccountsEvent: () => {},
    onCatalog: () => {},
    accounts: async () => ({ active: 'default', accounts: [] }),
    detect: async () => ({ state: 'signin', bin: null }),
    presence: async () => ({}),
  };
  startClaude();
  const key = 'claude:s1';
  onEvent({ kind: 'message', key, msg: { type: 'stream_event', event: { type: 'content_block_delta' } } });
  assert.equal(flushes(), 0, 'a delta waits for the frame');
  onEvent({ kind: 'closed', key });
  assert.equal(flushes(), 1);
});

test('a basic harness event commits the held session patches first, except a streamed update', async () => {
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
  const before = flushes();
  const key = 'acp:kimi:s1';
  onEvent({ kind: 'update', key, turnId: 't', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } });
  assert.equal(flushes(), before);
  onEvent({ kind: 'closed', key, working: true });
  assert.equal(flushes(), before + 1);
});
