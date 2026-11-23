// src/components/thread/PrInbox.tsx and src/components/thread/usePrInbox.ts: a chat's PR inbox, on any harness. The status
// line's count says what its family merged and has open; its tray groups them, answers a session's question in place,
// retries a stopped auto-fix, and opens the session or the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kit,
  sent,
  failures,
  chatsOpened,
  links,
  rows,
  prs,
  statusReads,
  empty,
  monitors,
  snapshots,
  configured,
  ComposerPills,
  Inbox,
  familyOf,
  familyUrls,
  url,
  open,
  child,
  facts,
  settle,
  show,
  tray,
  text,
  button,
  reset,
  act,
  h,
  render,
  click,
} from './support/prInboxUIKit.ts';

test('the family is the chat and every chat below it, once, even through a damaged loop', () => {
  const v: any = {
    ...empty,
    children: {
      a: child({ parentId: 'b', createdAt: 1 }),
      b: child({ parentId: 'a', createdAt: 2 }),
      c: child({ parentId: 'a', createdAt: 3 }),
    },
  };
  assert.deepEqual(familyOf(v, 'a'), ['a', 'b', 'c']);
  // the monitor's link wins and marks the source bound; a branch's link is not; a chat with neither has none
  assert.deepEqual(
    familyUrls({ ...v, children: { b: child(facts(2)), c: child(facts(3)) } }, ['a', 'b', 'c', 'd'], {
      a: { url: url(1) } as any,
      b: { url: 'nope' } as any,
    }),
    [
      { chatId: 'a', url: url(1), bound: true },
      { chatId: 'b', url: url(2), bound: false },
      { chatId: 'c', url: url(3), bound: false },
    ],
  );
});

test('a family with nothing to list shows no count; any merge counts, a closed PR never does', async () => {
  reset();
  await show({});
  const v = await render(h(Inbox, { threadId: 'top' }));
  const count = () => v.host.querySelector('[aria-haspopup="dialog"]');
  await settle();
  assert.equal(count(), null);
  await show({ a: child() });
  assert.equal(count(), null);
  Object.assign(prs, { [url(1)]: open({ url: url(1), state: 'merged', mergedAt: 1 }), [url(2)]: open({ url: url(2), state: 'closed' }) });
  await show({ b: child(facts(2)) });
  assert.equal(count(), null);
  await show({ a: child(facts(1)), b: child(facts(2)) });
  assert.equal(text(count()), '1 merged PR');
  assert.equal(v.host.querySelector('.composer-pills'), null);
  await v.unmount();
  // a read-only thread has no inbox at all
  const ro = await render(h(ComposerPills, { threadId: 'top', showGoal: false }));
  assert.equal(ro.host.innerHTML, '');
  await ro.unmount();
});

