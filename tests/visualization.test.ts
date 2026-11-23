import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockStore, autoMock, render, settle, resetStore, setStore, callsTo, moduleCalls, native, key } from './support/thread-kit.ts';
import { popoverStubs } from './support/stubs.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/session/clipboard.ts', 'clip');
autoMock('src/components/ui/Popover.tsx', 'pop', popoverStubs());
const { loadVisualization, previewDocument } = await import('../src/lib/visualization.ts');
const { Visualization, VisualizationContent } = await import('../src/components/markdown/Visualization.tsx');

test('local previews load the exact HTML through the supplied filesystem boundary', async () => {
  const calls: string[] = [];
  const html = '<button>Explore</button><script>window.example = 1</script>';
  const result = await loadVisualization('output/demo.html', '/repo', async (path) => {
    calls.push(path);
    return html;
  });
  assert.deepEqual(calls, ['/repo/output/demo.html']);
  assert.deepEqual(result, { path: '/repo/output/demo.html', html, error: null });
});

test('absolute Windows HTML paths do not resolve under the chat directory', async () => {
  const path = 'C:\\demo\\preview.HTML';
  const result = await loadVisualization(path, '/repo', async (resolved) => {
    assert.equal(resolved, path);
    return '';
  });
  assert.deepEqual(result, { path, html: '', error: null });
});

test('invalid, missing and unresolved paths never reach filesystem IPC', async () => {
  for (const path of [undefined, '', 'relative.html', 'https://example.com/a.html', '/repo/secrets.txt', '/repo/demo.html?x=1']) {
    const result = await loadVisualization(path, null, async () => {
      assert.fail('unexpected filesystem call');
    });
    assert.equal(result.html, null);
    assert.equal(result.error, 'Preview requires a local HTML file.');
  }
});

test('missing files show an explicit unavailable result', async () => {
  const result = await loadVisualization('/repo/gone.html', null, async () => null);
  assert.equal(result.html, null);
  assert.equal(result.error, 'Preview file is unavailable.');
});

test('read failures become a displayable error without exposing host error details', async () => {
  const result = await loadVisualization('/repo/demo.html', null, async () => {
    throw new Error('private host detail');
  });
  assert.equal(result.html, null);
  assert.equal(result.error, 'Unable to read preview file.');
});

test('the preview size limit rejects large files and accepts the boundary', async () => {
  const accepted = await loadVisualization('/repo/demo.html', null, async () => 'x'.repeat(1_000_000));
  assert.equal(accepted.error, null);
  const rejected = await loadVisualization('/repo/demo.html', null, async () => 'x'.repeat(1_000_001));
  assert.equal(rejected.html, null);
  assert.equal(rejected.error, 'Preview file is too large.');
});

test('the document preserves interactive markup and places restrictive CSP before it', () => {
  const fragment = '<button id="go">Explore</button><script>document.querySelector("#go").onclick = () => {};</script>';
  const document = previewDocument(fragment, false);
  assert.ok(document.includes(fragment));
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(document)?.[1];
  assert.ok(policy);
  assert.ok(document.indexOf('Content-Security-Policy') < document.indexOf(fragment));
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ])
    assert.ok(policy.includes(directive));
  assert.ok(policy.includes("script-src 'unsafe-inline'"));
  assert.ok(policy.includes('https://cdn.jsdelivr.net'));
});

test('the host theme selects the preview color scheme without modifying the fragment', () => {
  const fragment = '<div>Theme aware</div>';
  assert.match(previewDocument(fragment, true), /color-scheme: dark;/);
  assert.match(previewDocument(fragment, false), /color-scheme: light;/);
  assert.ok(previewDocument(fragment, true).endsWith(`${fragment}</body></html>`));
});

test('loaded content renders in a named script-only sandbox with no referrer', () => {
  const srcDoc = previewDocument('<button>Explore</button>', false);
  const frame = VisualizationContent({ srcDoc, title: 'Control preview', status: '' });
  assert.equal(frame.type, 'iframe');
  assert.equal(frame.props.srcDoc, srcDoc);
  assert.equal(frame.props.sandbox, 'allow-scripts');
  assert.equal(frame.props.referrerPolicy, 'no-referrer');
  const html = renderToStaticMarkup(frame);
  assert.match(html, /<iframe title="Control preview"/);
  assert.doesNotMatch(html, /allow-same-origin|allow-top-navigation/);
});

test('loading and unavailable states render status text without an executable frame', () => {
  for (const status of ['Loading preview…', 'Preview file is unavailable.']) {
    const html = renderToStaticMarkup(createElement(VisualizationContent, { title: 'Preview', status }));
    assert.match(html, /role="status"/);
    assert.ok(html.includes(status));
    assert.doesNotMatch(html, /iframe/);
  }
});

