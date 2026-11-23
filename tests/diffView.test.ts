// Diff rendering: the full-file table, the inline chat diff with word marks, and the
// side-by-side view. Syntax colours come from a stand-in tokenizer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { autoMock, render, settle, impl, callsTo, moduleCalls } from './support/thread-kit.ts';

let dark = true;
autoMock('src/components/markdown/Markdown.tsx', 'md', { useResolvedDark: () => dark });
autoMock('src/lib/highlight.ts', 'hl', { langFromPath: (p: string) => (p.endsWith('.ts') ? 'typescript' : 'text') });
// copying confirms only after the write (src/session/clipboard.ts, tests/clipboard.test.ts); here the write
// always lands, so a button that confirms on itself is called back and shows its check
const clipboard: string[] = [];
autoMock('src/session/clipboard.ts', 'clip', {
  copyText: (t: string, done: unknown) => {
    clipboard.push(t);
    moduleCalls.push(['clip:copyText', [t, typeof done === 'string' ? done : 'confirms on itself']]);
    if (typeof done === 'function') (done as () => void)();
  },
});
const { DiffLines, InlineDiff, SplitDiff, parseUnifiedDiff } = await import('../src/components/diff/DiffView.tsx');
const { diffFileText } = await import('../src/lib/diff.ts');
const { diffFingerprint } = await import('../src/lib/diffReview.ts');

beforeEach(() => {
  moduleCalls.length = 0;
  clipboard.length = 0;
  delete impl['hl:tokenizeLines'];
  dark = true;
});
const text = (el: Element | null | undefined) => el?.textContent ?? '';
const file = (path: string, diff: string, extra: any = {}) => ({
  ...parseUnifiedDiff(`--- a/${path}\n+++ b/${path}\n${diff}`)[0],
  path,
  ...extra,
});
/** Tokens that colour each line as one span, so tests can see they were applied. */
const colourAll = () => {
  impl['hl:tokenizeLines'] = async (code: string) => code.split('\n').map((t) => [[t, '#abc']]);
};

test('the diff table hides a leading whole-file hunk, labels later hunks, and colours lines once tokenized', async () => {
  colourAll();
  const f = file('/repo/a.ts', '@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n@@ -10 +10 @@ function f()\n-x\n@@ -20 +20 @@\n+y');
  const v = await render(h(DiffLines, { file: f, maxHeight: 200 }));
  await settle();
  assert.equal(v.$('.diff-lines')!.style.maxHeight, '200px');
  assert.deepEqual(
    v.$$('tr').map((r) => r.className),
    ['diff-ctx', 'diff-del', 'diff-add', 'diff-hunk', 'diff-del', 'diff-hunk', 'diff-add'],
  );
  assert.deepEqual(
    v.$$('.diff-hunk .code').map((c) => c.textContent),
    ['function f()', '⋯'],
  );
  assert.deepEqual(
    v.$$('tr:not(.diff-hunk) .sign').map((s) => s.textContent),
    [' ', '-', '+', '-', '+'],
  );
  assert.equal(v.$('.diff-del span[style]')!.style.color, '#abc');
  assert.deepEqual(
    [...v.$$('tr')[1].querySelectorAll('.ln')].map((c) => c.textContent),
    ['2', ''],
  );
  assert.equal(callsTo('hl:tokenizeLines')[0][1], 'typescript');
  assert.equal(callsTo('hl:tokenizeLines')[0][2], true);
  await v.unmount();
});

test('plain text and very long diffs are not tokenized; an answer after unmount is dropped', async () => {
  const v = await render(h(DiffLines, { file: file('notes.txt', '@@ -3 +3 @@\n-a\n+b') }));
  assert.deepEqual(callsTo('hl:tokenizeLines'), []);
  assert.equal(v.$('.diff-hunk .code')!.textContent, '⋯');
  const big = {
    path: '/r/big.ts',
    lines: Array.from({ length: 4001 }, (_, i) => ({ kind: 'add', text: `l${i}`, newNo: i + 1 })),
    added: 4001,
    removed: 0,
  };
  await v.rerender(h(DiffLines, { file: big as any }));
  assert.deepEqual(callsTo('hl:tokenizeLines'), []);
  let release!: (t: any) => void;
  impl['hl:tokenizeLines'] = () => new Promise((r) => (release = r));
  await v.rerender(h(DiffLines, { file: file('/r/x.ts', '@@ -5 +5 @@\n-a\n+b') }));
  await v.unmount();
  release([[['a', '#f00']], [['b', '#0f0']]]);
});

