// The tracked PR's controls in the Changes card and their monitor hook: CI wording, Auto-fix, menu, notes, races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  fx,
  calls,
  url,
  api,
  store,
  prChecks,
  usePrMonitor,
  prNumber,
  markWindowReady,
  resetWindowReady,
  deferred,
  base,
  pr,
  mount,
  button,
  rows,
  ci,
  rowLink,
  rowState,
  earlierButton,
  moreRows,
  note,
  parent,
  menuItem,
  openMenu,
  autoFixItem,
  settle,
} from './support/pr-monitor-ui.ts';
import styles from '../src/components/thread/prMonitor.module.css';

test('a chat that tracks no pull request shows no rows', async () => {
  fx.stored = null;
  const f = await mount();
  assert.equal(f.host.innerHTML, '');
  await f.close();
  // a monitor that can't be read shows nothing either: the summary panel reports it when the user attaches
  const g = await mount({
    ...api,
    snapshot: async () => {
      throw new Error('store unreadable');
    },
  });
  assert.equal(g.host.innerHTML, '');
  await g.close();
});

test('a tracked pull request is one row: number, title, CI icon and more options, with Auto-fix in its menu', async () => {
  fx.stored = base({ pr: pr({ failed: 2 }), message: 'Monitoring' });
  calls.length = 0;
  const f = await mount();
  try {
    // the rows' classes are their CSS Module's (identity names in unit tests, hashed in the app)
    const sheet = f.host.querySelector<HTMLElement>('[aria-label="Pull request controls"]')!;
    assert.equal(sheet.className, styles.prPanel);
    assert.equal(sheet.getAttribute('role'), 'group');
    // a PR stacked on nothing is the only row, with nothing to fold and no earlier PRs
    assert.equal(rows(f.host).length, 1);
    assert.equal(moreRows(f.host), undefined);
    assert.equal(earlierButton(f.host), undefined);
    const row = rows(f.host)[0];
    assert.equal(row.className, styles.prRow);
    assert.equal(row.dataset.tracked, 'true');
    assert.equal(row.dataset.ended, undefined);
    const link = rowLink(row);
    assert.equal(link.textContent, '#12Fix CI');
    // the branches moved off the row into the link's tooltip
    assert.equal(link.title, `Fix CI\nfeature/child → feature/parent\n${url}`);
    assert.equal(link.getAttribute('aria-label'), 'Open pull request #12 on GitHub');
    assert.equal(rowState(row), 'open');
    assert.equal(ci(row)!.dataset.tone, 'failed');
    assert.equal(ci(row)!.getAttribute('aria-label'), 'CI: 2 checks failing');
    assert.equal(ci(row)!.getAttribute('title'), '2 checks failing');
    // "Monitoring" is the resting state, not news
    assert.equal(note(f.host), null);
    await act(async () => link.click());
    assert.deepEqual(calls.at(-1), ['open', url]);

    // no Auto-fix on the row: it is a checked item in the PR's menu (#2042)
    assert.equal(button(f.host, 'Auto-fix'), undefined);
    assert.equal((await autoFixItem(f.host)).dataset.checked, 'false');
    await act(async () => menuItem(f.host, 'Auto-fix')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { autoFix: true }]);
    assert.equal((await autoFixItem(f.host)).dataset.checked, 'true');
    await act(async () => menuItem(f.host, 'Auto-fix')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { autoFix: false }]);

    await openMenu(f.host);
    assert.match(f.host.querySelector<HTMLButtonElement>('[aria-label="More PR options"]')!.className, /\bon\b/);
    // the row shows its menu is open
    assert.equal(rows(f.host)[0].dataset.menuOpen, 'true');
    assert.equal(menuItem(f.host, 'Retry auto-fix'), undefined);
    assert.match(f.host.textContent!, /Requires GitHub CLI sign-in/);
    await act(async () => menuItem(f.host, 'Open on GitHub')!.click());
    assert.deepEqual(calls.at(-1), ['open', url]);
    await openMenu(f.host);
    await act(async () => menuItem(f.host, 'Copy link')!.click());
    await settle(act);
    assert.deepEqual(calls.at(-1), ['copy', url]);
    assert.deepEqual(store.calls.at(-1), ['toast', 'Copied link']);
    await openMenu(f.host);
    assert.equal(menuItem(f.host, 'Address review comments')!.getAttribute('aria-checked'), 'false');
    await act(async () => menuItem(f.host, 'Address review comments')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { addressComments: true }]);
    await openMenu(f.host);
    assert.equal(menuItem(f.host, 'Address review comments')!.getAttribute('aria-checked'), 'true');
    await act(async () => menuItem(f.host, 'Address review comments')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { addressComments: false }]);
    await openMenu(f.host);
    await act(async () => menuItem(f.host, 'Refresh status')!.click());
    assert.deepEqual(calls.at(-1), ['refresh', 'chat']);

    // another chat's change leaves this row alone; this chat's is read again
    fx.stored = base({ pr: pr({ title: 'Renamed' }) });
    await act(async () => fx.listener('other'));
    assert.doesNotMatch(f.host.textContent!, /Renamed/);
    await act(async () => fx.listener('chat'));
    assert.match(f.host.textContent!, /Renamed/);
  } finally {
    await f.close();
  }
  assert.ok(fx.unsubscribed > 0);
});

