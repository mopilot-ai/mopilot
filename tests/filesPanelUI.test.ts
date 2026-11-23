import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { markdownStub, one, byText, settle, render, typeInto } from './support/shell-panels-kit.ts';
import { popoverStubs } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const theme = { dark: true };
const calls: unknown[][] = [];
const tree: Record<string, { fileName: string; isDirectory: boolean }[] | Error> = {};
const texts: Record<string, string | null | Error> = {};
// reads that fail with something other than an Error (an IPC rejection can carry a bare string)
const rawFailures: Record<string, unknown> = {};
const pending = new Map<string, (v: string | null) => void>();
let highlightGate: Promise<void> | null = null;
let highlightFailure: Error | null = null;
let searchOverride: ((cwd: string, query: string) => Promise<{ files: { path: string }[] }>) | null = null;
let searchResult: { files: { path: string }[] } | Error = { files: [] };
const native = {
  fs: {
    readDir: async (p: string) => {
      calls.push(['readDir', p]);
      const v = tree[p];
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    readText: (p: string) => {
      calls.push(['readText', p]);
      if (p in rawFailures) return Promise.reject(rawFailures[p]);
      if (!(p in texts)) return new Promise<string | null>((resolve) => pending.set(p, resolve));
      const v = texts[p];
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    },
  },
  search: {
    files: async (cwd: string, q: string, opts: any) => {
      calls.push(['search', cwd, q, opts]);
      if (searchOverride) return searchOverride(cwd, q);
      if (searchResult instanceof Error) throw searchResult;
      return searchResult;
    },
  },
};
const highlight = async (code: string, lang: string, dark: boolean) => {
  calls.push(['highlight', lang, dark]);
  if (highlightGate) await highlightGate;
  if (highlightFailure) throw highlightFailure;
  return code
    .split('\n')
    .map((l) => `<span class="line">${l}</span>`)
    .join('\n');
};
installNativeStub(native);
mock.module('../src/lib/highlight.ts', {
  namedExports: { highlight, langFromPath: (p: string) => (p.endsWith('.ts') ? 'typescript' : 'text') },
});
mock.module('../src/session/open.ts', {
  namedExports: { openPath: (p: string) => calls.push(['openPath', p]), revealPath: (p: string) => calls.push(['revealPath', p]) },
});
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (t: string) => calls.push(['copyText', t]) } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs() });
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub(theme) });
const { createElement, act } = await import('react');
mock.module('../src/components/panels/DiffPanel.tsx', {
  namedExports: { LangIcon: ({ path }: { path: string }) => createElement('i', { 'data-icon': path }) },
});
const { FilesPanel, FilePreview } = await import('../src/components/panels/FilesPanel.tsx');
const { resetFilesWorkspaces } = await import('../src/lib/filesWorkspace.ts');

const scrolled: string[] = [];
(window as any).HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  scrolled.push(this.textContent ?? '');
};

beforeEach(() => {
  resetFilesWorkspaces();
  calls.length = 0;
  scrolled.length = 0;
  pending.clear();
  highlightGate = null;
  highlightFailure = null;
  searchOverride = null;
  for (const k of Object.keys(tree)) delete tree[k];
  for (const k of Object.keys(texts)) delete texts[k];
});
const names = (host: HTMLElement) => [...host.querySelectorAll('.file-node-name')].map((n) => n.textContent);

