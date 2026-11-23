// Diff-panel UI unit cases for actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  calls,
  ok,
  fail,
  git,
  h,
  act,
  LangIcon,
  confirms,
  mount,
  label,
  menuItem,
  one,
  settle,
  render,
  typeInto,
  setConfirmAnswer,
} from './fixture.ts';

export function registerActions() {
  test('per-file actions open, copy, reveal and discard the file', async () => {
    const r = await mount({ scope: 'uncommitted' });
    const section = (p: string) => one(r.host, `.cp-file[data-path="${p}"]`);
    // with Finder chosen in Settings, a file opens in its own default app
    await act(async () => (section('src/a.ts').querySelector('[aria-label="Open in default app"]') as HTMLElement).click());
    assert.ok(r.host.querySelector('[data-inline="src/a.ts"]'), 'clicking actions does not collapse the file');
    await act(async () => (section('src/a.ts').querySelector('[aria-label="File actions"]') as HTMLElement).click());
    await act(async () => menuItem(r.host, 'Copy path').click());
    await settle(act);
    await act(async () => (section('src/a.ts').querySelector('[aria-label="File actions"]') as HTMLElement).click());
    await act(async () => menuItem(r.host, 'Reveal in Finder').click());
    assert.deepEqual(calls.slice(1), [
      ['openPath', '/repo/src/a.ts'],
      ['copy', '/repo/src/a.ts'],
      ['reveal', '/repo/src/a.ts'],
    ]);
    assert.deepEqual(store.calls, [['toast', 'Copied path']]);
    calls.length = 0;
    const discard = async (p: string) => {
      await act(async () => (section(p).querySelector('[aria-label="File actions"]') as HTMLElement).click());
      await act(async () => one(r.host, '[role="menuitem"][data-danger="true"]', 'Discard changes').click());
      await settle(act);
    };
    setConfirmAnswer(false);
    await discard('src/a.ts');
    assert.deepEqual(calls, []);
    setConfirmAnswer(true);
    await discard('src/a.ts');
    await discard('new.py');
    git.run = () => fail('error: pathspec\nhint');
    await discard('gone.md');
    assert.deepEqual(confirms[0], 'Discard all changes to src/a.ts? This cannot be undone.');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'git'),
      [
        ['git', 'rev-parse', '--show-toplevel'],
        ['git', 'ls-files', '--error-unmatch', '--', ':(literal)src/a.ts'],
        ['git', 'diff', '--cached', '--name-status', '--find-renames', '-z'],
        ['git', 'rev-parse', '--verify', 'HEAD'],
        ['git', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ':(literal)src/a.ts'],
        ['git', 'rev-parse', '--show-toplevel'],
        ['git', 'ls-files', '--error-unmatch', '--', ':(literal)new.py'],
        ['git', 'diff', '--cached', '--no-renames', '--name-only', '--diff-filter=D', '-z', '--', ':(literal)new.py'],
        ['git', 'clean', '-f', '--', ':(literal)new.py'],
        ['git', 'rev-parse', '--show-toplevel'],
      ],
    );
    assert.equal(calls.filter((c) => c[0] === 'diff').length, 3, 'each discard reloads');
    assert.deepEqual(store.calls.at(-1), ['toast', 'error: pathspec', 'error']);
  });

  test('discard all asks first, then resets tracked and untracked files', async () => {
    const r = await mount({ scope: 'uncommitted' });
    setConfirmAnswer(false);
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Discard all changes').click());
    assert.equal(calls.filter((c) => c[0] === 'git').length, 0);
    setConfirmAnswer(true);
    git.run = (args) => ok(args[1] === '--show-toplevel' ? '/repo\n' : 'tracked.txt\0');
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Discard all changes').click());
    await settle(act);
    assert.deepEqual(
      calls.filter((c) => c[0] === 'git'),
      [
        ['git', 'rev-parse', '--show-toplevel'],
        ['git', 'rev-parse', '--verify', 'HEAD'],
        ['git', 'ls-files', '-z', '--', '.'],
        ['git', 'restore', '--source=HEAD', '--staged', '--worktree', '--', '.'],
        ['git', 'clean', '-fd', '--', '.'],
      ],
    );
    assert.equal(calls.filter((c) => c[0] === 'diff').length, 2);
  });

  test('committing stages everything, commits with the message and reports failures', async () => {
    const r = await mount({ scope: 'uncommitted' });
    const input = () => one(r.host, '.cp-commit input') as HTMLInputElement;
    const button = () => one(r.host, '.cp-commit button') as HTMLButtonElement;
    const enter = () =>
      act(async () => {
        input().dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    assert.equal(button().disabled, true);
    await act(async () => typeInto(input(), '   '));
    await enter();
    assert.equal(calls.filter((c) => c[0] === 'git').length, 0, 'a blank message commits nothing');
    await act(async () => {
      input().dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    await act(async () => typeInto(input(), 'Fix bug'));
    git.run = (args) => (args[0] === 'add' ? fail('fatal: index.lock\nmore') : ok());
    await act(async () => button().click());
    await settle(act);
    git.run = (args) => (args[0] === 'commit' ? fail('') : ok());
    await enter();
    await settle(act);
    assert.deepEqual(store.calls, [
      ['toast', 'Another git command is using this repository. Try again when it finishes.', 'error'],
      ['toast', 'Git couldn’t commit. Its output, or a commit hook’s, is in the log.', 'error'],
    ]);
    assert.equal(input().value, 'Fix bug');
    git.run = () => ok();
    await act(async () => button().click());
    await settle(act);
    assert.deepEqual(calls.filter((c) => c[0] === 'git').slice(-2), [
      ['git', 'add', '-A', '--', '.'],
      ['git', 'commit', '-m', 'Fix bug'],
    ]);
    assert.deepEqual(store.calls.at(-1), ['toast', 'Committed changes', 'success']);
    assert.equal(input().value, '');
  });

  test('unticking files commits only the ticked ones, says how many, and keeps the ticks for the next commit', async () => {
    const r = await mount({ scope: 'uncommitted' });
    const input = () => one(r.host, '.cp-commit input') as HTMLInputElement;
    const button = () => one(r.host, '.cp-commit button') as HTMLButtonElement;
    const pick = (name: string) => one(r.host, `input[aria-label="Include ${name} in the commit"]`) as HTMLInputElement;
    // every file starts ticked
    assert.deepEqual(
      [...r.host.querySelectorAll('.cp-file-pick')].map((p) => (p as HTMLInputElement).checked),
      [true, true, true],
    );
    await act(async () => typeInto(input(), 'Some'));
    await act(async () => pick('new.py').click());
    assert.equal(button().textContent?.trim(), 'Commit 2 of 3');
    git.run = () => ok();
    await act(async () => button().click());
    await settle(act);
    // built in an index of its own (electron/platform/commitFiles.cjs has the real-git cases): the ticked files only
    assert.deepEqual(calls.filter((c) => c[0] === 'git' && ['rm', 'add', 'commit'].includes(c[1] as string)).slice(-3), [
      ['git', 'rm', '-q', '--cached', '--ignore-unmatch', '--', ':(literal)gone.md'],
      ['git', 'add', '-A', '--', ':(literal)src/a.ts'],
      ['git', 'commit', '-m', 'Some'],
    ]);
    assert.deepEqual(store.calls.at(-1), ['toast', 'Committed 2 files', 'success']);
    assert.equal(pick('new.py').checked, false, 'what was left out stays left out');
    // one file, then none: none commits nothing
    await act(async () => typeInto(input(), 'One'));
    await act(async () => pick('gone.md').click());
    assert.equal(button().textContent?.trim(), 'Commit 1 of 3');
    await act(async () => button().click());
    await settle(act);
    assert.deepEqual(store.calls.at(-1), ['toast', 'Committed 1 file', 'success']);
    await act(async () => typeInto(input(), 'None'));
    await act(async () => pick('src/a.ts').click());
    assert.equal(button().disabled, true);
    // ticked again, all of them: a plain commit of every change
    for (const name of ['src/a.ts', 'new.py', 'gone.md']) await act(async () => pick(name).click());
    assert.equal(button().textContent?.trim(), 'Commit');
  });

  test('the branch view has no ticks: only uncommitted changes can be committed', async () => {
    const r = await mount({ scope: 'branch' });
    assert.equal(r.host.querySelectorAll('.cp-file-pick').length, 0);
  });

  test('language badges: python logo, known languages colored, others plain', async () => {
    const r = await render(h('div', null, h(LangIcon, { path: 'a.py' }), h(LangIcon, { path: 'b.ts' }), h(LangIcon, { path: 'c.bin' })));
    const [py, ts, other] = [...r.host.firstElementChild!.children] as HTMLElement[];
    assert.equal(py.className, 'lang-icon logo');
    assert.ok(py.querySelector('svg'));
    assert.equal(ts.textContent, 'ts');
    assert.equal(ts.style.background, '#3178c6');
    assert.equal(other.getAttribute('class'), 'lucide lucide-file-text lang-icon plain');
  });
}
