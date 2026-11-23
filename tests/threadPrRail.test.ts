// ThreadView mounts one shared PR rail outside live/completed activity rows, on every supported harness and no read-only views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, T, user, reply, turn, chat, view } from './support/thread-view/fixture.ts';
import { inboxCount, inboxView } from '../src/lib/prInbox.ts';
import { setPrLine, clearPrLine } from '../src/components/thread/prLine.ts';

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: repeated replies and a live turn keep one named merged PR rail outside the status line`, async () => {
    const completed = turn('done', [user('u1', 'Fix it'), reply('r1', 'Merged the PR')]);
    chat([completed]);
    setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] } });
    const prs = inboxView(
      [
        {
          url: 'https://github.com/o/r/pull/7',
          chatId: T,
          session: null,
          pr: { url: 'https://github.com/o/r/pull/7', number: 7, title: 'Fix the parser', state: 'merged' },
        },
      ],
      null,
    );
    setPrLine(T, { view: prs, count: inboxCount(prs) });
    const v = await render(view());
    const rail = () => v.$('[aria-label="Chat pull requests"]');
    try {
      assert.ok(rail());
      assert.equal(v.$('.turn-status-slot [aria-label="Chat pull requests"]'), null);
      assert.equal(v.$$('.thread-column > [aria-label="Chat pull requests"]').length, 1);
      const live = turn('live', [user('u2', 'Check again')], { status: 'inProgress' });
      await settle(() => chat([completed, live], { activeTurnId: 'live' }));
      assert.ok(v.$('.turn-status-slot .claude-activity'));
      assert.equal(v.$$('.thread-column > [aria-label="Chat pull requests"]').length, 1);
      await settle(() => chat([completed, { ...live, status: 'completed', items: [...live.items, reply('r2', 'Still merged')] }]));
      assert.equal(v.$('.turn-status-slot .claude-activity'), null);
      assert.equal(rail()!.querySelectorAll('button[aria-label^="Open pull request #"]').length, 1);
      await v.rerender(view({ readOnly: true }));
      assert.equal(rail(), null);
    } finally {
      await v.unmount();
      clearPrLine(T);
    }
  });
}
