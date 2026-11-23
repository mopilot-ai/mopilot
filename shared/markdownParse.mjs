// The Markdown parser the phone draws a reply with and the code ranges are read from: CommonMark plus GFM tables, strikethrough and bare-URL links, with the CJK-friendly emphasis rule the Mac's renderer (remark-gfm, remark-cjk-friendly) applies, so one reply reads the same on both.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethroughCjkFriendly } from 'micromark-extension-cjk-friendly-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';

// The extension's own tokens only: its `transforms` rebuild links from text nodes without source offsets, which the reply's fade reads.
const { enter, exit } = gfmAutolinkLiteralFromMarkdown();

// a message of yours is not Markdown: only its addresses are read
const PLAIN = { extensions: [gfmAutolinkLiteral()], mdastExtensions: [{ enter, exit }] };

const OPTIONS = {
  extensions: [gfmTable(), gfmAutolinkLiteral(), cjkFriendlyExtension(), gfmStrikethroughCjkFriendly()],
  mdastExtensions: [gfmTableFromMarkdown(), { enter, exit }, gfmStrikethroughFromMarkdown()],
};

/** Full-width and curly punctuation (、。，「」【】！？：；… and quotes): never part of an address, however far into it it appears. */
const CJK_PUNCTUATION = /[\u2018-\u201f\u2026\u3001-\u3004\u3008-\u3011\u3014-\u301f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
/** Kana, Han and Hangul: the words of the sentence. A path may hold them (a wiki page), a host may not. */
const CJK_LETTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

/** Where the sentence takes over from a bare address: the first full-width punctuation, or the first word that follows the host with no space (`https://a.com看看`). -1 when it does not. */
function sentenceStart(address) {
  const scheme = /^https?:\/\//i.exec(address)?.[0].length ?? 0;
  const path = address.slice(scheme).search(/[/?#]/);
  const hostEnd = path < 0 ? address.length : scheme + path;
  const letter = address.search(CJK_LETTER);
  const candidates = [address.search(CJK_PUNCTUATION), letter < hostEnd ? letter : -1].filter((at) => at >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

/** A link is bare when its text is the whole of it: a written link ([text](url), <url>) has its brackets outside the text. */
const isBare = (link, text) =>
  text.type === 'text' &&
  text.position.start.offset === link.position.start.offset &&
  text.position.end.offset === link.position.end.offset;

/** Moves a parsed fragment to where it sits in the whole text (`line` lines down; `column` across on its first line). */
function place(node, offset, line, column) {
  for (const point of [node.position.start, node.position.end]) {
    point.offset += offset;
    if (point.line === 1) point.column += column;
    point.line += line;
  }
  for (const child of node.children ?? []) place(child, offset, line, column);
}

/**
 * A bare URL runs to the next space, so one written inside a sentence without spaces swallows the words after it, and whatever Markdown they hold
 * ([text](url), *emphasis*, `code`, a second address). It is cut where the sentence takes over, and the rest of the line's content is read again
 * as Markdown on its own, at its place in the source. Written links ([text](url), <url>) are left as they are.
 */
function cutBareUrls(node, source, options) {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const text = child.type === 'link' && child.children?.length === 1 ? child.children[0] : null;
    const cut = text && isBare(child, text) ? sentenceStart(text.value) : -1;
    if (cut > 0) {
      const at = child.position.start.offset + cut;
      const end = child.position.end;
      const rest = source.slice(at, children.at(-1).position.end.offset);
      child.url = child.url.slice(0, child.url.length - (end.offset - at));
      text.value = text.value.slice(0, cut);
      child.position = { ...child.position, end: { ...end, offset: at, column: end.column - (end.offset - at) } };
      // its own copy: a position shared with the link would be moved twice when the fragment around it is placed
      text.position = { start: { ...child.position.start }, end: { ...child.position.end } };
      const tail = fromMarkdown(rest, options);
      cutBareUrls(tail, rest, options);
      // what follows is inline content; anything else (it should not be) is kept as the words it is
      const inline =
        tail.children.length === 1 && tail.children[0].type === 'paragraph'
          ? tail.children[0].children
          : [
              {
                type: 'text',
                value: rest,
                position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: rest.length + 1, offset: rest.length } },
              },
            ];
      for (const part of inline) place(part, at, child.position.end.line - 1, child.position.end.column - 1);
      children.splice(i + 1, children.length, ...inline);
    } else cutBareUrls(child, source, options);
  }
}

/** The tree of a Markdown text: tables, strikethrough, bare URLs and emphasis next to CJK punctuation as the Mac reads them. @param {string} text */
export function parseMarkdown(text) {
  const tree = fromMarkdown(text, OPTIONS);
  cutBareUrls(tree, text, OPTIONS);
  return tree;
}

/**
 * The web and mail addresses in a text that is not Markdown (your own message), as `{ start, end, url }` over the text, found by the same
 * rule a reply's bare addresses follow. An address in backticks, or the text of a Markdown link, is not one: your words stay as you wrote them.
 * @param {string} text
 * @returns {{ start: number, end: number, url: string }[]}
 */
export function bareLinks(text) {
  const tree = fromMarkdown(text, PLAIN);
  cutBareUrls(tree, text, PLAIN);
  const found = [];
  const visit = (node) => {
    const only = node.type === 'link' && node.children?.length === 1 ? node.children[0] : null;
    if (only && isBare(node, only)) found.push({ start: node.position.start.offset, end: node.position.end.offset, url: node.url });
    else for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return found;
}
