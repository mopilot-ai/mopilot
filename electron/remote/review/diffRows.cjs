// A unified git diff as the rows a phone draws: one entry per file (path, status, counts) and, for one file, its rows with the word-level marks the app's diff view draws.

/** Characters one row keeps; a longer line is cut and marked. */
const MAX_LINE = 1000;
/** Bytes one page of rows carries at most once encoded (a frame to a phone is 256 KB sealed). */
const MAX_PAGE_CHARS = 100_000;

const ESCAPES = /** @type {Record<string, string>} */ ({ t: '\t', n: '\n', r: '\r' });

/** A path git wrote with C quoting ("a/caf\303\251"): the bytes it names, as text. */
function unquote(/** @type {string} */ s) {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const n = body[++i];
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(i, i + 3));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 2;
    } else bytes.push(...Buffer.from(ESCAPES[n] ?? n ?? ''));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `a/x b/x` after "diff --git ": the one path both sides name, or null when they differ (a rename names its own lines). */
function samePath(/** @type {string} */ head) {
  const quoted = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(head);
  const [a, b] = quoted
    ? [unquote(`"${quoted[1]}"`), unquote(`"${quoted[2]}"`)]
    : [head.slice(0, (head.length - 1) / 2), head.slice((head.length + 1) / 2)];
  return a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2) ? a.slice(2) : null;
}

const side = (/** @type {string} */ s, /** @type {string} */ prefix) => {
  const v = unquote(s.trim());
  return v === '/dev/null' ? null : v.startsWith(prefix) ? v.slice(2) : v;
};

/**
 * The files of a (multi-file) unified diff with every row; large inputs are the caller's to bound.
 * @param {string} text
 * @returns {{ path: string, oldPath?: string, status: 'added' | 'deleted' | 'renamed' | 'copied' | 'modified', binary: boolean, added: number, removed: number, rows: { k: string, t: string, o?: number, n?: number }[] }[]}
 */
function parseDiff(text) {
  const files = [];
  /** @type {any} */
  let cur = null;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = samePath(line.slice(11));
      cur = { path: path ?? '', status: 'modified', binary: false, added: 0, removed: 0, rows: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (inHunk && (line[0] === ' ' || line[0] === '+' || line[0] === '-' || line[0] === '\\')) {
      if (line[0] === '\\') cur.rows.push({ k: 'meta', t: line.slice(2) });
      else if (line[0] === '+') cur.added++, cur.rows.push({ k: 'add', t: line.slice(1), n: newNo++ });
      else if (line[0] === '-') cur.removed++, cur.rows.push({ k: 'del', t: line.slice(1), o: oldNo++ });
      else cur.rows.push({ k: 'ctx', t: line.slice(1), o: oldNo++, n: newNo++ });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      cur.rows.push({ k: 'hunk', t: line });
      continue;
    }
    inHunk = false;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) (cur.status = 'renamed'), (cur.oldPath = unquote(line.slice(12)));
    else if (line.startsWith('rename to ')) cur.path = unquote(line.slice(10));
    else if (line.startsWith('copy from ')) (cur.status = 'copied'), (cur.oldPath = unquote(line.slice(10)));
    else if (line.startsWith('copy to ')) cur.path = unquote(line.slice(8));
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true;
    else if (line.startsWith('--- ')) cur.from = side(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) {
      const to = side(line.slice(4), 'b/');
      // a deleted file's path is the old side's; an added or changed file's, the new
      if (to !== null) cur.path = to;
      else if (cur.from) cur.path = cur.from;
    }
  }
  return files.filter((f) => f.path).map(({ from: _from, ...f }) => f);
}

/** The range of `b` that differs from `a` after their common prefix and suffix, as the app's word marks have it. */
function changed(/** @type {string} */ a, /** @type {string} */ b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { del: [i, a.length - j], add: [i, b.length - j] };
}

/** Marks (`w: [start, end)` in the row's own text) on the lines of a removal that a following addition replaces, pairing them in order. */
function withWordMarks(/** @type {any[]} */ rows) {
  const out = rows.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; ) {
    if (out[i].k !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (out[d]?.k === 'del') d++;
    let a = d;
    while (out[a]?.k === 'add') a++;
    for (let n = 0; n < Math.min(d - i, a - d); n++) {
      const del = out[i + n];
      const add = out[d + n];
      const r = changed(del.t, add.t);
      if (r.del[0] < r.del[1]) del.w = r.del;
      if (r.add[0] < r.add[1]) add.w = r.add;
    }
    i = a;
  }
  return out;
}

/** A row cut to MAX_LINE characters, its marks clipped to what is left. */
function capped(/** @type {any} */ row) {
  if (row.t.length <= MAX_LINE) return row;
  const { w, ...rest } = row;
  const kept = { ...rest, t: row.t.slice(0, MAX_LINE), cut: true };
  return w && w[0] < MAX_LINE ? { ...kept, w: [w[0], Math.min(w[1], MAX_LINE)] } : kept;
}

/**
 * One page of a file's rows from row `from`: at most `count` rows and MAX_PAGE_CHARS characters; `next` is where the
 * following page starts, null at the end.
 * @param {any[]} rows
 */
function pageOf(rows, from, count) {
  const marked = withWordMarks(rows);
  const page = [];
  let chars = 0;
  let at = from;
  for (; at < marked.length && page.length < count; at++) {
    const row = capped(marked[at]);
    const size = Buffer.byteLength(JSON.stringify(row));
    if (page.length && chars + size > MAX_PAGE_CHARS) break;
    chars += size;
    page.push(row);
  }
  return { rows: page, from, next: at < marked.length ? at : null, total: marked.length };
}

module.exports = { parseDiff, pageOf, withWordMarks, MAX_LINE, MAX_PAGE_CHARS };
