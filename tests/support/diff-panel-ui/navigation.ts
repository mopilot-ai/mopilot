// Diff-panel UI unit cases for navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, calls, DIFF, git, act, scrolled, mount, sections, label, mode, menuItem, one, settle, typeInto } from './fixture.ts';

export function registerNavigation() {
  test('copy diff rebuilds a patch from the shown files', async () => {
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    await settle(act);
    const patch = calls.find((c) => c[0] === 'copy')![1] as string;
    assert.ok(patch.startsWith('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new'));
    assert.deepEqual(store.calls, [['toast', 'Copied diff']]);
  });

  test('view toggles: wrap, split, collapse all, hide files and per-file collapse', async () => {
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => label(r.host, 'Word wrap').click());
    assert.equal(one(r.host, '.cp-diffs').className, 'cp-diffs wrap');
    assert.equal(label(r.host, 'Word wrap').getAttribute('aria-pressed'), 'true');
    // the mode is a labelled segmented control: each segment says which view it gives and which is on
    assert.deepEqual(
      [...r.host.querySelectorAll('.cp-mode button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
      [
        ['Unified', 'true'],
        ['Split', 'false'],
      ],
    );
    assert.equal(one(r.host, '.cp-mode').getAttribute('aria-label'), 'Diff mode');
    await act(async () => mode(r.host, 'Split').click());
    assert.ok(r.host.querySelector('[data-split="src/a.ts"]'));
    assert.equal(mode(r.host, 'Split').getAttribute('aria-pressed'), 'true');
    assert.equal(mode(r.host, 'Split').className, 'on');
    await act(async () => mode(r.host, 'Unified').click());
    assert.ok(r.host.querySelector('[data-inline="src/a.ts"]'));
    await act(async () => one(r.host, '[aria-label$="all diffs"]').click());
    assert.equal(r.host.querySelectorAll('[data-inline]').length, 0);
    await act(async () => one(r.host, '[aria-label$="all diffs"]').click());
    assert.equal(r.host.querySelectorAll('[data-inline]').length, 3);
    const head = one(r.host, '.cp-file-head', 'new.py');
    await act(async () => head.click());
    assert.equal(r.host.querySelector('[data-inline="new.py"]'), null);
    await act(async () => head.click());
    assert.ok(r.host.querySelector('[data-inline="new.py"]'));
    // the file header folds from the keyboard too; a key on its own buttons is theirs
    assert.deepEqual(
      [head.getAttribute('role'), head.getAttribute('tabindex'), head.getAttribute('aria-expanded')],
      ['button', '0', 'true'],
    );
    assert.equal(head.getAttribute('aria-label'), head.querySelector('.cp-file-name')!.textContent);
    const press = (el: Element, key: string) =>
      act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    await press(head, 'Enter');
    assert.equal(r.host.querySelector('[data-inline="new.py"]'), null);
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    await press(head.querySelector('[aria-label="Open in default app"]')!, 'Enter');
    assert.equal(r.host.querySelector('[data-inline="new.py"]'), null);
    await press(head, ' ');
    assert.ok(r.host.querySelector('[data-inline="new.py"]'));
    assert.equal(head.querySelector('.cp-file-actions')!.getAttribute('role'), 'presentation');
    await act(async () => label(r.host, 'Hide files').click());
    assert.equal((one(r.host, '.cp-files') as HTMLElement).hidden, true);
    await act(async () => label(r.host, 'Hide files').click());
    assert.equal((one(r.host, '.cp-files') as HTMLElement).hidden, false);
  });

  test('the file filter narrows both lists case-insensitively', async () => {
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => typeInto(one(r.host, '.cp-filter input') as HTMLInputElement, 'NEW'));
    assert.deepEqual(sections(r.host), ['new.py']);
    assert.equal(r.host.querySelectorAll('.cp-file-row').length, 1);
  });

  test('jumping scrolls a file into view, from the file list, the jump menu or the requested file', async (t) => {
    const r = await mount({ scope: 'uncommitted', file: '/repo/new.py' });
    await settle(act, 60);
    assert.deepEqual(scrolled, ['new.py']);
    await act(async () => one(r.host, '.cp-file-row', 'gone.md').click());
    await act(async () => label(r.host, 'Jump to file').click());
    assert.deepEqual(
      [...r.host.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent),
      ['tssrc/a.ts', 'new.py', 'mdgone.md'],
    );
    await act(async () => menuItem(r.host, 'src/a.ts').click());
    assert.deepEqual(scrolled, ['new.py', 'gone.md', 'src/a.ts']);
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', file: 'missing.txt' } }));
    await settle(act, 60);
    assert.equal(scrolled.length, 3, 'a file not in the diff is not jumped to');
    // the jump waits 50 ms on a mocked clock, so a busy machine cannot let it fire before it is superseded
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', file: 'src/a.ts' } }));
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted' } }));
    await act(async () => t.mock.timers.tick(60));
    assert.equal(scrolled.length, 3, 'a jump superseded before it fires is cancelled');
  });
}

export function registerCollapse() {
  test('filenames matching object properties start expanded and remain independently collapsible', async () => {
    const paths = ['normal.txt', 'constructor', 'toString', '__proto__'];
    const patch = DIFF.slice(0, DIFF.indexOf('diff --git a/new.py'));
    git.diff = async () => paths.map((path) => patch.replaceAll('src/a.ts', path)).join('');
    const r = await mount({ scope: 'uncommitted' });
    const visible = () => [...r.host.querySelectorAll('[data-inline]')].map((row) => row.getAttribute('data-inline'));
    try {
      assert.deepEqual(visible(), paths);
      await act(async () => (r.host.querySelector('[data-path="normal.txt"] .cp-file-head') as HTMLElement).click());
      assert.deepEqual(visible(), paths.slice(1));
      for (const path of paths.slice(1)) {
        const head = r.host.querySelector(`[data-path="${path}"] .cp-file-head`) as HTMLElement;
        await act(async () => head.click());
        assert.ok(!visible().includes(path));
        await act(async () => head.click());
        assert.deepEqual(visible(), paths.slice(1));
      }
      await act(async () => one(r.host, '[aria-label$="all diffs"]').click());
      assert.deepEqual(visible(), paths);
      await act(async () => one(r.host, '[aria-label$="all diffs"]').click());
      assert.deepEqual(visible(), []);
      await act(async () => one(r.host, '[aria-label$="all diffs"]').click());
      assert.deepEqual(visible(), paths);
    } finally {
      await r.unmount();
    }
  });

  test('the collapse-all accessible label describes its current action', async () => {
    const r = await mount({ scope: 'uncommitted' });
    try {
      const toggle = () => one(r.host, '[aria-label$="all diffs"]');
      assert.equal(toggle().getAttribute('aria-label'), 'Collapse all diffs');
      await act(async () => toggle().click());
      assert.equal(toggle().getAttribute('aria-label'), 'Expand all diffs');
      await act(async () => toggle().click());
      assert.equal(toggle().getAttribute('aria-label'), 'Collapse all diffs');
    } finally {
      await r.unmount();
    }
  });
}
