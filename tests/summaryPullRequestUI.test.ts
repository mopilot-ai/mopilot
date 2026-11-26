// The Changes card's pull requests: the tracked PR's rows, attach the branch PR, open a merged one, create one, track by URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { one, settle, render, typeInto } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';

import { summaryPanelKit } from './support/summary-panel-kit.ts';

const kit = await summaryPanelKit();
const { store, calls, ok, impl, prUrl, monitorListeners, SummaryPanel, gitInfo, reset, mount, turn } = kit;
const { createElement, act } = await import('react');
const fail = (stderr = '') => ({ ok: false, stdout: '', stderr });
const noPullRequest = () => Promise.resolve(fail('no pull requests found for branch "main"'));
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

test('a git repo with a remote shows change totals and attaches the branch pull request', async () => {
  reset({ t1: { cwd: '/work/app' } }, { t1: { turns: [turn()] } });
  const { host, unmount } = await mount();
  assert.equal(host.querySelector('.summary-project')!.textContent, 'app');
  // the one-line name keeps the full folder on hover
  assert.equal(host.querySelector('.summary-project')!.getAttribute('title'), '/work/app');
  assert.equal(one(host, '.summary-row', 'Branch changes').querySelector('.diff-stat')!.textContent, '+5 -1');
  // the branch's open PR, not yet this chat's: Attach links it to the chat's monitor
  const attach = one(host, '.summary-row', 'Existing pull request') as HTMLButtonElement;
  assert.equal(attach.textContent, 'Existing pull requestAttach');
  assert.equal(attach.title, '#7 Fix it');
  await act(() => one(host, '.summary-row', 'Branch changes').click());
  await act(async () => attach.click());
  await settle(act);
  assert.deepEqual(calls.at(-1), ['configure', 't1', { url: prUrl }]);
  assert.deepEqual(store.calls, [
    ['openChanges', { scope: 'branch' }],
    ['toast', 'Pull request attached'],
  ]);
  // tracked: its rows and controls live in this card, as on Claude Desktop's session rail, read once for the card (#2042)
  assert.equal(monitorListeners.size, 1);
  assert.equal(
    [...host.querySelectorAll('.summary-row')].some((r) => /Attach/.test(r.textContent!)),
    false,
  );
  const link = () => one(host, '[aria-label="Pull request controls"] button', '#7') as HTMLButtonElement;
  assert.equal(link().textContent, '#7');
  assert.ok(host.querySelector('[aria-label="CI: Checking…"]'));
  kit.monitors.t1 = {
    ...kit.monitors.t1,
    pr: { title: 'Fix it', state: 'OPEN', failed: 0, pending: 0, headRefName: 'b', baseRefName: 'main' },
  };
  await act(async () => monitorListeners.forEach((fn) => fn('t1')));
  assert.equal(link().textContent, '#7Fix it');
  assert.ok(host.querySelector('svg[data-state="open"]'));
  await act(() => link().click());
  assert.deepEqual(calls.slice(-1), [['external', prUrl]]);
  assert.deepEqual(calls.slice(0, 3), [
    ['info', '/work/app'],
    ['status', '/work/app'],
    ['gh', '/work/app', 'pr', 'view', '--json', 'number,url,title,state'],
  ]);
  await unmount();
});

test('a branch PR that is merged or closed opens on GitHub, and a failed attach says why', async () => {
  reset({ t1: { cwd: '/work/app' } }, { t1: { turns: [] } });
  impl.gh = async () => ok(JSON.stringify({ number: 7, url: prUrl, title: 'Fix it', state: 'MERGED' }));
  let r = await mount();
  assert.equal(one(r.host, '.summary-row', '#7').textContent, '#7 Fix itmerged');
  await act(() => one(r.host, '.summary-row', '#7').click());
  assert.deepEqual(calls.at(-1), ['external', prUrl]);
  await r.unmount();
  reset({ t1: { cwd: '/work/app' } }, { t1: { turns: [] } });
  impl.configure = async () => {
    throw new Error('This chat is unavailable');
  };
  r = await mount();
  await act(async () => one(r.host, '.summary-row', 'Existing pull request').click());
  await settle(act);
  assert.deepEqual(store.calls, [['toast', 'This chat is unavailable', 'error']]);
  assert.ok(one(r.host, '.summary-row', 'Existing pull request'));
  await r.unmount();
});

