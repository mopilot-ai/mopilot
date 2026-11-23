// The real shared viewer routes every rich format, isolates document HTML and retires old reads/media on replacement.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, markdownStub } from './support/shell-panels-kit.ts';
import { popoverStubs } from './support/stubs.ts';
import { deferred } from './support/async-scenarios.ts';
import * as xlsx from 'xlsx';
import { installNativeStub } from './support/ports/native.ts';

const reads: string[] = [];
let text = '<h1>HTML preview</h1>';
let textFailure = false;
// files beside an HTML page that its preview inlines
const sideFiles: Record<string, string> = {};
let read = async (_path: string): Promise<any> => ({ kind: 'binary', data: new Uint8Array([1]) });
installNativeStub({
  fs: {
    readText: async (path: string) => {
      reads.push(path);
      if (textFailure) throw Error('Text read failed');
      return sideFiles[path] ?? text;
    },
    readImageDataUrl: async (path: string) => sideFiles[path] ?? null,
    readPreview: (path: string) => {
      reads.push(path);
      return read(path);
    },
  },
});
mock.module('../src/session/open.ts', { namedExports: { openPath: () => {}, revealPath: () => {} } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => {} } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs() });
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub({ dark: false }) });
mock.module('../src/lib/highlight.ts', {
  namedExports: { highlight: async (source: string) => `<pre>${source.replace(/</g, '&lt;')}</pre>`, langFromPath: () => 'text' },
});
mock.module('docx-preview', {
  namedExports: {
    renderAsync: async (_data: unknown, body: HTMLElement) => {
      body.innerHTML = '<h1>Word preview</h1>';
    },
  },
});
mock.module('@office-kit/pptx', { namedExports: { loadPresentation: async () => ({}), getSlides: () => [{}] } });
mock.module('@office-kit/pptx-preview', { namedExports: { renderSlideToSvg: () => '<svg><text>Presentation preview</text></svg>' } });
const { createElement: h, act, StrictMode, useLayoutEffect } = await import('react');
mock.module('../src/lib/canvas/loader.ts', {
  namedExports: { loadCanvasPreview: async () => ({ runtime: '', compile: (source: string) => source }) },
});
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { LangIcon: () => null } });
mock.module('../src/components/panels/FilePdfPreview.tsx', {
  namedExports: { FilePdfPreview: ({ data }: { data: Uint8Array }) => h('div', { className: 'pdf-fixture' }, String(data[0])) },
});
const { FilePreview } = await import('../src/components/panels/FilesPanel.tsx');
const { PreviewTable } = await import('../src/components/panels/PreviewTable.tsx');
const view = (path: string, line?: number) => h(FilePreview, { path, cwd: '/repo', line });
const fire = (el: Element, kind: string) =>
  act(() => {
    el.dispatchEvent(new window.Event(kind));
  });
const click = (host: HTMLElement, label: string) =>
  act(() => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label);
    assert.ok(button, label);
    button.click();
  });
let paused = 0,
  loaded = 0;
Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
  value: () => {
    paused++;
  },
  configurable: true,
});
Object.defineProperty(window.HTMLMediaElement.prototype, 'load', {
  value: () => {
    loaded++;
  },
  configurable: true,
});

test('HTML defaults to an opaque interactive preview and switches to escaped source, including cited lines', async () => {
  text = '<h1>HTML preview</h1><script>parent.native()</script>';
  const r = await render(view('/repo/page.html'));
  try {
    const frame = r.host.querySelector('iframe')!;
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(frame.getAttribute('srcdoc')!, /HTML preview/);
    assert.match(frame.getAttribute('srcdoc')!, /connect-src 'none'/);
    await click(r.host, 'View source');
    assert.equal(r.host.querySelector('iframe'), null);
    assert.match(r.host.querySelector('.file-preview')?.textContent ?? '', /<h1>/);
    await click(r.host, 'View rendered');
    assert.ok(r.host.querySelector('iframe'));
    await r.rerender(view('/repo/page.htm', 2));
    assert.equal(r.host.querySelector('iframe'), null);
  } finally {
    await r.unmount();
  }
});

test('a linked canvas plan opens a rendered preview instead of leaving the user in TSX source', async () => {
  text = 'import { H1 } from "cursor/canvas"; export default function Plan() { return <H1>Readable plan</H1>; }';
  const r = await render(view('/repo/repo-health-improvement-plan.canvas.tsx'));
  try {
    assert.ok(r.host.querySelector('iframe[title="Canvas preview"]'), 'a canvas plan needs a rendered view');
    assert.equal(r.host.querySelector('.file-preview'), null, 'source is available through the explicit toggle');
    await click(r.host, 'View source');
    assert.match(r.host.querySelector('.file-preview')?.textContent ?? '', /cursor\/canvas/);
  } finally {
    await r.unmount();
  }
});

