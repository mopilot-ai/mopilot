// Superagent intake text cleaning, applied once when an event arrives so nothing downstream sees raw GitHub text.
// Strip list follows anthropics/claude-code-action src/github/utils/sanitizer.ts: invisible characters, HTML comments, text hidden in
// image alt text, link titles and attributes, entity tricks, and GitHub tokens. The code here is our own.

const { prefixUnits } = require('../../../shared/textPrefix.mjs');

const MAX_TEXT = 20_000;

// zero-width, bidi controls, word joiner, soft hyphen, BOM, the Unicode tag block, and other C0/C1 controls (keeps \t \n \r)
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁯­﻿\u{E0000}-\u{E007F}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** &#65; and &#x41; written out, so what they hide is seen by the other steps. */
function decodeNumericEntities(text) {
  const char = (code) => (Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');
  return text.replace(/&#(\d{1,7});/g, (_, d) => char(Number(d))).replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => char(Number.parseInt(h, 16)));
}

/**
 * Cleans untrusted text: the order matters (entities first, so the later steps see what they hide).
 * @param {unknown} input
 * @returns {string}
 */
function sanitize(input) {
  if (typeof input !== 'string') return '';
  let t = decodeNumericEntities(input);
  t = t.replace(INVISIBLE, '');
  t = t.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  // ![alt text](url "title") -> ![](url): alt text and titles are where instructions hide from readers
  t = t.replace(/!\[[^\]]*\]\(([^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g, '![]($1)');
  t = t.replace(/\[([^\]]*)\]\(([^)\s]*)\s+(?:"[^"]*"|'[^']*')\)/g, '[$1]($2)');
  // attributes that carry text a reader never sees
  t = t.replace(/<[a-z][^>]*>/gi, (tag) =>
    tag.replace(/\s(?:alt|title|aria-label|aria-description|placeholder|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''),
  );
  t = t.replace(TOKEN, '[REDACTED_GITHUB_TOKEN]');
  return t.length > MAX_TEXT ? `${prefixUnits(t, MAX_TEXT)}\n[truncated]` : t;
}

module.exports = { sanitize, MAX_TEXT };