test('without a pull request the row opens the create form, and the pull request made in the app replaces it with its rows', async () => {
  reset({ t1: { cwd: '/work/app' } }, { t1: { turns: [] } });
  impl.status = async () => ({ files: [] });
  impl.gh = noPullRequest;
  const { host, unmount } = await mount();
  assert.equal(one(host, '.summary-row', 'Branch changes').querySelector('.diff-stat'), null);
  assert.equal(one(host, '.summary-row', 'Branch changes').querySelector('.summary-hint')!.textContent, 'No changes');
  const create = one(host, '.summary-row', 'Pull request');
  assert.equal(create.querySelector('.summary-hint')!.textContent, 'Create');
  assert.equal(create.getAttribute('aria-expanded'), 'false');
  const form = () => host.querySelector('form[aria-label="Create pull request"]');
  assert.equal(form(), null);
  await act(async () => create.click());
  await settle(act);
  assert.equal(create.getAttribute('aria-expanded'), 'true');
  assert.equal(form()!.querySelector<HTMLInputElement>('[aria-label="Pull request title"]')!.value, 'Fix it');
  // the row toggles the form, and Cancel closes it; no browser, no gh from the window
  await act(async () => create.click());
  assert.equal(form(), null);
  await act(async () => create.click());
  await settle(act);
  await act(async () => one(host, 'form[aria-label="Create pull request"] button', 'Cancel').click());
  assert.equal(form(), null);
  await act(async () => create.click());
  await settle(act);
  await act(async () => one(host, 'form[aria-label="Create pull request"] button', 'Create pull request').click());
  await settle(act);
  assert.deepEqual(calls.at(-1), ['create', 't1', { title: 'Fix it', body: 'Because.', base: 'main', branch: 'feature' }]);
  assert.equal(
    calls.some((c) => c[0] === 'gh' && c.includes('create')),
    false,
  );
  assert.deepEqual(store.calls, [['toast', 'Pull request created; attached to this chat']]);
  // main bound the new pull request to this chat: its change puts the PR's rows where the form was
  await act(async () => monitorListeners.forEach((fn) => fn('t1')));
  await settle(act);
  assert.equal(form(), null);
  assert.ok(one(host, '[aria-label="Pull request controls"] button', '#7'));
  await unmount();
});

test('refresh failures preserve a pull request draft, while changing the checkout closes it', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  impl.gh = noPullRequest;
  const { host, unmount } = await mount();
  const refresh = () => act(() => window.dispatchEvent(new Event('focus')));
  const form = () => host.querySelector('form[aria-label="Create pull request"]');
  const field = (label: string) => form()?.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  const create = () => one(form()!, 'button', 'Create pull request') as HTMLButtonElement;
  await act(() => one(host, '.summary-row', 'Create').click());
  await act(() => {
    typeInto(field('Pull request title')!, 'Edited title');
    typeInto(field('Pull request description')!, 'Edited description');
  });
  const valid = { number: 7, url: prUrl, title: 'Fix it', state: 'OPEN' };
  for (const reply of [
    '{',
    'null',
    '{"number":7}',
    '{"number":7,"url":"https://github.com/o/r/pull/7"}',
    '{"number":7,"url":"https://github.com/o/r/pull/7","title":"Incomplete"}',
    JSON.stringify({ ...valid, url: '' }),
    JSON.stringify({ ...valid, url: 'https://github.com/o/r' }),
    JSON.stringify({ ...valid, url: 'https://github.com/o/r/pull/9' }),
    JSON.stringify({ ...valid, url: 'https://example.com/o/r/pull/7' }),
    JSON.stringify({ ...valid, title: ' ' }),
    JSON.stringify({ ...valid, state: 'UNKNOWN' }),
  ]) {
    impl.gh = async () => ok(reply);
    await refresh();
    assert.equal(field('Pull request title')?.value, 'Edited title');
    assert.equal(field('Pull request description')?.value, 'Edited description');
  }
  impl.gh = async () => {
    throw new Error('GitHub unavailable');
  };
  await refresh();
  assert.equal(field('Pull request title')?.value, 'Edited title');

  for (const unavailable of [async () => null, async () => Promise.reject(new Error('Git unavailable'))]) {
    impl.info = unavailable;
    await refresh();
    assert.equal(field('Pull request title')?.value, 'Edited title');
    assert.equal(create().disabled, true);
    await act(() => form()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(
      calls.some(([method]) => method === 'create'),
      false,
    );
  }

  impl.info = async () => gitInfo;
  impl.gh = noPullRequest;
  await refresh();
  assert.equal(field('Pull request title')?.value, 'Edited title');
  assert.equal(create().disabled, false);
  impl.info = async () => ({ ...gitInfo, branch: 'another' });
  await refresh();
  assert.equal(form(), null);
  impl.info = async () => gitInfo;
  await refresh();
  assert.equal(form(), null);
  await act(() => one(host, '.summary-row', 'Create').click());
  await settle(act);
  assert.equal(field('Pull request title')?.value, 'Fix it');
  await unmount();
});

