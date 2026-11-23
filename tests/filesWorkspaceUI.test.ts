// The Files pane as a workspace (src/components/panels/FilesPanel.tsx and files/): files open as tabs beside the tree,
// the tree hides, moves and reveals a file, and `?` searches contents (setup: tests/support/files-ui-kit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { one, byText, settle, typeInto } from './support/shell-panels-kit.ts';
import {
  fx,
  act,
  asked,
  calls,
  click,
  filesWorkspace,
  filterQuery,
  getState,
  groupMatches,
  hasDraft,
  indentUnit,
  lineOffset,
  openFile,
  openWorkspaceFile,
  panel,
  scrolled,
  setState,
  tabs,
  type,
  FILES_SIDE_BY_SIDE_PX,
} from './support/files-ui-kit.ts';

test('the filter reads a ? at its start as a content search, and matches group by file', () => {
  assert.equal(filterQuery('  '), null);
  assert.equal(filterQuery('?  '), null);
  assert.deepEqual(filterQuery(' main '), { kind: 'names', query: 'main' });
  assert.deepEqual(filterQuery('? find me'), { kind: 'text', query: 'find me' });
  const m = (path: string, line: number) => ({ path, line, column: 0, text: '' });
  assert.deepEqual(
    groupMatches([m('a', 1), m('b', 2), m('a', 3)]).map((g) => [g.path, g.lines.map((l) => l.line)]),
    [
      ['a', [1, 3]],
      ['b', [2]],
    ],
  );
});

test('an editor goes to a line by its offset, and indents as the file does', () => {
  assert.equal(lineOffset('one\ntwo\nthree', 1), 0);
  assert.equal(lineOffset('one\ntwo\nthree', 3), 8);
  assert.equal(lineOffset('one', 5), 3, 'a line past the end is the end');
  assert.equal(indentUnit('a\n\tb'), '\t');
  assert.equal(indentUnit('a\n  b'), '  ');
});

test('files open as tabs beside the tree; a tab click brings its file forward and the close button closes it', async () => {
  const r = await panel();
  await openFile(r, 'a.ts');
  await openFile(r, 'b.ts');
  assert.deepEqual(tabs(r.host), ['a.ts', 'b.ts*']);
  assert.ok(r.host.querySelector('.files-tree'), 'the tree stays beside the file');
  assert.equal(one(r.host, '.file-node.active').textContent, 'b.ts');
  await click(one(r.host, '.files-tab-name', 'a.ts'));
  await settle(act);
  assert.deepEqual(tabs(r.host), ['a.ts*', 'b.ts']);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'one\ntwo\nthree');
  await click(one(r.host, '[aria-label="Close a.ts"]'));
  await settle(act);
  assert.deepEqual(tabs(r.host), ['b.ts*']);
  // a middle click on a tab closes it too
  await act(
    async () =>
      void one(r.host, '.files-tab-name', 'b.ts').dispatchEvent(new (window as any).MouseEvent('auxclick', { bubbles: true, button: 1 })),
  );
  await act(
    async () => void one(r.host, '.files-tree').dispatchEvent(new (window as any).MouseEvent('auxclick', { bubbles: true, button: 2 })),
  );
  assert.deepEqual(tabs(r.host), []);
  assert.equal(r.host.querySelector('.files-main'), null, 'nothing open: the tree has the pane');
  await r.unmount();
});

test('a tab with unsaved edits closes only once the user agrees to lose them', async () => {
  const r = await panel();
  await openFile(r, 'a.ts');
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'edited');
  assert.equal(one(r.host, '.files-tab').querySelector('[aria-label="Unsaved changes"]') !== null, true);
  fx.confirmAnswer = false;
  await click(one(r.host, '[aria-label="Close a.ts"]'));
  assert.deepEqual(tabs(r.host), ['a.ts*']);
  assert.match(asked[0], /Discard unsaved changes/);
  fx.confirmAnswer = true;
  await click(one(r.host, '[aria-label="Close a.ts"]'));
  assert.deepEqual(tabs(r.host), []);
  assert.equal(hasDraft('/repo/a.ts'), false);
  await r.unmount();
});

