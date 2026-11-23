// `@path` file references in prompt text: which words read as a file the @ menu (or the user) named, by Claude Desktop's rules.

import { filePreviewKind, previewExtension } from '../../shared/filePreview.mjs';
import { langFromPath } from './highlight';

export interface FileMention {
  /** Where `@` starts, and where the reference ends (trailing punctuation left out). */
  start: number;
  end: number;
  /** The reference as written, `@` included. */
  token: string;
  /** The path after `@`, as the harness reads it. */
  path: string;
}

/**
 * `@` at the start or after whitespace, then everything up to the next space or backtick. A full-width sentence mark also
 * bounds it on either side: Chinese runs on without spaces (`看，@notes.md。还有`), and no path the @ menu inserts holds one.
 */
const AT = /(?<=^|[\s\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F])@([^\s`\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F]+)/g;
/** A sentence's punctuation after the path, Chinese and Japanese included (Claude's app trims the same). */
const TRAILING = /[.,;:!?'"\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\u2026]+$/;
/** A markdown link: an `@` in one belongs to the link (a browser tab token, a link the user pasted). */
const LINK = /\[(?:\\.|[^\]\\\n])*\]\([^)\s]*\)/g;
/** A last segment with an extension that starts with a letter: `v1.2` and `@3.5` are not files. */
const EXTENSION = /\.[a-z][^/]*$/i;
/** Text files no viewer or highlighter claims, still named bare often enough. */
const PLAIN = new Set(['txt', 'log', 'ini', 'cfg', 'conf', 'env', 'lock', 'rtf', 'jsonl', 'ipynb', 'plist', 'zip', 'gz', 'tgz']);
/** Past this a word is not a path; past that many a text is not a prompt that names files. */
const MAX_PATH = 1024;
const MAX_MENTIONS = 256;

/** A file type people name bare (`@notes.md`, `@Design.pdf`), so `@john.doe` stays a name. */
function knownExtension(path: string) {
  return filePreviewKind(path) !== 'source' || langFromPath(path) !== 'text' || PLAIN.has(previewExtension(path));
}

/** The path without the punctuation that ends its sentence, and without a `)` it never opened. */
function trimmed(word: string) {
  let path = word.replace(TRAILING, '');
  while (path.endsWith(')') && path.split(')').length > path.split('(').length) path = path.slice(0, -1).replace(TRAILING, '');
  return path;
}

/** Whether a word after `@` names a file (or a folder, written with its trailing `/` as the @ menu inserts one). */
export function fileMentionPath(path: string) {
  // a web address after `@` stays the bubble's URL link
  if (!path || path.length > MAX_PATH || /^[a-z][\w+.-]*:\/\//i.test(path)) return false;
  const normalized = path.replaceAll('\\', '/');
  if (normalized.endsWith('/')) return normalized.length > 1;
  if (!EXTENSION.test(normalized)) return false;
  // a bare name needs a known type; a path with a folder or a dotfile reads as a file already
  return normalized.includes('/') || normalized.startsWith('.') || knownExtension(normalized);
}

/** The file references in a text, in order; an `@` inside a markdown link is the link's. */
export function fileMentions(text: string): FileMention[] {
  if (!text.includes('@')) return [];
  const links = text.includes('](') ? [...text.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length]) : [];
  const out: FileMention[] = [];
  for (const m of text.matchAll(AT)) {
    if (links.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const path = trimmed(m[1]);
    if (!fileMentionPath(path)) continue;
    out.push({ start: m.index, end: m.index + 1 + path.length, token: `@${path}`, path });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}