test('CI wording covers every pull request state, and each tone has its icon', async () => {
  assert.deepEqual(prChecks(undefined), { text: 'Checking…', tone: 'muted' });
  assert.deepEqual(prChecks(pr({ state: 'MERGED', failed: 3 })), { text: 'Merged', tone: 'muted' });
  assert.deepEqual(prChecks(pr({ state: 'CLOSED' })), { text: 'Closed', tone: 'muted' });
  assert.deepEqual(prChecks(pr({ failed: 1, pending: 4 })), { text: '1 check failing', tone: 'failed' });
  assert.deepEqual(prChecks(pr({ pending: 4 })), { text: 'Checks in progress', tone: 'pending' });
  assert.deepEqual(prChecks(pr()), { text: 'No failing checks', tone: 'ok' });
  assert.equal(prNumber(url), '12');
  assert.equal(prNumber('https://example.com/nothing'), '');
  fx.stored = base({ pr: pr({ parents: [parent(11, { pending: 1 }), parent(10, { failed: 1 })] }) });
  const f = await mount();
  try {
    assert.deepEqual(
      rows(f.host).map((r) => ci(r)!.dataset.tone),
      ['ok', 'pending', 'failed'],
    );
    assert.deepEqual(
      rows(f.host).map((r) => ci(r)!.getAttribute('aria-label')),
      ['CI: No failing checks', 'CI: Checks in progress', 'CI: 1 check failing'],
    );
    assert.ok(rows(f.host).every((r) => ci(r)!.querySelector('svg')));
  } finally {
    await f.close();
  }
});

test('the row before its first read, after a merge, and after a close', async () => {
  fx.stored = base();
  const f = await mount();
  const link = rowLink(rows(f.host)[0]);
  // no title yet: the number alone, the link names the URL, and CI is still being checked
  assert.equal(link.textContent, '#12');
  assert.equal(link.title, url);
  assert.equal(ci(rows(f.host)[0])!.dataset.tone, 'muted');
  assert.equal(ci(rows(f.host)[0])!.getAttribute('aria-label'), 'CI: Checking…');
  // before the first read it can still be turned on
  assert.equal((await autoFixItem(f.host)).disabled, false);
  fx.stored = base({ pr: pr({ state: 'MERGED' }), message: 'PR merged' });
  await act(async () => fx.listener('chat'));
  // the chat's own PR stays its first row once merged, muted, and its state icon says it all
  assert.equal(rowState(rows(f.host)[0]), 'merged');
  assert.equal(rows(f.host)[0].dataset.ended, 'true');
  assert.equal(ci(rows(f.host)[0]), null);
  // a merged pull request has nothing left for Auto-fix
  assert.equal((await autoFixItem(f.host)).disabled, true);
  assert.equal(note(f.host), null);
  fx.stored = base({ pr: pr({ state: 'CLOSED' }), message: 'PR closed' });
  await act(async () => fx.listener('chat'));
  assert.equal(rowState(rows(f.host)[0]), 'closed');
  await f.close();
});

test("the monitor's news, its errors, and recovery after an uncertain or exhausted auto-fix", async () => {
  fx.stored = base({ pr: pr(), message: 'Waiting: chat busy' });
  const f = await mount();
  try {
    assert.equal(f.host.querySelector('[role="status"]')!.textContent, 'Waiting: chat busy');
    fx.stored = base({ pr: pr(), message: 'Needs attention', error: 'gh: offline' });
    await act(async () => fx.listener('chat'));
    assert.equal(f.host.querySelector('[role="alert"]')!.textContent, 'gh: offline');
    assert.equal(f.host.querySelector('[role="status"]'), null);
    fx.stored = base({ pr: pr(), message: 'Needs attention' });
    await act(async () => fx.listener('chat'));
    assert.equal(note(f.host), null);
    fx.stored = base({ pr: pr(), uncertain: true, message: 'Autofix started' });
    await act(async () => fx.listener('chat'));
    assert.match(f.host.querySelector('[role="status"]')!.textContent!, /may not have reached the chat/);
    await openMenu(f.host);
    await act(async () => menuItem(f.host, 'Retry auto-fix')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { retry: true }]);
    fx.stored = base({ pr: pr(), limited: true });
    await act(async () => fx.listener('chat'));
    await openMenu(f.host);
    assert.ok(menuItem(f.host, 'Retry auto-fix'));
  } finally {
    await f.close();
  }
});

