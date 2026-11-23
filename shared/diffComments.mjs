// Comments on diff lines as the official Codex app's `# Diff comments:` section, written and read back the same for every harness.
import { maskMarkdownCode } from './markdownProse.mjs';

export const DIFF_COMMENTS_HEADING = '# Diff comments:';

const sideLine = (side, line) => `${side}${line}`;

/** `Lines:` as the official app writes it: `12`, `12-14`, or `L5-R7` when the range crosses sides. */
export function diffCommentLines({ startSide, startLine, endSide, endLine }) {
  if (startSide !== endSide) return `${sideLine(startSide, startLine)}-${sideLine(endSide, endLine)}`;
  const lo = Math.min(startLine, endLine);
  const hi = Math.max(startLine, endLine);
  return lo === hi ? String(hi) : `${lo}-${hi}`;
}

/** A fence longer than any backtick run in the hunk, so a code line (even ` ```` ` after its sign) can't close it. */
function fenceFor(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * A comment line starting with `#` would read as the next transport heading, and one starting a code fence would hide
 * the headings after it; Markdown's backslash escape keeps either one prose.
 */
const escapeComment = (comment) => comment.replace(/^([ \t]*)(\\*)([#`~])/gm, '$1$2\\$3');
const unescapeComment = (comment) => comment.replace(/^([ \t]*)(\\*)\\([#`~])/gm, '$1$2$3');

/**
 * A path as a `File:` value: as is, or as a JSON string when a line break or a leading quote would split or change
 * the field (git allows both in file names).
 */
const pathField = (path) => (/[\r\n]|^"/.test(path) ? JSON.stringify(path) : path);
function readPath(value) {
  if (!value.startsWith('"')) return value;
  // JSON that starts with a quote is a string, or not JSON at all
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** The `# Diff comments:` section for comments on diff lines, numbered as the official app numbers them. */
export function formatDiffComments(comments) {
  if (!comments.length) return '';
  let out = `\n${DIFF_COMMENTS_HEADING}\n`;
  comments.forEach(({ diff, annotation }, i) => {
    const sides = diff.startSide === diff.endSide ? diff.endSide : `${diff.startSide}-${diff.endSide}`;
    out += `\n## User Comment ${i + 1}\nFile: ${pathField(diff.path)}\n`;
    if (diff.workspace) out += `Workspace: ${diff.workspace}\n`;
    out += `Side: ${sides}\nLines: ${diffCommentLines(diff)}\n`;
    if (diff.hunk?.trim()) {
      const fence = fenceFor(diff.hunk);
      out += `Diff hunk:\n${fence}diff\n${diff.hunk}\n${fence}\n`;
    }
    out += `Comment:\n${escapeComment(annotation ?? '')}\n`;
  });
  return out;
}

/** Reads the comments of a `# Diff comments:` section (without its heading) back as quoted annotations. */
export function parseDiffComments(section) {
  const markers = maskMarkdownCode(section);
  const starts = [...markers.matchAll(/^## (?:User )?Comment \d+[ \t]*$/gm)];
  return starts.flatMap((m, i) => {
    const block = section.slice(m.index + m[0].length, starts[i + 1]?.index).replace(/^\n/, '');
    const blockMarkers = maskMarkdownCode(block);
    // the comment runs from its marker, past the fenced hunk, to the end of the block; the fields come before it.
    // A hunk whose fence never closes hides the marker from the masked text, so the raw text is the fallback.
    const commentAt = /^Comment:\n/m.exec(blockMarkers) ?? /^Comment:\n/m.exec(block);
    const head = blockMarkers.slice(0, commentAt?.index);
    const field = (name) => new RegExp(`^${name}: (.*)$`, 'm').exec(head)?.[1].trim();
    const raw = field('File');
    if (!raw) return [];
    const path = readPath(raw);
    const hunk = /^Diff hunk:\n(`{3,})diff\n([\s\S]*?)\n\1$/m.exec(block)?.[2] ?? '';
    const comment = commentAt ? unescapeComment(block.slice(commentAt.index + commentAt[0].length).replace(/\n+$/, '')) : '';
    const lines = field('Lines') ?? '';
    return [{ text: hunk, annotation: comment || undefined, file: { path, lines, side: field('Side') ?? 'R' } }];
  });
}
