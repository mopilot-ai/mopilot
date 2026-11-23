// Assistant Markdown as the thread renders it: links and their favicons, directive chips, skills,
// images, inline paths and code blocks with lazy highlighting. Follow-ups are covered in markdownFollowupsUI.test.ts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  settle,
  resetStore,
  impl,
  callsTo,
  moduleCalls,
  native,
} from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
autoMock('src/components/markdown/PullRequestLink.tsx', 'prl', {
  PullRequestLink: (props: any) =>
    h('button', { 'data-stub': 'PullRequestLink', ...props, live: String(props.live), onClick: props.onOpen }),
});
const { Markdown, CodeBlock, useResolvedDark } = await import('../src/components/markdown/Markdown.tsx');
const { COPY_CHECK_MS } = await import('../src/session/copyConfirm.ts');
const { resetMessagePaths } = await import('../src/lib/messagePaths.ts');

const clipboard: string[] = [];
native.clipboard = {
  write: async (t: string) => {
    clipboard.push(t);
  },
};
// copying goes through src/session/clipboard.ts (tests/clipboard.test.ts): a failed write is its toastFailure
impl['store:toastFailure'] = (what: string) => (e: unknown) => moduleCalls.push(['store:failed', [what, (e as Error)?.message ?? e]]);
beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
  clipboard.length = 0;
  delete impl['hl:highlight'];
});
const text = (el: Element | null | undefined) => el?.textContent ?? '';
const md = (t: string, props: any = {}) => render(h(Markdown, { text: t, cwd: '/repo', ...props }));

test('heartbeat reports render Markdown and clickable links after live metadata is complete', async () => {
  const raw =
    '<heartbeat><automation_id>daily</automation_id><decision>NOTIFY</decision><message>Finished **two** changes.\n\n[Report](/tmp/report.json)</message></heartbeat>';
  const v = await md(raw.slice(0, -1), { streaming: true });
  assert.equal(text(v.$('.md')), '');
  await v.rerender(h(Markdown, { text: raw, cwd: '/repo', streaming: false }));
  assert.equal(text(v.$('strong')), 'two');
  assert.doesNotMatch(text(v.$('.md')), /heartbeat|automation_id|decision|NOTIFY|<message>/);
  const link = v.$('a')!;
  assert.equal(link.getAttribute('href'), '/tmp/report.json');
  await settle(() => link.click());
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['/tmp/report.json', '/repo']);
  await v.unmount();
});

test('links open through the app with a favicon for web pages; an empty link does nothing', async () => {
  const v = await md('[docs](https://www.example.com/x) and [rel](docs/a.md) and [none]()');
  const [web, rel, none] = v.$$('a');
  assert.equal(web.title, 'https://www.example.com/x');
  assert.equal(web.querySelector('.md-favicon')!.getAttribute('data-letter'), 'E');
  assert.ok(!rel.querySelector('.md-favicon'));
  assert.ok(!none.querySelector('.md-favicon'));
  await settle(() => web.click());
  await settle(() => none.click());
  assert.deepEqual(
    callsTo('open:openMessageLink').map((c) => [c[0], c[1]]),
    [['https://www.example.com/x', '/repo']],
  );
  assert.equal(v.$('.md')!.className, 'md');
  await v.unmount();
});

test('skill files render as skill links, whether linked, cited or written as code', async () => {
  const v = await md('[review](/skills/review/SKILL.md) `skills/x/SKILL.md` :codex-file-citation{path="/s/y/SKILL.md"}');
  assert.deepEqual(
    v.$$('[data-stub="SkillLink"]').map((s) => s.dataset.path),
    ['/skills/review/SKILL.md', '/repo/skills/x/SKILL.md', '/s/y/SKILL.md'],
  );
  await v.unmount();
});

