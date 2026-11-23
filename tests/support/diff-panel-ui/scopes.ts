// Diff-panel UI unit cases for scopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_SHA,
  store,
  calls,
  ok,
  fail,
  DIFF,
  git,
  act,
  mount,
  sections,
  label,
  menuItem,
  turn,
  one,
  byText,
  settle,
} from './fixture.ts';

export function registerScopes() {
  test('uncommitted changes list every file with totals, icons and per-file stats', async () => {
    const r = await mount({ scope: 'uncommitted' });
    assert.deepEqual(calls, [['diff', '/repo']]);
    assert.equal(one(r.host, '.cp-scope').textContent, 'Uncommitted+2 -2');
    assert.deepEqual(sections(r.host), ['src/a.ts', 'new.py', 'gone.md']);
    assert.deepEqual(
      [...r.host.querySelectorAll('.cp-file-row')].map((b) => b.textContent),
      ['tsa.ts+1 -1', 'new.py+1 ', 'mdgone.md -1'],
    );
    assert.equal(r.host.querySelector('[data-inline="src/a.ts"]')!.getAttribute('data-bare'), 'true');
    assert.ok(r.host.querySelector('.cp-commit'));
  });

  test('branch changes use an available merge base, with HEAD as the final fallback', async () => {
    await (await mount({ scope: 'branch' })).unmount();
    assert.deepEqual(calls, [
      ['git', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      ['git', 'merge-base', 'HEAD', 'refs/remotes/origin/main'],
      ['git', 'diff', BASE_SHA, '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'],
    ]);
    calls.length = 0;
    git.run = (args) => (args[0] === 'merge-base' ? fail('no upstream') : ok(''));
    const r = await mount({ scope: 'branch', file: 'x' });
    assert.deepEqual(calls.at(-1), [
      'git',
      'diff',
      'HEAD',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ]);
    assert.equal(one(r.host, '.empty-state').textContent, 'No changes');
    assert.equal(r.host.querySelector('.cp-commit'), null);
  });

  test('the last turn shows the chat diff and never asks git', async () => {
    const r = await mount({ turnId: 'turn1' }, 't1', { t1: { turns: [turn(DIFF)] } });
    assert.deepEqual(calls, []);
    assert.equal(one(r.host, '.cp-scope').textContent, 'Last Turn+2 -2');
    assert.equal(r.host.querySelector('.cp-commit'), null);
    await act(async () => label(r.host, 'Refresh').click());
    assert.deepEqual(calls, []);
    await act(async () => label(r.host, 'Changes options').click());
    assert.equal(byText(r.host, '[role="menuitem"]', 'Discard all').length, 0);
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => label(r.host, 'File actions').click());
    assert.deepEqual(
      [...r.host.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent),
      ['Copy path', 'Reveal in Finder', 'Attach as context'],
    );
    await act(async () => store.set({ runtime: { t1: { turns: [turn('', 'turn1')] } } }));
    assert.equal(one(r.host, '.empty-state').textContent, 'No changes in this turn');
  });

  test('a slow git load is shown as loading, and a superseded load is dropped', async () => {
    let release!: (d: string) => void;
    git.diff = () => new Promise((res) => (release = res));
    const r = await mount({ scope: 'uncommitted' });
    assert.ok(r.host.querySelector('.cp-diffs .center-pad'));
    assert.equal(r.host.querySelector('.cp-scope .diff-stat'), null);
    // nothing to copy or collapse yet
    await act(async () => one(r.host, '[aria-label$="all diffs"]').click());
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    await settle(act);
    assert.deepEqual(calls.at(-1), ['copy', '']);
    const first = release;
    git.diff = async () => '';
    await act(async () => label(r.host, 'Refresh').click());
    await settle(act);
    await act(async () => first(DIFF));
    assert.equal(one(r.host, '.empty-state').textContent, 'No changes', 'the older, slower result never lands');
  });

  test('the scope menu and options switch scopes; the chatless panel has no Last Turn', async () => {
    const r = await mount({ scope: 'uncommitted' }, 't1', { t1: { turns: [turn(DIFF)] } });
    await act(async () => one(r.host, '.cp-scope').click());
    assert.deepEqual(
      [...r.host.querySelectorAll('[role="menuitem"]')].map((m) => [m.textContent, m.getAttribute('data-checked')]),
      [
        ['Last Turn', 'false'],
        ['Uncommitted changes', 'true'],
        ['Branch changes', 'false'],
      ],
    );
    await act(async () => menuItem(r.host, 'Last Turn').click());
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Last Turn');
    await act(async () => one(r.host, '.cp-scope').click());
    await act(async () => menuItem(r.host, 'Branch changes').click());
    await settle(act);
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Branch');
    assert.equal(store.get().diffPanel.scope, 'branch', 'navigation can snapshot the scope actually selected in this chat');
    await act(async () => one(r.host, '.cp-scope').click());
    await act(async () => menuItem(r.host, 'Uncommitted changes').click());
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Show branch changes').click());
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Branch');
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Show uncommitted changes').click());
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Uncommitted');
    await act(async () => store.set({ diffPanel: { scope: 'branch' } }));
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Branch', 'a new request from the store resets the scope');
    await r.unmount();
    const solo = await mount({ scope: 'uncommitted' }, null);
    await act(async () => one(solo.host, '.cp-scope').click());
    assert.deepEqual(
      [...solo.host.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent),
      ['Uncommitted changes', 'Branch changes'],
    );
  });

  test('without a requested scope the pane opens on Branch, then on the scope the user last picked', async () => {
    const r = await mount({});
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Branch');
    await act(async () => one(r.host, '.cp-scope').click());
    await act(async () => menuItem(r.host, 'Uncommitted changes').click());
    assert.deepEqual(store.calls, [
      ['setState', { diffPanel: { scope: 'uncommitted' } }],
      ['setPrefs', { changesScope: 'uncommitted' }],
    ]);
    await r.unmount();
    const next = await mount({}, 't1', {}, store.get().prefs);
    assert.equal(one(next.host, '.cp-scope span').textContent, 'Uncommitted');
    await next.unmount();
    const solo = await mount({}, null, {}, { changesScope: 'turn' });
    assert.equal(one(solo.host, '.cp-scope span').textContent, 'Branch', 'a new chat has no last turn');
    await solo.unmount();
  });

  test('last turn only keeps the pane on the turn diff and hides the git scopes', async () => {
    const r = await mount(
      { scope: 'branch' },
      't1',
      { t1: { turns: [turn(DIFF)] } },
      { changesLastTurnOnly: true, changesScope: 'uncommitted' },
    );
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Last Turn');
    assert.equal(calls.length, 0, 'git is never read');
    await act(async () => one(r.host, '.cp-scope').click());
    assert.deepEqual(
      // the label, without the item's description line
      [...r.host.querySelectorAll('[role="menuitem"]')].map((m) =>
        (m.textContent ?? '').replace(m.querySelector('.menu-desc')?.textContent ?? '', ''),
      ),
      ['Last Turn', 'Git-based diffs are off'],
    );
    await act(async () => menuItem(r.host, 'Git-based diffs are off').click());
    await act(async () => label(r.host, 'Changes options').click());
    assert.deepEqual(
      [...r.host.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent),
      ['Copy diff', 'Show whitespace'],
    );
    await act(async () => store.set({ prefs: { changesLastTurnOnly: false } }));
    assert.equal(one(r.host, '.cp-scope span').textContent, 'Branch', 'turning git diffs back on restores the requested scope');
    await r.unmount();
  });
}
