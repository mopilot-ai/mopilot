// Page diffs after browser actions: per tab, the page tree the model last saw, and what changed in it since, as <page_diff> or a full <page_tree>.
//
// Lines are the browser_read_page format (indent, "- ", role "name" attrs [ref_N]). Refs are stable
// and never renumbered, so a line is matched by its ref (a text line by its text): "~" a line whose
// attributes changed, "+" a new line (indented as in the tree), "-" removed refs collapsed into ranges.
// No baseline, another page, or a change to most of the tree sends the full tree instead.

const { ownTable } = require('../../../shared/ownTable.mjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { clippedNote } = require('../../../shared/clippedText.mjs');
const { pagingNote } = require('../../../shared/pagingNote.mjs');

/** Above this share of changed lines the full tree is clearer than a diff. */
const FULL_RATIO = 0.6;
/**
 * What an action's result carries of the page at most (G10, #3571): a page that changed under a wide read (`all`) sent
 * up to 16k characters after one click; read_page still reads the whole tree.
 */
const ACTION_CHARS = 8000;
const DEFAULTS = { filter: 'interactive', depth: 15, maxChars: 50000 };
const SCOPES = ownTable({
  visible: 'elements in the viewport',
  interactive: 'interactive elements in the viewport',
  all: 'all elements',
});

/** A tree line as { key, indent, text }: keyed by its ref, a line without one by its text and occurrence. */
function parse(lines) {
  const seen = new Map();
  return lines.map((line) => {
    // matches every line (each part is optional)
    const m = /** @type {RegExpExecArray} */ (/^(\s*)(?:- )?(.*)$/.exec(line));
    const indent = m[1];
    const text = m[2];
    const ref = /\[(ref_\d+)\]\s*$/.exec(text)?.[1];
    if (ref) return { key: ref, indent, text };
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    return { key: `${text}\u0000${n}`, indent, text };
  });
}

/** Ref numbers as ranges: ref_51..ref_57, ref_60. */
function ranges(refs) {
  const nums = [...new Set(refs.map((r) => Number(r.slice(4))))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `ref_${nums[i]}..ref_${nums[j]}` : `ref_${nums[i]}`);
    i = j;
  }
  return out;
}

/** The diff from `before` to `after` (tree lines): { lines, changes } with lines already marked. */
function diffLines(before, after) {
  const old = new Map(parse(before).map((l) => [l.key, l]));
  const cur = parse(after);
  const keys = new Set(cur.map((l) => l.key));
  const lines = [];
  for (const l of cur) {
    const was = old.get(l.key);
    if (!was) lines.push(`+ ${l.indent}${l.text}`);
    else if (was.text !== l.text) lines.push(`~ ${l.indent}${l.text}`);
  }
  const gone = [...old.values()].filter((l) => !keys.has(l.key));
  const isRef = (l) => /^ref_\d+$/.test(l.key);
  const changes = lines.length + gone.length;
  for (const r of ranges(gone.filter(isRef).map((l) => l.key))) lines.push(`- ${r}`);
  for (const l of gone) if (!isRef(l)) lines.push(`- ${l.text}`);
  return { lines, changes };
}

const sameDocument = (a, b) => String(a).split('#')[0] === String(b).split('#')[0];
const cap = (text, maxChars) =>
  text.length > maxChars ? `${prefixUnits(text, maxChars)}\n[Truncated at the ${maxChars.toLocaleString('en-US')}-character limit.]` : text;
/** An action's view of the page, held to ACTION_CHARS: what is cut is read with read_page. */
const capAction = (text, maxChars) =>
  maxChars > ACTION_CHARS && text.length > ACTION_CHARS
    ? `${prefixUnits(text, ACTION_CHARS)}\n[Cut at ${ACTION_CHARS.toLocaleString('en-US')} characters after the action: read_page shows the rest.]`
    : cap(text, maxChars);

/** What the model saw of each chat's tabs, until the turn ends. */
class PageSnapshots {
  constructor() {
    /** @type {Map<string, Map<string, { tab: object, url: string, opts: typeof DEFAULTS, lines: string[] }>>} */
    this.chats = new Map();
  }

  /** @returns {{ tab: object, url: string, opts: typeof DEFAULTS, lines: string[] } | null} */
  get(tab) {
    const s = this.chats.get(tab.chatId)?.get(tab.id);
    return s && s.tab === tab ? s : null;
  }

  /** The read options the model last used on the tab (a baseline's), or the compact default. */
  options(tab) {
    return this.get(tab)?.opts ?? DEFAULTS;
  }

  /** The model read the whole page (browser_read_page without ref_id): the new baseline. */
  seen(tab, { url, opts, lines }) {
    let chat = this.chats.get(tab.chatId);
    if (!chat) this.chats.set(tab.chatId, (chat = new Map()));
    chat.set(tab.id, { tab, url, opts: { ...DEFAULTS, ...opts }, lines: [...lines] });
  }

  /** The model saw some elements again (browser_find): their lines in the baseline are what it saw. */
  saw(tab, lines) {
    const s = this.get(tab);
    if (!s) return;
    const fresh = new Map(parse(lines).map((l) => [l.key, l.text]));
    s.lines = s.lines.map((line) => {
      const [l] = parse([line]);
      return fresh.has(l.key) ? `${l.indent}- ${fresh.get(l.key)}` : line;
    });
  }

  /**
   * The page after an action, against what the model last saw: a <page_diff>, or a <page_tree> when
   * there is nothing to compare with. The page read becomes the new baseline.
   */
  update(tab, { url, lines, truncated = false }) {
    const base = this.get(tab);
    const opts = base?.opts ?? DEFAULTS;
    this.seen(tab, { url, opts, lines });
    const scope = SCOPES[opts.filter] ?? SCOPES.visible;
    const full = (why) =>
      capAction(
        `<page_tree>\nFull page tree (${why}), ${scope}:\n${lines.length ? lines.join('\n') : '(nothing to show)'}${truncated ? '\n[Tree truncated at the character limit.]' : ''}\n</page_tree>`,
        opts.maxChars,
      ) +
      clippedNote(lines) +
      pagingNote(lines); // after the block, so the cap at ACTION_CHARS never cuts them away
    if (!base) return full('no earlier read of this tab to compare with');
    if (!sameDocument(base.url, url)) return full('the tab is on another page now');
    const d = diffLines(base.lines, lines);
    // one line when nothing the model reads changed (G10): not a tree, not a diff
    if (!d.lines.length) return `<page_diff>No visible change (${scope}).</page_diff>`;
    if (d.changes > FULL_RATIO * Math.max(base.lines.length, lines.length)) return full('most of the page changed');
    // the notes are about the page as it is now: a line the diff reports as removed is not on it
    const here = d.lines.filter((line) => !line.startsWith('- '));
    return capAction(`<page_diff>\n${d.lines.join('\n')}\n</page_diff>`, opts.maxChars) + clippedNote(here) + pagingNote(here);
  }

  /** The chat's turn ended: the next turn starts without baselines. */
  reset(chatId) {
    this.chats.delete(chatId);
  }
}

module.exports = { PageSnapshots, diffLines, ranges, FULL_RATIO, ACTION_CHARS };