test('the inline diff marks the changed words of paired lines, across token boundaries', async () => {
  impl['hl:tokenizeLines'] = async (code: string) =>
    code.split('\n').map((t) =>
      t === 'const a = 1;'
        ? [
            ['const ', '#111'],
            ['a = 1', ''],
            [';', '#222'],
          ]
        : [[t, '#333']],
    );
  const f = file('/repo/x.ts', '@@ -1,4 +1,4 @@\n same\n-const a = 1;\n-gone\n+const a = 2;\n+same line\n-only del\n ctx');
  const v = await render(h(InlineDiff, { file: f, cwd: '/repo' }));
  await settle();
  assert.equal(text(v.$('.idiff-name')), 'x.ts');
  assert.equal(v.$('.idiff-body')!.style.maxHeight, '360px');
  const rows = v.$$('.idiff-row');
  assert.deepEqual(
    rows.map((r) => r.className),
    ['idiff-row ctx', 'idiff-row del', 'idiff-row del', 'idiff-row add', 'idiff-row add', 'idiff-row del', 'idiff-row ctx'],
  );
  assert.deepEqual(
    rows.map((r) => text(r.querySelector('.idiff-ln'))),
    ['1', '2', '3', '2', '3', '4', '4'],
  );
  // "const a = 1;" vs "const a = 2;": only the digit is marked, inside the uncoloured token
  assert.deepEqual(
    [...rows[1].querySelectorAll('.idiff-code span')].map((s) => [s.textContent, s.className, (s as HTMLElement).style.color]),
    [
      ['const ', '', '#111'],
      ['a = ', '', ''],
      ['1', 'word-mark', ''],
      [';', '', '#222'],
    ],
  );
  assert.equal(text(rows[3].querySelector('.word-mark')), '2');
  assert.ok(rows[2].querySelector('.word-mark')); // "gone" vs "same line": all of it changed
  assert.ok(!rows[5].querySelector('.word-mark')); // a deletion with no addition after it
  await settle(() => v.$('.idiff-copy')!.click());
  assert.equal(clipboard[0], ' same\n-const a = 1;\n-gone\n+const a = 2;\n+same line\n-only del\n ctx');
  await v.unmount();
});

test('identical pairs carry no mark; bare, plain-text and very long inline diffs skip the extras', async () => {
  const pair = {
    path: 'p.txt',
    lines: [
      { kind: 'del', text: 'x', oldNo: 1 },
      { kind: 'add', text: 'x', newNo: 1 },
      { kind: 'add', text: 'extra', newNo: 2 },
    ],
    added: 2,
    removed: 1,
  } as any;
  const v = await render(h(InlineDiff, { file: pair, bare: true, maxHeight: 50 }));
  assert.equal(v.$('.idiff')!.className, 'idiff bare');
  assert.ok(!v.$('.idiff-head'));
  assert.ok(!v.$('.word-mark'));
  assert.equal(v.$('.idiff-code span')!.getAttribute('style'), null);
  assert.deepEqual(callsTo('hl:tokenizeLines'), []);
  const big = {
    path: '/r/big.ts',
    lines: Array.from({ length: 3001 }, (_, i) => ({ kind: 'ctx', text: `l${i}`, oldNo: i, newNo: i })),
    added: 0,
    removed: 0,
  };
  await v.rerender(h(InlineDiff, { file: big as any }));
  assert.deepEqual(callsTo('hl:tokenizeLines'), []);
  let release!: (t: any) => void;
  impl['hl:tokenizeLines'] = () => new Promise((r) => (release = r));
  dark = false;
  await v.rerender(h(InlineDiff, { file: file('/r/y.ts', '@@ -5 +5 @@\n-a\n+b') }));
  assert.equal(callsTo('hl:tokenizeLines')[0][2], false);
  await v.unmount();
  release([[['a', '#f00']], [['b', '#0f0']]]);
});

test('the split view pairs deletions with additions and leaves the shorter side empty', async () => {
  const f = file('s.txt', '@@ -1,4 +1,3 @@\n keep\n-a\n-b\n+c\n x\n+d\n+e');
  const v = await render(h(SplitDiff, { file: f }));
  const rows = v
    .$$('.split-row')
    .map((r) =>
      [...r.querySelectorAll('.idiff-row')].map(
        (c) => `${c.className.replace(/\s+/g, ' ').trim()}|${text(c.querySelector('.idiff-ln'))}|${text(c.querySelector('.idiff-code'))}`,
      ),
    );
  assert.deepEqual(rows, [
    ['idiff-row|1|keep', 'idiff-row|1|keep'],
    ['idiff-row del|2|a', 'idiff-row add|2|c'],
    ['idiff-row del|3|b', 'idiff-row empty||'],
    ['idiff-row|4|x', 'idiff-row|3|x'],
    ['idiff-row empty||', 'idiff-row add|4|d'],
    ['idiff-row empty||', 'idiff-row add|5|e'],
  ]);
  await v.unmount();
});