test('the tree hides and shows again, and moves to the other side', async () => {
  const r = await panel();
  await openFile(r, 'a.ts');
  await click(one(r.host, '[aria-label="Hide file tree"]'));
  assert.equal(r.host.querySelector('.files-tree'), null);
  assert.ok(r.host.querySelector('.file-editor'));
  await click(one(r.host, '[aria-label="Show file tree"]'));
  assert.ok(r.host.querySelector('.files-tree'));
  assert.ok(r.host.querySelector('.files-workspace.tree-left'));
  await click(one(r.host, '[aria-label="Move file tree to the right"]'));
  assert.equal(getState().prefs.filesTreeSide, 'right');
  assert.ok(r.host.querySelector('.files-workspace.tree-right'));
  await click(one(r.host, '[aria-label="Move file tree to the left"]'));
  assert.equal(getState().prefs.filesTreeSide, 'left');
  // with nothing open and the tree hidden, the pane says how to pick a file
  await click(one(r.host, '[aria-label="Close a.ts"]'));
  openWorkspaceFile('/repo', '/repo/b.ts');
  await settle(act);
  await click(one(r.host, '[aria-label="Hide file tree"]'));
  await click(one(r.host, '[aria-label="Close b.ts"]'));
  await settle(act);
  assert.ok(r.host.querySelector('.files-tree'), 'closing the last file shows the tree again');
  await r.unmount();
});

test('in a narrow pane the tree and the file take turns', async () => {
  fx.paneWidth = FILES_SIDE_BY_SIDE_PX - 1;
  const r = await panel();
  await openFile(r, 'a.ts');
  assert.equal(r.host.querySelector('.files-tree'), null, 'the file takes the tree’s place');
  assert.equal(r.host.querySelector('[aria-label^="Move file tree"]'), null, 'no room to move the tree');
  await click(one(r.host, '[aria-label="Show file tree"]'));
  assert.ok(r.host.querySelector('.files-tree'));
  assert.equal(r.host.querySelector('.file-editor'), null);
  await r.unmount();
  setState({ ...getState() });
});

test('the empty state shows when the tree is hidden with nothing open', async () => {
  const { setWorkspaceTree } = await import('../src/lib/filesWorkspace.ts');
  setWorkspaceTree('/repo', false);
  const r = await panel();
  assert.equal(one(r.host, '.files-empty').textContent, 'Show the file tree to pick a file.');
  await r.unmount();
});

test('Reveal in file tree opens the folders to the file, scrolls to it and clears the filter', async () => {
  openWorkspaceFile('/repo', '/repo/src/deep.ts');
  const r = await panel();
  await act(async () => typeInto(one(r.host, '.files-filter input') as HTMLInputElement, 'zzz'));
  await click(one(r.host, '.file-preview-head [aria-label="File actions"]'));
  await click(one(r.host, '[role="menuitem"]', 'Reveal in file tree'));
  await settle(act);
  await settle(act);
  assert.equal((one(r.host, '.files-filter input') as HTMLInputElement).value, '');
  assert.ok(byText(r.host, '.files-tree .file-node', 'deep.ts').length);
  assert.ok(scrolled.includes('deep.ts'));
  await r.unmount();
});