test('directives become file chips, annotation marks and visualizations; unknown ones drop out', async () => {
  const v = await md(
    'See :codex-file-citation{path="src/a.ts" page_number="3"} and :codex-file-citation{path="/abs/b.ts"} :codex-annotation{index="2"} :codex-annotation{} :codex-file-citation{} \uE200visualize\uE202{"path":"out/c.html","mode":"wide","title":"Chart"}\uE201',
  );
  const chips = v.$$('.md-file-chip');
  assert.deepEqual(
    chips.map((c) => text(c)),
    ['a.tsp. 3', 'b.ts'],
  );
  assert.equal(chips[0].getAttribute('href'), '/repo/src/a.ts');
  await settle(() => chips[1].click());
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['/abs/b.ts', '/repo']);
  assert.equal(text(v.$('.md-annotation')), '2');
  assert.equal(v.$('.md-annotation')!.title, 'Answers annotation 2');
  assert.equal(v.$$('.md-annotation').length, 1);
  const viz = v.$('[data-stub="Visualization"]')!;
  assert.deepEqual([viz.dataset.path, viz.dataset.mode, viz.dataset.title, viz.dataset.cwd], ['out/c.html', 'wide', 'Chart', '/repo']);
  await v.unmount();
});

test('images load web, data and local files; a relative path needs a folder', async () => {
  const srcs = async (t: string, cwd: string | null = '/repo') => {
    const v = await md(t, { cwd });
    const out = v.$$('[data-stub="ZoomableImage"]').map((i) => i.dataset.src);
    await v.unmount();
    return out;
  };
  assert.deepEqual(
    await srcs('![a](https://x/a.png) ![b](data:image/png;base64,AA) ![c](/tmp/c%20d.png) ![d](file:///C:/w/e.png) ![e](rel/f.png)'),
    [
      'https://x/a.png',
      'data:image/png;base64,AA',
      'codex-asset:///tmp/c%20d.png',
      'codex-asset:///C:/w/e.png',
      'codex-asset:///repo/rel/f.png',
    ],
  );
  assert.deepEqual(await srcs('![e](rel/f.png)', null), ['rel/f.png']);
  // an undecodable path is kept as written
  assert.deepEqual(await srcs('![bad](/tmp/%E0%A4%A.png)'), ['codex-asset:///tmp/%25E0%25A4%2525A.png']);
  assert.deepEqual(await srcs('![none](javascript:alert)'), []);
});

test('inline code: a path main finds in the chat folder is a path link, other code is plain', async () => {
  native.fs = {
    messagePath: async (p: string, cwd: string | null) => (p === 'src/a.ts' && cwd ? { path: `${cwd}/src/a.ts`, kind: 'file' } : null),
  };
  resetMessagePaths();
  const v = await md('`src/a.ts:12` and `plain` and `README.md`');
  await settle();
  const link = v.$('a.md-path')!;
  assert.equal(link.getAttribute('href'), 'src/a.ts:12');
  assert.equal(link.title, '/repo/src/a.ts');
  await settle(() => link.click());
  assert.deepEqual(callsTo('open:openMessagePath')[0].slice(0, 3), ['src/a.ts', '/repo', { line: 12, endLine: undefined }]);
  assert.deepEqual(
    v.$$('code.inline-code').map((c) => c.textContent),
    ['plain', 'README.md'],
  );
  // a relative path names nothing without the chat's folder
  await v.rerender(h(Markdown, { text: '`src/a.ts`', cwd: null }));
  await settle();
  assert.equal(v.$('a'), null);
  await v.unmount();
});

test('inline code: a path or skill path inside a link is plain code, so the link holds no second link', async () => {
  const v = await md('[`src/a.ts:12`](/repo/src/a.ts#L12) and [`/s/review/SKILL.md`](https://x.test/doc)');
  assert.equal(v.$$('a a').length, 0);
  assert.equal(v.$('[data-stub="SkillLink"]'), null);
  assert.deepEqual(
    v.$$('a code').map((c) => c.className),
    ['inline-code', 'inline-code'],
  );
  await settle(() => v.$$('a code')[0].click());
  assert.equal(callsTo('open:openMessageLink').length, 1, 'one click opens the file once');
  await v.unmount();
});