test('a new HTML file never commits a frame containing the previous file source', async () => {
  const frames: string[] = [];
  function Audit({ path }: { path: string }) {
    useLayoutEffect(() => {
      frames.push(document.querySelector('iframe')?.getAttribute('srcdoc') ?? '');
    }, [path]);
    return view(path);
  }
  text = '<h1>Old document content</h1>';
  const r = await render(h(Audit, { path: '/repo/old.html' }));
  try {
    frames.length = 0;
    text = '<h1>New document content</h1>';
    await r.rerender(h(Audit, { path: '/repo/new.html' }));
    assert.ok(frames.every((source) => !source.includes('Old document content')));
    assert.match(r.host.querySelector('iframe')?.getAttribute('srcdoc') ?? '', /New document content/);
  } finally {
    await r.unmount();
  }
});

test('CSV/TSV tables preserve hostile strings as text, switch to source and retry malformed quoting', async () => {
  text = 'Name,Value\n"<script>alert(1)</script>",42';
  const r = await render(view('/repo/data.csv'));
  try {
    assert.equal(r.host.querySelector('td')?.textContent, 'Name');
    assert.match(r.host.querySelector('table')?.textContent ?? '', /<script>alert/);
    assert.equal(r.host.querySelector('script'), null);
    await click(r.host, 'View source');
    assert.equal(r.host.querySelector('table'), null);
    await click(r.host, 'View rendered');
    assert.ok(r.host.querySelector('table'));
    text = 'First\tSecond\n1\t2';
    await r.rerender(view('/repo/data.tsv'));
    assert.equal(r.host.querySelector('tr')?.querySelectorAll('td').length, 2);
    text = '"unfinished';
    await r.rerender(view('/repo/broken.csv'));
    assert.match(r.host.querySelector('[role="alert"]')?.textContent ?? '', /quoted field/);
    text = 'Recovered,42';
    await click(r.host, 'Retry file preview');
    assert.match(r.host.querySelector('table')?.textContent ?? '', /Recovered/);
    text = '';
    await r.rerender(view('/repo/empty.csv'));
    assert.match(r.host.textContent ?? '', /sheet is empty/);
  } finally {
    await r.unmount();
  }
});