test('notes show under their line of the new file in both views: the last row at or before it, else the first', async () => {
  const f = file('s.txt', '@@ -3,3 +3,3 @@\n keep\n-a\n+c\n x');
  const note = (line: number, key: string) => ({ line, key, node: h('aside', { 'data-note': key }) });
  const notes = [note(1, 'before'), note(4, 'on-add'), note(9, 'after'), note(4, 'second')];
  const order = (root: { $: (s: string) => HTMLElement | null }) =>
    [...root.$('.idiff-body')!.children].map((c) =>
      c.tagName === 'ASIDE' ? `note:${c.getAttribute('data-note')}` : (c.querySelector('.idiff-ln')?.textContent ?? ''),
    );
  const v = await render(h(InlineDiff, { file: f, bare: true, notes }));
  assert.deepEqual(order(v), ['3', 'note:before', '4', '4', 'note:on-add', 'note:second', '5', 'note:after']);
  await v.rerender(h(SplitDiff, { file: f, notes }));
  assert.deepEqual(
    [...v.$('.idiff-body')!.children].map((c) => (c.tagName === 'ASIDE' ? `note:${c.getAttribute('data-note')}` : c.className)),
    ['split-row', 'note:before', 'split-row', 'note:on-add', 'note:second', 'split-row', 'note:after'],
  );
  await v.unmount();
});

for (const Component of [DiffLines, InlineDiff]) {
  test(`${Component.name} shows the new diff while its tokenizer is pending or fails`, async () => {
    colourAll();
    const v = await render(h(Component, { file: file('/repo/old.ts', '@@ -2 +2 @@\n-old source\n+old result') }));
    await settle();
    assert.ok(text(v.$('.diff-lines, .idiff')).includes('old source'));
    let reject!: (error: Error) => void;
    impl['hl:tokenizeLines'] = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    await v.rerender(h(Component, { file: file('/repo/new.ts', '@@ -2 +2 @@\n-new source\n+new result') }));
    assert.ok(text(v.$('.diff-lines, .idiff')).includes('new source'));
    assert.ok(text(v.$('.diff-lines, .idiff')).includes('new result'));
    assert.ok(!text(v.$('.diff-lines, .idiff')).includes('old source'));
    await settle(() => reject(new Error('temporary tokenizer failure')));
    assert.ok(text(v.$('.diff-lines, .idiff')).includes('new source'));
    colourAll();
    await v.rerender(h(Component, { file: file('/repo/recovered.ts', '@@ -2 +2 @@\n-recovered source\n+recovered result') }));
    await settle();
    assert.ok(text(v.$('.diff-lines, .idiff')).includes('recovered source'));
    assert.ok(v.$$('span[style]').some((span) => span.style.color === '#abc'));
    await v.unmount();
  });
}

for (const Component of [DiffLines, InlineDiff]) {
  test(`${Component.name} clears old theme colors and ignores replaced tokenizer results`, async () => {
    colourAll();
    const f = file('/repo/theme.ts', '@@ -2 +2 @@\n-old\n+new');
    const v = await render(h(Component, { file: f }));
    try {
      await settle();
      assert.ok(v.$$('span[style]').some((s) => s.style.color === '#abc'));
      let release!: (tokens: [string, string][][]) => void;
      impl['hl:tokenizeLines'] = () =>
        new Promise((r) => {
          release = r;
        });
      dark = false;
      await v.rerender(h(Component, { file: f }));
      assert.ok(!v.$$('span[style]').some((s) => s.style.color === '#abc'));
      assert.equal(callsTo('hl:tokenizeLines').at(-1)![2], false);
      colourAll();
      await v.rerender(h(Component, { file: file('/repo/latest.ts', '@@ -2 +2 @@\n-current\n+latest') }));
      await settle();
      await settle(() => release([[['stale', '#f00']], [['obsolete', '#f00']]]));
      assert.ok(text(v.$('.diff-lines, .idiff')).includes('current'));
      assert.ok(!text(v.$('.diff-lines, .idiff')).includes('stale'));
    } finally {
      await v.unmount();
    }
  });
}

