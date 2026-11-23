// Renders through the same remark/rehype plugins as src/components/markdown/Markdown.tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { normalizeMath, rehypePlugins, remarkPlugins } from '../src/lib/markdownMath.ts';

const md = String.raw;

function render(text: string) {
  const warnings: unknown[][] = [];
  const { warn, error } = console;
  console.warn = console.error = (...args: unknown[]) => void warnings.push(args);
  try {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, normalizeMath(text)));
    return { html, warnings, tex: texOf(html), display: (html.match(/class="katex-display"/g) ?? []).length };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

// The TeX source KaTeX rendered, one entry per formula.
function texOf(html: string) {
  return [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map((m) => m[1]);
}

test('currency next to CJK text stays plain text without KaTeX warnings', () => {
  const r = render('苹果 $10 一斤，香蕉 $20 一串。');
  assert.deepEqual(r.tex, []);
  assert.equal(r.html, '<p>苹果 $10 一斤，香蕉 $20 一串。</p>');
  assert.deepEqual(r.warnings, []);
});

test('other currency shapes stay plain text', () => {
  for (const s of ['price is $5 and $10', 'from $1,200.50 to $3,400 (USD)', 'a $ b $ c', 'Total: $30, i.e. 3 × $10.']) {
    const r = render(s);
    assert.deepEqual(r.tex, [], s);
    assert.ok(!r.html.includes('katex'), s);
  }
});

test('single-dollar math is not math anymore (same as Codex)', () => {
  assert.deepEqual(render('$x^2$').tex, []);
});

test('$$…$$ inline and block still render', () => {
  const inline = render('area is $$\\pi r^2$$ here');
  assert.deepEqual(inline.tex, ['\\pi r^2']);
  assert.equal(inline.display, 0);

  const block = render('$$\nE=mc^2\n$$');
  assert.deepEqual(block.tex, ['E=mc^2']);
  assert.equal(block.display, 1);
});

test('\\(…\\) renders as inline math', () => {
  const r = render(md`Inline \(a^2+b^2=c^2\) done.`);
  assert.deepEqual(r.tex, ['a^2+b^2=c^2']);
  assert.equal(r.display, 0);
  assert.match(r.html, /^<p>Inline <span class="katex">/);
  assert.match(r.html, / done\.<\/p>$/);
});

test('\\(…\\) may wrap across a single line break but not a paragraph break', () => {
  assert.deepEqual(render(md`see \(a +` + '\n' + md`b\) ok`).tex, ['a +\nb']);
  assert.deepEqual(render(md`see \(a` + '\n\n' + md`b\) ok`).tex, []);
});

test('\\[…\\] on its own lines renders as display math', () => {
  const r = render(md`Display:` + '\n\n' + md`\[` + '\n' + md`\int_0^1 x\,dx` + '\n' + md`\]` + '\n\nafter');
  assert.deepEqual(r.tex, [md`\int_0^1 x\,dx`]);
  assert.equal(r.display, 1);
  assert.match(r.html, /<p>after<\/p>$/);
});

test('\\[…\\] on one line, including inside a list item', () => {
  assert.equal(render(md`\[ y = mx + b \]`).display, 1);

  const r = render('- item\n\n  ' + md`\[ y = mx \]` + '\n- next');
  assert.deepEqual(r.tex, ['y = mx']);
  assert.equal(r.display, 1);
  assert.match(r.html, /<li>\s*<p>item<\/p>\s*<span class="katex-display">[\s\S]*<\/li>\s*<li>\s*<p>next<\/p>/);
});

test('mid-line \\[…\\] renders as inline math', () => {
  const r = render(md`so \[x = 1\] holds`);
  assert.deepEqual(r.tex, ['x = 1']);
  assert.equal(r.display, 0);
});

test('currency and math in the same message', () => {
  const r = render(md`Costs: $10 + $20 = $30, and \(x^2\) is math.`);
  assert.deepEqual(r.tex, ['x^2']);
  assert.match(r.html, /^<p>Costs: \$10 \+ \$20 = \$30, and <span class="katex">/);
  assert.deepEqual(r.warnings, []);
});

test('inline code is left untouched', () => {
  const r = render(md`code ` + '`' + md`\(x\)` + '` and ``a ` ' + md`\[y\]` + '`` then ' + md`\(z\)`);
  assert.deepEqual(r.tex, ['z']);
  assert.ok(r.html.includes(md`<code>\(x\)</code>`));
  assert.ok(r.html.includes(md`<code>a ` + '` ' + md`\[y\]</code>`));
});

test('fenced code blocks are left untouched', () => {
  for (const fence of ['```', '~~~', '````']) {
    const r = render(`${fence}ts\n` + md`const s = '\(x\)' + '\[y\]';` + `\n${fence}\nafter ` + md`\(z\)`);
    assert.deepEqual(r.tex, ['z'], fence);
    assert.ok(r.html.includes(md`\(x\)`) && r.html.includes(md`\[y\]`), fence);
  }
  // a shorter fence inside a longer one doesn't close it
  const nested = render('````md\n```\n' + md`\(x\)` + '\n```\n````');
  assert.deepEqual(nested.tex, []);
});

test('escaped backslashes are not delimiters', () => {
  const r = render(md`a literal \\(x\\) here`);
  assert.deepEqual(r.tex, []);
});

test('unclosed delimiters while streaming render as text', () => {
  assert.deepEqual(render(md`partial \(a^2 + `).tex, []);
  assert.deepEqual(render(md`\[` + '\n' + md`\int`).tex, []);
});

test('normalizeMath returns input unchanged when there are no backslash delimiters', () => {
  const s = 'plain $5 text with `code` and $$x$$';
  assert.equal(normalizeMath(s), s);
});

test('indented code keeps math delimiters while paragraph continuation math still renders', () => {
  assert.equal(normalizeMath('    \\(x\\)'), '    \\(x\\)');
  assert.equal(normalizeMath('before\n    \\(x\\)'), 'before\n    $$x$$');
});