test('code blocks highlight once ready, wrap, copy, and skip a late or failed highlight', async () => {
  impl['hl:highlight'] = async (code: string, lang: string, dark: boolean) =>
    `<pre class="hl" data-lang="${lang}" data-dark="${dark}">${code}</pre>`;
  const v = await md('```ts\nconst a = 1\n```\n\n```\nplain\nlines\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n```', { animate: true });
  assert.equal(v.$('.md')!.className, 'md md-animated');
  await settle(() => new Promise((r) => setTimeout(r, 5)));
  const blocks = v.$$('.code-block');
  assert.equal(blocks.length, 2);
  assert.equal(text(blocks[0].querySelector('.code-lang')), 'ts');
  assert.equal(blocks[0].querySelector('.hl')!.getAttribute('data-dark'), 'true');
  assert.equal(text(blocks[1].querySelector('.code-lang')), '');
  assert.equal(text(blocks[1].querySelector('.hl')), 'plain\nlines');
  assert.ok(v.$('.md-table-wrap table'));
  assert.equal(v.$$('code.inline-code').length, 1); // the empty fence reads as empty inline code
  await settle(() => (blocks[0].querySelector('[title="Toggle wrap"]') as HTMLElement).click());
  assert.equal(blocks[0].className, 'code-block wrap');
  const real = globalThis.setTimeout;
  const later: (() => void)[] = [];
  (globalThis as any).setTimeout = (cb: () => void, ms?: number) => (ms === COPY_CHECK_MS ? (later.push(cb), 0) : real(cb, ms));
  try {
    await settle(() => (blocks[0].querySelector('[title="Copy"]') as HTMLElement).click());
  } finally {
    globalThis.setTimeout = real;
  }
  assert.deepEqual(clipboard, ['const a = 1']);
  assert.ok(blocks[0].querySelector('[title="Copy"] svg'));
  const before = blocks[0].querySelector('[title="Copy"]')!.innerHTML;
  await settle(() => later.forEach((cb) => cb()));
  assert.notEqual(blocks[0].querySelector('[title="Copy"]')!.innerHTML, before);
  await v.unmount();

  // a failed highlight keeps the plain fallback
  impl['hl:highlight'] = async () => {
    throw new Error('no grammar');
  };
  const f = await render(h(CodeBlock, { code: 'x', lang: 'zz', showHeader: false, maxHeight: 80 }));
  await settle(() => new Promise((r) => setTimeout(r, 5)));
  assert.equal(text(f.$('.shiki-fallback')), 'x');
  assert.ok(!f.$('.code-header'));
  assert.equal(f.$('.code-body')!.style.maxHeight, '80px');
  // a highlight that lands after unmount is dropped
  let release!: (html: string) => void;
  impl['hl:highlight'] = () => new Promise((r) => (release = r));
  await f.rerender(h(CodeBlock, { code: 'y', lang: 'zz', showHeader: false }));
  await settle(() => new Promise((r) => setTimeout(r, 5)));
  await f.unmount();
  release('<b>late</b>');
});

test('a code block still streaming shows its plain text, and is highlighted once, when it stops growing', async () => {
  const calls: string[] = [];
  impl['hl:highlight'] = async (code: string) => (calls.push(code), `<pre class="hl">${code}</pre>`);
  const wait = () => settle(() => new Promise((r) => setTimeout(r, 5)));
  const stream = (t: string, streaming = true) => v.rerender(h(Markdown, { text: t, cwd: '/repo', streaming }));
  const v = await md('Intro.\n\n```js\na', { streaming: true });
  // every version of the growing block stays plain and unhighlighted
  for (const t of ['Intro.\n\n```js\na\nb', 'Intro.\n\n```js\na\nb\n', 'Intro.\n\n```js\na\nb\n``']) {
    await stream(t);
    await wait();
  }
  assert.deepEqual(calls, []);
  assert.equal(text(v.$('.shiki-fallback')), 'a\nb\n``');
  // its closing fence arrives: highlighted once, and not again as the reply goes on
  await stream('Intro.\n\n```js\na\nb\n```');
  await wait();
  assert.deepEqual(calls, ['a\nb']);
  await stream('Intro.\n\n```js\na\nb\n```\n\nAfter');
  await wait();
  await stream('Intro.\n\n```js\na\nb\n```\n\nAfter that');
  await wait();
  assert.deepEqual(calls, ['a\nb']);
  assert.equal(text(v.$('.hl')), 'a\nb');
  // a block that ends the reply is highlighted once the reply stops streaming
  await stream('Intro.\n\n```js\na\nb\n```\n\nAfter that:\n\n    indented\n');
  await wait();
  assert.deepEqual(calls, ['a\nb']);
  await stream('Intro.\n\n```js\na\nb\n```\n\nAfter that:\n\n    indented\n', false);
  await wait();
  assert.deepEqual(calls, ['a\nb', 'indented']);
  await v.unmount();
});

