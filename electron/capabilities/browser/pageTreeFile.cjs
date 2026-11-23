// read_page's answer: the page's header and its tree, or (save_to, G2) for a tree above the character limit or one the agent
// asks to keep, the whole tree written to the chat's download folder and a summary with its path instead of a cut tree.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { mkdirPrivate } = require('../../platform/privateFiles.cjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { oneLine } = require('./host.cjs');
const { clippedNote } = require('../../../shared/clippedText.mjs');
const { pagingNote } = require('../../../shared/pagingNote.mjs');

/** The most a saved tree holds (characters): far above any answer, still a bounded file. */
const FILE_MAX = 2_000_000;
/** How much of the tree the summary shows before the path. */
const PREVIEW_CHARS = 3000;

/** "button" from a tree line such as `  button "Send" [ref_4]`; null for text lines. */
const roleOf = (/** @type {string} */ line) => /^\s*([a-z][a-z-]*)\b/.exec(line)?.[1] ?? null;

/**
 * The summary answer for a saved tree: the line and character counts, the most common roles, the start of the tree and
 * where the whole of it is.
 * @param {{ head: string, lines: string[], file: string, truncated: boolean }} o
 */
function savedSummary({ head, lines, file, truncated }) {
  const text = lines.join('\n');
  const roles = new Map();
  for (const l of lines) {
    const r = roleOf(l);
    if (r) roles.set(r, (roles.get(r) ?? 0) + 1);
  }
  const top = [...roles.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([r, n]) => `${r} ${n}`)
    .join(', ');
  const preview = text.length > PREVIEW_CHARS ? `${prefixUnits(text, PREVIEW_CHARS)}\n…` : text;
  return [
    head,
    `The whole tree (${lines.length.toLocaleString('en-US')} lines, ${text.length.toLocaleString('en-US')} characters${truncated ? `, cut at ${FILE_MAX.toLocaleString('en-US')}` : ''}) is saved to ${file}. Read or search that file for the rest; refs in it stay valid like this answer's.`,
    top ? `Roles: ${top}.` : '',
    preview,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Writes the tree to `<folder>/page-<tab>-<time>.txt` and returns the summary answer; null when the chat has no folder
 * (the caller answers with the tree cut at its limit, as before).
 * @param {{ folder: string | null | undefined, tabId: string, head: string, lines: string[], truncated: boolean, now?: () => number }} o
 */
function savePageTree({ folder, tabId, head, lines, truncated, now = Date.now }) {
  if (!folder) return null;
  mkdirPrivate(folder);
  const file = path.join(fs.realpathSync(folder), `page-${String(tabId).replace(/[^\w-]/g, '_')}-${now()}.txt`);
  fs.writeFileSync(file, `${head}\n${lines.join('\n')}\n`, { mode: 0o600 });
  // the notes read the WHOLE tree: a pager or a cut text run below the point where the answer's tree stops is still on the page
  return `${savedSummary({ head, lines, file, truncated })}${clippedNote(lines)}${pagingNote(lines)}`;
}

/**
 * read_page's save_to, or a tree above its limit: reads the tab's whole tree (up to FILE_MAX) and saves it to `folder`.
 * Returns the summary answer, or null when the chat has no folder (read_page answers with the tree cut at its limit).
 * @param {{ readPage: (tab: any, o: object) => Promise<{ lines: string[], truncated: boolean }> }} tabs
 * @param {{ id: string }} tab @param {{ filter: string, depth: number, ref: string | null }} read
 * @param {string | null | undefined} folder @param {string} head
 * @param {{ lines: string[], truncated: boolean } | null} [have] the tree already read whole, if it was
 */
async function saveWholeTree(tabs, tab, read, folder, head, have = null) {
  if (!folder) return null;
  // a tree the first read gave whole is saved as it is; only a cut one is read again
  const whole = have ?? (await tabs.readPage(tab, { ...read, maxChars: FILE_MAX }));
  return savePageTree({ folder, tabId: tab.id, head, ...whole });
}

/**
 * What read_page answers for `tab`, whose tree read with `read` gave `lines` (cut at read.maxChars when `truncated`): the
 * saved summary when the agent asked (`save`) or the tree was cut and the chat has a `folder`, else the tree itself.
 * @param {any} tabs @param {{ id: string, title?: string, url?: string }} tab
 * @param {{ filter: string, depth: number, ref: string | null, maxChars: number }} read
 * @param {{ lines: string[], truncated: boolean, save: boolean, folder: string | null | undefined }} got
 */
async function readPageAnswer(tabs, tab, read, { lines, truncated, save, folder }) {
  const { filter, depth, ref, maxChars } = read;
  const head = `Page ${tab.id}: ${oneLine(tab.title, 120) || '(untitled)'} — ${oneLine(tab.url, 300)}${filter === 'all' ? '' : ` (${filter === 'interactive' ? 'interactive elements' : 'elements'} in the viewport; filter "all" includes the rest)`}`;
  const have = truncated ? null : { lines, truncated };
  const saved = (save || truncated) && (await saveWholeTree(tabs, tab, { filter, depth, ref }, folder, head, have));
  if (saved) return saved;
  const body = lines.length ? lines.join('\n') : '(nothing to show)';
  return `${head}\n${body}${truncated ? `\n[Output truncated at the ${maxChars.toLocaleString('en-US')}-character limit. Narrow it with a smaller depth or a ref_id.]` : ''}${clippedNote(lines)}${pagingNote(lines)}`;
}

/**
 * What get_page_text answers for `tab`: the page's header, its text, and a note when the text was cut at `maxChars` or says it is one page of several.
 * @param {{ id: string }} tab @param {{ title?: string, url?: string, text: string, truncated: boolean }} r @param {number} maxChars
 */
function pageTextAnswer(tab, r, maxChars) {
  const cut = r.truncated ? `\n[Text truncated at ${maxChars.toLocaleString('en-US')} characters.]` : '';
  return `Page ${tab.id}: ${oneLine(r.title, 120)} — ${oneLine(r.url, 300)}\n\n${r.text}${cut}${pagingNote([r.text])}`;
}

module.exports = { FILE_MAX, PREVIEW_CHARS, savePageTree, savedSummary, saveWholeTree, readPageAnswer, pageTextAnswer };
