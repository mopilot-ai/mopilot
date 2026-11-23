// A command card of a chat on a machine names the agent the chat runs, also when the request's source names none (#5403: "Allow The agent to run this command?").
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, setStore, impl } from './support/thread-kit.ts';

mockStore();
const { fileChangeToDiff, parseUnifiedDiff } = await import('../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { ApprovalCard } = await import('../src/components/thread/Approvals.tsx');

beforeEach(() => {
  resetStore();
  for (const k of Object.keys(impl)) delete impl[k];
  impl['store:chatHarnessLabel'] = () => 'Codex';
});
afterEach(() => {
  document.body.innerHTML = '';
});

const options = [
  { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
];
const params = { options, toolCall: { kind: 'execute', title: 'Run', rawInput: { command: 'ls' } } };
async function message(threadId: string, sourceHarness: string | null | undefined) {
  const v = await render(
    h(ApprovalCard, {
      req: { id: 'p', method: 'acp/permission', params, sourceHarness, threadId, receivedAt: 0 } as any,
      cwd: '/repo',
      threadId,
      more: 0,
    }),
  );
  const said = v.$('.approval-message')?.textContent;
  await v.unmount();
  return said;
}

test('a card whose source names no agent takes the name of the agent the machine chat runs', async () => {
  assert.equal(await message('acp:host-claude:abc', null), 'Allow Claude Code to run this command?');
  assert.equal(await message('acp:host-codex:abc', null), 'Allow Codex to run this command?');
});

test('a source that names the machine agent but whose label is not known here still names it', async () => {
  assert.equal(await message('acp:host-claude:abc', 'acp:host-claude'), 'Allow Claude Code to run this command?');
  assert.equal(await message('acp:host-codex:abc', 'acp:host-codex'), 'Allow Codex to run this command?');
});

test('what the Host said after a switch decides, and a source that names an agent is kept', async () => {
  setStore({ chatConfig: { 'acp:host-codex:abc': { hostAgent: 'claude' } } });
  assert.equal(await message('acp:host-codex:abc', null), 'Allow Claude Code to run this command?');
  assert.equal(await message('acp:host-claude:abc', 'codex'), 'Allow Codex to run this command?');
});

test('a chat that is not on a machine, and a basic agent on a machine, still say "The agent" when nothing names it', async () => {
  assert.equal(await message('t1', null), 'The agent wants to: Run');
  assert.equal(await message('acp:host-kimi:abc', null), 'The agent wants to: Run');
});