test('a first pull request lookup error offers retry, and an older failed read cannot replace the answer', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  impl.gh = async () => fail('GitHub CLI is not logged in');
  const { host, unmount } = await mount();
  const retry = () => one(host, '.summary-row', 'Pull request unavailable');
  const older = deferred<ReturnType<typeof ok>>();
  impl.gh = () => older.promise;
  await act(() => retry().click());
  impl.gh = noPullRequest;
  await act(() => retry().click());
  await act(() => older.reject(new Error('The previous lookup failed')));
  assert.ok(one(host, '.summary-row', 'Create'));
  assert.equal(host.querySelector('.summary-row[aria-expanded]')?.getAttribute('aria-expanded'), 'false');
  await unmount();
});

test('two checkout transitions observed in one render batch retire the old pull request draft', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  impl.gh = noPullRequest;
  const { host, unmount } = await mount();
  const form = () => host.querySelector('form[aria-label="Create pull request"]');
  await act(() => one(host, '.summary-row', 'Create').click());
  await settle(act);
  assert.ok(form());

  const reads = () => calls.filter(([method]) => method === 'gh').length;
  const before = reads();
  await act(async () => {
    impl.info = async () => ({ ...gitInfo, branch: 'another' });
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    assert.equal(reads(), before + 1);
    impl.info = async () => gitInfo;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    assert.equal(reads(), before + 2);
  });
  assert.equal(host.querySelector('.summary-branch')?.textContent, gitInfo.branch);
  assert.equal(form(), null);
  await unmount();
});

test('"Track pull request…" takes any PR URL, shows why one fails, and closes on Cancel or Escape', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  impl.info = async () => null;
  const { host, unmount } = await mount();
  const openForm = async () => {
    await act(() => one(host, '.icon-btn').click());
    await act(() => one(host, '[role="menuitem"]', 'Track pull request…').click());
  };
  await openForm();
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Pull request URL"]')!;
  assert.equal(document.activeElement, input());
  const submit = () => one(host, '.summary-track button', 'Track') as HTMLButtonElement;
  assert.equal(submit().disabled, true);
  impl.configure = async () => {
    throw new Error('Enter a GitHub pull request URL.');
  };
  await act(async () => typeInto(input(), ' not a url '));
  await act(async () => submit().click());
  await settle(act);
  assert.deepEqual(calls.at(-1), ['configure', 't1', { url: 'not a url' }]);
  assert.equal(one(host, '.summary-track [role="alert"]').textContent, 'Enter a GitHub pull request URL.');
  // keys other than Escape leave the form open
  await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })));
  assert.ok(host.querySelector('.summary-track'));
  let bubbled = 0;
  const onKey = () => bubbled++;
  document.addEventListener('keydown', onKey);
  await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  document.removeEventListener('keydown', onKey);
  assert.equal(host.querySelector('.summary-track'), null);
  // the form's Escape stops there: nothing behind it (a running turn, the pane) hears it
  assert.equal(bubbled, 0);
  await openForm();
  await act(() => one(host, '.summary-track .link-btn', 'Cancel').click());
  assert.equal(host.querySelector('.summary-track'), null);
  // a PR from any branch: no remote is needed, and the tracked row replaces the form
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  await openForm();
  await act(async () => typeInto(input(), prUrl));
  await act(async () =>
    host.querySelector('.summary-track')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
  );
  await settle(act);
  assert.deepEqual(calls.at(-1), ['configure', 't1', { url: prUrl }]);
  assert.equal(host.querySelector('.summary-track'), null);
  assert.ok(one(host, '[aria-label="Pull request controls"] button', '#7'));
  await unmount();
});

