// Claude message parsing retains its defensive fallback when a block reader returns incomplete text.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('../shared/contentBlocks.mjs', {
  namedExports: {
    contentBlocks: (content: unknown) => (Array.isArray(content) ? content : []),
    contentBlockEntries: (content: unknown) => (Array.isArray(content) ? content.map((block, index) => [index, block]) : []),
  },
});
const { userContent } = await import('./support/claude-translate.ts');

test('user content tolerates an incomplete text block from the block reader', () => {
  assert.deepEqual(userContent([{ type: 'text' }, { type: 'text', text: 'Keep this prompt' }]), [
    { type: 'text', text: 'Keep this prompt', text_elements: [] },
  ]);
});

test('the translator tolerates incomplete assistant text and reasoning from the block reader', async () => {
  const { ClaudeTranslator } = await import('./support/claude-translate.ts');
  const items: any[] = [];
  const tr = new ClaudeTranslator('thread', '/repo', (method, params) => {
    if (method === 'item/completed') items.push(params.item);
  });
  tr.beginTurn('turn');
  tr.onMessage({ type: 'assistant', message: { id: 'message', content: [{ type: 'text' }, { type: 'thinking' }] } });
  assert.deepEqual(
    items.map((item) => [item.type, item.text]),
    [['agentMessage', '']],
  );
});