test('the tree lists the folder with hidden entries skipped, folders first, and expands lazily', async () => {
  tree['/repo'] = [
    { fileName: 'b.ts', isDirectory: false },
    { fileName: 'node_modules', isDirectory: true },
    { fileName: 'src', isDirectory: true },
    { fileName: 'a.md', isDirectory: false },
    { fileName: 'docs', isDirectory: true },
    { fileName: '.git', isDirectory: true },
  ];
  tree['/repo/src'] = [{ fileName: 'main.ts', isDirectory: false }];
  tree['/repo/docs'] = new Error('EACCES');
  const r = await render(createElement(FilesPanel, { cwd: '/repo' }));
  await settle(act);
  assert.deepEqual(names(r.host), ['docs', 'src', 'a.md', 'b.ts']);
  assert.ok(r.host.querySelector('.file-node.dir svg'));
  const src = one(r.host, '.file-node.dir', 'src');
  await act(async () => src.click());
  await settle(act);
  assert.deepEqual(names(r.host), ['docs', 'src', 'main.ts', 'a.md', 'b.ts']);
  assert.equal((one(r.host, '.file-node', 'main.ts') as HTMLElement).style.paddingLeft, '35px');
  await act(async () => one(r.host, '.file-node.dir', 'docs').click());
  await settle(act);
  assert.deepEqual(names(r.host), ['docs', 'src', 'main.ts', 'a.md', 'b.ts'], 'an unreadable folder keeps other entries visible');
  await act(async () => src.click());
  assert.deepEqual(names(r.host), ['docs', 'src', 'a.md', 'b.ts']);
  await act(async () => src.click());
  assert.equal(calls.filter((c) => c[1] === '/repo/src').length, 1, 'a folder is read once');
  texts['/repo/src/main.ts'] = 'const a = 1;';
  await act(async () => one(r.host, '.file-node', 'main.ts').click());
  await settle(act);
  assert.equal(one(r.host, '.file-preview-head .file-node-name').textContent, 'src/main.ts');
  assert.ok(r.host.querySelector('.files-tree'), 'the file opens beside the tree (tests/filesWorkspaceUI.test.ts)');
});

test('a folder shows a spinner until its entries arrive', async () => {
  let release!: (v: any) => void;
  native.fs.readDir = (
    (orig) => async (p: string) =>
      p === '/slow' ? new Promise((res) => (release = res)) : orig(p)
  )(native.fs.readDir);
  const r = await render(createElement(FilesPanel, { cwd: '/slow' }));
  assert.ok(r.host.querySelector('.file-node.muted'));
  await act(async () => release([{ fileName: 'x.ts', isDirectory: false }]));
  assert.equal(r.host.querySelector('.file-node.muted'), null);
  assert.deepEqual(names(r.host), ['x.ts']);
});

test('filtering searches the project after a pause and lists matches; failures list nothing', async () => {
  searchResult = { files: [{ path: 'src/a.ts' }, { path: 'lib/b.ts' }] };
  const r = await render(createElement(FilesPanel, { cwd: '/repo' }));
  const input = r.host.querySelector('.files-filter input') as HTMLInputElement;
  await act(async () => typeInto(input, 'a'));
  await act(async () => typeInto(input, 'ab'));
  await settle(act, 150);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'search'),
    [['search', '/repo', 'ab', { limit: 60, dirs: false }]],
  );
  assert.deepEqual(names(r.host), ['src/a.ts', 'lib/b.ts']);
  texts['/repo/lib/b.ts'] = 'b';
  await act(async () => one(r.host, '.file-node', 'lib/b.ts').click());
  await settle(act);
  assert.ok(r.host.querySelector('.file-preview'));
  searchResult = new Error('rg missing');
  await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, 'zz'));
  await settle(act, 150);
  assert.equal(r.host.querySelectorAll('.file-node').length, 0);
  await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, ' '));
  await settle(act);
  assert.equal(byText(r.host, '.file-node', 'lib/b.ts').length, 0, 'clearing the filter goes back to the tree');
  assert.deepEqual(calls.at(-1), ['readDir', '/repo']);
});

