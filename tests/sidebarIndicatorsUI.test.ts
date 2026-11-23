// Sidebar rows hide worktree icons while retaining PR badges, ancestry and live activity across harnesses.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import type { Thread } from '../src/store/types.ts';
import { reset, render, update, getState, thread, ThreadRow } from './support/shell-sidebar-kit.ts';

// after the kit's mocks, as ThreadRow is
const { ThreadActivityIndicator } = await import('../src/components/sidebar/ThreadIndicators.tsx');

const style = document.createElement('style');
style.textContent = readFileSync(new URL('../src/styles/app/sidebar.css', import.meta.url), 'utf8');
before(() => document.head.append(style));
after(() => style.remove());

function checkDotSize(dot: Element) {
  const css = getComputedStyle(dot);
  assert.equal(css.width, '8px', 'status dots match Claude Code’s 8px diameter');
  assert.equal(css.height, '8px');
  assert.equal(css.borderRadius, '50%');
  assert.equal(css.flexShrink, '0', 'narrow rows keep the full dot size');
}

for (const id of ['codex-chat', 'claude-chat', 'acp:gemini:chat']) {
  test(`${id}: PR badges stay mounted and worktree icons stay hidden through the complete status journey`, async () => {
    const chat = thread(id, { cwd: '/repo/worktree', forkedFromId: 'parent', status: { type: 'idle' } }) as Thread;
    reset({ worktreeOf: { [id]: '/repo' } });
    const view = await render(h(ThreadRow, { thread: chat, active: false }));
    const row = view.$('.thread-row');
    const label = (value: string) => !!row.querySelector(`[aria-label="${value}"]`);
    const checkBadges = () => {
      assert.equal(label('Forked conversation'), true);
      assert.equal(label('Worktree'), false);
      assert.equal(row.querySelector('.thread-worktree-icon'), null);
      assert.equal(row.querySelector('[data-pr]')?.getAttribute('data-pr'), id);
      assert.equal(row.querySelector('[data-pr]')?.getAttribute('data-pr-cwd'), chat.cwd);
      for (const dot of row.querySelectorAll('.row-status .row-dot')) checkDotSize(dot);
    };
    try {
      checkBadges();
      assert.equal(row.querySelector('.row-status')!.textContent, '');
      await update({ ...getState(), sessions: { [id]: { rev: 1, turn: 'running' } } });
      assert.equal(label('Working'), true);
      assert.ok(row.querySelector('.row-status .row-dot.working[aria-label="Working"]'));
      assert.equal(row.querySelector('.row-status .sr-only'), null, 'activity must have a visible marker');
      checkBadges();
      await update({ ...getState(), sessions: { [id]: { rev: 2, turn: 'awaitingUser' } } });
      assert.equal(label('Awaiting approval'), true);
      for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request']) {
        await update({ ...getState(), sessions: { [id]: { rev: 3, turn: 'awaitingUser', approvals: [{ method }] } } });
        assert.equal(label('Needs input'), true);
        assert.equal(label('Working'), false);
        checkBadges();
      }
      await update({
        ...getState(),
        sessions: {},
        pending: [
          { threadId: id, method: 'item/tool/requestUserInput' },
          { threadId: id, method: 'acp/permission' },
        ],
      });
      assert.equal(label('Awaiting approval'), true, 'an approval is not hidden behind a simultaneous question');
      await update({ ...getState(), pending: [], sessions: { [id]: { rev: 4, turn: 'crashed' } } });
      assert.equal(label('Chat failed'), true);
      await update({ ...getState(), sessions: { [id]: { rev: 4, turn: 'running' } } });
      assert.equal(label('Working'), true, 'retry clears the failed indicator');
      assert.ok(row.querySelector('.row-status .row-dot.working'));
      await update({ ...getState(), sessions: {}, unread: { [id]: true } });
      assert.equal(label('Unread result'), true);
      checkBadges();
      await update({ ...getState(), unread: {} });
      assert.equal(label('Unread result'), false);
      await update({ ...getState(), voice: { threadId: id, phase: 'speaking' } });
      assert.equal(label('Voice chat active'), true);
      checkBadges();
      await update({ ...getState(), voice: { threadId: id, phase: 'error' } });
      assert.equal(label('Voice chat active'), false);
      await update({ ...getState(), voice: { threadId: 'other', phase: 'listening' } });
      assert.equal(label('Voice chat active'), false);
    } finally {
      await view.unmount();
    }
  });
}

test('native flags, renderer failures and external activity have accessible fallback indicators', async () => {
  const cases = [
    [{ status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }, {}, 'Needs input'],
    [{ status: { type: 'active', activeFlags: ['waitingOnApproval'] } }, {}, 'Awaiting approval'],
    [{ status: { type: 'systemError' } }, {}, 'Chat failed'],
    [{ status: { type: 'idle' } }, { runtime: { chat: { turns: [], error: 'Failed' } } }, 'Chat failed'],
    [{ status: { type: 'idle' } }, { runtime: { chat: { turns: [{ status: 'failed' }] } } }, 'Chat failed'],
    [{ status: { type: 'idle' } }, { runtime: { chat: { turns: [], error: 'Old failure', activeTurnId: 'retry' } } }, 'Working'],
    [{ status: { type: 'idle' } }, { elsewhere: { chat: { app: 'claude-desktop', running: true } } }, 'Running in Claude desktop'],
    [{ status: { type: 'idle' } }, { elsewhere: { chat: { app: 'sage', running: false } } }, 'Open in another window'],
    [{ status: { type: 'idle' } }, { pending: [{ threadId: 'other' }] }, null],
  ] as const;
  for (const [fields, state, expected] of cases) {
    reset(state);
    const view = await render(h(ThreadRow, { thread: thread('chat', fields) as Thread, active: false }));
    try {
      assert.equal(view.host.querySelector('.row-status [aria-label]')?.getAttribute('aria-label') ?? null, expected);
      if (expected === 'Working' || expected?.startsWith('Running in')) {
        const status = expected === 'Working' ? 'working' : 'elsewhere';
        assert.ok(view.host.querySelector(`.row-status .row-dot.${status}`), `${expected} has a visible dot`);
        checkDotSize(view.host.querySelector(`.row-status .row-dot.${status}`)!);
      }
    } finally {
      await view.unmount();
    }
  }
});

for (const how of ['failed', 'lost'] as const) {
  test(`a linked session whose last report says ${how} shows the same red alert and a tooltip, like a failed chat`, async () => {
    reset({});
    const linked = {
      parentId: 'top',
      name: 'kid',
      title: 'kid',
      harness: 'codex',
      useWorktree: true,
      createdAt: 1,
      lastReport: { how, report: null, chars: 0, at: 1 },
    };
    const view = await render(
      h(ThreadActivityIndicator, { thread: thread('kid', { status: { type: 'idle' } }) as Thread, linked: linked as any }),
    );
    try {
      const slot = view.$('.row-status');
      assert.ok(slot.classList.contains('error'), 'the alert is red, as it is for a failed chat');
      assert.ok(slot.querySelector('[aria-label="Failed"]'));
      assert.equal(slot.querySelector('[data-tooltip]')?.getAttribute('data-tooltip'), 'Session failed · open it to read its report');
    } finally {
      await view.unmount();
    }
  });
}
