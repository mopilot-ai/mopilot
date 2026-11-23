// A reply's Markdown in the Chrome side panel (electron/chrome-extension/src/panelMarkdown.mjs): the blocks and inline marks it knows, links only to web pages, and nothing a reply says ever becomes HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './support/side-panel-page.ts';

const { markdown, inline } = await import('../electron/chrome-extension/src/panelMarkdown.mjs');

// HTML DOM tagName is uppercase; a lowercase fake hides list grouping failures in Chrome.
const doc = { createElement: el, createTextNode: (text: string) => ({ textContent: text }) };
/** A node as a short string: its tag and what's in it; text as itself. */
const shape = (n: any): any =>
  n.tagName
    ? { [n.tagName.toLowerCase()]: n.children.length ? n.children.map(shape) : n.text, ...(n.attrs.href ? { href: n.attrs.href } : {}) }
    : n.textContent;

test('paragraphs, a heading, lists of each kind and a code block', () => {
  const md = [
    '## Top stories',
    'The first line',
    'and its second.',
    '',
    '- one',
    '- two',
    '1. first',
    '2. second',
    '```js',
    'const a = "<b>";',
    '',
    '```',
    'after',
  ].join('\n');
  assert.deepEqual(markdown(doc, md).map(shape), [
    { p: ['Top stories'] },
    // a line break within a paragraph is kept, as the app shows it
    { p: ['The first line', { br: '' }, 'and its second.'] },
    { ul: [{ li: ['one'] }, { li: ['two'] }] },
    { ol: [{ li: ['first'] }, { li: ['second'] }] },
    { pre: [{ code: 'const a = "<b>";\n' }] },
    { p: ['after'] },
  ]);
  assert.equal(markdown(doc, '# h')[0].className, 'h');
  // a block not closed runs to the end
  assert.deepEqual(markdown(doc, 'x\n```\ncode').map(shape), [{ p: ['x'] }, { pre: [{ code: 'code' }] }]);
});

test('inline code, bold, italic and a link to a web page; any other link stays text', () => {
  assert.deepEqual(inline(doc, 'Run `npm test` **now**, *then* see [the docs](https://a.example/d).').map(shape), [
    'Run ',
    { code: 'npm test' },
    ' ',
    { strong: 'now' },
    ', ',
    { em: 'then' },
    ' see ',
    { a: 'the docs', href: 'https://a.example/d' },
    '.',
  ]);
  const [a] = inline(doc, '[x](http://b.example)');
  assert.equal(a.attrs.rel, 'noopener noreferrer');
  assert.equal(a.attrs.target, '_blank');
  // a script or file link is the text it was
  assert.deepEqual(inline(doc, '[click](javascript:alert(1))').map(shape), ['[click](javascript:alert(1))']);
  // an address with (…) in it, as Wikipedia's
  assert.deepEqual(inline(doc, '[Rust](https://en.wikipedia.org/wiki/Rust_(language)).').map(shape), [
    { a: 'Rust', href: 'https://en.wikipedia.org/wiki/Rust_(language)' },
    '.',
  ]);
  assert.deepEqual(inline(doc, 'plain').map(shape), ['plain']);
});

test('markup in a reply is text, never HTML', () => {
  const [p] = markdown(doc, '<img src=x onerror=alert(1)> **<b>bold</b>**');
  assert.deepEqual(shape(p), { p: ['<img src=x onerror=alert(1)> ', { strong: '<b>bold</b>' }] });
});

test('a table reads as a table in a box that scrolls sideways, its cells’ marks kept and their text only text', () => {
  const md = [
    'Before',
    '| Item | Meaning |',
    '|---|:-:|',
    '| Free cancel | **by 11/24** |',
    '| Pipe \\| inside | `<b>` |',
    'short | row | extra',
    '',
    'After',
  ].join('\n');
  assert.deepEqual(markdown(doc, md).map(shape), [
    { p: ['Before'] },
    {
      div: [
        {
          table: [
            { thead: [{ tr: [{ th: ['Item'] }, { th: ['Meaning'] }] }] },
            {
              tbody: [
                { tr: [{ td: ['Free cancel'] }, { td: [{ strong: 'by 11/24' }] }] },
                // an escaped pipe stays in its cell; a row's cells past the header's are dropped
                { tr: [{ td: ['Pipe | inside'] }, { td: [{ code: '<b>' }] }] },
                { tr: [{ td: ['short'] }, { td: ['row'] }] },
              ],
            },
          ],
        },
      ],
    },
    { p: ['After'] },
  ]);
  assert.equal(markdown(doc, '| a |\n|---|')[0].className, 'table');
  // a header alone: no body; a missing cell is empty
  assert.deepEqual(markdown(doc, '| a | b |\n| - | - |\n| 1 |').map(shape), [
    { div: [{ table: [{ thead: [{ tr: [{ th: ['a'] }, { th: ['b'] }] }] }, { tbody: [{ tr: [{ td: ['1'] }, { td: '' }] }] }] }] },
  ]);
  assert.deepEqual(markdown(doc, 'a | b\n--- | ---').map(shape), [
    { div: [{ table: [{ thead: [{ tr: [{ th: ['a'] }, { th: ['b'] }] }] }] }] },
  ]);
  // not a table: a delimiter row of another width, a pipe with no delimiter after it, or one inside a code block
  assert.deepEqual(markdown(doc, '| a | b |\n|---|').map(shape), [{ p: ['| a | b |', { br: '' }, '|---|'] }]);
  assert.deepEqual(markdown(doc, 'a | b').map(shape), [{ p: ['a | b'] }]);
  assert.deepEqual(markdown(doc, '```\n| a |\n|---|\n```').map(shape), [{ pre: [{ code: '| a |\n|---|' }] }]);
});

test('a numbered list with blank lines between its items is one list, counting from its first number', () => {
  const md = ['1. Open the page', '', '2. Pick 11/27', '', '3. Check the price', '', 'Then tell me.'].join('\n');
  assert.deepEqual(markdown(doc, md).map(shape), [
    { ol: [{ li: ['Open the page'] }, { li: ['Pick 11/27'] }, { li: ['Check the price'] }] },
    { p: ['Then tell me.'] },
  ]);
  const later = markdown(doc, '3. third\n4. fourth');
  assert.equal(later[0].attrs.start, '3');
  assert.equal(markdown(doc, '1. first')[0].attrs.start, undefined);
  // a paragraph between items ends the list: the next item starts another
  assert.deepEqual(markdown(doc, '- a\ntext\n- b').map(shape), [{ ul: [{ li: ['a'] }] }, { p: ['text'] }, { ul: [{ li: ['b'] }] }]);
});

test('repeated malformed table delimiters with long whitespace render without quadratic backtracking', () => {
  const text = 'Header |\n' + ' '.repeat(19_000) + 'x';
  const started = performance.now();
  for (let i = 0; i < 100; i++) {
    const nodes = markdown(doc, text);
    assert.ok(nodes.length > 0);
    assert.ok(!nodes.some((n: any) => n.className === 'table'));
  }
  assert.ok(performance.now() - started < 2000, '100 bounded rerenders must finish within two seconds');
});