test('? searches the files’ contents and a matching line opens its file there', async () => {
  fx.textSearch = async () => ({
    matches: [
      { path: 'a.ts', line: 2, column: 0, text: '  two  ' },
      { path: 'a.ts', line: 3, column: 0, text: 'three' },
      { path: 'b.ts', line: 1, column: 0, text: 'bee' },
    ],
    truncated: true,
  });
  const r = await panel();
  await act(async () => typeInto(one(r.host, '.files-filter input') as HTMLInputElement, '?t'));
  assert.ok(r.host.querySelector('.files-tree .file-node.muted svg, .files-tree .file-node.muted'), 'pending while it searches');
  await settle(act, 300);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'text'),
    [['text', '/repo', 't', { limit: 200 }]],
  );
  assert.deepEqual(
    [...r.host.querySelectorAll('.files-text-file')].map((f) => f.textContent),
    ['a.ts2', 'b.ts1'],
  );
  assert.ok(byText(r.host, '.file-node.muted', 'More results were left out').length);
  await click(one(r.host, '.files-text-line', 'two'));
  await settle(act);
  assert.deepEqual(filesWorkspace('/repo').span, { line: 2 });
  assert.equal(one(r.host, '.file-preview-target').textContent, 'two');
  fx.textSearch = async () => ({ matches: [], truncated: false });
  await act(async () => typeInto(one(r.host, '.files-filter input') as HTMLInputElement, '?nothing'));
  await settle(act, 300);
  assert.equal(one(r.host, '.files-tree .file-node.muted').textContent, 'No results for “nothing”');
  fx.textSearch = async () => {
    throw new Error('rg missing');
  };
  await act(async () => typeInto(one(r.host, '.files-filter input') as HTMLInputElement, '?again'));
  await settle(act, 300);
  assert.match(one(r.host, '[role="alert"]').textContent!, /rg missing/);
  await r.unmount();
});

test('a name filter with no match says so', async () => {
  const r = await panel();
  await act(async () => typeInto(one(r.host, '.files-filter input') as HTMLInputElement, 'zz'));
  await settle(act, 150);
  assert.equal(one(r.host, '.files-tree .file-node.muted').textContent, 'No files match');
  await r.unmount();
});

test('clicking the file already in front (its tab or row) leaves its editor as it is', async () => {
  const r = await panel();
  await openFile(r, 'a.ts');
  const area = one(r.host, 'textarea');
  await click(one(r.host, '.files-tab-name', 'a.ts'));
  await click(one(r.host, '.files-tree .file-node', 'a.ts'));
  await settle(act);
  assert.equal(one(r.host, 'textarea'), area);
  await r.unmount();
});

test('closing one of two views of an edited file keeps the edit without asking', async () => {
  const r = await panel();
  await openFile(r, 'a.ts');
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'edited');
  setState({ paneTabs: [{ id: 'f', kind: 'file', path: '/repo/a.ts' }] });
  await click(one(r.host, '[aria-label="Close a.ts"]'));
  assert.deepEqual([tabs(r.host), asked, hasDraft('/repo/a.ts')], [[], [], true]);
  setState({ paneTabs: [] });
  openWorkspaceFile('/elsewhere', '/repo/a.ts');
  openWorkspaceFile('/repo', '/repo/a.ts');
  await settle(act);
  await click(one(r.host, '[aria-label="Close a.ts"]'));
  assert.deepEqual([asked, hasDraft('/repo/a.ts')], [[], true], 'another folder’s Files tab shows it');
  await r.unmount();
});

test('a reveal acts once: folders shown again later stay as the user leaves them', async () => {
  openWorkspaceFile('/repo', '/repo/src/deep.ts');
  const r = await panel();
  await click(one(r.host, '.file-preview-head [aria-label="File actions"]'));
  await click(one(r.host, '[role="menuitem"]', 'Reveal in file tree'));
  await settle(act);
  await click(one(r.host, '.files-tree .file-node.dir', 'src'));
  assert.equal(byText(r.host, '.files-tree .file-node', 'deep.ts').length, 0, 'the user folded it');
  const now = Date.now;
  Date.now = () => now() + 10_000;
  try {
    await click(one(r.host, '[aria-label="Hide file tree"]'));
    await click(one(r.host, '[aria-label="Show file tree"]'));
    await settle(act);
    assert.equal(byText(r.host, '.files-tree .file-node', 'deep.ts').length, 0, 'an old reveal does not open it again');
  } finally {
    Date.now = now;
  }
  await r.unmount();
});