test('inline diff copies missing-newline markers without adding rendered rows', async () => {
  const f = file('/repo/x.txt', '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  const v = await render(h(InlineDiff, { file: f, cwd: '/repo' }));
  await settle(() => v.$('.idiff-copy')!.click());
  assert.equal(clipboard[0], '-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file');
  assert.equal(v.$$('.idiff-row').length, 2);
  await v.unmount();
});

test('encoded binary patch records parse as a binary file with no lines', () => {
  const binary = parseUnifiedDiff('diff --git a/image.bin b/image.bin\nGIT binary patch\nliteral 0\nHcmV?d00001\n')[0];
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.lines, []);
});

test('a file merged from two edits of the same lines keeps one split row per change (no duplicate keys)', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
  try {
    // two edits of line 1, merged as a turn's chat diff is when it has no aggregate diff (src/lib/turnDiff.ts)
    const second = file('m.txt', '@@ -1 +1 @@\n-c\n+d').lines;
    const merged = { path: 'm.txt', added: 2, removed: 2, lines: [...file('m.txt', '@@ -1 +1 @@\n-a\n+b').lines, ...second] };
    const v = await render(h(SplitDiff, { file: merged }));
    assert.deepEqual(
      v.$$('.split-row .idiff-row.add .idiff-code').map((c) => text(c)),
      ['b', 'd'],
    );
    await v.rerender(h(SplitDiff, { file: { ...merged, lines: second } }));
    assert.deepEqual(
      v.$$('.split-row .idiff-row.add .idiff-code').map((c) => text(c)),
      ['d'],
    );
    await v.unmount();
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    errors.filter((e) => /same key/.test(e)),
    [],
  );
});

test('inline and split views say a new file the Host left out for its size is too large to show (#5277)', async () => {
  const large = parseUnifiedDiff('diff --git a/big.txt b/big.txt\nnew file mode 100644\nLarge file, not shown: 1200000 bytes\n')[0];
  assert.equal(large.tooLarge, 1_200_000);
  const v = await render(h(InlineDiff, { file: large }));
  assert.equal(text(v.$('.diff-binary')), 'File too large to show (1.2 MB)');
  await v.rerender(h(SplitDiff, { file: large }));
  assert.equal(text(v.$('.diff-binary')), 'File too large to show (1.2 MB)');
  const small = parseUnifiedDiff('diff --git a/m.txt b/m.txt\nnew file mode 100644\nLarge file, not shown: 300000 bytes\n')[0];
  await v.rerender(h(InlineDiff, { file: small }));
  assert.equal(text(v.$('.diff-binary')), 'File too large to show (300 KB)');
  // the copied diff and the Viewed fingerprint keep the placeholder: a copy says too large (not an empty file), a grown file is a new fingerprint
  assert.equal(diffFileText(large), 'diff --git a/big.txt b/big.txt\nnew file mode 100644\nLarge file, not shown: 1200000 bytes\n');
  assert.notEqual(diffFingerprint(large), diffFingerprint({ ...large, tooLarge: 5_000_000 }));
  assert.equal(
    diffFileText({ ...large, isNew: false, mode: undefined }),
    'diff --git a/big.txt b/big.txt\nLarge file, not shown: 1200000 bytes\n',
  );
  // the same words inside a hunk are file content, not a placeholder
  const inside = parseUnifiedDiff('diff --git a/n.txt b/n.txt\n@@ -1 +1 @@\n-a\n+b\n Large file, not shown: 9 bytes\n')[0];
  assert.equal(inside.tooLarge, undefined);
  await v.unmount();
});

test('inline and split views label binary changes and copying does not produce an empty diff', async () => {
  const binary = parseUnifiedDiff('diff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n')[0];
  const v = await render(h(InlineDiff, { file: binary }));
  assert.equal(text(v.$('.diff-binary')), 'Binary file');
  await settle(() => v.$('.idiff-copy')!.click());
  assert.match(clipboard[0], /Binary files a\/image.bin and b\/image.bin differ/);
  await v.rerender(h(InlineDiff, { file: binary, bare: true }));
  assert.equal(text(v.$('.diff-binary')), 'Binary file');
  await v.rerender(h(InlineDiff, { file: file('text.txt', '@@ -1 +1 @@\n-a\n+b') }));
  assert.equal(v.$('.diff-binary'), null);
  assert.equal(v.$$('.idiff-row').length, 2);
  await v.rerender(h(SplitDiff, { file: binary }));
  assert.equal(text(v.$('.diff-binary')), 'Binary file');
  await v.rerender(h(SplitDiff, { file: file('text.txt', '@@ -1 +1 @@\n-a\n+b') }));
  assert.equal(v.$('.diff-binary'), null);
  assert.equal(v.$$('.split-row').length, 1);
  await v.unmount();
});