test("a chat's late attach never closes another chat's track form", async () => {
  reset({ t1: { cwd: '/repo' }, t2: { cwd: '/repo' } }, { t1: { turns: [] }, t2: { turns: [] } });
  const pending = deferred<any>();
  impl.configure = () => pending.promise;
  const r = await render(createElement(SummaryPanel, { threadId: 't1' }));
  await settle(act);
  const openForm = async () => {
    await act(() => one(r.host, '.icon-btn').click());
    await act(() => one(r.host, '[role="menuitem"]', 'Track pull request…').click());
  };
  await openForm();
  await act(async () => typeInto(r.host.querySelector<HTMLInputElement>('input[aria-label="Pull request URL"]')!, prUrl));
  await act(async () => one(r.host, '.summary-track button', 'Track').click());
  await r.rerender(createElement(SummaryPanel, { threadId: 't2' }));
  await settle(act);
  // the form belonged to t1: t2 opens with none, then its own
  assert.equal(r.host.querySelector('.summary-track'), null);
  await openForm();
  await act(async () => pending.resolve({ chatId: 't1', url: prUrl }));
  await settle(act);
  assert.ok(r.host.querySelector('.summary-track'));
  await r.rerender(createElement(SummaryPanel, { threadId: 't1' }));
  assert.equal(r.host.querySelector('.summary-track'), null);
  await r.unmount();
});

test('with a pull request tracked, a failed attach of another says why once, under the rows (#2042)', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  kit.monitors.t1 = { chatId: 't1', url: prUrl, autoFix: false, addressComments: false, uncertain: false, limited: false };
  const { host, unmount } = await mount();
  await act(() => one(host, '.icon-btn').click());
  await act(() => one(host, '[role="menuitem"]', 'Track pull request…').click());
  impl.configure = async () => {
    throw new Error('Enter a GitHub pull request URL.');
  };
  await act(async () => typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Pull request URL"]')!, 'nope'));
  await act(async () => one(host, '.summary-track button', 'Track').click());
  await settle(act);
  const alerts = [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
  assert.deepEqual(alerts, ['Enter a GitHub pull request URL.']);
  assert.equal(host.querySelector('.summary-track [role="alert"]'), null);
  await unmount();
});

test('a branch whose origin is deleted offers the PR of the repository it is pushed to', async () => {
  reset({ t1: { cwd: '/work/app' } }, { t1: { turns: [turn()] } });
  impl.gh = async (_cwd: string, args: string[]) =>
    args[1] === 'view'
      ? fail("GraphQL: Could not resolve to a Repository with the name 'o/deleted'. (repository)")
      : ok(JSON.stringify([{ number: 7, url: prUrl, title: 'Fix it', state: 'OPEN', isCrossRepository: false }]));
  impl.run = async (_cwd: string, args: string[]) =>
    ok(
      args[0] === 'symbolic-ref'
        ? 'main\n'
        : args[0] === 'for-each-ref'
          ? 'internal\0refs/heads/main\n'
          : 'remote.origin.url https://github.com/o/deleted.git\nremote.internal.url https://github.com/o/r.git\n',
    );
  const { host, unmount } = await mount();
  assert.equal((one(host, '.summary-row', 'Existing pull request') as HTMLButtonElement).title, '#7 Fix it');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'gh').map((c) => c.slice(2, 5)),
    [
      ['pr', 'view', '--json'],
      ['pr', 'list', '--repo=github.com/o/r'],
    ],
  );
  await unmount();
});
