// A usage-limit note left in the chat (src/components/thread/LimitNoteAction.tsx): it offers the way on the toast offered,
// worked out when shown and clicked, on every harness; a note outside a chat (no chat id) has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle } from './support/thread-kit.ts';

const runs: string[] = [];
mockStore({ limitNoteAction: (chatId: string) => ({ label: `Continue on Codex (${chatId})`, run: () => runs.push(chatId) }) });
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
const { BlockItem } = await import('../src/components/thread/Items.tsx');
const note = { id: 'limit-1', type: 'statusNote', kind: 'limit', text: 'Claude Code limit reached.' } as any;

test('a limit note offers the way on, and runs it', async () => {
  const v = await render(h(BlockItem, { item: note, cwd: '/r', threadId: 'c1' }));
  const button = v.$('.status-note-action') as HTMLButtonElement;
  assert.equal(button.textContent, 'Continue on Codex (c1)');
  await settle(() => button.click());
  assert.deepEqual(runs, ['c1']);
  await v.unmount();
  // no chat: only the note
  const bare = await render(h(BlockItem, { item: note, cwd: '/r' }));
  assert.equal(bare.$('.status-note-action'), null);
  await bare.unmount();
});