test('an inline visualization loads its file, previews it themed, expands, and opens the file', async () => {
  resetStore({ prefs: { theme: 'system' }, dark: true });
  moduleCalls.length = 0;
  const reads: string[] = [];
  let release!: (html: string | null) => void;
  native.fs = { readText: (p: string) => (reads.push(p), new Promise((r) => (release = r))) };
  const v = await render(createElement(Visualization, { path: 'out/chart.html', mode: 'wide', cwd: '/repo' }));
  assert.deepEqual(reads, ['/repo/out/chart.html']);
  assert.equal(v.$('.md-visualization')!.className, 'md-visualization wide');
  assert.equal(v.$('.md-visualization-header span')!.textContent, 'chart.html');
  assert.equal(v.$('[role="status"]')!.textContent, 'Loading preview…');
  assert.equal(
    v
      .$$('button')
      .map((b) => b.textContent)
      .join(','),
    'Open file',
  );
  await settle(() => release('<p>hi</p>'));
  const frame = v.$('iframe') as HTMLIFrameElement;
  assert.match(frame.getAttribute('srcdoc')!, /color-scheme: dark;/);
  await settle(() => v.$$('button')[0].click());
  assert.equal(v.$('.md-visualization')!.className, 'md-visualization wide expanded');
  assert.equal(v.$$('button')[0].textContent, 'Collapse');
  await settle(() => v.$$('button')[1].click());
  assert.deepEqual(callsTo('open:openPath'), [['/repo/out/chart.html']]);
  await settle(() => setStore({ prefs: { theme: 'light' } }));
  assert.match(v.$('iframe')!.getAttribute('srcdoc')!, /color-scheme: light;/);
  await settle(() => setStore({ prefs: { theme: 'dark' } }));
  assert.match(v.$('iframe')!.getAttribute('srcdoc')!, /color-scheme: dark;/);
  // a new path drops the old preview until it loads, and a late answer for the old one is ignored
  const first = release;
  await v.rerender(createElement(Visualization, { path: '/abs/other.htm', title: 'Other', cwd: '/repo' }));
  assert.equal(v.$('.md-visualization')!.className, 'md-visualization');
  assert.equal(v.$('.md-visualization-header span')!.textContent, 'Other');
  await v.rerender(createElement(Visualization, { path: '/abs/missing.html', cwd: '/repo' }));
  await settle(() => release(null));
  assert.equal(v.$('[role="status"]')!.textContent, 'Preview file is unavailable.');
  void first;
  await v.unmount();
});

test('an inline visualization inlines the stylesheet beside its file', async () => {
  resetStore({ prefs: { theme: 'light' }, dark: false });
  native.fs = {
    readText: async (p: string) =>
      p === '/repo/out/chart.html'
        ? '<link rel="stylesheet" href="chart.css"><p>hi</p>'
        : p === '/repo/out/chart.css'
          ? 'p { color: teal }'
          : null,
    readImageDataUrl: async () => null,
  };
  const v = await render(createElement(Visualization, { path: 'out/chart.html', cwd: '/repo' }));
  await settle(() => {});
  const srcdoc = (v.$('iframe') as HTMLIFrameElement).getAttribute('srcdoc')!;
  assert.match(srcdoc, /<style data-href="\/repo\/out\/chart.css">p \{ color: teal \}<\/style><p>hi<\/p>/);
  await v.unmount();
});

test('a visualization without a usable path says so and offers no file to open', async () => {
  resetStore();
  const v = await render(createElement(Visualization, {}));
  await settle();
  assert.equal(v.$('.md-visualization-header span')!.textContent, 'Visualization');
  assert.equal(v.$('[role="status"]')!.textContent, 'Preview requires a local HTML file.');
  assert.equal(v.$$('button').length, 0);
  await v.rerender(createElement(Visualization, { path: 'notes.txt', cwd: '/repo' }));
  await settle();
  assert.equal(v.$$('button').length, 0);
  await v.unmount();
});

test("a preview's Open file button also carries the path menu, reached from the keyboard", async () => {
  resetStore({ prefs: { theme: 'system' }, dark: true });
  moduleCalls.length = 0;
  native.fs = { readText: async () => '<p>hi</p>' };
  const v = await render(createElement(Visualization, { path: 'out/chart.html', cwd: '/repo' }));
  await settle();
  const open = v.$$('button').find((b) => b.textContent === 'Open file')!;
  assert.equal(open.getAttribute('aria-haspopup'), 'menu');
  await settle(() => open.click());
  assert.deepEqual(callsTo('open:openPath'), [['/repo/out/chart.html']], 'the click still opens the preferred destination');
  assert.equal(v.$('[role=menu]'), null);
  await key(open, 'keydown', { key: 'ContextMenu' });
  const item = (label: string) => v.$$('[role=menuitem]').find((n) => n.textContent?.trim() === label)!;
  await settle(() => item('Reveal in Finder').click());
  assert.deepEqual(callsTo('open:revealPath'), [['/repo/out/chart.html']]);
  await v.unmount();
});
