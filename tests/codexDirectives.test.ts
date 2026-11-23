// Directives the official Codex app has the model write (see src/lib/codexDirectives.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

// src/ imports its siblings without the `.ts` extension (Vite resolves them); do the same here.
const { parseDirectives, directiveFromHref, stripDirectives, urlTransform } = await import('../src/lib/codexDirectives.ts');
const { normalizeMath, rehypePlugins, remarkPlugins } = await import('../src/lib/markdownMath.ts');

// The directives Markdown.tsx would render, in document order.
function render(text: string) {
  const { markdown, followups } = parseDirectives(text);
  const found: string[] = [];
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins,
        rehypePlugins,
        urlTransform,
        components: {
          a: ({ href, children }) => {
            const d = directiveFromHref(href);
            if (!d) return createElement('a', { href }, children);
            found.push(`${d.name} ${JSON.stringify(d.attrs)}`);
            return createElement('x-directive');
          },
        },
      },
      normalizeMath(markdown),
    ),
  );
  return { html, found, followups: followups.map((f) => [f.label, f.attrs.prompt]) };
}

test('file citations and annotations become directive links', () => {
  const r = render(
    'The totals come from the report :codex-file-citation{path="/tmp/demo/q3_report.pdf" purpose="source"}.\nIt is due Friday.:codex-annotation{index="2"}',
  );
  assert.deepEqual(r.found, ['file-citation {"path":"/tmp/demo/q3_report.pdf","purpose":"source"}', 'annotation {"index":"2"}']);
  assert.match(r.html, /report <x-directive><\/x-directive>\.<br\/>\nIt is due Friday\.<x-directive>/);
  assert.doesNotMatch(r.html, /codex-/);
});

test('citation attributes with spaces, parentheses, underscores and dollars survive', () => {
  const path = '/tmp/demo/My Notes (v2)/cost_$5_*draft*.md';
  const r = render(`See :codex-file-citation{path="${path}" purpose="source" page_number="3"}`);
  assert.deepEqual(r.found, [`file-citation ${JSON.stringify({ path, purpose: 'source', page_number: '3' })}`]);
});

test('backslash escapes in quoted values; Windows paths keep their backslashes', () => {
  const r = render(String.raw`:codex-file-citation{path="C:\Users\demo\a \"b\".txt"}`);
  assert.deepEqual(r.found, [`file-citation ${JSON.stringify({ path: 'C:\\Users\\demo\\a "b".txt' })}`]);
});

test('follow-ups are lifted out, including their now-empty lines', () => {
  const text = [
    'Done. The parser now handles nested lists.',
    '',
    ':codex-followup[Add tests]{prompt="Add unit tests for the list parser"}',
    '- :codex-followup[Run `npm test`]{prompt="Run `npm test` and fix any {failures} [if any]"}',
    ':codex-followup[Explain]{prompt="Explain the change"} :codex-followup[Ship it]{prompt="Open a PR"}',
  ].join('\n');
  const r = render(text);
  assert.deepEqual(r.followups, [
    ['Add tests', 'Add unit tests for the list parser'],
    ['Run `npm test`', 'Run `npm test` and fix any {failures} [if any]'],
    ['Explain', 'Explain the change'],
    ['Ship it', 'Open a PR'],
  ]);
  assert.equal(parseDirectives(text).markdown, 'Done. The parser now handles nested lists.');
});

test('directives inside code stay literal', () => {
  const text = 'Write `:codex-annotation{index="1"}` like so:\n\n```md\n:codex-followup[A]{prompt="b"}\n```\n';
  const r = render(text);
  assert.deepEqual(r.found, []);
  assert.deepEqual(r.followups, []);
  assert.match(r.html, /<code>:codex-annotation\{index=&quot;1&quot;\}<\/code>/);
  assert.match(r.html, /:codex-followup\[A\]\{prompt=&quot;b&quot;\}/);
});

test('a directive still streaming in is hidden', () => {
  assert.equal(parseDirectives('All set. :codex-followup[Next ste').markdown, 'All set. ');
  assert.equal(parseDirectives('All set. :codex-file-citation{path="/tmp/de').markdown, 'All set. ');
  assert.equal(parseDirectives('Ratio a:b and see :codex-unknown{x="1"}').markdown, 'Ratio a:b and see :codex-unknown{x="1"}');
});

