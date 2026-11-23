// The header of MoPilot's own approval cards: which surface a card is about (the browser for a site's card,
// whichever browser; computer use for an app's), rendered from the real session state (#1840).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, impl } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff') });
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');

impl['store:chatHarnessLabel'] = () => 'Claude Code';
afterEach(() => {
  document.body.innerHTML = '';
});

async function header(params: Record<string, unknown>) {
  useSessions.setState({
    sessions: { t1: { ...EMPTY_SESSION, rev: 1, approvals: [{ id: 's1', method: `sage/${params.kind}`, params }] } },
  });
  const v = await render(h(Approvals, { threadId: 't1', cwd: '/repo' }));
  const text = v.$('.approval-kind')?.textContent;
  await v.unmount();
  return text;
}

test("a site's action that can't be undone is the browser's card, in either browser", async () => {
  for (const browser of ['iab', 'chrome'])
    assert.equal(
      await header({ kind: 'computerConfirm', origin: 'https://shop.test', browser, verb: 'make a purchase', summary: 'left click "Pay"' }),
      'Browser',
    );
});

test("an app's action that can't be undone, and an app's access, stay computer use's", async () => {
  assert.equal(await header({ kind: 'computerConfirm', app: { name: 'Mail' }, verb: 'send' }), 'Computer use');
  assert.equal(await header({ kind: 'computerAccess', app: { name: 'Notes' } }), 'Computer use');
  assert.equal(await header({ kind: 'browserOrigin', origin: 'https://shop.test', level: 'read' }), 'Browser');
});
