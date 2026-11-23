// Markdown code boundaries shared by message decoding and renderer transformations.
import { parseMarkdown } from './markdownParse.mjs';

/** Code ranges from the same parser the renderer uses, including nested and indented code. */
function codeRanges(md, inline) {
  const ranges = [];
  const visit = (node) => {
    if (node.type === 'code' || (inline && node.type === 'inlineCode')) ranges.push([node.position.start.offset, node.position.end.offset]);
    else if (node.children) for (const child of node.children) visit(child);
  };
  visit(parseMarkdown(md));
  return ranges;
}

/** Transform each run of prose; code and its delimiters stay literal unless an explicit code transform is supplied. */
export function mapProse(md, fn, code = (text) => text, inline = true) {
  const out = [];
  let offset = 0;
  for (const [start, end] of codeRanges(md, inline)) {
    if (start > offset) out.push(fn(md.slice(offset, start)));
    out.push(code(md.slice(start, end)));
    offset = end;
  }
  if (offset < md.length || !md.length) out.push(fn(md.slice(offset)));
  return out.join('');
}

/** Code has no transport markers; preserve its offsets and line breaks while hiding its contents. */
export function maskMarkdownCode(md) {
  return mapProse(
    md,
    (prose) => prose,
    (code) => code.replace(/[^\r\n]/g, ' '),
  );
}
