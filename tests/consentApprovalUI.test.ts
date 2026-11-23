// The consent card (src/components/thread/approvals/ConsentApproval.tsx): one change an agent's tool asks to make, allowed
// or denied once, only by a person's input; the real approval stack routes the 'consent' kind to it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore, trustedClick, native, impl, key, settle, window } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { ConsentApproval } = await import('../src/components/thread/approvals/ConsentApproval.tsx');
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
const params = { kind: 'consent', harness: 'acp:kimi', summary: 'set Theme to “dark”' };
const button = (host: ParentNode, word: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(word))!;

test('the approval stack routes consent to its card, which names the agent and the change and answers once', async () => {
  useSessions.setState({
    sessions: { parent: { ...EMPTY_SESSION, rev: 1, approvals: [{ id: 'consent-1', method: 'sage/consent', params }] } },
  } as any);
  const v = await render(h(Approvals, { threadId: 'parent', cwd: '/repo' }));
  assert.equal(v.$('.approval-card')?.getAttribute('data-kind'), 'consent');
  assert.equal(v.$('.approval-message')?.textContent, 'Allow Kimi Code to set Theme to “dark”?');
  assert.equal(v.host.querySelectorAll('.allow-chevron').length, 0);
  assert.doesNotMatch(v.host.textContent ?? '', /Always|Allow in this chat/);
  await settle(() => button(v.host, 'Allow once').click());
  assert.deepEqual(answers, [], 'a scripted click cannot approve');
  await trustedClick(button(v.host, 'Allow once'));
  assert.deepEqual(answers.pop(), ['consent-1', { decision: 'allow', scope: 'once' }]);
  await trustedClick(button(v.host, 'Deny'));
  assert.deepEqual(answers.pop(), ['consent-1', { decision: 'deny' }]);
  await v.unmount();
});

test('keys answer only this card; typing, popovers and synthetic keys do not', async () => {
  const v = await render(h(ConsentApproval, { id: 'c2', threadId: 'parent', params: params as any }));
  const press = (value: string, target: EventTarget = document.body) => key(target, 'keydown', { key: value });
  await press('Escape');
  assert.deepEqual(answers.pop(), ['c2', { decision: 'deny' }]);
  await press('Enter');
  assert.deepEqual(answers.pop(), ['c2', { decision: 'allow', scope: 'once' }]);
  await press('1');
  assert.deepEqual(answers.pop(), ['c2', { decision: 'allow', scope: 'once' }]);
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
  const plain = await render(h(ConsentApproval, { id: 'c3', threadId: 'parent', params: { kind: 'consent', harness: 'acp:kimi' } as any }));
  assert.equal(plain.$('.approval-message')?.textContent, 'Allow Kimi Code to make a change?');
  await plain.unmount();
});