test('an HTML page shows with the stylesheet and images beside it, and a refresh picks up an edited stylesheet', async () => {
  text = '<link rel="stylesheet" href="styles.css"><svg><rect class="box"/><image href="assets/a.png"/></svg>';
  sideFiles['/repo/designs/styles.css'] = 'svg .box { fill: #eef; }';
  sideFiles['/repo/designs/assets/a.png'] = 'data:image/png;base64,AAAA';
  const r = await render(view('/repo/designs/page.html'));
  try {
    const srcdoc = () => r.host.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    assert.match(srcdoc(), /<style data-href="\/repo\/designs\/styles.css">svg \.box \{ fill: #eef; \}<\/style>/);
    assert.match(srcdoc(), /<image href="data:image\/png;base64,AAAA"\/>/);
    assert.doesNotMatch(srcdoc(), /href="styles.css"/);
    sideFiles['/repo/designs/styles.css'] = 'svg .box { fill: #fee; }';
    await click(r.host, 'Refresh preview');
    assert.match(srcdoc(), /fill: #fee;/);
    await click(r.host, 'View source');
    assert.match(r.host.querySelector('.file-preview')?.textContent ?? '', /href="styles.css"/);
  } finally {
    for (const key of Object.keys(sideFiles)) delete sideFiles[key];
    await r.unmount();
  }
});

test('a failed HTML read can retry the same path successfully', async () => {
  textFailure = true;
  const r = await render(view('/repo/retry.html'));
  try {
    assert.ok(r.host.querySelector('[role="alert"]'));
    textFailure = false;
    text = '<h1>Retry succeeded</h1>';
    await click(r.host, 'Retry file preview');
    assert.match(r.host.querySelector('iframe')?.getAttribute('srcdoc') ?? '', /Retry succeeded/);
  } finally {
    textFailure = false;
    await r.unmount();
  }
});

test('workbook tables select sheets and describe empty/truncated content', async () => {
  const sheets = [
    { name: 'First', rows: [['a']], truncated: true },
    { name: 'Empty', rows: [], truncated: false },
  ];
  const r = await render(h(PreviewTable, { sheets }));
  try {
    assert.match(r.host.querySelector('[role="status"]')?.textContent ?? '', /1,000 rows/);
    const select = r.host.querySelector('select')!;
    await act(() => {
      select.value = '1';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.match(r.host.textContent ?? '', /sheet is empty/);
    await r.rerender(h(PreviewTable, { sheets: [] }));
    assert.match(r.host.textContent ?? '', /no worksheets/);
  } finally {
    await r.unmount();
  }
});

test('Word and PowerPoint markup only enter script-disabled document frames', async () => {
  read = async () => ({ kind: 'binary', data: new Uint8Array([1]) });
  const r = await render(view('/repo/document.docx'));
  try {
    const word = r.host.querySelector('iframe')!;
    assert.equal(word.getAttribute('sandbox'), '');
    assert.match(word.getAttribute('srcdoc')!, /Word preview/);
    assert.equal(r.host.querySelector('h1'), null);
    await r.rerender(view('/repo/slides.pptx'));
    assert.match(r.host.querySelector('iframe')?.getAttribute('srcdoc') ?? '', /Presentation preview/);
    await r.rerender(view('/repo/document.pdf'));
    assert.equal(r.host.querySelector('.pdf-fixture')?.textContent, '1');
    read = async () => ({ kind: 'text', text: 'Legacy document content' });
    await r.rerender(view('/repo/legacy.doc'));
    assert.match(r.host.textContent ?? '', /Text preview/);
    assert.match(r.host.querySelector('pre')?.textContent ?? '', /Legacy document content/);
  } finally {
    await r.unmount();
  }
});

test('real workbook decoding reaches the shared file viewer', async () => {
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['Workbook value']]), 'Sheet');
  const data = new Uint8Array(xlsx.write(book, { bookType: 'xlsx', type: 'buffer' }));
  read = async () => ({ kind: 'binary', data });
  const r = await render(view('/repo/book.xlsx'));
  try {
    assert.match(r.host.querySelector('table')?.textContent ?? '', /Workbook value/);
  } finally {
    await r.unmount();
  }
});

for (const rejection of [false, true])
  test(`retired document ${rejection ? 'rejection' : 'success'} cannot replace a newer file`, async () => {
    const old = deferred<any>(),
      current = deferred<any>();
    read = (path) => (path.includes('first') ? old.promise : current.promise);
    const r = await render(view('/repo/first.docx'));
    try {
      await r.rerender(view('/repo/second.docx'));
      await act(async () => {
        if (rejection) old.reject(Error('retired'));
        else old.resolve({ kind: 'binary', data: new Uint8Array([1]) });
      });
      assert.ok(r.host.querySelector('[role="status"]'));
      assert.equal(r.host.querySelector('[role="alert"]'), null);
      await act(async () => current.resolve({ kind: 'text', text: 'Current document' }));
      assert.match(r.host.textContent ?? '', /Current document/);
    } finally {
      await r.unmount();
    }
  });

test('document failures end loading, retry succeeds, and late completions after disposal are ignored', async () => {
  read = async () => {
    throw Error('broken');
  };
  const r = await render(view('/repo/broken.docx'));
  assert.ok(r.host.querySelector('[role="alert"]'));
  read = async () => ({ kind: 'text', text: 'Recovered' });
  await click(r.host, 'Retry file preview');
  assert.match(r.host.textContent ?? '', /Recovered/);
  const gate = deferred<any>();
  read = () => gate.promise;
  await r.rerender(view('/repo/disposed.docx'));
  await r.unmount();
  await act(async () => gate.reject(Error('after disposal')));
});

test('Strict Mode document setup/cleanup/setup still publishes only the current attempt', async () => {
  const pending: ReturnType<typeof deferred<any>>[] = [];
  read = () => {
    const request = deferred<any>();
    pending.push(request);
    return request.promise;
  };
  const r = await render(h(StrictMode, null, view('/repo/strict.docx')));
  try {
    assert.equal(pending.length, 2);
    await act(async () => pending[0].resolve({ kind: 'text', text: 'Retired' }));
    assert.ok(r.host.querySelector('[role="status"]'));
    await act(async () => pending[1].resolve({ kind: 'text', text: 'Current' }));
    assert.match(r.host.textContent ?? '', /Current/);
  } finally {
    await r.unmount();
  }
});

test('audio/video controls load metadata, report failure, retry and retire playback', async () => {
  const r = await render(h(StrictMode, null, view('/repo/movie.mp4')));
  try {
    const first = r.host.querySelector('video')!;
    assert.equal(first.getAttribute('src'), 'codex-asset:///repo/movie.mp4');
    assert.equal(first.controls, true);
    await fire(first, 'loadeddata');
    assert.equal(r.host.querySelector('[role="status"]'), null);
    const before = paused;
    await r.rerender(view('/repo/sound.wav'));
    assert.ok(paused > before);
    assert.ok(loaded > 0);
    const audio = r.host.querySelector('audio')!;
    assert.equal(audio.controls, true);
    await fire(first, 'error');
    assert.ok(r.host.querySelector('[role="status"]'));
    await fire(audio, 'error');
    assert.match(r.host.querySelector('[role="alert"]')?.textContent ?? '', /Could not play/);
    await click(r.host, 'Retry file preview');
    const retry = r.host.querySelector('audio')!;
    assert.notEqual(audio, retry);
    await fire(audio, 'loadeddata');
    assert.ok(r.host.querySelector('[role="status"]'));
    await fire(retry, 'loadeddata');
    assert.equal(r.host.querySelector('[role="status"]'), null);
  } finally {
    await r.unmount();
  }
});