test('a preview highlights the file, marks the requested line and opens the file', async () => {
  texts['/repo/a.ts'] = 'one\ntwo\nthree';
  const r = await render(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/repo', line: 2 }));
  await settle(act);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'highlight'),
    [['highlight', 'typescript', true]],
  );
  assert.equal(one(r.host, '.file-preview-target').textContent, 'two');
  assert.deepEqual(scrolled, ['two']);
  assert.equal(r.host.querySelector('[aria-label="Back to files"]'), null);
  await r.rerender(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/repo', line: 9 }));
  assert.equal(r.host.querySelector('.file-preview-target'), null, 'a line past the end marks nothing');
  const view = one(r.host, '.file-preview');
  view.scrollTop = 50;
  await r.rerender(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/repo', line: 0 }));
  assert.equal(view.scrollTop, 0);
  await r.rerender(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/repo' }));
  await act(async () => one(r.host, '[aria-label="Open file"]').click());
  assert.deepEqual(calls.at(-1), ['openPath', '/repo/a.ts']);
  theme.dark = false;
  await r.rerender(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/elsewhere' }));
  await settle(act);
  theme.dark = true;
  assert.deepEqual(calls.filter((c) => c[0] === 'highlight').at(-1), ['highlight', 'typescript', false]);
  assert.equal(
    one(r.host, '.file-preview-head .file-node-name').textContent,
    '/repo/a.ts',
    'a file outside the folder shows its full path',
  );
});

test('missing, binary and oversized files say they cannot be previewed; an unreadable one says why', async () => {
  texts['/n'] = null;
  texts['/bin'] = 'a\0b';
  texts['/big'] = 'x'.repeat(400_001);
  texts['/err'] = new Error('EIO');
  rawFailures['/raw'] = 'EACCES: permission denied';
  const r = await render(createElement(FilePreview, { path: '/n', cwd: '/' }));
  const messages: string[] = [];
  for (const path of ['/n', '/bin', '/big', '/err', '/raw']) {
    await r.rerender(createElement(FilePreview, { path, cwd: '/' }));
    await settle(act);
    messages.push(one(r.host, '[role="alert"]').textContent!);
  }
  assert.deepEqual(messages, [
    'This file can’t be previewed',
    'This file can’t be previewed',
    'File is too large to preview',
    'EIO',
    'EACCES: permission denied',
  ]);
});

test('results for a file the preview has moved past are dropped', async () => {
  const r = await render(createElement(FilePreview, { path: '/slow-read', cwd: '/' }));
  assert.ok(r.host.querySelector('.center-pad'));
  await r.rerender(createElement(FilePreview, { path: '/second', cwd: '/' }));
  await act(async () => pending.get('/slow-read')!('late'));
  let gate!: () => void;
  highlightGate = new Promise((res) => (gate = res));
  texts['/slow-highlight'] = 'h';
  texts['/final'] = 'final';
  await r.rerender(createElement(FilePreview, { path: '/slow-highlight', cwd: '/' }));
  await settle(act);
  highlightGate = null;
  await r.rerender(createElement(FilePreview, { path: '/final', cwd: '/' }));
  await settle(act);
  await act(async () => gate());
  assert.equal(one(r.host, '.file-editor-code').textContent, 'final');
  assert.equal(calls.filter((c) => c[0] === 'highlight').length, 2, 'the stale read was never highlighted');
});

test('a read that fails after the preview moved on is ignored', async () => {
  let fail!: (e: Error) => void;
  const orig = native.fs.readText;
  native.fs.readText = (p: string) => (p === '/doomed' ? new Promise((_, rej) => (fail = rej)) : orig(p));
  texts['/ok'] = 'fine';
  const r = await render(createElement(FilePreview, { path: '/doomed', cwd: '/' }));
  await r.rerender(createElement(FilePreview, { path: '/ok', cwd: '/' }));
  await settle(act);
  await act(async () => fail(new Error('late')));
  native.fs.readText = orig;
  assert.equal(r.host.querySelector('.empty-state'), null);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'fine');
});

test('preview path labels respect directory boundaries, roots and Windows separators', async () => {
  for (const [path, cwd, label] of [
    ['/repository/a.ts', '/repo', '/repository/a.ts'],
    ['/repo/a.ts', '/repo/', 'a.ts'],
    ['/repo/a.ts', '/', 'repo/a.ts'],
    ['C:\\Repo\\src\\a.ts', 'c:/repo/', 'src\\a.ts'],
    ['C:\\Repository\\a.ts', 'C:\\Repo', 'C:\\Repository\\a.ts'],
  ]) {
    texts[path] = 'content';
    const r = await render(createElement(FilePreview, { path, cwd }));
    await settle(act);
    assert.equal(one(r.host, '.file-preview-head .file-node-name').textContent, label);
    await act(async () => one(r.host, '[aria-label="Open file"]').click());
    assert.deepEqual(calls.at(-1), ['openPath', path]);
  }
});

test('highlight failure preserves escaped source text and citation navigation', async () => {
  const source = '<script>unsafe()</script>\nsecond line\n';
  texts['/repo/readable.ts'] = source;
  highlightFailure = new Error('temporary syntax failure');
  const r = await render(createElement(FilePreview, { path: '/repo/readable.ts', cwd: '/repo', line: 2 }));
  await settle(act);
  assert.ok(!r.host.querySelector('[role="alert"]'));
  assert.equal(one(r.host, '.file-editor-code').textContent, source);
  assert.equal(r.host.querySelector('script'), null);
  assert.equal(one(r.host, '.file-preview-target').textContent, 'second line');
  assert.deepEqual(scrolled, ['second line']);
  await r.rerender(createElement(FilePreview, { path: '/repo/readable.ts', cwd: '/repo', line: 99 }));
  assert.equal(r.host.querySelector('.file-preview-target'), null);
  highlightFailure = null;
  theme.dark = false;
  await r.rerender(createElement(FilePreview, { path: '/repo/readable.ts', cwd: '/repo' }));
  await settle(act);
  theme.dark = true;
  assert.equal(r.host.querySelector('.shiki-fallback'), null);
  assert.ok(one(r.host, '.file-editor-code').textContent!.includes('second line'));
});

test('a late highlighting failure cannot replace the current file preview', async () => {
  texts['/repo/first.ts'] = 'first source';
  texts['/repo/next.ts'] = 'next source';
  let reject!: (error: Error) => void;
  highlightGate = new Promise((_, fail) => {
    reject = fail;
  });
  const r = await render(createElement(FilePreview, { path: '/repo/first.ts', cwd: '/repo' }));
  await settle(act);
  highlightGate = null;
  await r.rerender(createElement(FilePreview, { path: '/repo/next.ts', cwd: '/repo' }));
  await settle(act);
  await act(async () => reject(new Error('stale syntax failure')));
  assert.equal(one(r.host, '.file-editor-code').textContent, 'next source');
  assert.ok(!r.host.querySelector('.shiki-fallback'));
  assert.ok(!r.host.querySelector('[role="alert"]'));
});

for (const change of ['query', 'clear', 'folder'])
  for (const failure of [false, true]) {
    test(`file search ignores a late ${failure ? 'failure' : 'result'} after a ${change} change`, async () => {
      const requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
      searchOverride = (cwd, query) => new Promise((resolve, reject) => requests.set(`${cwd}:${query}`, { resolve, reject }));
      tree['/repo'] = [{ fileName: 'tree.ts', isDirectory: false }];
      const r = await render(createElement(FilesPanel, { cwd: '/repo' }));
      await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, 'old'));
      await settle(act, 150);
      const old = requests.get('/repo:old')!;
      if (change === 'clear') {
        await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, ''));
        await settle(act);
      } else {
        if (change === 'folder') await r.rerender(createElement(FilesPanel, { cwd: '/next' }));
        else await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, 'new'));
        await settle(act, 150);
        const latest = requests.get(change === 'folder' ? '/next:old' : '/repo:new')!;
        await act(async () => latest.resolve({ files: [{ path: 'latest.ts' }] }));
      }
      const expected = change === 'clear' ? ['tree.ts'] : ['latest.ts'];
      assert.deepEqual(names(r.host), expected);
      await act(async () => (failure ? old.reject(new Error('stale search failure')) : old.resolve({ files: [{ path: 'stale.ts' }] })));
      assert.deepEqual(names(r.host), expected);
      assert.ok(!r.host.querySelector('[role="alert"]'));
      await r.unmount();
    });
  }

