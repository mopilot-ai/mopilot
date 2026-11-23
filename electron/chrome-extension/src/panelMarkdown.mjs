// A reply's Markdown as the side panel shows it (panelThread.mjs): paragraphs, headings, nested lists, quotes, code blocks, tables, and inline code, bold, italic, http(s) links and images (panelImage.mjs), built as DOM nodes whose text is only ever set as text.
//
// The reply is the agent's, and may quote a page: nothing in it becomes HTML. Anything this subset doesn't know stays
// as the text it is.

import { imageAllowed, imageNode } from './panelImage.mjs';

/** A link only to a web page; any other scheme stays text. */
const WEB = /^https?:\/\//i;
/** Inline marks, the earliest first: `code`, **bold**, *italic*, [text](url), ![alt](url); a url may hold one level of (…). */
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|!\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/;

/**
 * The inline marks of one line as nodes.
 * @param {any} doc @param {string} text
 * @returns {any[]}
 */
export function inline(doc, text) {
  const out = [];
  let rest = text;
  for (;;) {
    const m = INLINE.exec(rest);
    if (!m) break;
    if (m.index) out.push(doc.createTextNode(rest.slice(0, m.index)));
    let el;
    if (m[1] !== undefined) {
      el = doc.createElement('code');
      el.textContent = m[1];
    } else if (m[2] !== undefined) {
      el = doc.createElement('strong');
      el.textContent = m[2];
    } else if (m[3] !== undefined) {
      el = doc.createElement('em');
      el.textContent = m[3];
    } else if (m[7] !== undefined && imageAllowed(m[7])) el = imageNode(doc, m[6], m[7]);
    else if (m[5] !== undefined && WEB.test(m[5])) {
      el = doc.createElement('a');
      el.textContent = m[4];
      el.setAttribute('href', m[5]);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else el = doc.createTextNode(m[0]);
    out.push(el);
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(doc.createTextNode(rest));
  return out;
}

/** A table's delimiter row: `| --- | :-: |`, each cell dashes with an optional colon at either end. */
const delimiter = (line) => cells(line).every((cell) => /^:?-+:?$/.test(cell));

/** A table row's cells: the outer pipes dropped, split at each pipe that isn't escaped (`\|` is a pipe in a cell). */
export function cells(/** @type {string} */ line) {
  const row = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** A table (GFM): its header row, then its body rows, in a box that scrolls sideways when the table is wider than the panel. */
function table(/** @type {any} */ doc, /** @type {string[]} */ head, /** @type {string[][]} */ body) {
  const box = doc.createElement('div');
  box.className = 'table';
  const t = doc.createElement('table');
  const row = (/** @type {string[]} */ texts, /** @type {string} */ tag) => {
    const tr = doc.createElement('tr');
    // a body row has the header's number of cells: missing ones are empty, extra ones are dropped (as GFM reads them)
    for (let i = 0; i < head.length; i++) {
      const c = doc.createElement(tag);
      c.append(...inline(doc, texts[i] ?? ''));
      tr.append(c);
    }
    return tr;
  };
  const thead = doc.createElement('thead');
  thead.append(row(head, 'th'));
  t.append(thead);
  if (body.length) {
    const tbody = doc.createElement('tbody');
    tbody.append(...body.map((r) => row(r, 'td')));
    t.append(tbody);
  }
  box.append(t);
  return box;
}

/** How deep lists and quotes nest before the rest stays at that level (a hostile reply can't build an unbounded tree). */
const MAX_DEPTH = 6;

/** A line's leading width, a tab counting as four spaces. */
const widthOf = (/** @type {string} */ lead) => lead.replace(/\t/g, '    ').length;

/**
 * A reply's Markdown as block nodes.
 * @param {any} doc @param {string} text @param {number} [depth] how many quotes this text is inside
 * @returns {any[]}
 */
export function markdown(doc, text, depth = 0) {
  const blocks = [];
  const lines = String(text).split('\n');
  /** @type {any[]} the lists open at each depth ({ indent, kind, el }), while their items run */
  let lists = [];
  /** @type {string[]} the paragraph's lines, until a blank line or another block */
  let para = [];
  // a line break within a paragraph is one, as the app's replies show them (remark-breaks, src/lib/markdownMath.ts)
  const endPara = () => {
    if (!para.length) return;
    const p = doc.createElement('p');
    para.forEach((line, i) => {
      if (i) p.append(doc.createElement('br'));
      p.append(...inline(doc, line));
    });
    blocks.push(p);
    para = [];
  };
  /** The list for an item at `indent`: the one open at that depth, a deeper one inside the last item above, or a new top one. */
  const listFor = (/** @type {number} */ indent, /** @type {string} */ kind, /** @type {string | undefined} */ number) => {
    while (lists.length > 1 && indent < lists.at(-1).indent) lists.pop();
    // the first item may sit indented; a later one at the margin is the same list
    if (lists.length === 1 && indent < lists[0].indent) lists[0].indent = indent;
    const top = lists.at(-1);
    // as deep as lists go, an item stays at that depth
    if (top && lists.length >= MAX_DEPTH) indent = top.indent;
    if (top && indent === top.indent && top.kind === kind) return top.el;
    // the other kind at the same depth starts a list beside the one before
    if (top && indent === top.indent) lists.pop();
    const el = doc.createElement(kind);
    // a numbered list counts from its first number
    if (number !== undefined && Number(number) !== 1) el.setAttribute('start', String(Number(number)));
    const parent = lists.at(-1)?.el.lastChild;
    if (parent) parent.append(el);
    else blocks.push(el);
    lists.push({ indent, kind, el });
    return el;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```/.test(line);
    const item = /^(\s*)(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    // a blank line between items keeps the list going (a loose list); any other line ends it
    if (!item && line.trim()) lists = [];
    // a header row with a pipe, then a delimiter row with as many cells: a table, as long as rows with a pipe follow
    if (!fence && line.includes('|') && i + 1 < lines.length && delimiter(lines[i + 1])) {
      const head = cells(line);
      if (cells(lines[i + 1]).length === head.length) {
        endPara();
        const body = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) body.push(cells(lines[i]));
        i--;
        blocks.push(table(doc, head, body));
        continue;
      }
    }
    if (fence) {
      endPara();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = doc.createElement('pre');
      const c = doc.createElement('code');
      c.textContent = code.join('\n');
      pre.append(c);
      blocks.push(pre);
    } else if (depth < MAX_DEPTH && /^\s*>/.test(line)) {
      // a quote: the run of lines that start with ">", read as Markdown of their own
      endPara();
      const inner = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) inner.push(lines[i].replace(/^\s*> ?/, ''));
      i--;
      const quote = doc.createElement('blockquote');
      quote.append(...markdown(doc, inner.join('\n'), depth + 1));
      blocks.push(quote);
    } else if (item) {
      endPara();
      const li = doc.createElement('li');
      li.append(...inline(doc, item[3]));
      listFor(widthOf(item[1]), item[2] === undefined ? 'ul' : 'ol', item[2]).append(li);
    } else if (heading) {
      endPara();
      const h = doc.createElement('p');
      h.className = 'h';
      h.setAttribute('role', 'heading');
      h.setAttribute('aria-level', String(heading[1].length));
      h.append(...inline(doc, heading[2]));
      blocks.push(h);
    } else if (!line.trim()) endPara();
    else para.push(line.trim());
  }
  endPara();
  return blocks;
}
