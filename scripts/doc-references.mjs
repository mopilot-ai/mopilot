// Markdown references a reader follows: links, reference definitions and `npm run` commands, found outside code samples.
import path from 'node:path';

// an unclosed fence runs to the end of the file, as in CommonMark
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^ {0,3}\1[ \t]*$|[\s\S]*(?![\s\S]))/gm;
// for markers only a closed fence counts: one left open by mistake must not turn private passages into a sample
const CLOSED_FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm;
// a code span never runs past a blank line, so one stray backtick cannot turn the rest of a file inside out
const SPAN = /(`+)(?!`)(?:(?!\n[ \t]*\n)[^`]|(?!\1)`+)*?[^`\n]\1(?!`)/g;
// the same on one line: what can hide a marker, which always starts a line of its own
const LINE_SPAN = /(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g;
// a label may hold one level of brackets (an image inside a link); a destination one level of parentheses
const LABEL = String.raw`(?:[^\[\]\\\n]|\\.|\[(?:[^\[\]\\\n]|\\.)*\])*`;
const DEST = String.raw`<[^>\n]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))+`;
const TITLE = String.raw`(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?`;
const LINK = new RegExp(String.raw`(!?)\[(${LABEL})\]\(\s*(${DEST})${TITLE}\s*\)`, 'g');
// a definition may sit inside block quotes and list items
const DEFINITION = new RegExp(
  String.raw`^ {0,3}(?:(?:>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+) {0,3})*\[((?:[^\[\]\\\n]|\\.)+)\]:[ \t]*(${DEST})`,
  'gm',
);
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const UTF8 = new TextDecoder();
const NAME = String.raw`([a-z](?:[\w:.-]*\w)?)`;
// `npm run x`, `npm run-script x` and `npm --prefix dir run x`
const NPM_RUN = new RegExp(String.raw`\bnpm(?:\s+--prefix[ =](\S+))?\s+run(?:-script)?\s+${NAME}`, 'g');

const blank = (/** @type {string} */ code) => code.replace(/[^\n]/g, ' ');

/** The text with fenced blocks and inline code spans blanked to the same length, so offsets stay valid. */
export function withoutCode(text) {
  return text.replace(FENCE, blank).replace(SPAN, blank);
}

/** The text with closed fenced blocks and one-line code spans blanked: where a whole-line marker is text, not a marker. */
export function withoutLineCode(text) {
  return text.replace(CLOSED_FENCE, blank).replace(LINE_SPAN, blank);
}

/** The repository-relative path a relative target names, or null for a URL, a scheme or a same-file anchor. */
function resolveTarget(/** @type {string} */ file, /** @type {string} */ target) {
  if (!target || target.startsWith('#') || SCHEME.test(target) || target.startsWith('//')) return null;
  const bare = target.split('#')[0].split('?')[0];
  // each run of %XX escapes decodes as UTF-8 (an invalid sequence to U+FFFD); a lone % stays as written
  const decoded = bare.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
    UTF8.decode(Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16))),
  );
  const joined = decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(file), decoded);
  const resolved = path.posix.normalize(joined).replace(/\/$/, '');
  return resolved === '.' ? '' : resolved;
}

const unwrap = (/** @type {string} */ raw) => (raw.startsWith('<') ? raw.slice(1, -1) : raw);

/**
 * @typedef {{ kind: 'link' | 'definition' | 'autolink', start: number, end: number, labelStart: number, labelEnd: number,
 *   image: boolean, target: string, resolved: string | null }} MarkdownLink
 */

/**
 * Every link outside code, nested ones included (an image inside a link's label): inline links, reference
 * definitions and `<scheme:…>` autolinks, with their offsets, their label's offsets, the raw target and, for a
 * relative target, the repository-relative path it names (anchors and queries dropped).
 * @param {string} file repository-relative path of the markdown file
 * @param {string} text
 * @returns {MarkdownLink[]}
 */
export function markdownLinks(file, text) {
  const masked = withoutCode(text);
  /** @type {MarkdownLink[]} */
  const links = [];
  const inline = (/** @type {number} */ from, /** @type {number} */ to) => {
    const scope = new RegExp(LINK.source, 'g');
    const part = masked.slice(from, to);
    for (const match of part.matchAll(scope)) {
      const [whole, bang, label, rawTarget] = match;
      const start = from + match.index;
      const labelStart = start + bang.length + 1;
      const target = unwrap(rawTarget);
      links.push({
        kind: 'link',
        start,
        end: start + whole.length,
        labelStart,
        labelEnd: labelStart + label.length,
        image: bang === '!',
        target,
        resolved: resolveTarget(file, target),
      });
      if (label.includes('](')) inline(labelStart, labelStart + label.length);
    }
  };
  inline(0, masked.length);
  for (const match of masked.matchAll(DEFINITION)) {
    const target = unwrap(match[2]);
    const end = match.index + match[0].length;
    links.push({
      kind: 'definition',
      start: match.index,
      end,
      labelStart: end,
      labelEnd: end,
      image: false,
      target,
      resolved: resolveTarget(file, target),
    });
  }
  const destinations = links.map((link) => [link.labelEnd, link.end]);
  for (const match of masked.matchAll(AUTOLINK)) {
    const end = match.index + match[0].length;
    if (destinations.some(([from, to]) => match.index >= from && end <= to)) continue;
    links.push({
      kind: 'autolink',
      start: match.index,
      end,
      labelStart: match.index + 1,
      labelEnd: end - 1,
      image: false,
      target: match[1],
      resolved: null,
    });
  }
  return links.sort((a, b) => a.start - b.start);
}

/** Whether a repository-relative path names a file or a folder holding one, in a set of file paths. */
export function pathExists(files, resolved) {
  if (resolved === '' || files.has(resolved)) return true;
  const prefix = `${resolved}/`;
  for (const file of files) if (file.startsWith(prefix)) return true;
  return false;
}

/**
 * Scripts given to `npm run`, in prose and in fenced samples alike (a sample command is still an instruction), with
 * the package folder a `--prefix <dir>` or a preceding `cd <dir> &&` (or `;`) on the same line names (null: the owning one).
 * @returns {{ name: string, prefix: string | null }[]}
 */
export function npmRunScripts(text) {
  const found = new Map();
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(NPM_RUN)) {
      const rest = line.slice(match.index).split(/`|&&|;|\|/)[0];
      const prefix =
        match[1] ??
        rest.match(/\s--prefix[ =](\S+)/)?.[1] ??
        line.slice(0, match.index).match(/\bcd ([^\s`;&|]+)\s*(?:&&|;)\s*$/)?.[1] ??
        null;
      const name = match[2];
      found.set(`${prefix}\0${name}`, { name, prefix: prefix && path.posix.normalize(prefix).replace(/\/$/, '') });
    }
  }
  return [...found.values()];
}

/** The package.json that owns a file: the nearest one in its folder or above, in a set of file paths. */
/** @param {Set<string>} files @param {string} file @returns {string | null} */
export function owningManifest(files, file) {
  const dir = path.posix.dirname(file);
  const manifest = dir === '.' ? 'package.json' : `${dir}/package.json`;
  if (files.has(manifest)) return manifest;
  return dir === '.' ? null : owningManifest(files, dir);
}
