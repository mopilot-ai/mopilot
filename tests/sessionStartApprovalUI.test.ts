// Session-start approvals use the broker's exact request id and allow only one start after trusted user input.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore, trustedClick, native, impl, key, settle, window } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { SessionStartApproval } = await import('../src/components/thread/approvals/SessionStartApproval.tsx');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const answers: unknown[] = [];
native.computer = { answer: async (...args: unknown[]) => (answers.push(args), true) };
beforeEach(() => {
  resetStore();
  useSessions.setState({ sessions: {} });
  answers.length = 0;
  impl['store:chatHarnessLabel'] = () => 'Kimi Code';
});
const params = {
  kind: 'sessionStart',
  harness: 'acp:kimi',
  summary: 'It has requested 10 sessions since your last message.',
  count: 10,
};
const button = (host: ParentNode, word: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(word))!;

test('the real approval stack routes sessionStart to one-start approval without a persistent grant', async () => {
  useSessions.setState({
    sessions: { parent: { ...EMPTY_SESSION, rev: 1, approvals: [{ id: 'start-10', method: 'sage/sessionStart', params }] } },
  } as any);
  const v = await render(h(Approvals, { threadId: 'parent', cwd: '/repo' }));
  assert.equal(v.$('.approval-card')?.getAttribute('data-kind'), 'sessionStart');
  assert.equal(v.$('.approval-message')?.textContent, 'Kimi Code wants to start another session.');
  assert.equal(v.$('.sage-access-hint')?.textContent, params.summary);
  assert.equal(v.host.querySelectorAll('.allow-chevron').length, 0);
  assert.doesNotMatch(v.host.textContent ?? '', /Always|Allow in this chat|can’t be undone/);
  await settle(() => button(v.host, 'Allow once').click());
  await settle(() => button(v.host, 'Deny').click());
  assert.deepEqual(answers, [], 'scripted clicks cannot approve or deny');
  await trustedClick(button(v.host, 'Allow once'));
  assert.deepEqual(answers.pop(), ['start-10', { decision: 'allow', scope: 'once' }]);
  await trustedClick(button(v.host, 'Deny'));
  assert.deepEqual(answers.pop(), ['start-10', { decision: 'deny' }]);
  await v.unmount();
});

test('keyboard answers only the current card, while typing, popovers and synthetic keys stay private', async () => {
  const v = await render(h(SessionStartApproval, { id: 'wake-start', threadId: 'parent', params: { ...params, continued: true } as any }));
  assert.equal(v.$('.sage-access-hint')?.textContent, 'The app is continuing your request. Allow a new session?');
  const press = (value: string, target: EventTarget = document.body) => key(target, 'keydown', { key: value });
  await press('Escape');
  assert.deepEqual(answers.pop(), ['wake-start', { decision: 'deny' }]);
  await press('Enter');
  assert.deepEqual(answers.pop(), ['wake-start', { decision: 'allow', scope: 'once' }]);
  await press('1');
  assert.deepEqual(answers.pop(), ['wake-start', { decision: 'allow', scope: 'once' }]);
  await press('x');
  const input = document.createElement('input');
  document.body.append(input);
  await press('1', input);
  const popover = document.createElement('div');
  popover.className = 'popover-layer';
  document.body.append(popover);
  await press('Enter');
  popover.remove();
  await settle(() => {
    const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(event, 'isTrusted', { value: false });
    document.body.dispatchEvent(event as any);
  });
  assert.deepEqual(answers, []);
  input.remove();
  await v.unmount();
  const missing = await render(
    h(SessionStartApproval, { id: 'missing', threadId: 'parent', params: { kind: 'sessionStart', harness: 'codex' } as any }),
  );
  assert.equal(missing.$('.sage-access-hint')?.textContent, 'It has requested 0 sessions since your last message.');
  await missing.unmount();
});