test('the count says what merged and is open; the tray groups, answers in place and opens sessions and PRs', async () => {
  reset();
  Object.assign(rows, {
    top: 'idle',
    ask: 'input',
    quiet: 'approval',
    stuck: 'idle',
    ready: 'done',
    run: 'working',
    red: 'idle',
    unsure: 'idle',
  });
  const today = Date.now();
  Object.assign(prs, {
    [url(1)]: open({ url: url(1), number: 1, title: 'Search by branch' }),
    [url(2)]: open({ url: url(2), number: 2, title: 'Pair by QR' }),
    [url(3)]: open({
      url: url(3),
      number: 3,
      title: 'Archive worktrees',
      details: { checks: 'failing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
    }),
    [url(4)]: open({ url: url(4), number: 4, title: 'Land host/ux' }),
    [url(5)]: open({
      url: url(5),
      number: 5,
      title: 'Batch output',
      details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN', landing: true },
    }),
    [url(6)]: open({
      url: url(6),
      number: 6,
      title: 'Stream fix',
      details: { checks: 'pending', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' },
    }),
    [url(7)]: open({ url: url(7), number: 7, state: 'merged', title: 'Preview assets', mergedAt: today }),
    [url(9)]: new Error('rate limited'),
    [url(10)]: open({
      url: url(10),
      number: 10,
      title: 'Red checks',
      details: { checks: 'failing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
    }),
    [url(11)]: open({ url: url(11), number: 11, title: 'Unsure fix' }),
  });
  Object.assign(monitors, {
    stuck: { url: url(3), autoFix: true, limited: true, uncertain: false },
    top: { url: url(4), autoFix: false, limited: false, uncertain: false },
    unsure: { url: url(11), autoFix: true, limited: false, uncertain: true },
  });
  const children = {
    ask: child({ name: 'sidebar-search', createdAt: 1, ...facts(1) }),
    quiet: child({ name: 'pairing', createdAt: 2, ...facts(2) }),
    stuck: child({ name: 'archive', createdAt: 3 }),
    ready: child({ name: 'batching', createdAt: 4, ...facts(5) }),
    run: child({ name: 'stream', createdAt: 5, ...facts(6) }),
    grand: child({ parentId: 'ask', name: 'preview', createdAt: 6, ...facts(7) }),
    lost: child({ name: 'lost', createdAt: 7, ...facts(9) }),
    red: child({ name: 'red', createdAt: 8, ...facts(10) }),
    unsure: child({ name: 'unsure', createdAt: 9 }),
  };
  const wrapUps = {
    ask: {
      recap: 'r',
      ask: 'Keep ⌘⇧F as an alias?',
      actions: [
        { label: 'Keep alias', message: null },
        { label: 'Drop it', message: 'Drop the alias.' },
      ],
    },
  };
  await show(children, { wrapUps });
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children, { wrapUps });
  const pill = v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement;
  assert.equal(pill.getAttribute('aria-label'), 'Pull requests: 1 merged, 9 open');
  assert.equal(text(pill), '1 merged PR · 9 open PRs');
  await click(pill);
  const t = tray()!;
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  const groups = [...t.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'));
  assert.deepEqual(groups, ['Open', 'Merged']);
  const titles = (label: string, root: Element = t) =>
    [...root.querySelector(`section[aria-label="${label}"]`)!.querySelectorAll('button[title*="Open #"]')].map((b) => b.textContent);
  // checks failing with nothing fixing them only open the session; an unconfirmed auto-fix can be retried
  const actionsOf = (title: string) => [...button(t, title)!.parentElement!.querySelectorAll('button')].slice(2).map((b) => b.textContent);
  assert.deepEqual(actionsOf('Red checks'), ['Open session']);
  assert.deepEqual(actionsOf('Unsure fix'), ['Retry', 'Open session']);
  // a session's question first, then what the user may act on; the PR GitHub didn't answer for is named by its number
  assert.deepEqual(titles('Open'), [
    'Search by branch',
    'Pair by QR',
    'Archive worktrees',
    'Red checks',
    'Unsure fix',
    'Land host/ux',
    'Batch output',
    'Stream fix',
    'Pull request #9',
  ]);
  // a question reads whole and offers its session next to its answers
  assert.deepEqual(actionsOf('Search by branch'), ['Keep alias', 'Drop it', 'Open session']);
  assert.ok(t.querySelector('[title="Keep ⌘⇧F as an alias?"]'));
  assert.match(text(t)!, /Asks youKeep ⌘⇧F as an alias\?/);
  assert.match(text(t)!, /this chat/);
  assert.match(text(t)!, /StuckAuto-fix stopped after several tries/);
  // where a moving PR stands: merging past its checks, or still on them
  const steps = [...t.querySelectorAll('[aria-label="Merges once it can"] [data-at]')].map((s) => [
    s.getAttribute('data-at'),
    s.textContent,
  ]);
  assert.deepEqual(steps, [
    ['done', 'Checks'],
    ['now', 'Merges once it can'],
    ['next', 'Main'],
  ]);
  assert.equal(t.querySelector('[aria-label="Checks running"] [data-at="now"]')?.textContent, 'Checks running');

  // a question answered in place goes to its session as the user's own words, once
  await click(button(t, 'Keep alias')!);
  assert.deepEqual(sent, [['ask', 'Keep alias', { human: true }]]);
  assert.equal(button(t, 'Drop it'), undefined);
  assert.match(text(t)!, /Sent/);
  assert.deepEqual(actionsOf('Search by branch'), ['Open session']);
  // a session waiting with no answers to click opens instead
  const quietRow = t.querySelector('section[aria-label="Open"]')!.children[2];
  await click(button(quietRow, 'Open session')!);
  assert.deepEqual(chatsOpened, ['quiet']);
  assert.equal(pill.getAttribute('aria-expanded'), 'false');

  // the answer is remembered while the tray closes and opens: no second send behind a busy turn
  await click(pill);
  assert.equal(button(tray()!, 'Keep alias'), undefined);
  assert.match(text(tray())!, /Sent/);
  await click(pill);
  // the main chat at work may still hand its own ready PR to the merge robot: its row says so until the turn ends
  rows.top = 'working';
  await show(children, { wrapUps });
  await click(pill);
  assert.match(text(tray())!, /Land host\/ux#4·this chatChecksWaiting to merge/);
  assert.equal(button(tray()!, 'Review & merge'), undefined);
  await click(pill);
  // and the count never moves with it
  assert.equal(text(pill), '1 merged PR · 9 open PRs');
  rows.top = 'idle';
  await show(children, { wrapUps });

  // Escape closes the tray and gives the keyboard back to the pill
  await click(pill);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, pill);

  await click(pill);
  const t2 = tray()!;
  await click(button(t2, 'Retry')!);
  assert.deepEqual(configured, [['stuck', { retry: true }]]);
  kit.configure = async () => {
    throw new Error('gone');
  };
  await click(button(t2, 'Retry')!);
  await settle();
  assert.deepEqual(failures, ["Couldn't retry auto-fix"]);
  await click(button(t2, 'Review & merge')!);
  await click(button(t2, 'Batch output')!);
  assert.deepEqual(links, [url(4), url(5)]);
  await click(button(t2, 'sidebar-search')!);
  assert.deepEqual(chatsOpened, ['quiet', 'ask']);

  // a merged row says when, not a second "merged"
  await click(pill);
  const merged = tray()!.querySelector('section[aria-label="Merged"]')!;
  assert.deepEqual(titles('Merged', tray()!), ['Preview assets']);
  assert.match(text(merged)!, /#7·previewToday /);
  assert.equal(merged.querySelector('[data-tag="landed"] [data-tag]'), null);
  await v.unmount();
});

test('an answer that could not go waits in the session draft, and the tray says so', async () => {
  reset();
  rows.ask = 'input';
  prs[url(1)] = open({ url: url(1), number: 1 });
  kit.sendAnswer = false;
  const children = { ask: child({ name: 'api', ...facts(1) }) };
  const wrapUps = { ask: { recap: 'r', ask: 'Ship?', actions: [{ label: 'Ship', message: 'Ship it now.' }] } };
  await show(children, { wrapUps });
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children, { wrapUps });
  const pill = v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement;
  assert.equal(text(pill), '1 open PR');
  await click(pill);
  await click(button(tray()!, 'Ship')!);
  await settle();
  assert.deepEqual(sent, [['ask', 'Ship it now.', { human: false }]]);
  assert.match(text(tray())!, /Not sent · in its draft/);
  await v.unmount();
});

test('the count stays the same as a session starts and stops asking; only the row says it asks', async () => {
  reset();
  Object.assign(rows, { draft: 'idle', failed: 'done', review: 'idle' });
  Object.assign(prs, {
    [url(1)]: open({ url: url(1), number: 1, state: 'draft' }),
    [url(2)]: open({ url: url(2), number: 2, details: { checks: 'failing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' } }),
    [url(3)]: open({ url: url(3), number: 3, details: { review: true, checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' } }),
  });
  const children = { draft: child(facts(1)), failed: child(facts(2)), review: child(facts(3)) };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'top' }));
  try {
    await show(children);
    const pill = v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement;
    assert.equal(text(pill), '3 open PRs');
    await click(pill);
    for (const state of ['input', 'approval', 'done']) {
      rows.draft = state;
      await show(children);
      assert.equal(text(pill), '3 open PRs');
      assert.equal(tray()!.querySelectorAll('[data-tag="asks"][data-group="needs"]').length, state === 'done' ? 0 : 1);
    }
  } finally {
    await v.unmount();
  }
});

test('the count and tray refresh the monitor and GitHub when they change', async () => {
  reset();
  rows.run = 'working';
  prs[url(6)] = open({ url: url(6), number: 6, details: { checks: 'pending', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' } });
  const children = { run: child({ name: 'stream', ...facts(6) }) };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children);
  const pill = v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement;
  assert.equal(text(pill), '1 open PR');
  await click(pill);
  assert.ok(tray()!.querySelector('section[aria-label="Open"]'));
  assert.equal(tray()!.querySelector('section[aria-label="Merged"]'), null);

  // the monitor says a family chat changed: it is read again; another chat's change is not this family's
  const before = snapshots.length;
  await act(async () => kit.monitorChanged('run'));
  await act(async () => kit.monitorChanged('elsewhere'));
  await settle();
  assert.deepEqual(snapshots.slice(before), ['run']);
  // a later monitor read wins over an earlier one that settles after it
  const pending: ((v: any) => void)[] = [];
  kit.snapshot = (id: string) => new Promise((resolve) => (snapshots.push(id), pending.push(resolve)));
  await act(async () => kit.monitorChanged('run'));
  await act(async () => kit.monitorChanged('run'));
  await act(async () => pending[1]({ url: url(6), autoFix: false, limited: true, uncertain: false }));
  await act(async () => pending[0](null));
  await settle();
  // a stopped auto-fix offers Retry on its way, and still nothing needs the user
  assert.equal(text(pill), '1 open PR');
  // the tray, still open, shows it as it changed
  assert.match(text(tray())!, /StuckAuto-fix stopped after several tries/);
  assert.ok(button(tray()!, 'Retry'));
  // the window coming back reads GitHub again; the same answer changes nothing
  const reads = statusReads.length;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.ok(statusReads.length > reads);
  // reads that settle after the count went are dropped
  kit.snapshot = (id: string) => new Promise((resolve) => (snapshots.push(id), pending.push(resolve)));
  await act(async () => kit.monitorChanged('run'));
  await v.unmount();
  await act(async () => pending.at(-1)!(null));
});