test('in a run that is still growing, a code block above its end is closed and highlighted at once', async () => {
  const calls: string[] = [];
  impl['hl:highlight'] = async (code: string) => (calls.push(code), `<pre class="hl">${code}</pre>`);
  // a definition keeps the reply one run, so the closed block shares the growing run
  const v = await md('[d]: https://example.com\n\n```\ndone\n```\n\n```\ngrow', { streaming: true });
  await settle(() => new Promise((r) => setTimeout(r, 5)));
  assert.deepEqual(calls, ['done']);
  assert.equal(text(v.$('.hl')), 'done');
  assert.equal(text(v.$('.shiki-fallback')), 'grow');
  await v.unmount();
});

test('dark mode follows the theme, or the system when the theme says so', async () => {
  const Probe = () => h('i', null, String(useResolvedDark()));
  resetStore({ prefs: { theme: 'light' }, dark: true });
  const v = await render(h(Probe));
  assert.equal(text(v.$('i')), 'false');
  await settle(() => resetStore({ prefs: { theme: 'system' }, dark: true }));
  assert.equal(text(v.$('i')), 'true');
  await settle(() => resetStore({ prefs: { theme: 'system' }, dark: false }));
  assert.equal(text(v.$('i')), 'false');
  await v.unmount();
});

for (const [src, cwd, expected] of [
  ['/tmp/hash%23name.png', '/repo', 'codex-asset:///tmp/hash%23name.png'],
  ['/tmp/query%3Fname.png', '/repo', 'codex-asset:///tmp/query%3Fname.png'],
  ['image.png', '/tmp/100%20done', 'codex-asset:///tmp/100%2520done/image.png'],
  ['my%20image.png', '/tmp/build%logs', 'codex-asset:///tmp/build%25logs/my%20image.png'],
  ['/tmp/app%2fwork/diagram%20v2.png', '/tmp/app%2fwork', 'codex-asset:///tmp/app%252fwork/diagram%20v2.png'],
  ['file://localhost/tmp/image.png', '/repo', 'codex-asset:///tmp/image.png'],
  ['FILE:///tmp/image.png', '/repo', 'codex-asset:///tmp/image.png'],
  ['file:image.png', '/repo', 'codex-asset:///repo/image.png'],
  ['file://C:/repo/image.png', '/repo', 'codex-asset:///C:/repo/image.png'],
  ['file://server/share/image.png', '/repo', 'codex-asset:////server/share/image.png'],
  ['HTTPS://example.com/image.png', '/repo', 'HTTPS://example.com/image.png'],
  ['%2Ftmp%2Fimage.png', '/repo', 'codex-asset:///tmp/image.png'],
  ['chart.svg?version=2#preview', '/repo', 'codex-asset:///repo/chart.svg?version=2#preview'],
  ['file:///tmp/image.png?version=2#preview', '/repo', 'codex-asset:///tmp/image.png?version=2#preview'],
  ['file:///tmp/hash%23name%3F.png?raw=1#preview', '/repo', 'codex-asset:///tmp/hash%23name%3F.png?raw=1#preview'],
  ['file:///tmp/percent%2520.png', '/repo', 'codex-asset:///tmp/percent%2520.png'],
  ['C:/repo/image.png', '/repo', 'codex-asset:///C:/repo/image.png'],
  ['C:\\repo\\image.png', '/repo', 'codex-asset:///C:/repo/image.png'],
  ['C:%2Frepo%2Fimage.png', '/repo', 'codex-asset:///C:/repo/image.png'],
]) {
  test(`Markdown image ${src} resolves its filename without rewriting the chat folder`, async () => {
    const v = await md(`![image](${src})`, { cwd });
    try {
      assert.equal(v.$('[data-stub="ZoomableImage"]')?.dataset.src, expected);
    } finally {
      await v.unmount();
    }
  });
}

