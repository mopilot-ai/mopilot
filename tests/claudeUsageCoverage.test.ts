// The bounded /usage query (electron/harness/claude/usage.cjs): how the reply text is assembled from the
// stream, the default error, and a query whose close() throws. The SDK is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { readUsage } = createRequire(import.meta.url)('../electron/harness/claude/usage.cjs');
function sdkWith(messages: any[], close: () => void = () => {}) {
  const prompts: any[] = [];
  const sdk = async () => ({
    query: (p: any) => {
      prompts.push(p);
      return {
        async *[Symbol.asyncIterator]() {
          yield* messages;
        },
        close,
      };
    },
  });
  return { sdk, prompts };
}

test('assistant text is collected when the result is empty, and returned when the stream just ends', async () => {
  const msgs = [
    { type: 'assistant' },
    { type: 'assistant', message: { content: [null, 42, [], { type: 'tool_use' }, { type: 'text', text: 'Session 5%' }] } },
    { type: 'system' },
  ];
  const { sdk, prompts } = sdkWith([...msgs, { type: 'result' }]);
  assert.equal(await readUsage(sdk, { cwd: '/x' }), 'Session 5%');
  assert.deepEqual(prompts, [{ prompt: '/usage', options: { cwd: '/x' } }]);
  assert.equal(await readUsage(sdkWith([...msgs, { type: 'result', result: '  ' }]).sdk, {}), 'Session 5%');
  assert.equal(await readUsage(sdkWith(msgs).sdk, {}), 'Session 5%');
  // a result with text is the reply, whatever came before it
  assert.equal(await readUsage(sdkWith([...msgs, { type: 'result', result: 'Week 9%' }]).sdk, {}), 'Week 9%');
});

test('an error result names the result text, else a default; a close that throws is ignored', async () => {
  const boom = () => {
    throw new Error('already closed');
  };
  await assert.rejects(
    readUsage(sdkWith([{ type: 'result', is_error: true, result: 'Not logged in' }], boom).sdk, {}),
    /^Error: Not logged in$/,
  );
  await assert.rejects(readUsage(sdkWith([{ type: 'result', is_error: true }]).sdk, {}), /Claude Code could not read usage/);
});

test('a hold is awaited before the CLI closes, and only when a query started', async () => {
  const order: string[] = [];
  const { sdk } = sdkWith([{ type: 'result', result: 'Week 9%' }], () => order.push('close'));
  const hold = async () => {
    await new Promise((r) => setImmediate(r));
    order.push('hold');
  };
  assert.equal(await readUsage(sdk, {}, 20000, hold), 'Week 9%');
  assert.deepEqual(order, ['hold', 'close']);
  // the SDK never loaded: there is no CLI to hold open
  await assert.rejects(
    readUsage(
      async () => {
        throw new Error('no sdk');
      },
      {},
      20000,
      async () => order.push('held'),
    ),
    /no sdk/,
  );
  assert.equal(order.includes('held'), false);
});
