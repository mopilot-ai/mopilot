// src/components/thread/items/BlockItems.tsx: a start_session or hand_off_to_session call that started a session is its
// card wherever a block renders (a chat's turn or an agent's page); a proposal is never drawn here, since the turn's
// suggestion card shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/thread/TaskProposalCard.tsx', 'sessionCard', {
  TaskProposalCard: (p: any) => h('div', { 'data-stub': 'TaskProposalCard', 'data-kind': p.call.kind }),
});
const { BlockItem } = await import('../src/components/thread/Items.tsx');

const out = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const item = (result: unknown) => ({
  id: 's',
  type: 'mcpToolCall',
  tool: 'mcp__sage_ab__start_session',
  status: 'completed',
  result: out(result),
});
const started = item({ status: 'started', chat_id: 'kid', title: 'T', name: 't', worktree: true, context: 'fresh' });
const proposed = item({ status: 'proposed', task_id: 't1', title: 'T', kind: 'own_initiative' });

test('a started session is its card with or without a chat; a proposal is not drawn as a block', async () => {
  const v = await render(h(BlockItem, { item: started, cwd: '/r', threadId: 'top' } as any));
  assert.equal(v.$('[data-stub="TaskProposalCard"]')!.dataset.kind, 'started');
  await v.rerender(h(BlockItem, { item: started, cwd: '/r' } as any));
  assert.ok(v.$('[data-stub="TaskProposalCard"]'), 'an agent page has no chat, yet the session it started shows');
  await v.rerender(h(BlockItem, { item: proposed, cwd: '/r', threadId: 'top' } as any));
  assert.equal(v.$('[data-stub="TaskProposalCard"]'), null);
});
