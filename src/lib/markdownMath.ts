// Markdown plugins for messages (GFM, CJK emphasis, math, line breaks) and rewriting math delimiters outside code.

import type { Options } from 'react-markdown';
import { mapProse } from '../../shared/markdownProse.mjs';
export { mapProse } from '../../shared/markdownProse.mjs';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import rehypeKatex from 'rehype-katex';

export const remarkPlugins: NonNullable<Options['remarkPlugins']> = [
  remarkGfm,
  // CommonMark won't close `**` between punctuation and a CJK letter (`**星宇(JX)**的`)
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  [remarkMath, { singleDollarTextMath: false }],
  remarkBreaks,
];
export const rehypePlugins: NonNullable<Options['rehypePlugins']> = [rehypeKatex];

// Single `$` is too often currency ("costs $10 and $20") to treat as math, so (like Codex)
// only `$$…$$`, `\(…\)` and `\[…\]` render as math. remark-math doesn't parse the
// backslash forms, so rewrite them to `$$` outside of code.
export function normalizeMath(source: string): string {
  const md = normalizeAutolinks(source);
  if (!md.includes('\\(') && !md.includes('\\[')) return md;
  return mapProse(md, rewriteMath);
}

// GFM ends a bare URL only at whitespace or `<`, so `**https://a.com/x**，用…` swallows the closing `**`
// and the CJK text after it into the link. Bracket such URLs (`<…>`) where a `*` or non-ASCII char follows.
const BARE_URL_BEFORE_SWALLOW = /(?<![(<[\w])(https?:\/\/[^\s<>*\u0080-\uffff]+)(?=[*\u0080-\uffff])/g;

export function normalizeAutolinks(md: string): string {
  if (!md.includes('://')) return md;
  return mapProse(md, (prose) => prose.replace(BARE_URL_BEFORE_SWALLOW, '<$1>'));
}

function rewriteMath(s: string): string {
  return s
    .replace(/^([ \t]*)(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\][ \t]*$/gm, (_, ind, body) => `${ind}$$\n${ind}${body.trim()}\n${ind}$$`)
    .replace(/(?<!\\)\\\[((?:(?!\n\s*\n)[\s\S])+?)(?<!\\)\\\]/g, (_, body) => `$$${body.trim()}$$`)
    .replace(/(?<!\\)\\\(((?:(?!\n\s*\n)[\s\S])+?)(?<!\\)\\\)/g, (_, body) => `$$${body.trim()}$$`);
}
