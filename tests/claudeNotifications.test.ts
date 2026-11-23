// Native Claude notification routing preserves sender identity and the sub-agent transcript path.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const agents: unknown[][] = [];
mock.module('../src/store/agentThreads.ts', { namedExports: { putAgentItems: (...args: unknown[]) => agents.push(args) } });
const { claudeNotifications } = await import('../src/session/harness/claudeNotifications.ts');
test('regular output stays unchanged; usage keeps the actual native owner even when a replacement emits first', () => {
  const output: unknown[][] = [];
  const emit = (...args: unknown[]) => {
    output.push(args);
  };
  const older = claudeNotifications('old', emit);
  const current = claudeNotifications('new', emit);
  const plain = { threadId: 'chat', turnId: 'turn', text: 'hello' };
  older('item/completed', plain);
  assert.equal(output[0][1], plain);
  current('thread/tokenUsage/updated', { threadId: 'chat', tokenUsage: { total: 20 } });
  older('thread/tokenUsage/updated', { threadId: 'chat', tokenUsage: { total: 80 }, tokenUsageSource: { nativeId: 'new' } });
  assert.deepEqual((output[1][1] as any).tokenUsageSource, { harness: 'claude', nativeId: 'new' });
  assert.deepEqual((output[2][1] as any).tokenUsageSource, { harness: 'claude', nativeId: 'old' });
  older('agent/items', { threadId: 'chat', agentKey: 'child', items: new TextEncoder().encode('["message"]') });
  assert.deepEqual(agents, [['chat', 'child', ['message']]]);
  assert.equal(output.length, 3);
});
