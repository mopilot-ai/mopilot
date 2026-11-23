// The Chrome side panel's richer reply Markdown (electron/chrome-extension/src/panelMarkdown.mjs, panelImage.mjs): heading levels, nested lists, quotes and images, with nothing a reply says becoming HTML or loading unasked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './support/side-panel-page.ts';

const { markdown, inline } = await import('../electron/chrome-extension/src/panelMarkdown.mjs');
const { imageAllowed, imageNode } = await import('../electron/chrome-extension/src/panelImage.mjs');

const doc = { createElement: el, createTextNode: (text: string) => ({ textContent: text }) };
/** A node as a short string: its tag and what's in it; text as itself. */
const shape = (n: any): any =>
  n.tagName ? { [n.tagName.toLowerCase()]: n.children.length ? n.children.map(shape) : n.text } : n.textContent;
/** How many lists or quotes sit inside each other, at the deepest. */
const depth = (n: any, tag: string): number =>
  (n.children ?? []).reduce((d: number, c: any) => Math.max(d, depth(c, tag)), 0) +
  (tag.split('|').includes(n.tagName?.toLowerCase()) ? 1 : 0);
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('headings carry their level, and a line that is not one stays a paragraph', () => {
  const [h1, h2, h3, h6] = markdown(doc, ['# One', '## Two *marked*', '### Three', '###### Six'].join('\n'));
  assert.deepEqual(
    [h1, h2, h3, h6].map((h) => [h.tagName, h.className, h.attrs.role, h.attrs['aria-level']]),
    [1, 2, 3, 6].map((n) => ['P', 'h', 'heading', String(n)]),
  );
  assert.deepEqual(shape(h2), { p: ['Two ', { em: 'marked' }] });
  // seven marks or no space after them are text
  assert.deepEqual(markdown(doc, '####### seven\n#tag').map(shape), [{ p: ['####### seven', { br: '' }, '#tag'] }]);
});

test('lists nest by indentation, each depth its own list under its parent item', () => {
  const md = ['- one', '  - nested a', '  - nested b', '    1. deep', '- two', '1. other kind'].join('\n');
  assert.deepEqual(markdown(doc, md).map(shape), [
    {
      ul: [{ li: ['one', { ul: [{ li: ['nested a'] }, { li: ['nested b', { ol: [{ li: ['deep'] }] }] }] }] }, { li: ['two'] }],
    },
    { ol: [{ li: ['other kind'] }] },
  ]);
  // a tab is four spaces; a blank line between items keeps the nesting going
  assert.deepEqual(markdown(doc, '- a\n\n\t- b\n\n- c').map(shape), [{ ul: [{ li: ['a', { ul: [{ li: ['b'] }] }] }, { li: ['c'] }] }]);
  // the other kind at a nested depth is a list beside the one before, inside the same item
  assert.deepEqual(markdown(doc, '- a\n  - b\n  1. c').map(shape), [
    { ul: [{ li: ['a', { ul: [{ li: ['b'] }] }, { ol: [{ li: ['c'] }] }] }] },
  ]);
  // a first item that is indented and a later one at the margin are one list; a numbered list keeps its start
  assert.deepEqual(markdown(doc, '  - a\n- b').map(shape), [{ ul: [{ li: ['a'] }, { li: ['b'] }] }]);
  const [ol] = markdown(doc, '3. x\n   - y');
  assert.equal(ol.attrs.start, '3');
  // any other line ends the list
  assert.deepEqual(
    markdown(doc, '- a\ntext\n  - b')
      .map(shape)
      .map((b) => Object.keys(b)[0]),
    ['ul', 'p', 'ul'],
  );
});

test('lists and quotes stop nesting at a fixed depth, however deep a reply goes', () => {
  const deep = Array.from({ length: 20 }, (_, i) => `${' '.repeat(i * 2)}- level ${i}`).join('\n');
  const lists = markdown(doc, deep);
  assert.equal(lists.length, 1);
  assert.equal(depth(lists[0], 'ul'), 6);
  // the other kind at the deepest level stays at that level
  const kinds = markdown(doc, `${deep}\n${' '.repeat(40)}1. x`);
  assert.equal(depth(kinds[0], 'ul|ol'), 6);
  const quotes = markdown(doc, `${'>'.repeat(30)} end`);
  assert.equal(depth(quotes[0], 'blockquote'), 6);
  // what is left after the last quote is the text it is
  assert.match(JSON.stringify(shape(quotes[0])), />>>/);
});