for (const oldState of ['cached', 'pending result', 'pending failure']) {
  test(`changing the tree folder replaces its ${oldState} with the new directory`, async (t) => {
    tree['/old-tree'] = [{ fileName: 'old.ts', isDirectory: false }];
    tree['/new-tree'] = [{ fileName: 'fresh.ts', isDirectory: false }];
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    if (oldState !== 'cached') {
      const original = native.fs.readDir;
      native.fs.readDir = (path) =>
        path === '/old-tree'
          ? new Promise((done, fail) => {
              resolve = done;
              reject = fail;
            })
          : original(path);
      t.after(() => {
        native.fs.readDir = original;
      });
    }
    const r = await render(createElement(FilesPanel, { cwd: '/old-tree' }));
    await settle(act);
    await r.rerender(createElement(FilesPanel, { cwd: '/new-tree' }));
    await settle(act);
    assert.deepEqual(names(r.host), ['fresh.ts']);
    if (oldState === 'pending result') await act(async () => resolve([{ fileName: 'late.ts', isDirectory: false }]));
    if (oldState === 'pending failure') await act(async () => reject(new Error('old directory missing')));
    assert.deepEqual(names(r.host), ['fresh.ts']);
    assert.equal(calls.filter((call) => call[0] === 'readDir' && call[1] === '/new-tree').length, 1);
    texts['/new-tree/fresh.ts'] = 'fresh source';
    await act(async () => one(r.host, '.file-node', 'fresh.ts').click());
    await settle(act);
    assert.equal(one(r.host, '.file-editor-code').textContent, 'fresh source');
    assert.ok(calls.some((call) => call[0] === 'readText' && call[1] === '/new-tree/fresh.ts'));
  });
}

