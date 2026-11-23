// MoPilot 12-Grid Bench (#1381) `files` source: a task's folder as graders see it (each file's size, hash, text and
// the text inside a PDF), built from a task's seeded files and from what the runner reads back from the Mac; and the
// CSV spreadsheets tasks seed and grade.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const TEXT = /\.(txt|csv|tsv|md|json|html?|xml|ics|eml)$/i;
/** The most text kept per file: graders look for names, numbers and codes, not whole documents. */
export const TEXT_MAX = 256 * 1024;

/**
 * The text a PDF shows, best effort: the strings drawn by Tj/TJ in each content stream, inflated when the stream is
 * Flate-compressed. Fonts that map glyphs to codes (embedded subsets) give no readable text, so a grader treats an
 * empty result as unknown, never as "the PDF says nothing".
 * @param {Buffer} buf
 */
export function pdfText(buf) {
  const src = buf.toString('latin1');
  /** @type {string[]} */
  const out = [];
  for (const m of src.matchAll(/<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body = m[2];
    if (/\/FlateDecode/.test(m[1])) {
      try {
        body = inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
      } catch {
        continue;
      }
    }
    for (const t of body.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      const parts = t[1] !== undefined ? [...t[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((p) => p[1]) : [t[2]];
      out.push(parts.map((p) => p.replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n')).join(''));
    }
  }
  return out.join('\n').slice(0, TEXT_MAX);
}

/**
 * One file as graders see it: size, SHA-256, its text for text formats and its drawn text for a PDF.
 * @param {string} name @param {Buffer} buf
 * @returns {{ size: number, sha256: string, text?: string, pdfText?: string }}
 */
export function describeFile(name, buf) {
  const entry = { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  if (TEXT.test(name)) return { ...entry, text: buf.toString('utf8').slice(0, TEXT_MAX) };
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ...entry, pdfText: pdfText(buf) };
  return entry;
}

/**
 * A task's `files` fixture (`{ entries: { "<relative path>": { text } | { base64 } } }`) as the state the runner would
 * read back from the folder before the agent did anything. Paths stay inside the folder.
 * @param {any} f
 */
export function initFiles(f) {
  const entries = f?.entries ?? {};
  if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error('files fixture needs an entries object');
  /** @type {Record<string, ReturnType<typeof describeFile>>} */
  const out = {};
  for (const [p, v] of Object.entries(entries)) {
    if (!safePath(p)) throw new Error(`file path ${p} leaves the task folder`);
    const buf = typeof v?.base64 === 'string' ? Buffer.from(v.base64, 'base64') : Buffer.from(String(v?.text ?? ''), 'utf8');
    out[p] = describeFile(p, buf);
  }
  return { entries: out };
}

/** A relative path that stays inside its folder: no absolute path, no "..", no empty part. @param {string} p */
export const safePath = (p) => !!p && !p.startsWith('/') && p.split('/').every((x) => x && x !== '.' && x !== '..');

/** The entries whose path ends with a file name (any folder), case-insensitive. @param {any} files @param {string} name */
export const named = (files, name) =>
  Object.entries(files?.entries ?? {})
    .filter(([p]) => p.split('/').pop()?.toLowerCase() === name.toLowerCase())
    .map(([path, e]) => ({ path, ...e }));

/** Rows of cells as CSV (quoted where needed): the spreadsheet a task seeds in its folder. @param {unknown[][]} rows */
export const toCsv = (rows) =>
  `${rows
    .map((r) =>
      r
        .map((c) => String(c ?? ''))
        .map((c) => (/[",\r\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c))
        .join(','),
    )
    .join('\n')}\n`;

/**
 * A CSV file's rows of cells, as a spreadsheet app or an editor saves it: quoted cells may hold commas, quotes ("")
 * and line breaks; lines end in LF or CRLF; a final line break adds no row. A semicolon-separated file (a European
 * locale's export) is read the same way when its header row has no comma.
 * @param {unknown} text
 * @returns {string[][]}
 */
export function csvRows(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) rows.push([...row, cell]);
  return rows;
}
