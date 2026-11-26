import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { window } from './support/dom.ts';
import { createElement as h } from 'react';
import { iconStubs, mockSource, popoverStubs, withStoreSlices } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

(window.HTMLElement.prototype as any).scrollIntoView = function (options?: ScrollIntoViewOptions) {
  this.setAttribute('data-scrolled', 'true');
  this.setAttribute('data-block', options?.block ?? '');
};
const fixture = {
  readText: async (_path: string): Promise<string | null> => '# Document',
  links: [] as unknown[][],
  prefs: { theme: 'light', wrapCode: false },
};
const f = fixture;
const nul = () => null;
const stubs: Record<string, Record<string, unknown>> = {
  // navigate and threadTitle: Markdown's chat links (components/ChatLink.tsx)
  store: {
    useStore: (s: any) => s({ prefs: f.prefs, threads: {} }),
    toast: () => {},
    toastFailure: () => () => {},
    navigate: () => {},
    // a chat link's ⌥-click (session/openChat.ts)
    openInSplit: () => {},
    threadTitle: () => '',
    giveBackToComposer: () => assert.fail('a global file preview has no chat owner'),
  },
  'session/open.ts': {
    openPath: (p: string) => f.links.push([p]),
    openMessageLink: (...a: unknown[]) => f.links.push(a),
    openMessagePath: (...a: unknown[]) => f.links.push(a),
    openFile: (p: string) => f.links.push(['open', p]),
    revealPath: (p: string) => f.links.push(['reveal', p]),
  },
  'session/clipboard.ts': { copyText: (t: string) => f.links.push(['copy', t]) },
  'components/ui/Popover.tsx': popoverStubs(),
  'components/ui/icons.tsx': iconStubs(),
  'components/panels/DiffPanel.tsx': { LangIcon: nul },
  'components/ui/ImageLightbox.tsx': { ZoomableImage: (p: any) => h('img', p) },
  'components/markdown/SkillLink.tsx': { SkillLink: nul },
  'components/markdown/Visualization.tsx': { Visualization: nul },
  'components/markdown/PullRequestLink.tsx': { PullRequestLink: nul },
  'lib/format.ts': { linkMark: nul, pluralize: (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}` },
  'lib/skills.ts': { skillPath: nul },
};
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub({
  // main's answer for a path a link names: a file beside the document
  fs: { readText: (p: string) => f.readText(p), messagePath: async (p: string, cwd: string) => ({ path: `${cwd}/${p}`, kind: 'file' }) },
  clipboard: { write: async () => {} },
});
for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) mockSource(`src/${rel}`, exports);
// Vite inlines CSS imports; under node they are empty modules
registerHooks({
  load: (url, c, next) =>
    url.startsWith('file:') && url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, c),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FilePreview } = await import('../src/components/panels/FilesPanel.tsx');
const { highlight, langFromPath } = await import('../src/lib/highlight.ts');

async function mount(path: string, line?: number, endLine?: number) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const update = async (path: string, line?: number, endLine?: number) => {
    await act(async () => root.render(createElement(FilePreview, { path, cwd: '/repo', line, endLine })));
  };
  await update(path, line, endLine);
  return {
    host,
    update,
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  assert.ok(button, text);
  await act(async () => button.click());
}

test('Markdown files render headings, tables, tasks and fenced code by default', async () => {
  const source = '# Document\n\n| Name | Status |\n| --- | --- |\n| Preview | Ready |\n\n- [x] Done\n\n```js\nconst value = 1;\n```';
  fixture.readText = async () => source;
  await highlight('const value = 1;', 'js', false);
  for (const ext of ['md', 'MD', 'markdown', 'mdown']) {
    const m = await mount(`/repo/docs/guide.${ext}`);
    try {
      assert.equal(m.host.querySelector('h1')?.textContent, 'Document');
      assert.equal(m.host.querySelector('td')?.textContent, 'Preview');
      assert.ok(m.host.querySelector('input[type="checkbox"]:checked'));
      assert.match(m.host.querySelector('.code-block')?.textContent ?? '', /const value = 1/);
      assert.ok(m.host.querySelector('.file-markdown-preview'));
      assert.equal(m.host.querySelector('.file-preview') === null, true);
    } finally {
      await m.close();
    }
  }
});

test('source toggle shows literal Markdown then restores rendered content', async () => {
  const source = '# Document\n\n**Bold**';
  fixture.readText = async () => source;
  await highlight(source, 'markdown', false);
  const m = await mount('/repo/docs/guide.md');
  try {
    await click(m.host as any, 'View source');
    assert.equal(m.host.querySelector('.file-editor-code')?.textContent, source);
    assert.equal(m.host.querySelector('h1') === null, true);
    await click(m.host as any, 'View rendered');
    assert.equal(m.host.querySelector('strong')?.textContent, 'Bold');
  } finally {
    await m.close();
  }
});

test('relative links and images resolve from the document folder', async () => {
  fixture.readText = async () => '[Sibling](other.md)\n\n![Diagram](images/diagram.png)';
  fixture.links.length = 0;
  const m = await mount('/repo/docs/guide.md');
  try {
    const image = m.host.querySelector('img');
    assert.equal(image?.getAttribute('src'), 'codex-asset:///repo/docs/images/diagram.png');
    await act(async () => (m.host.querySelector('a') as HTMLElement).click());
    assert.deepEqual(fixture.links[0].slice(0, 2), ['other.md', '/repo/docs']);
    // the file is there: the link offers the path menu (Reveal in Finder) on a right-click
    assert.equal(m.host.querySelector('a')?.getAttribute('aria-haspopup'), 'menu');
  } finally {
    await m.close();
  }
});

test('line citations open Markdown source and retain target highlighting', async () => {
  const source = '# Document\n\nSecond paragraph';
  fixture.readText = async () => source;
  await highlight(source, 'markdown', false);
  const m = await mount('/repo/docs/guide.md', 3);
  try {
    assert.equal(m.host.querySelector('.file-preview-target')?.textContent, 'Second paragraph');
    assert.ok(m.host.querySelector('[data-scrolled="true"]'));
    await click(m.host as any, 'View rendered');
    assert.equal(m.host.querySelector('h1')?.textContent, 'Document');
    await m.update('/repo/docs/guide.md', 1);
    assert.equal(m.host.querySelector('.file-preview-target')?.textContent, '# Document');
  } finally {
    await m.close();
  }
});

test('a cited range marks every line in it and scrolls its first line to the top; a single line after it marks one', async () => {
  const source = 'one\ntwo\nthree\nfour\nfive';
  fixture.readText = async () => source;
  await highlight(source, 'typescript', false);
  const m = await mount('/repo/range.ts', 2, 4);
  try {
    const marked = () => [...m.host.querySelectorAll('.file-preview-target')].map((el) => el.textContent);
    assert.deepEqual(marked(), ['two', 'three', 'four']);
    assert.equal(m.host.querySelectorAll('[data-scrolled="true"]').length, 1, 'only the first line scrolls');
    assert.equal(m.host.querySelector('[data-scrolled="true"]')?.getAttribute('data-block'), 'start');
    // a range running past the end marks what is there
    await m.update('/repo/range.ts', 4, 99);
    assert.deepEqual(marked(), ['four', 'five']);
    await m.update('/repo/range.ts', 3);
    assert.deepEqual(marked(), ['three']);
  } finally {
    await m.close();
  }
});

test('a range cited after the rendered view was chosen opens the source again to mark it', async () => {
  const source = '# A\n\nb\n\nc';
  fixture.readText = async () => source;
  await highlight(source, 'markdown', false);
  const m = await mount('/repo/docs/r.md', 3);
  try {
    await click(m.host as any, 'View rendered');
    assert.equal(m.host.querySelector('.file-preview-target'), null);
    await m.update('/repo/docs/r.md', 3, 5);
    assert.deepEqual(
      [...m.host.querySelectorAll('.file-preview-target')].map((el) => el.textContent),
      ['b', '', 'c'],
    );
  } finally {
    await m.close();
  }
});

test('ordinary code files still show highlighted source without Markdown controls', async () => {
  const source = 'export const value = 1;';
  fixture.readText = async () => source;
  await highlight(source, 'typescript', false);
  const m = await mount('/repo/value.ts');
  try {
    assert.equal(m.host.querySelector('.file-editor-code')?.textContent, source);
    assert.equal(m.host.querySelector('.file-preview-toggle') === null, true);
    assert.equal(m.host.querySelector('.file-markdown-preview') === null, true);
    assert.equal(langFromPath('/repo/value.mdx'), 'mdx');
  } finally {
    await m.close();
  }
});

for (const [name, read, message] of [
  ['missing', async () => null, 'This file can’t be previewed'],
  ['binary', async () => '# Header\0binary', 'This file can’t be previewed'],
  ['oversized', async () => 'x'.repeat(400_001), 'File is too large to preview'],
  [
    'rejected',
    async () => {
      throw new Error('Read failed');
    },
    'Read failed',
  ],
] as const)
  test(`${name} files show an error and recover after switching files`, async () => {
    fixture.readText = read;
    const m = await mount('/repo/broken.md');
    try {
      assert.equal(m.host.querySelector('[role="alert"]')?.textContent, message);
      assert.equal((m.host.querySelector('.file-preview-toggle') as HTMLButtonElement).disabled, true);
      fixture.readText = async () => '# Recovered';
      await m.update('/repo/recovered.md');
      assert.equal(m.host.querySelector('[role="alert"]') === null, true);
      assert.equal(m.host.querySelector('h1')?.textContent, 'Recovered');
    } finally {
      await m.close();
    }
  });

test('empty Markdown is a readable document with a working source toggle', async () => {
  fixture.readText = async () => '';
  await highlight('', 'markdown', false);
  const m = await mount('/repo/empty.md');
  try {
    assert.ok(m.host.querySelector('.file-markdown-preview'));
    assert.equal(m.host.querySelector('[role="alert"]') === null, true);
    await click(m.host as any, 'View source');
    assert.equal(m.host.querySelector('.file-editor-code')?.textContent, '');
  } finally {
    await m.close();
  }
});

test('theme changes preserve source mode without rereading the file', async () => {
  let reads = 0;
  const source = '# Document';
  fixture.readText = async () => {
    reads++;
    return source;
  };
  fixture.prefs.theme = 'light';
  await highlight(source, 'markdown', false);
  await highlight(source, 'markdown', true);
  const m = await mount('/repo/theme.md');
  try {
    await click(m.host as any, 'View source');
    fixture.prefs.theme = 'dark';
    await m.update('/repo/theme.md');
    assert.equal(reads, 1);
    assert.equal(m.host.querySelector('.file-editor-code')?.textContent, source);
    assert.equal(m.host.querySelector('.file-markdown-preview') === null, true);
  } finally {
    fixture.prefs.theme = 'light';
    await m.close();
  }
});

test('late file reads cannot replace the current document', async () => {
  let resolve!: (source: string) => void;
  fixture.readText = (p) =>
    p.endsWith('old.md')
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve('# Current');
  const m = await mount('/repo/old.md');
  try {
    await m.update('/repo/current.md');
    await act(async () => resolve('# Stale'));
    assert.equal(m.host.querySelector('h1')?.textContent, 'Current');
  } finally {
    await m.close();
  }
});