for (const nested of [false, true])
  for (const failure of [new Error('EACCES'), 'read failed', null, '']) {
    test(`a ${nested ? 'nested' : 'root'} folder read failure ${String(failure)} can be retried`, async (t) => {
      const path = nested ? '/retry/src' : '/retry';
      tree['/retry'] = nested ? [{ fileName: 'src', isDirectory: true }] : [];
      tree[path] = [{ fileName: 'recovered.ts', isDirectory: false }];
      let failing = true;
      const original = native.fs.readDir;
      native.fs.readDir = async (p) => {
        if (p === path && failing) {
          calls.push(['readDir', p]);
          throw failure;
        }
        return original(p);
      };
      t.after(() => {
        native.fs.readDir = original;
      });
      const r = await render(createElement(FilesPanel, { cwd: '/retry' }));
      if (nested) await act(async () => one(r.host, '.file-node.dir', 'src').click());
      await settle(act);
      const retry = r.host.querySelector(`[aria-label="Retry reading ${path}"]`) as HTMLButtonElement | null;
      assert.ok(retry);
      assert.match(retry.textContent ?? '', /Could not read folder/);
      assert.ok(!r.host.querySelector('.file-node.muted:not(button)'));
      failing = false;
      await act(async () => retry.click());
      await settle(act);
      assert.ok(names(r.host).includes('recovered.ts'));
      assert.ok(!r.host.querySelector(`[aria-label="Retry reading ${path}"]`));
      assert.equal(calls.filter((call) => call[0] === 'readDir' && call[1] === path).length, 2);
      await r.unmount();
    });
  }

for (const failure of [new Error('search unavailable'), 'search unavailable', null, '']) {
  test(`file search reports ${String(failure)} and retries the same query`, async () => {
    let failing = true;
    searchOverride = async () => {
      if (failing) throw failure;
      return { files: [{ path: 'recovered.ts' }] };
    };
    const r = await render(createElement(FilesPanel, { cwd: '/repo' }));
    await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, 'same query'));
    await settle(act, 150);
    const alert = r.host.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent ?? '', /Could not search files/);
    const retry = one(r.host, '[aria-label="Retry file search"]');
    failing = false;
    await act(async () => retry.click());
    assert.ok(!r.host.querySelector('[role="alert"]'));
    await settle(act, 150);
    assert.deepEqual(names(r.host), ['recovered.ts']);
    assert.equal((r.host.querySelector('.files-filter input') as HTMLInputElement).value, 'same query');
    assert.deepEqual(
      calls.filter((call) => call[0] === 'search').map((call) => call.slice(1, 3)),
      [
        ['/repo', 'same query'],
        ['/repo', 'same query'],
      ],
    );
    texts['/repo/recovered.ts'] = 'recovered source';
    await act(async () => one(r.host, '.file-node', 'recovered.ts').click());
    await settle(act);
    assert.equal(one(r.host, '.file-editor-code').textContent, 'recovered source');
    await r.unmount();
  });
}

test('clearing a failed file search removes its error and restores the tree', async () => {
  searchResult = new Error('search unavailable');
  tree['/repo'] = [{ fileName: 'tree.ts', isDirectory: false }];
  const r = await render(createElement(FilesPanel, { cwd: '/repo' }));
  await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, 'broken'));
  await settle(act, 150);
  assert.ok(r.host.querySelector('[role="alert"]'));
  await act(async () => typeInto(r.host.querySelector('.files-filter input') as HTMLInputElement, ''));
  await settle(act);
  assert.ok(!r.host.querySelector('[role="alert"]'));
  assert.deepEqual(names(r.host), ['tree.ts']);
});

test('switching folders closes the old file preview and shows the new tree', async () => {
  tree['/old'] = [{ fileName: 'old.ts', isDirectory: false }];
  tree['/new'] = [{ fileName: 'new.ts', isDirectory: false }];
  texts['/old/old.ts'] = 'old source';
  const r = await render(createElement(FilesPanel, { cwd: '/old' }));
  await settle(act);
  await act(async () => one(r.host, '.file-node', 'old.ts').click());
  await settle(act);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'old source');
  await r.rerender(createElement(FilesPanel, { cwd: '/new' }));
  await settle(act);
  assert.ok(!r.host.querySelector('.file-preview'), 'the previous preview closes');
  assert.deepEqual(names(r.host), ['new.ts']);
});