test('a quote is the run of lines that start with ">", read as Markdown of its own', () => {
  const md = ['intro', '> a', '> b', '', '> - x', '> > inner', 'after', '>', '>no space'].join('\n');
  assert.deepEqual(markdown(doc, md).map(shape), [
    { p: ['intro'] },
    { blockquote: [{ p: ['a', { br: '' }, 'b'] }] },
    { blockquote: [{ ul: [{ li: ['x'] }] }, { blockquote: [{ p: ['inner'] }] }] },
    { p: ['after'] },
    { blockquote: [{ p: ['no space'] }] },
  ]);
  // a fence keeps its ">" lines as code
  assert.deepEqual(markdown(doc, '```\n> not a quote\n```').map(shape), [{ pre: [{ code: '> not a quote' }] }]);
});

test('an image of a reply: a data: raster is drawn at once, its alt text only text', () => {
  const [img] = inline(doc, `![A <b>chart</b>](${PNG})`);
  assert.equal(img.tagName, 'IMG');
  assert.deepEqual(img.attrs, { src: PNG, alt: 'A <b>chart</b>', referrerpolicy: 'no-referrer' });
  // no alt text: a word for it
  assert.equal(inline(doc, `![](${PNG})`)[0].attrs.alt, 'Image');
  // beside text and other marks; inside a table cell too
  assert.deepEqual(
    inline(doc, `a ![x](${PNG}) **b**`).map((n: any) => n.tagName ?? n.textContent),
    ['a ', 'IMG', ' ', 'STRONG'],
  );
  const table = markdown(doc, `| h |\n| - |\n| ![x](${PNG}) |`)[0];
  assert.equal(JSON.stringify(shape(table)).includes('"img"'), true);
});

test('an https: image waits behind a button naming its host; a click draws it, and it stays drawn', () => {
  const url = 'https://img.example/pics/cat.png?token=1';
  const [box] = inline(doc, `![A cat](${url})`);
  assert.equal(box.className, 'img-box');
  const [ask] = box.children;
  assert.deepEqual(
    [ask.tagName, ask.type, ask.className, ask.textContent, ask.title],
    ['BUTTON', 'button', 'img-load', 'Show image: A cat', 'Loads from img.example'],
  );
  // nothing is requested: no element with the address exists until the click
  assert.equal(JSON.stringify(shape(box)).includes('img.example'), false);
  ask.listeners.click();
  assert.equal(box.children.length, 1);
  assert.deepEqual(box.children[0].attrs, { src: url, alt: 'A cat', referrerpolicy: 'no-referrer' });
  // drawn again (the live reply is drawn anew with each word): no second click
  assert.equal(inline(doc, `![A cat](${url})`)[0].tagName, 'IMG');
  // another address still asks, with a word for no alt text
  const other = imageNode(doc, '', 'https://img.example/other.png');
  assert.equal(other.children[0].textContent, 'Show image: Image');
});

test('only https: and data: rasters are images; anything else stays the text it is', () => {
  for (const url of [
    'http://a.example/x.png',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,PGI+',
    'https://',
    'file:///etc/passwd',
    '//a.example/x.png',
  ]) {
    assert.equal(imageAllowed(url), false, url);
    assert.deepEqual(inline(doc, `![x](${url})`).map(shape), [`![x](${url})`], url);
  }
  for (const url of [
    PNG,
    'data:image/jpeg;base64,/9j/4AAQ',
    'data:image/webp;base64,UklGR',
    'data:image/GIF;base64,R0lGOD',
    'https://a.example/x.png',
  ]) {
    assert.equal(imageAllowed(url), true, url);
  }
  // a plain link is still a link, and a link's text is not an image
  assert.deepEqual(
    inline(doc, '[a](https://a.example)').map((n: any) => n.tagName),
    ['A'],
  );
  assert.deepEqual(inline(doc, '[a](javascript:x)').map(shape), ['[a](javascript:x)']);
});
