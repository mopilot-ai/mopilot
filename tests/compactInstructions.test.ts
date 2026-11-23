// Codex compaction refuses unsupported instructions without losing queued input, including after a harness switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, selectSegment, tick } from './support/controller/fixture';

for (const switched of [false, true]) {
  test(`custom compaction instructions remain retryable on Codex${switched ? ' after a harness switch' : ''}`, async () => {
    const { c, chats, s } = setup();
    const requests: unknown[] = [];
    Object.assign(c.codex, { compacting: new Set(), touch: () => {}, request: async (...args: unknown[]) => requests.push(args) });
    const item = {
      id: 'custom',
      text: '/compact Keep decisions',
      attachments: [],
      opts: { human: true, retainInMain: true, compact: { args: 'Keep decisions' } },
    };
    if (switched) {
      selectSegment(c, chats, 'chat', [['claude', 'old']]);
      await c.send('chat', { text: 'first', opts: {} }, null, true);
      await c.send('chat', item, null, true);
      selectSegment(c, chats, 'chat', [
        ['claude', 'old'],
        ['codex', 'new'],
      ]);
      c.end('chat');
      await tick();
    } else assert.equal((await c.send('chat', item, null, true)).action, 'queued');
    assert.deepEqual(requests, []);
    assert.equal(s('chat').queue[0].opts.compact.args, 'Keep decisions');
    assert.match(s('chat').crashed, /custom compaction instructions/);
  });
}