for (const change of ['language', 'theme']) {
  test(`a code block drops its previous highlight after a ${change} change, including failure`, async () => {
    resetStore({ prefs: { theme: 'dark' } });
    impl['hl:highlight'] = async (code: string) => `<pre class="old-highlight">${code}</pre>`;
    const v = await render(h(CodeBlock, { code: 'same code', lang: 'ts' }));
    await settle(() => new Promise((resolve) => setTimeout(resolve, 5)));
    assert.ok(v.$('.old-highlight'));
    let reject!: (error: Error) => void;
    impl['hl:highlight'] = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    if (change === 'language') await v.rerender(h(CodeBlock, { code: 'same code', lang: 'python' }));
    else await settle(() => resetStore({ prefs: { theme: 'light' } }));
    assert.ok(!v.$('.old-highlight'));
    assert.equal(text(v.$('.shiki-fallback')), 'same code');
    await settle(() => new Promise((resolve) => setTimeout(resolve, 5)));
    await settle(() => reject(new Error('temporary highlight failure')));
    assert.equal(text(v.$('.shiki-fallback')), 'same code');
    impl['hl:highlight'] = async (code: string, lang: string, dark: boolean) =>
      `<pre class="recovered-highlight" data-lang="${lang}" data-dark="${dark}">${code}</pre>`;
    await v.rerender(h(CodeBlock, { code: 'same code', lang: 'rust' }));
    await settle(() => new Promise((resolve) => setTimeout(resolve, 5)));
    assert.equal(v.$('.recovered-highlight')!.dataset.lang, 'rust');
    assert.equal(v.$('.recovered-highlight')!.dataset.dark, String(change !== 'theme'));
    await v.unmount();
  });
}

test('late code-block highlights cannot replace a newer language result', async () => {
  let release!: (html: string) => void;
  impl['hl:highlight'] = () =>
    new Promise((r) => {
      release = r;
    });
  const v = await render(h(CodeBlock, { code: 'same code', lang: 'ts' }));
  try {
    await settle(() => new Promise((r) => setTimeout(r, 5)));
    impl['hl:highlight'] = async () => '<pre class="latest-highlight">same code</pre>';
    await v.rerender(h(CodeBlock, { code: 'same code', lang: 'python' }));
    await settle(() => new Promise((r) => setTimeout(r, 5)));
    assert.ok(v.$('.latest-highlight'));
    await settle(() => release('<pre class="stale-highlight">same code</pre>'));
    assert.ok(v.$('.latest-highlight'));
    assert.equal(v.$('.stale-highlight'), null);
  } finally {
    await v.unmount();
  }
});

test('a code block confirms copy only after success and supports retry after failure', async (t) => {
  impl['hl:highlight'] = async () => '<pre>copy me</pre>';
  const original = native.clipboard.write;
  t.after(() => {
    native.clipboard.write = original;
  });
  const v = await render(h(CodeBlock, { code: 'copy me', lang: 'text' }));
  const button = v.$('[title="Copy"]')!;
  const initial = button.innerHTML;
  let reject!: (error: Error) => void;
  native.clipboard.write = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  await settle(() => button.click());
  assert.equal(button.innerHTML, initial);
  await settle(() => reject(new Error('clipboard unavailable')));
  assert.equal(button.innerHTML, initial);
  assert.deepEqual(callsTo('store:failed'), [["Couldn't copy", 'clipboard unavailable']]);
  native.clipboard.write = original;
  await settle(() => button.click());
  assert.deepEqual(clipboard, ['copy me']);
  assert.notEqual(button.innerHTML, initial);
  await v.unmount();
});

test('copy confirmation follows the copied code when the block changes', async (t) => {
  impl['hl:highlight'] = async (code: string) => `<pre>${code}</pre>`;
  const original = native.clipboard.write;
  t.after(() => {
    native.clipboard.write = original;
  });
  let resolve!: () => void;
  native.clipboard.write = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  const v = await render(h(CodeBlock, { code: 'old code', lang: 'text' }));
  await settle(() => v.$('[title="Copy"]')!.click());
  await v.rerender(h(CodeBlock, { code: 'new code', lang: 'text' }));
  await settle(() => resolve());
  assert.ok(v.$('[title="Copy"] .lucide-copy'));
  native.clipboard.write = original;
  await settle(() => v.$('[title="Copy"]')!.click());
  assert.deepEqual(clipboard, ['new code']);
  assert.ok(v.$('[title="Copy"] .lucide-check'));
  await v.rerender(h(CodeBlock, { code: 'updated code', lang: 'text' }));
  assert.ok(v.$('[title="Copy"] .lucide-copy'));
  await v.unmount();
});

