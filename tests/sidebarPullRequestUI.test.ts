// Real sidebar rows retain PR lifecycle, counts and interactive hover previews independently of worktree icons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { window } from './support/dom.ts';
import './support/allOnScreen.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { Thread } from '../src/store/types.ts';
import type { ThreadPullRequest } from '../src/lib/threadPullRequest.ts';

import { sidebarRowKit } from './support/sidebar-row-kit.ts';

const kit = await sidebarRowKit();
const { opened, navigated, reads, ThreadRow } = kit;

const styles = document.createElement('style');
styles.textContent = ['sidebar.css', 'sidebar-families.css', 'popovers.css']
  .map((file) => readFileSync(new URL(`../src/styles/app/${file}`, import.meta.url), 'utf8'))
  .join('\n');
document.head.append(styles);
const url = 'https://github.com/org/repo/pull/42';
const pr = (fields: Partial<ThreadPullRequest> = {}): ThreadPullRequest => ({
  url,
  number: 42,
  state: 'open',
  title: 'Keep PR status',
  additions: 12,
  deletions: 3,
  ...fields,
});

for (const id of ['codex-chat', 'claude:chat', 'acp:gemini:chat']) {
  test(`${id}: the real row keeps its location column, PR lifecycle and hover previews`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    opened.length = 0;
    navigated.length = 0;
    reads.length = 0;
    kit.result = null;
    kit.working = false;
    kit.speaking = false;
    kit.machineLine = { id: 'build-host', name: 'Build host', word: null };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const chat = {
      id,
      name: 'A worktree chat',
      cwd: `/Users/dev/.mopilot/worktrees/${id}/repo`,
      updatedAt: 1,
      forkedFromId: 'parent',
    } as Thread;
    let version = 0;
    const show = (depth: number) =>
      act(async () => root.render(h(ThreadRow, { thread: { ...chat, updatedAt: ++version }, active: false, depth })));
    const checkColumns = () => {
      const row = host.querySelector('.thread-row')!;
      const status = row.querySelector('.row-status')!;
      const content = row.querySelector('.thread-row-content')!;
      const contentStyle = window.getComputedStyle(content as any);
      assert.equal(contentStyle.minWidth, '0', 'extra adornments cannot force the title group wider than its available space');
      assert.equal(contentStyle.overflow, 'hidden', 'extra adornments stay inside their own bounded group at minimum sidebar width');
      assert.equal(row.querySelector('.row-actions')!.parentElement, row, 'the menu keeps its own space outside the clipped adornments');
      const actions = row.querySelector('.row-actions')!;
      const display = (el: Element) => window.getComputedStyle(el as any).display;
      const style = window.getComputedStyle(status as any);
      assert.equal(style.width, '16px', 'every row reserves the same trailing activity column');
      assert.equal(display(status), 'flex', 'an idle row shows its activity column');
      assert.equal(display(actions), 'none', 'an idle row hides its menu');
      const actionsStyle = window.getComputedStyle(actions as any);
      assert.deepEqual(
        [actionsStyle.marginLeft, actionsStyle.marginRight],
        ['-3px', '-3px'],
        'the 22px menu fills the 16px activity slot without moving the PR column',
      );
      row.classList.add('menu-open');
      assert.equal(display(actions), 'flex', 'a hovered or open row shows its menu');
      assert.equal(display(status), 'none', "the menu takes the status dot's place");
      const hint = document.createElement('kbd');
      hint.className = 'chat-shortcut-hint';
      hint.textContent = '⌘1';
      row.insertBefore(hint, actions);
      assert.equal(display(actions), 'none', 'shortcut hints replace the menu even while hovered or open');
      assert.equal(display(status), 'flex', 'a shortcut hint leaves the status dot in place');
      hint.remove();
      row.classList.remove('menu-open');
      const columns = [...row.children];
      const location = row.querySelector('.host-mark[aria-label="On Build host"]')!;
      assert.ok(location);
      assert.ok(location.closest('.side-row-name')?.querySelector('.side-row-label + .host-mark'), 'the location mark follows the name');
      assert.ok(columns.indexOf(status) < columns.indexOf(actions), 'the menu sits right of the activity slot it replaces');
      const count = row.querySelector('.thread-pr-count');
      if (count) assert.equal(window.getComputedStyle(count as any).order, '-1', 'counts grow left of the aligned PR icon');
      const badge = row.querySelector('.thread-pr-badge');
      if (badge) {
        assert.ok(
          badge.parentElement!.nextElementSibling === status,
          'the PR column sits beside activity in every row, with no location slot between',
        );
        assert.ok(columns.indexOf(badge.parentElement!) < columns.indexOf(actions), 'the menu sits right of the PR badge');
      }
    };
    const hover = async () => {
      const anchor = host.querySelector('.thread-pr-badge')!.parentElement!;
      await act(async () => anchor.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }) as any));
      await act(async () => t.mock.timers.tick(450));
      return [...document.querySelectorAll('.tooltip.rich .thread-pr-list-item')];
    };
    const leave = async () => {
      const anchor = host.querySelector('.thread-pr-badge')!.parentElement!;
      await act(async () =>
        anchor.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body as any }) as any),
      );
      await act(async () => t.mock.timers.tick(150));
    };
    try {
      for (const depth of [0, 1]) {
        kit.result = null;
        await show(depth);
        assert.equal(host.querySelector('.thread-pr-badge'), null, 'no PR leaves no badge');
        checkColumns();
        for (const [value, indicator, label] of [
          [pr({ state: 'draft' }), 'draft', 'draft'],
          [pr({ details: { checks: 'pending', mergeable: 'MERGEABLE', mergeState: 'CLEAN' } }), 'in_progress', 'checks pending'],
          [pr({ details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' } }), 'ready', 'ready to merge'],
          [pr({ details: { checks: 'passing', mergeable: 'CONFLICTING', mergeState: 'DIRTY' } }), 'failing', 'merge conflicts'],
          [pr({ state: 'merged' }), 'merged', 'merged'],
        ] as const) {
          kit.result = value;
          await show(depth);
          checkColumns();
          const badge = host.querySelector('.thread-pr-badge')!;
          assert.ok(badge, 'the production ThreadRow must mount its PR badge');
          assert.equal(badge.getAttribute('data-indicator'), indicator);
          assert.ok(badge.getAttribute('aria-label')!.includes(label));
          assert.equal(host.querySelector('[aria-label="Worktree"]'), null);
          assert.equal(host.querySelector('.thread-worktree-icon'), null);
          assert.ok(host.querySelector('[aria-label="Forked conversation"]'));
          const rows = await hover();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].querySelector('.thread-pr-list-state')!.getAttribute('data-indicator'), indicator);
          assert.equal(rows[0].querySelector('.thread-pr-list-title')!.textContent, value.title);
          assert.ok(rows[0].textContent!.includes('org/repo #42'));
          assert.equal(rows[0].querySelector('.plus')!.textContent, '+12');
          assert.equal(rows[0].querySelector('.minus')!.textContent, '−3');
          await leave();
        }
        const entries = [pr({ state: 'draft' }), pr({ url: url.replace('42', '41'), number: 41, state: 'merged', title: 'Earlier PR' })];
        kit.result = { ...entries[0], entries };
        for (const running of [true, false]) {
          kit.working = running;
          await show(depth);
          checkColumns();
          assert.equal(host.querySelector('.thread-pr-count')!.textContent, '2');
          assert.equal(!!host.querySelector('[aria-label="Working"]'), running);
          const rows = await hover();
          assert.deepEqual(
            rows.map((row) => row.querySelector('.thread-pr-list-title')!.textContent),
            ['Keep PR status', 'Earlier PR'],
          );
          await act(async () => (rows[1] as HTMLElement).click());
          assert.equal(opened.at(-1), entries[1].url, 'the preview opens its own PR');
          assert.equal(document.querySelector('.tooltip.rich'), null, 'opening a preview closes it');
          await leave();
        }
        kit.result = { ...entries[0], entries: Array.from({ length: 12 }, (_, i) => pr({ number: 42 + i })) };
        kit.speaking = true;
        await show(depth);
        assert.equal(host.querySelector('.thread-pr-count')!.textContent, '12');
        checkColumns();
        const voice = host.querySelector('[aria-label="Voice chat active"]')!.closest('.thread-row-content')!;
        const columns = [...host.querySelector('.thread-row')!.children];
        assert.ok(columns.indexOf(voice) < columns.indexOf(host.querySelector('.thread-pr-badge')!.parentElement!));
        kit.speaking = false;
      }
      await act(async () => (host.querySelector('.thread-pr-badge') as HTMLElement).click());
      assert.equal(opened.at(-1), url);
      assert.deepEqual(navigated, [], 'PR actions never open the chat row');
      assert.ok(reads.every(([chatId, cwd, fresh]) => chatId === id && cwd === chat.cwd && fresh === true));
      assert.equal(reads.at(-1)![3], JSON.stringify([version, id]));
    } finally {
      await act(async () => root.unmount());
      host.remove();
      kit.machineLine = null;
    }
  });
}