test('other links are still sanitized', () => {
  assert.equal(urlTransform('javascript:alert(1)'), '');
  assert.equal(urlTransform('https://example.com/a'), 'https://example.com/a');
});

test('stripDirectives converts for export and previews', () => {
  const text =
    'Summary from :codex-file-citation{path="/tmp/demo/a [1].txt" purpose="source"}:codex-annotation{index="1"}\n:codex-followup[More]{prompt="Tell me more"}';
  assert.equal(stripDirectives(text), 'Summary from [a \\[1\\].txt](</tmp/demo/a [1].txt>)');
  assert.equal(stripDirectives(text, true), 'Summary from a [1].txt');
});

const visual = (data: unknown) => `\uE200visualize\uE202${JSON.stringify(data)}\uE201`;

test('visualization references become renderable directives alongside citations', () => {
  const attrs = { path: '/tmp/My Preview [v2].html', mode: 'wide', title: 'Control preview' };
  const result = render(`Before.\n\n${visual(attrs)}\n\nAfter. :codex-file-citation{path="/tmp/design.md"}`);
  assert.deepEqual(result.found, [`visualize ${JSON.stringify(attrs)}`, 'file-citation {"path":"/tmp/design.md"}']);
  assert.match(result.html, /Before\./);
  assert.match(result.html, /After\./);
  assert.doesNotMatch(result.html, /[\uE200-\uE202]|My Preview|"mode"/);
});

test('visualization JSON preserves Windows paths and accepts only string display attributes', () => {
  const path = 'C:\\Users\\demo\\a "b".html';
  assert.deepEqual(render(visual({ path, mode: 5, title: null, extra: 'ignored' })).found, [`visualize ${JSON.stringify({ path })}`]);
});

test('visualization references inside inline and fenced code remain examples', () => {
  const marker = visual({ path: '/tmp/demo.html' });
  const text = `Use \`${marker}\`.\n\n~~~text\n${marker}\n~~~`;
  assert.deepEqual(render(text).found, []);
  assert.equal(parseDirectives(text).markdown, text);
  assert.equal(stripDirectives(text), text);
});

test('every streaming prefix stays hidden until the visualization is complete', () => {
  const marker = visual({ path: '/tmp/demo.html', mode: 'wide' });
  for (let i = 1; i < marker.length; i++) {
    assert.equal(parseDirectives(`Before.\n\n${marker.slice(0, i)}`).markdown, 'Before.', `prefix ${i}`);
  }
  assert.equal(render(marker).found.length, 1);
});

test('malformed visualization payloads do not leak protocol text or swallow adjacent prose', () => {
  for (const payload of ['{broken}', 'null', '5', '[]']) {
    const text = `Before.\n\n\uE200visualize\uE202${payload}\uE201\n\nAfter.`;
    const result = render(text);
    assert.deepEqual(result.found, []);
    assert.match(result.html, /Before\./);
    assert.match(result.html, /After\./);
    assert.doesNotMatch(result.html, /[\uE200-\uE202]|broken/);
  }
});

test('multiple previews retain document order and export as useful file links', () => {
  const first = visual({ path: '/tmp/a [1].html' });
  const second = visual({ path: '/tmp/b.html' });
  assert.deepEqual(render(`${first}\n\n${second}`).found, ['visualize {"path":"/tmp/a [1].html"}', 'visualize {"path":"/tmp/b.html"}']);
  assert.equal(stripDirectives(first), '[a \\[1\\].html](</tmp/a [1].html>)');
  assert.equal(stripDirectives(first, true), 'a [1].html');
});

test('unfinished directive examples inside open code blocks remain literal', () => {
  for (const text of ['```text\n:codex-followup[Example', '~~~~\n:codex-annotation{index="1"']) {
    assert.deepEqual(parseDirectives(text), { markdown: text, followups: [] });
    assert.equal(stripDirectives(text), text);
  }
});

test('indented and nested code remain examples while indented paragraph continuations stay prose', () => {
  const directive = ':codex-followup[Go]{prompt="go"}';
  for (const text of [`    ${directive}`, `> \`\`\`\n> ${directive}\n> \`\`\``]) {
    assert.deepEqual(parseDirectives(text), { markdown: text, followups: [] });
    assert.equal(stripDirectives(text), text);
  }
  assert.equal(parseDirectives(`before\n    ${directive}`).followups.length, 1);
});
