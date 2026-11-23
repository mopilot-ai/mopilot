// An ACP edit tool call's file changes: from a unified patch in its output, its diff blocks, or its input (#1942).
import { contentBlocks } from '../contentBlocks.mjs';

const UPDATE = Object.freeze({ type: 'update', move_path: null });

/** A hunk replacing `oldStr` with `newStr`, numbered from line 1: the best a fragment or whole-file pair can say. */
export function replaceDiff(oldStr, newStr) {
  const o = String(oldStr).split('\n');
  const n = String(newStr ?? '').split('\n');
  return `@@ -1,${o.length} +1,${n.length} @@\n${o.map((l) => '-' + l).join('\n')}\n${n.map((l) => '+' + l).join('\n')}`;
}

const headerPath = (line) => line.slice(4).replace(/\t.*$/, '');
/** Git's a/ and b/ prefixes come off a pair of header paths (/dev/null has none). */
const unprefix = (from, to) =>
  from.startsWith('a/') || to.startsWith('b/') ? [from.replace(/^a\//, ''), to.replace(/^b\//, '')] : [from, to];

/**
 * A unified patch's files as changes, each with only its hunks (Undo adds headers relative to the chat's folder).
 * opencode puts one in rawOutput.metadata.diff, with "Index:" lines and absolute paths, and with real line numbers
 * where its diff blocks hold only the replaced fragments. A hunk's lines are counted from its header, so a removed
 * "-- x" line followed by an added "++ y" line is content, not the next file.
 */
export function patchChanges(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split('\n');
  /** @type {{ from: string, to: string, hunks: string[] }[]} */
  const files = [];
  /** @type {{ from: string, to: string, hunks: string[] } | null} */
  let file = null;
  /** the hunk being read: its lines go to its file */
  let into = /** @type {string[]} */ ([]);
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (oldLeft > 0 || newLeft > 0) {
      into.push(l);
      if (l[0] !== '+' && l[0] !== '\\') oldLeft--;
      if (l[0] !== '-' && l[0] !== '\\') newLeft--;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const [from, to] = unprefix(headerPath(l), headerPath(lines[++i]));
      file = { from, to, hunks: [] };
      files.push(file);
    } else if (file && hunk) {
      into = file.hunks;
      into.push(l);
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    } else if (file?.hunks.length && l.startsWith('\\')) file.hunks.push(l);
  }
  return files
    .filter((f) => f.hunks.length)
    .map((f) => ({
      path: f.to === '/dev/null' ? f.from : f.to,
      kind: f.from === '/dev/null' ? { type: 'add' } : f.to === '/dev/null' ? { type: 'delete' } : { ...UPDATE },
      diff: f.hunks.join('\n'),
    }));
}

/** ACP diff blocks: whole-file old and new text by the spec (a new file has no old text). */
const blockChanges = (diffs) =>
  diffs.map((d) =>
    d.oldText == null
      ? { path: d.path, kind: { type: 'add' }, diff: String(d.newText ?? '') }
      : { path: d.path, kind: { ...UPDATE }, diff: replaceDiff(d.oldText, d.newText) },
  );

/**
 * An edit call's input, for an agent that sends no diff block for it (opencode's write never does, its edit only once
 * done): a replacement (`oldString`/`old_string`) or a whole file (`content`). A write is a new file only when the
 * agent says the file did not exist (opencode's rawOutput.metadata.exists), or as a preview while it runs; a finished
 * one that existed, or that never said (a turn that ended first), carries no patch, since its old text is unknown:
 * Undo must neither empty nor delete the file.
 */
function inputChanges(tc) {
  const input = tc.rawInput ?? {};
  const path = [input.filePath, input.file_path, input.path, tc.locations?.[0]?.path].find((p) => typeof p === 'string' && p);
  if (!path) return [];
  const oldText = input.oldString ?? input.old_string;
  if (typeof oldText === 'string') return [{ path, kind: { ...UPDATE }, diff: replaceDiff(oldText, input.newString ?? input.new_string) }];
  if (typeof input.content !== 'string') return [];
  const running = tc.status !== 'completed' && tc.status !== 'failed';
  if (tc.rawOutput?.metadata?.exists === false || (running && tc.rawOutput?.metadata?.exists !== true))
    return [{ path, kind: { type: 'add' }, diff: input.content }];
  return [{ path, kind: { ...UPDATE }, diff: '' }];
}

/**
 * The changes a tool call made, or none when it is not a file edit we can place: a patch in its output first, then its
 * diff blocks (any kind, as before), then an edit's input.
 */
export function editChanges(tc, diffs = contentBlocks(tc.content).filter((c) => c?.type === 'diff')) {
  const patched = tc.kind === 'edit' || diffs.length ? patchChanges(tc.rawOutput?.metadata?.diff) : [];
  if (patched.length) return patched;
  if (diffs.length) return blockChanges(diffs);
  return tc.kind === 'edit' ? inputChanges(tc) : [];
}
