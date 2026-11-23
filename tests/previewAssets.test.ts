// An HTML preview inlines the stylesheets, scripts and images beside its file, and nothing outside that folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

installNativeStub({
  fs: {
    readText: async (path: string) => `/* native ${path} */`,
    readImageDataUrl: async (path: string) => `data:image/png;base64,${path.length}`,
  },
});
const { inlineLocalAssets, localAsset, useLocalAssets, nativeAssets, MAX_ASSETS, MAX_ASSET_CHARS } = await import(
  '../src/lib/previewAssets.ts'
);

const files = (table: Record<string, string>, calls: string[] = []) => ({
  readText: async (path: string) => (calls.push(path), table[path] ?? null),
  readDataUrl: async (path: string) => (calls.push(path), table[path] ?? null),
});

test('references resolve inside the HTML file folder only', () => {
  assert.equal(localAsset('styles.css', '/d'), '/d/styles.css');
  assert.equal(localAsset('./a/b%20c.png?v=1#x', '/d'), '/d/a/b c.png');
  assert.equal(localAsset('assets\\x.png', 'C:\\d'), 'C:\\d\\assets\\x.png');
  for (const ref of [
    '',
    '  ',
    '#top',
    '../x.css',
    'a/../../x.css',
    '/etc/x.css',
    '\\x.css',
    'https://e.com/x.css',
    '//e.com/x.css',
    'data:text/css,a',
    '%E0%A4%A.css',
    './',
  ])
    assert.equal(localAsset(ref, '/d'), null, ref);
});

test('a linked stylesheet, its url() images, a script and images are inlined from the same folder', async () => {
  const calls: string[] = [];
  const io = files(
    {
      '/d/styles.css': 'svg .box { fill: red; background: url("img/bg.png") } .x { background: url(https://e.com/a.png) }</style>',
      '/d/img/bg.png': 'data:image/png;base64,BG',
      '/d/app.js': 'window.ok = "</script>"',
      '/d/logo.svg': 'data:image/svg+xml;base64,LOGO',
      '/d/pic.png': 'data:image/png;base64,PIC',
      '/d/in.png': 'data:image/png;base64,IN',
    },
    calls,
  );
  const html = [
    '<link rel="stylesheet" href="styles.css">',
    "<link rel='icon' href='logo.svg'><link href=styles.css><link rel=stylesheet href=missing.css><link rel=stylesheet>",
    '<script type="module" src="app.js"></script><script src="https://cdn.e/x.js"></script><script>inline()</script>',
    "<script src='app.js'></script><script defer src=app.js></script>",
    '<img alt="l" src="logo.svg"><img src=pic.png><img src="notes.txt"><img src="https://e.com/p.png"><img alt="none">',
    '<svg><image href="pic.png"/><image xlink:href=\'logo.svg\'/></svg>',
    '<style>.a { background: url(in.png) } .b { background: url(gone.png) }</style>',
  ].join('\n');
  const out = await inlineLocalAssets(html, '/d/page.html', io);
  assert.match(out, /<style data-href="\/d\/styles.css">svg \.box \{ fill: red; background: url\("data:image\/png;base64,BG"\) \}/);
  assert.match(out, /url\(https:\/\/e\.com\/a\.png\) \}<\\\/style><\/style>/);
  assert.ok(
    out.includes("<link rel='icon' href='logo.svg'><link href=styles.css><link rel=stylesheet href=missing.css><link rel=stylesheet>"),
  );
  assert.ok(
    out.includes(
      '<script type="module">window.ok = "<\\/script>"</script><script src="https://cdn.e/x.js"></script><script>inline()</script>',
    ),
  );
  assert.ok(out.includes('<script>window.ok = "<\\/script>"</script><script defer>window.ok = "<\\/script>"</script>'));
  assert.ok(out.includes('<img alt="l" src="data:image/svg+xml;base64,LOGO"><img src="data:image/png;base64,PIC"><img src="notes.txt">'));
  assert.ok(out.includes('<img src="https://e.com/p.png"><img alt="none">'));
  assert.ok(out.includes('<image href="data:image/png;base64,PIC"/><image xlink:href="data:image/svg+xml;base64,LOGO"/>'));
  assert.ok(out.includes('.a { background: url("data:image/png;base64,IN") } .b { background: url(gone.png) }'));
  assert.ok(!calls.includes('/d/notes.txt'), 'a non-image file is never read as an image');
});

test('only real attributes and markup count: values, comments and script bodies are passed over', async () => {
  const calls: string[] = [];
  const io = files(
    {
      '/d/a.png': 'data:image/png;base64,A',
      '/d/b.png': 'data:image/png;base64,B',
      '/d/s.css': '.s{}',
      '/d/app.js': 'const t = \'<img src="a.png">\' + "<style>.x{background:url(a.png)}</style>";',
      '/d/notes.env': 'SECRET=1',
      '/d/dollar.png': 'data:image/svg+xml,<svg>$&$1</svg>',
    },
    calls,
  );
  const html = [
    `<img alt="x src='a.png'" src="b.png">`,
    '<link title="a>b" rel="stylesheet" href="s.css">',
    '<!-- <img src="a.png"> --><script>const s = \'<link rel="stylesheet" href="s.css">\'</script>',
    '<SCRIPT SRC="app.js"></SCRIPT><script src="notes.env"></script><link rel="stylesheet" href="notes.env">',
    '<img src="dollar.png"><img src>',
  ].join('\n');
  const out = await inlineLocalAssets(html, '/d/p.html', io);
  assert.ok(out.includes(`<img alt="x src='a.png'" src="data:image/png;base64,B">`));
  assert.ok(out.includes('<style data-href="/d/s.css">.s{}</style>'));
  assert.ok(out.includes('<!-- <img src="a.png"> --><script>const s = \'<link rel="stylesheet" href="s.css">\'</script>'));
  assert.ok(out.includes(`<SCRIPT>const t = '<img src="a.png">' + "<style>.x{background:url(a.png)}</style>";</SCRIPT>`));
  assert.ok(out.includes('<script src="notes.env"></script><link rel="stylesheet" href="notes.env">'));
  assert.ok(out.includes('<img src="data:image/svg+xml,<svg>$&$1</svg>"><img src>'));
  assert.ok(!calls.includes('/d/notes.env'), 'a stylesheet or script reference reads only .css or .js files');
  assert.equal(calls.filter((c) => c === '/d/a.png').length, 0);
});