test('repeated copies keep confirmation for the full time after the latest success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  impl['hl:highlight'] = async () => '<pre>same code</pre>';
  const v = await render(h(CodeBlock, { code: 'same code', lang: 'text' }));
  // half a hold, a second copy, then half again: the first copy's deadline passes without taking the check away
  const half = COPY_CHECK_MS / 2;
  await settle(() => v.$('[title="Copy"]')!.click());
  await settle(() => t.mock.timers.tick(half));
  await settle(() => v.$('[title="Copy"]')!.click());
  await settle(() => t.mock.timers.tick(half));
  assert.ok(v.$('[title="Copy"] .lucide-check'));
  await settle(() => t.mock.timers.tick(half));
  assert.ok(v.$('[title="Copy"] .lucide-copy'));
  await v.unmount();
});

test('an older copy failure cannot clear confirmation for a newer successful copy', async (t) => {
  impl['hl:highlight'] = async () => '<pre>same code</pre>';
  const original = native.clipboard.write;
  t.after(() => {
    native.clipboard.write = original;
  });
  let reject!: (error: Error) => void;
  native.clipboard.write = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  const v = await render(h(CodeBlock, { code: 'same code', lang: 'text' }));
  await settle(() => v.$('[title="Copy"]')!.click());
  native.clipboard.write = original;
  await settle(() => v.$('[title="Copy"]')!.click());
  assert.ok(v.$('[title="Copy"] .lucide-check'));
  await settle(() => reject(new Error('older write failed')));
  assert.ok(v.$('[title="Copy"] .lucide-check'));
  await v.unmount();
});

test('Markdown local hrefs use URI mode and relative skill URLs keep their pathname', async () => {
  const v = await md('[doc](README.md#installation) [file](file:///repo/README.md?raw=1#notes) [skill](review/SKILL.md?raw=1#usage)');
  try {
    const links = v.$$('a');
    assert.equal(links[1].getAttribute('href'), 'file:///repo/README.md?raw=1#notes');
    await settle(() => {
      links[0].click();
      links[1].click();
    });
    assert.deepEqual(
      callsTo('open:openMessageLink').map((c) => [c[0], c[1], c[3]]),
      [
        ['README.md#installation', '/repo', true],
        ['file:///repo/README.md?raw=1#notes', '/repo', true],
      ],
    );
    assert.equal(v.$('[data-stub="SkillLink"]')?.dataset.path, '/repo/review/SKILL.md');
  } finally {
    await v.unmount();
  }
});

test('inline-code skill paths preserve literal percent sequences instead of treating them as hrefs', async () => {
  const v = await md('`/a/100%20done/SKILL.md`');
  try {
    assert.equal(v.$('[data-stub="SkillLink"]')?.dataset.path, '/a/100%20done/SKILL.md');
  } finally {
    await v.unmount();
  }
});

test('GitHub PR links become PR chips that read their status once their run is settled; others stay links', async () => {
  const pr = 'https://github.com/Org/Repo/pull/12';
  const v = await md(`See [the fix](${pr}#discussion) and ${pr}/files.`);
  const chip = v.$('[data-stub="PullRequestLink"]')!;
  assert.equal(chip.getAttribute('url'), 'https://github.com/org/repo/pull/12');
  assert.equal(chip.getAttribute('href'), `${pr}#discussion`);
  assert.equal(chip.getAttribute('live'), 'true');
  assert.equal(v.$('a')!.getAttribute('href'), `${pr}/files`, 'a PR page that is not the PR stays a plain link');
  chip.click();
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), [`${pr}#discussion`, '/repo']);
  assert.equal(callsTo('open:openMessageLink')[0][3], true);
  const streaming = await md(`Opened ${pr}`, { streaming: true });
  assert.equal(streaming.$('[data-stub="PullRequestLink"]')!.getAttribute('live'), 'false', 'an autolink may still grow');
});