test('a settings write that fails shows why, and the controls come back', async () => {
  fx.stored = base({ pr: pr() });
  const f = await mount({
    ...api,
    configure: async () => {
      throw new Error('disk full');
    },
  });
  try {
    await act(async () => (await autoFixItem(f.host)).click());
    assert.equal(f.host.querySelector('[role="alert"]')!.textContent, 'disk full');
    assert.equal((await autoFixItem(f.host)).disabled, false);
  } finally {
    await f.close();
  }
});

test('the newest read wins in either settlement order, and nothing lands after unmount', async () => {
  for (const reject of [false, true]) {
    const older = deferred<any>();
    const newer = deferred<any>();
    let reads = 0;
    const f = await mount({ ...api, snapshot: () => (++reads === 1 ? older.promise : newer.promise) });
    await act(async () => fx.listener('chat'));
    await act(async () => newer.resolve(base({ pr: pr({ title: 'newer' }) })));
    await act(async () => {
      if (reject) older.reject(new Error('obsolete failure'));
      else older.resolve(null);
    });
    assert.match(f.host.textContent!, /newer/);
    assert.equal(f.host.querySelector('[role="alert"]'), null);
    await f.close();
  }
  for (const reject of [false, true]) {
    const later = deferred<any>();
    const f = await mount({ ...api, snapshot: () => later.promise });
    await f.close();
    await act(async () => {
      if (reject) later.reject(new Error('retired'));
      else later.resolve(null);
    });
  }
});

test('a write that settles after unmount neither reads again nor touches state', async () => {
  for (const reject of [false, true]) {
    const later = deferred<any>();
    let reads = 0;
    let result: unknown;
    const host = document.createElement('div');
    const root = createRoot(host);
    let monitor!: ReturnType<typeof usePrMonitor>;
    // one api object: a new one each render would re-subscribe and read on every render
    const probeApi = { ...api, snapshot: async () => (reads++, base()), configure: () => later.promise };
    const Probe = () => {
      monitor = usePrMonitor('chat', probeApi);
      return null;
    };
    await act(async () => root.render(h(Probe)));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = monitor.mutate({ autoFix: true }).then((r) => (result = r));
    });
    await act(async () => root.unmount());
    const before = reads;
    if (reject) later.reject(new Error('retired'));
    else later.resolve(base());
    await pending;
    assert.equal(reads, before);
    assert.equal(result, reject ? 'retired' : '');
  }
});

test('a chat shown while the window is still starting reads its monitor only once main knows the window', async () => {
  // main refuses an unknown window, and the row would show "Unknown app window" until the monitor next changed
  resetWindowReady();
  fx.stored = base({ pr: pr() });
  let reads = 0;
  const m = await mount({ ...api, snapshot: async () => (reads++, fx.stored) });
  await settle(act);
  assert.equal(reads, 0);
  await act(async () => markWindowReady());
  await settle(act);
  assert.equal(reads, 1);
  assert.match(m.host.textContent ?? '', /Fix CI/);
  await m.close();
  fx.stored = null;
});

test('the parent picker opens from the menu and closes on cancel or PR replacement', async () => {
  fx.stored = base({ pr: pr() });
  const f = await mount();
  try {
    const show = async () => {
      await openMenu(f.host);
      await act(async () => menuItem(f.host, 'Stack on another PR…')!.click());
      assert.ok(f.host.querySelector('[role="dialog"]'));
    };
    await show();
    await act(async () => button(f.host, 'Cancel')!.click());
    assert.equal(f.host.querySelector('[role="dialog"]'), null);
    await show();
    fx.stored = base({ url: 'https://github.com/o/r/pull/13', pr: pr({ title: 'Replacement' }) });
    await act(async () => fx.listener('chat'));
    assert.equal(f.host.querySelector('[role="dialog"]'), null);
    await openMenu(f.host);
    fx.stored = base({ pr: pr({ state: 'MERGED' }) });
    await act(async () => fx.listener('chat'));
    assert.equal(menuItem(f.host, 'Stack on another PR…')!.disabled, true);
  } finally {
    await f.close();
  }
});

test('a waiting continuation can be cancelled or retried after uncertain acceptance', async () => {
  fx.stored = base({
    continuation: { when: 'merged', message: 'Continue authorized packaging' },
    uncertain: true,
    pr: pr({ state: 'MERGED' }),
  });
  calls.length = 0;
  const f = await mount();
  try {
    assert.match(note(f.host)!.textContent!, /Continuation may not have reached/);
    await openMenu(f.host);
    await act(async () => menuItem(f.host, 'Retry continuation')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { retry: true }]);
    await openMenu(f.host);
    await act(async () => menuItem(f.host, 'Cancel continuation')!.click());
    assert.deepEqual(calls.at(-1), ['chat', { continuation: null }]);
  } finally {
    await f.close();
  }
});