test('the asset count and size budgets leave further references untouched', async () => {
  const many = Array.from({ length: MAX_ASSETS + 1 }, (_, i) => `<img src="${i}.png">`).join('');
  const out = await inlineLocalAssets(many, '/d/p.html', { readText: async () => null, readDataUrl: async () => 'data:x' });
  assert.equal(out.match(/data:x/g)?.length, MAX_ASSETS);
  assert.ok(out.endsWith(`<img src="${MAX_ASSETS}.png">`));
  const big = 'x'.repeat(MAX_ASSET_CHARS);
  const sized = await inlineLocalAssets('<img src="a.png"><img src="b.png">', '/d/p.html', {
    readText: async () => null,
    readDataUrl: async (p) => (p.endsWith('a.png') ? 'data:a' : big),
  });
  assert.equal(sized, '<img src="data:a"><img src="b.png">');
});

test('a failed read leaves the reference as it was', async () => {
  const out = await inlineLocalAssets('<link rel="stylesheet" href="s.css"><img src="a.png">', '/d/p.html', {
    readText: () => Promise.reject(Error('EACCES')),
    readDataUrl: () => Promise.reject(Error('EACCES')),
  });
  assert.equal(out, '<link rel="stylesheet" href="s.css"><img src="a.png">');
});

test('the native reader goes through main for text and images', async () => {
  assert.equal(await nativeAssets.readText('/d/s.css'), '/* native /d/s.css */');
  assert.equal(await nativeAssets.readDataUrl('/d/a.png'), 'data:image/png;base64,8');
});

test('the hook replaces an inlining still in flight and keeps the last result until the next lands', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const pending = new Map<string, ReturnType<typeof deferred<string | null>>>();
  const io = {
    readText: (path: string) => {
      const d = deferred<string | null>();
      pending.set(path, d);
      return d.promise;
    },
    readDataUrl: async () => null,
  };
  const shown: (string | null)[] = [];
  function View({ html, path, refresh }: { html: string | null; path: string; refresh?: number }) {
    shown.push(useLocalAssets(html, path, { refresh, io })?.html ?? null);
    return null;
  }
  const at = async (props: { html: string | null; path: string; refresh?: number }) => act(() => root.render(h(View, props)));
  const link = '<link rel="stylesheet" href="s.css">';
  await at({ html: link, path: '/a/p.html' });
  assert.equal(shown.at(-1), null);
  const first = pending.get('/a/s.css')!;
  await at({ html: link, path: '/b/p.html' });
  await act(async () => first.resolve('.stale{}'));
  assert.equal(shown.at(-1), null, 'a superseded file never shows');
  await act(async () => pending.get('/b/s.css')!.resolve('.b{}'));
  assert.match(shown.at(-1)!, /\.b\{\}/);
  await at({ html: link, path: '/b/p.html', refresh: 1 });
  assert.match(shown.at(-1)!, /\.b\{\}/, 'the last result stays while a refresh reads again');
  await act(async () => pending.get('/b/s.css')!.resolve('.b2{}'));
  assert.match(shown.at(-1)!, /\.b2\{\}/);
  await at({ html: null, path: '/b/p.html' });
  assert.equal(shown.at(-1), null);
  await act(() => root.unmount());
});

test('the hook returns the tag its result was read for', async () => {
  const root = createRoot(document.createElement('div'));
  const gate = deferred<string | null>();
  const io = { readText: () => gate.promise, readDataUrl: async () => null };
  let shown: { html: string; tag: string | undefined } | null = null;
  function View({ tag }: { tag: string }) {
    shown = useLocalAssets('<link rel="stylesheet" href="s.css">', '/d/p.html', { refresh: tag, tag, io });
    return null;
  }
  await act(async () => root.render(h(View, { tag: 'r1' })));
  await act(async () => gate.resolve('.a{}'));
  assert.equal(shown!.tag, 'r1');
  assert.match(shown!.html, /\.a\{\}/);
  await act(() => root.unmount());
});

test('the hook falls back to the HTML as written when inlining throws', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  let shown: string | null = null;
  const io = {
    readText: (): Promise<string | null> => {
      throw Error('sync');
    },
    readDataUrl: async () => null,
  };
  function View() {
    shown = useLocalAssets('<link rel="stylesheet" href="s.css">', '/d/p.html', { io })?.html ?? null;
    return null;
  }
  await act(async () => root.render(h(View)));
  assert.equal(shown, '<link rel="stylesheet" href="s.css">');
  await act(() => root.unmount());
});