test('a blank file-read rejection shows a failure instead of an endless loading state', async () => {
  for (const error of [new Error(''), '', null, undefined]) {
    const path = '/repo/blank-error.ts';
    rawFailures[path] = error;
    const r = await render(createElement(FilePreview, { path, cwd: '/repo' }));
    try {
      await settle(act);
      const alert = r.host.querySelector('[role="alert"]');
      assert.ok(alert, 'the completed failed read must show an error');
      assert.equal(alert.textContent, 'Could not read file');
      assert.ok(!r.host.querySelector('.center-pad'), 'a rejected read must stop loading');
    } finally {
      await r.unmount();
      delete rawFailures[path];
    }
  }
});

test('another folder starts at its own tree, and coming back shows the files it had open', async () => {
  tree['/a'] = [{ fileName: 'x.ts', isDirectory: false }];
  tree['/b'] = [{ fileName: 'y.ts', isDirectory: false }];
  texts['/a/x.ts'] = 'const x = 1;';
  const r = await render(createElement(FilesPanel, { cwd: '/a' }));
  await settle(act);
  await act(async () => one(r.host, '.file-node', 'x.ts').click());
  await settle(act);
  assert.equal(one(r.host, '.file-preview-head .file-node-name').textContent, 'x.ts');
  await r.rerender(createElement(FilesPanel, { cwd: '/b' }));
  await settle(act);
  assert.equal(r.host.querySelector('.file-preview-head'), null);
  assert.deepEqual(names(r.host), ['y.ts']);
  await r.rerender(createElement(FilesPanel, { cwd: '/a' }));
  await settle(act);
  // each folder keeps its own open files: coming back shows the file again, read afresh
  assert.equal(one(r.host, '.files-tab.active').textContent, 'x.ts');
  assert.equal(calls.filter((c) => c[0] === 'readText').length, 2);
  await r.unmount();
});

test("another folder never shows the last folder's search results, and searches again for the same filter", async () => {
  tree['/a'] = [];
  tree['/b'] = [];
  searchResult = { files: [{ path: 'src/old.ts' }] };
  const r = await render(createElement(FilesPanel, { cwd: '/a' }));
  await act(async () => typeInto(one(r.host, '.files-filter input') as HTMLInputElement, 'ts'));
  await settle(act, 150);
  assert.deepEqual(names(r.host), ['src/old.ts']);
  let release!: (v: { files: { path: string }[] }) => void;
  searchOverride = () => new Promise((resolve) => (release = resolve));
  await r.rerender(createElement(FilesPanel, { cwd: '/b' }));
  assert.deepEqual(names(r.host), [], "the old folder's matches are gone at once");
  await settle(act, 150);
  await act(async () => release({ files: [{ path: 'lib/new.ts' }] }));
  await settle(act);
  assert.deepEqual(names(r.host), ['lib/new.ts']);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'search').map((c) => c[1]),
    ['/a', '/b'],
  );
  await r.unmount();
});

test('the file preview keeps Open file as its click and reaches Reveal in Finder through the path menu', async () => {
  texts['/repo/a.ts'] = 'const a = 1;';
  const r = await render(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/repo' }));
  await settle(act);
  const menuItem = (label: string) =>
    [...r.host.querySelectorAll('[role=menuitem]')].find((n) => n.textContent?.trim() === label) as HTMLElement;
  await act(async () => one(r.host, '[aria-label="Open file"]').click());
  assert.deepEqual(calls.at(-1), ['openPath', '/repo/a.ts'], 'the preferred destination still opens on the primary click');
  const trigger = one(r.host, '[aria-label="File actions"]');
  assert.equal(trigger.tagName, 'BUTTON', 'the menu has a focusable trigger of its own');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  await act(async () => trigger.click());
  await act(async () => menuItem('Reveal in Finder').click());
  assert.deepEqual(calls.at(-1), ['revealPath', '/repo/a.ts']);
  await act(async () => one(r.host, '[aria-label="File actions"]').click());
  await act(async () => menuItem('Copy path').click());
  assert.deepEqual(calls.at(-1), ['copyText', '/repo/a.ts']);
});
