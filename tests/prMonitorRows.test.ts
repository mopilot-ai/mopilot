// The PR rows' stack layout, as Claude Code lists a stack: open PRs as rows, earlier ones folded, right-click menus, Show N more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  fx,
  calls,
  url,
  store,
  clipboard,
  prRows,
  VISIBLE_ROWS,
  base,
  pr,
  mount,
  button,
  rows,
  rowText,
  rowLink,
  rowState,
  earlierRows,
  earlierButton,
  moreRows,
  note,
  ci,
  rightClick,
  parent,
  menuItem,
  openMenu,
  settle,
} from './support/pr-monitor-ui.ts';

test('a stacked PR is one row per open PR, as Claude Code lists them; merged and closed ones are earlier pull requests', async () => {
  fx.stored = base({
    autoFix: true,
    pr: pr({ parents: [parent(11, { pending: 1 }), parent(10, { state: 'MERGED' }), parent(9), parent(8, { state: 'CLOSED' })] }),
  });
  calls.length = 0;
  const f = await mount();
  try {
    // the tracked PR first, then the open PRs it is stacked on, nearest first
    assert.deepEqual(rows(f.host).map(rowText), ['#12Fix CI', '#11Parent 11', '#9Parent 9']);
    const second = rows(f.host)[1];
    // a parent row has no Auto-fix and its own quieter menu button
    assert.equal(button(second, 'Auto-fix'), undefined);
    assert.equal(second.dataset.tracked, undefined);
    assert.ok(second.querySelector('[aria-label="Pull request options"]'));
    assert.equal(rowLink(second).title, 'Parent 11\np11 → p12\nhttps://github.com/o/r/pull/11');
    await act(async () => rowLink(second).click());
    assert.deepEqual(calls.at(-1), ['open', 'https://github.com/o/r/pull/11']);

    const earlier = earlierButton(f.host)!;
    assert.deepEqual(
      [...earlier.querySelectorAll('span')].map((s) => s.textContent),
      ['2 earlier pull requests', '1 merged'],
    );
    assert.equal(earlier.getAttribute('aria-expanded'), 'false');
    assert.equal(f.host.querySelector('ul[aria-label="Earlier pull requests"]'), null);
    await act(async () => earlier.click());
    assert.equal(earlier.getAttribute('aria-expanded'), 'true');
    const old = earlierRows(f.host);
    assert.deepEqual(old.map(rowText), ['#10Parent 10', '#8Parent 8']);
    assert.deepEqual(old.map(rowState), ['merged', 'closed']);
    assert.ok(old.every((r) => r.dataset.ended === 'true' && ci(r) === null));
    await act(async () => earlier.click());
    assert.equal(f.host.querySelector('ul[aria-label="Earlier pull requests"]'), null);
  } finally {
    await f.close();
  }
});

test('earlier pull requests that were all closed say so without a merged count, and one reads singular', async () => {
  fx.stored = base({ pr: pr({ parents: [parent(7, { state: 'CLOSED' })] }) });
  const f = await mount();
  try {
    assert.deepEqual(
      [...earlierButton(f.host)!.querySelectorAll('span')].map((s) => s.textContent),
      ['1 earlier pull request'],
    );
    assert.deepEqual(
      prRows(fx.stored!).rows.map((r) => r.url),
      [url],
    );
  } finally {
    await f.close();
  }
});

test('a right-click on a row opens its menu where the pointer is; a parent row offers open and copy', async () => {
  fx.stored = base({ pr: pr({ parents: [parent(11)] }) });
  calls.length = 0;
  const f = await mount();
  try {
    const second = rows(f.host)[1];
    await rightClick(second);
    assert.equal(rows(f.host)[1].dataset.menuOpen, 'true');
    const items = () => [...f.host.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent);
    assert.deepEqual(items(), ['Open on GitHub', 'Copy link']);
    await act(async () => menuItem(f.host, 'Open on GitHub')!.click());
    assert.deepEqual(calls.at(-1), ['open', 'https://github.com/o/r/pull/11']);
    assert.equal(f.host.querySelector('[role="menu"]'), null);
    // the parent row's ⋯ opens the same menu
    await act(async () => rows(f.host)[1].querySelector<HTMLButtonElement>('[aria-label="Pull request options"]')!.click());
    clipboard.fail = true;
    await act(async () => menuItem(f.host, 'Copy link')!.click());
    await settle(act);
    clipboard.fail = false;
    assert.deepEqual(calls.at(-1), ['copy', 'https://github.com/o/r/pull/11']);
    assert.deepEqual(store.calls.at(-1), ['toast', "Couldn't copy: denied", 'error']);

    // a right-click on the chat's own PR opens everything its ⋯ offers, and closes the ⋯ menu if it was open
    await openMenu(f.host);
    await rightClick(rows(f.host)[0]);
    assert.equal(f.host.querySelectorAll('[role="menu"]').length, 1);
    assert.ok(menuItem(f.host, 'Address review comments'));
    await act(async () => menuItem(f.host, 'Stack on another PR…')!.click());
    assert.ok(f.host.querySelector('[role="dialog"]'));
    await act(async () => button(f.host, 'Cancel')!.click());
    // and opening ⋯ closes a right-click menu
    await rightClick(rows(f.host)[1]);
    await openMenu(f.host);
    assert.equal(f.host.querySelectorAll('[role="menu"]').length, 1);
    assert.ok(menuItem(f.host, 'Refresh status'));
  } finally {
    await f.close();
  }
});

