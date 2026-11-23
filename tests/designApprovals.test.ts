// Claude Code's approval card for its claude.ai artifact and Claude Design tools (src/components/thread/approvals/toolCards.tsx):
// a publish says what it publishes and where, in place of its raw input; the CLI's own title still wins, and a call with
// nothing to summarize keeps its input.
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
beforeEach(() => {
  resetStore();
  useSessions.setState({ sessions: {} });
  moduleCalls.length = 0;
  for (const k of Object.keys(impl)) delete impl[k];
  impl['store:chatHarnessLabel'] = () => 'Claude Code';
  impl['store:chatOf'] = (id: string) => `chat:${id}`;
});
afterEach(() => {
  document.body.innerHTML = '';
});
const text = (el: Element | null) => el?.textContent ?? '';
const show = async (params: any) => {
  useSessions.setState({
    sessions: { [T]: { ...EMPTY_SESSION, rev: 1, approvals: [{ id: 'r1', method: 'claude/toolApproval', params }] } },
  });
  return render(h(Approvals, { threadId: T, cwd: '/repo' }));
};

test('a publish says what it publishes, in place of its input', async () => {
  const v = await show({ toolName: 'Artifact', input: { file_path: '/w/landing.html', title: 'Landing page' } });
  assert.equal(text(v.$('.approval-kind')), 'Artifact');
  assert.equal(text(v.$('.approval-message')), 'Publish Landing page to claude.ai?');
  assert.deepEqual(
    v.$$('.approval-facts li').map((l) => text(l)),
    ['Title: Landing page', 'File: /w/landing.html', 'Private to you on claude.ai until you share it'],
  );
  assert.ok(!v.$('.approval-cmd'));
  await v.unmount();
});

test("the CLI's title wins, and a Claude Design call with nothing to summarize keeps its input", async () => {
  const input = { operation: 'write_files', arguments: { n: 1 } };
  let v = await show({ toolName: 'ClaudeDesign', input, title: 'Write files?' });
  assert.equal(text(v.$('.approval-kind')), 'Claude Design');
  assert.equal(text(v.$('.approval-message')), 'Write files?');
  assert.equal(text(v.$('.approval-cmd')), JSON.stringify(input, null, 2));
  await v.unmount();
  v = await show({ toolName: 'ClaudeDesign', input });
  assert.equal(text(v.$('.approval-message')), 'Run write files in Claude Design?');
  await v.unmount();
});
