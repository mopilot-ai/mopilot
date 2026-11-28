// Claude Code's reason for asking on its permission cards (src/components/thread/approvals/shared.tsx): a safety
// check can ask even in full access, and the card's title is often the command's own description.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, moduleCalls, impl } from './support/thread-kit.ts';

mockStore();
const { fileChangeToDiff, parseUnifiedDiff } = await import('../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');

const T = 't1';
const show = (method: string, params: any, id: string) => {
  useSessions.setState({ sessions: { [T]: { ...EMPTY_SESSION, rev: 1, approvals: [{ id, method, params }] } } });
  return render(h(Approvals, { threadId: T, cwd: '/repo' }));
};
const text = (el: Element | null) => el?.textContent ?? '';

beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
  for (const k of Object.keys(impl)) delete impl[k];
  impl['store:chatHarnessLabel'] = () => 'Claude Code';
  impl['store:chatOf'] = (id: string) => `chat:${id}`;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const why = "Claude Code can't be sure it read this command the way the shell will";

test("a Claude Code command card shows Claude Code's reason for asking under its title", async () => {
  const v = await show('item/commandExecution/requestApproval', { command: 'ls', reason: 'List files', why }, 'cperm-1');
  assert.equal(text(v.$('.approval-message')), 'List files');
  assert.equal(text(v.$('.approval-why')), why);
  await v.unmount();
});

test('no second line when the reason is already the title, is missing or is blank', async () => {
  for (const params of [
    { command: 'ls', reason: why, why },
    { command: 'ls', reason: 'List files', why: null },
    { command: 'ls', why: '  ' },
  ]) {
    const v = await show('item/commandExecution/requestApproval', params, 'cperm-1');
    assert.ok(!v.$('.approval-why'), JSON.stringify(params));
    await v.unmount();
  }
});

test('a tool card titled by Claude Code keeps the reason too', async () => {
  const v = await show('claude/toolApproval', { toolName: 'WebFetch', title: 'Fetch it', why }, 'cperm-2');
  assert.equal(text(v.$('.approval-message')), 'Fetch it');
  assert.equal(text(v.$('.approval-why')), why);
  await v.unmount();
});