test('past five rows the rest fold behind Show N more, and a stack that stops folding forgets it was expanded', async () => {
  assert.equal(VISIBLE_ROWS, 5);
  const many = [parent(11), parent(10), parent(9), parent(8), parent(7), parent(6)];
  fx.stored = base({ pr: pr({ parents: many }) });
  const f = await mount();
  try {
    assert.equal(rows(f.host).length, 5);
    const more = moreRows(f.host)!;
    assert.equal(more.textContent, 'Show 2 more');
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    await act(async () => more.click());
    assert.equal(rows(f.host).length, 7);
    assert.equal(more.textContent, 'Show less');
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    await act(async () => more.click());
    assert.equal(rows(f.host).length, 5);
    await act(async () => more.click());
    fx.stored = base({ pr: pr({ parents: [parent(11)] }) });
    await act(async () => fx.listener('chat'));
    await settle(act);
    assert.equal(moreRows(f.host), undefined);
    fx.stored = base({ pr: pr({ parents: many }) });
    await act(async () => fx.listener('chat'));
    await settle(act);
    assert.equal(rows(f.host).length, 5);
    assert.equal(moreRows(f.host)!.textContent, 'Show 2 more');
  } finally {
    await f.close();
  }
});

test("a stack that couldn't be read says so quietly under the rows, after any monitor news", async () => {
  fx.stored = base({ pr: pr({ stackError: 'rate limited' }) });
  let f = await mount();
  try {
    assert.equal(note(f.host)!.textContent, 'Couldn’t read the PRs this one is stacked on: rate limited');
    assert.equal(note(f.host)!.getAttribute('role'), 'status');
  } finally {
    await f.close();
  }
  fx.stored = base({ message: 'Autofix started', pr: pr({ stackError: 'rate limited' }) });
  f = await mount();
  try {
    assert.equal(note(f.host)!.textContent, 'Autofix started');
  } finally {
    await f.close();
  }
});

test('a stack read that names a PR twice, or loops back to the tracked one, shows each PR once', () => {
  const state = base({
    pr: pr({ parents: [parent(11), parent(12), parent(11), parent(10, { state: 'MERGED' }), parent(10, { state: 'MERGED' })] }),
  });
  const { rows: open, earlier } = prRows(state);
  assert.deepEqual(
    open.map((r) => [r.url, r.tracked]),
    [
      [url, true],
      ['https://github.com/o/r/pull/11', false],
    ],
  );
  assert.deepEqual(
    earlier.map((r) => r.url),
    ['https://github.com/o/r/pull/10'],
  );
});

test('opened earlier pull requests that go away and come back start folded again', async () => {
  fx.stored = base({ pr: pr({ parents: [parent(10, { state: 'MERGED' })] }) });
  const f = await mount();
  try {
    await act(async () => earlierButton(f.host)!.click());
    assert.ok(f.host.querySelector('ul[aria-label="Earlier pull requests"]'));
    fx.stored = base({ pr: pr({ parents: [] }) });
    await act(async () => fx.listener('chat'));
    await settle(act);
    assert.equal(earlierButton(f.host), undefined);
    fx.stored = base({ pr: pr({ parents: [parent(10, { state: 'MERGED' })] }) });
    await act(async () => fx.listener('chat'));
    await settle(act);
    assert.equal(earlierButton(f.host)!.getAttribute('aria-expanded'), 'false');
    assert.equal(f.host.querySelector('ul[aria-label="Earlier pull requests"]'), null);
  } finally {
    await f.close();
  }
});
