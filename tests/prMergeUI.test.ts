// The tracked PR's Merge item: enabled only when the shared gate passes, each blocking state named, the head pinned, refusals shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { fx, api, url, store, base, pr, mount, note, openMenu, deferred, settle, rightClick, rows } from './support/pr-monitor-ui.ts';

const head = '0123456789abcdef0123456789abcdef01234567';
const ready = (extra = {}) => pr({ head, mergeable: 'MERGEABLE', mergeState: 'CLEAN', ...extra });
const item = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent!.startsWith('Merge pull request'));
async function mergeItem(host: HTMLElement) {
  if (!item(host)) await openMenu(host);
  return item(host)!;
}
const merging = (merge: (...args: any[]) => any) => ({ ...api, merge });

test('a mergeable pull request with green checks offers Merge; the click merges exactly the head the row was drawn for', async () => {
  fx.stored = base({ pr: ready() });
  store.calls.length = 0;
  const calls: any[] = [];
  const f = await mount(merging(async (...args: any[]) => (calls.push(args), { status: 'merged', method: 'SQUASH' })));
  try {
    const merge = await mergeItem(f.host);
    assert.equal(merge.disabled, false);
    assert.equal(merge.textContent, 'Merge pull request');
    // nothing merges until the user clicks
    assert.equal(calls.length, 0);
    await act(async () => merge.click());
    await settle(act);
    assert.deepEqual(calls, [['chat', url, head]]);
    assert.deepEqual(store.calls, [['toast', 'Pull request merged']]);
    assert.equal(note(f.host), null);
  } finally {
    await f.close();
  }
});

test('each state in the way disables Merge and says which it is', async () => {
  for (const [state, words] of [
    [undefined, /Checking the pull request…/],
    [ready({ pending: 2, mergeState: 'BLOCKED' }), /2 checks are still running\./],
    [ready({ failed: 1, mergeState: 'BLOCKED' }), /1 check is failing\./],
    [ready({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' }), /has merge conflicts/],
    [ready({ mergeState: 'BLOCKED' }), /Branch protection is not satisfied/],
    [ready({ mergeState: 'BEHIND' }), /behind its base/],
    [ready({ mergeState: 'DRAFT' }), /is a draft/],
    // a read from before this build, or GitHub still computing: unknown is never ready
    [pr(), /still working out/],
  ] as const) {
    fx.stored = base({ pr: state as any });
    const calls: any[] = [];
    const f = await mount(merging(async (...args: any[]) => calls.push(args)));
    try {
      const merge = await mergeItem(f.host);
      assert.equal(merge.disabled, true);
      assert.match(merge.textContent!, words);
      await act(async () => merge.click());
      assert.equal(calls.length, 0);
    } finally {
      await f.close();
    }
  }
  // a merged or closed pull request has no Merge at all
  for (const state of ['MERGED', 'CLOSED']) {
    fx.stored = base({ pr: ready({ state }) });
    const f = await mount();
    await openMenu(f.host);
    assert.equal(item(f.host), undefined);
    await f.close();
  }
  // a gate that passes without a head to pin (a malformed read) still cannot merge
  fx.stored = base({ pr: ready({ head: undefined }) });
  const f = await mount();
  assert.equal((await mergeItem(f.host)).disabled, true);
  await f.close();
});

test('a refusal from main is shown under the rows: head moved, protection, sign-in, and a thrown failure', async () => {
  fx.stored = base({ pr: ready() });
  store.calls.length = 0;
  const answers: any[] = [
    {
      status: 'refused',
      reason: 'head_moved',
      text: 'The pull request has new commits since you looked. Review them, then merge again.',
    },
    { status: 'refused', reason: 'protected', text: 'GitHub refused the merge: an approving review is required' },
    { status: 'refused', reason: 'gh_auth', text: 'GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.' },
    new Error('Another pull request action is still running for this chat.'),
    { status: 'refused', reason: 'protected', text: 'refused again' },
    { status: 'merged', method: 'MERGE' },
    { status: 'accepted', text: 'GitHub accepted the merge, but it is not merged yet.' },
  ];
  const f = await mount(
    merging(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  try {
    for (const words of [/new commits since you looked/, /approving review is required/, /gh auth login/, /still running for this chat/]) {
      await act(async () => void (await mergeItem(f.host)).click());
      await settle(act);
      assert.equal(note(f.host)!.getAttribute('role'), 'alert');
      assert.match(note(f.host)!.textContent!, words);
      assert.deepEqual(store.calls, []);
    }
    // a refusal is about an open pull request: one merged elsewhere no longer shows it
    fx.stored = base({ pr: ready({ state: 'MERGED' }) });
    await act(async () => fx.listener('chat'));
    assert.equal(note(f.host), null);
    fx.stored = base({ pr: ready() });
    await act(async () => fx.listener('chat'));
    assert.match(note(f.host)!.textContent!, /still running for this chat/);
    // opening the menu again retires it, before any new attempt
    await openMenu(f.host);
    assert.equal(note(f.host), null);
    // and so does the row's right-click menu, which offers the same Merge
    await act(async () => void (await mergeItem(f.host)).click());
    await settle(act);
    assert.equal(note(f.host)!.getAttribute('role'), 'alert');
    await rightClick(rows(f.host)[0]);
    assert.equal(note(f.host), null);
    await act(async () => void (await mergeItem(f.host)).click());
    await settle(act);
    assert.equal(note(f.host), null);
    assert.deepEqual(store.calls, [['toast', 'Pull request merged']]);
    // queued by GitHub, not merged: never the merged toast
    await act(async () => void (await mergeItem(f.host)).click());
    await settle(act);
    assert.deepEqual(store.calls.at(-1), ['toast', 'GitHub accepted the merge, but it is not merged yet.']);
    assert.equal(note(f.host), null);
  } finally {
    await f.close();
  }
});

test('while a merge is in flight the item is disabled; a refusal belongs to the pull request it was asked of', async () => {
  fx.stored = base({ pr: ready() });
  const pending = deferred<any>();
  let merges = 0;
  const f = await mount(merging(() => (merges++, pending.promise)));
  try {
    await act(async () => void (await mergeItem(f.host)).click());
    const busy = await mergeItem(f.host);
    assert.equal(busy.disabled, true);
    assert.match(busy.textContent!, /Merging…/);
    await act(async () => busy.click());
    assert.equal(merges, 1);
    // the chat is rebound to another pull request before the answer lands: its rows do not show this refusal
    fx.stored = base({ url: 'https://github.com/o/r/pull/13', pr: ready() });
    await act(async () => fx.listener('chat'));
    pending.resolve({ status: 'refused', reason: 'protected', text: 'refused for #12' });
    await settle(act);
    assert.equal(note(f.host), null);
    assert.equal((await mergeItem(f.host)).disabled, false);
  } finally {
    await f.close();
  }
});
