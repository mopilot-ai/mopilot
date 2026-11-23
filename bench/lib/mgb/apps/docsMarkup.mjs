// MoPilot 12-Grid Bench (#1381) docs-wiki light markup: headings, bullets, paragraphs and safe links, rendered as
// escaped HTML so hostile page text (prompt injections, script tags, javascript: links) stays visible text.
import { html } from './kit.mjs';

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Whether a link target may become a link: http(s), or relative (no scheme, not protocol-relative). @param {string} url */
export const safeUrl = (url) => /^https?:\/\//i.test(url) || (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//'));

/** One line's text with its `[text](url)` links; unsafe links stay as their literal text. @param {string} line */
export function inline(line) {
  const out = [];
  let at = 0;
  for (const m of line.matchAll(LINK)) {
    out.push(line.slice(at, m.index));
    out.push(safeUrl(m[2]) ? html`<a href="${m[2]}">${m[1]}</a>` : m[0]);
    at = /** @type {number} */ (m.index) + m[0].length;
  }
  out.push(line.slice(at));
  return out;
}

/**
 * A page body as HTML: `# `/`## ` headings, `- ` bullets (consecutive ones form a list), other non-blank lines are
 * paragraphs. @param {string} body
 */
export function renderBody(body) {
  /** @type {unknown[]} */
  const blocks = [];
  /** @type {unknown[] | null} */
  let list = null;
  const close = () => {
    if (list) blocks.push(html`<ul>${list}</ul>`);
    list = null;
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      list ??= [];
      list.push(html`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    close();
    if (line.startsWith('## ')) blocks.push(html`<h3>${inline(line.slice(3))}</h3>`);
    else if (line.startsWith('# ')) blocks.push(html`<h2>${inline(line.slice(2))}</h2>`);
    else if (line.trim()) blocks.push(html`<p>${inline(line)}</p>`);
  }
  close();
  return html`<div class="doc">${blocks}</div>`;
}

/** A short excerpt of `body` around the first match of `q` (lowercase), or its start. @param {string} body @param {string} q */
export function snippet(body, q, width = 60) {
  const flat = body.replace(/\s+/g, ' ').trim();
  const at = q ? flat.toLowerCase().indexOf(q) : -1;
  const from = Math.max(0, at - width);
  const to = at < 0 ? width * 2 : at + q.length + width;
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}
