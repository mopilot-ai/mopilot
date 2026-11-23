// Unified diff parsing, file change rows, and patch serialization with Git metadata.

import { decodeDiffHeaderPath, decodeGitPath, encodeGitPath } from './gitPath';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
  noNewline?: boolean;
}
export interface DiffFile {
  path: string;
  oldPath?: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  isNew?: boolean;
  isDeleted?: boolean;
  isCopy?: boolean;
  binary?: boolean;
  /** The size in bytes of a new file a Host left out of the patch for its size (a header-only row, no lines). */
  tooLarge?: number;
  /** Git's old/new blob identities, when a binary patch supplies them. */
  binaryVersion?: string;
  mode?: string;
  oldMode?: string;
  newMode?: string;
}

/** Parse a (multi-file) unified git diff. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let blobIdentity: string | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (inHunk && oldRemaining <= 0 && newRemaining <= 0 && l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      cur = null;
      inHunk = false;
    }
    if (l.startsWith('diff --git ')) {
      inHunk = false;
      blobIdentity = undefined;
      const samePath = /^diff --git a\/(.*) b\/\1$/.exec(l)?.[1];
      const m = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(l);
      cur = {
        path: samePath ?? (m ? decodeGitPath(m[2]).replace(/^b\//, '') : l.slice(11)),
        oldPath: samePath ?? (m ? decodeGitPath(m[1]).replace(/^a\//, '') : undefined),
        lines: [],
        added: 0,
        removed: 0,
      };
      files.push(cur);
      continue;
    }
    if (!cur) {
      if (l.startsWith('--- ') || l.startsWith('@@')) {
        cur = { path: '', lines: [], added: 0, removed: 0 };
        files.push(cur);
      } else continue;
    }
    if (l.startsWith('new file mode')) {
      cur.isNew = true;
      cur.mode = l.slice('new file mode '.length).trim();
    } else if (l.startsWith('deleted file mode')) {
      cur.isDeleted = true;
      cur.mode = l.slice('deleted file mode '.length).trim();
    } else if (l.startsWith('old mode ')) cur.oldMode = l.slice('old mode '.length).trim();
    else if (l.startsWith('new mode ')) cur.newMode = l.slice('new mode '.length).trim();
    else if (l.startsWith('rename from ') || l.startsWith('copy from ')) {
      const copy = l.startsWith('copy from ');
      cur.oldPath = decodeGitPath(l.slice(copy ? 'copy from '.length : 'rename from '.length));
      if (copy) cur.isCopy = true;
    } else if (l.startsWith('rename to ') || l.startsWith('copy to ')) {
      const copy = l.startsWith('copy to ');
      cur.path = decodeGitPath(l.slice(copy ? 'copy to '.length : 'rename to '.length));
      if (copy) cur.isCopy = true;
    } else if (!inHunk && l.startsWith('index ')) blobIdentity = l.slice(6);
    else if (!inHunk && /^Large file, not shown: \d+ bytes$/.test(l)) cur.tooLarge = Number(/\d+/.exec(l)![0]);
    else if (l.startsWith('Binary files') || l === 'GIT binary patch') {
      cur.binary = true;
      if (blobIdentity) cur.binaryVersion = blobIdentity;
    } else if (!inHunk && l.startsWith('--- ')) {
      const p = decodeDiffHeaderPath(l.slice(4)).replace(/^a\//, '');
      if (p === '/dev/null') cur.isNew = true;
      if (p !== '/dev/null') {
        cur.oldPath = p;
        if (!cur.path) cur.path = p;
      }
    } else if (!inHunk && l.startsWith('+++ ')) {
      const p = decodeDiffHeaderPath(l.slice(4)).replace(/^b\//, '');
      if (p === '/dev/null') cur.isDeleted = true;
      if (p !== '/dev/null') cur.path = p;
    } else if (l.startsWith('@@')) {
      inHunk = true;
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/.exec(l);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[3]) : 0;
      oldRemaining = m ? Number(m[2] ?? 1) : Infinity;
      newRemaining = m ? Number(m[4] ?? 1) : Infinity;
      cur.lines.push({ kind: 'hunk', text: l });
    } else if (l.startsWith('+')) {
      cur.lines.push({ kind: 'add', text: l.slice(1), newNo: newNo++ });
      cur.added++;
      newRemaining--;
    } else if (l.startsWith('-')) {
      cur.lines.push({ kind: 'del', text: l.slice(1), oldNo: oldNo++ });
      cur.removed++;
      oldRemaining--;
    } else if (l.startsWith(' ') || (l === '' && i < lines.length - 1 && cur.lines.length && oldRemaining > 0 && newRemaining > 0)) {
      cur.lines.push({ kind: 'ctx', text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
      oldRemaining--;
      newRemaining--;
    } else if (l === '\\ No newline at end of file') {
      const previous = cur.lines.at(-1);
      if (previous && previous.kind !== 'hunk') previous.noNewline = true;
    }
  }
  return files.filter((f) => f.path || f.lines.length);
}

/** Build a DiffFile from a Codex FileUpdateChange. */
export function fileChangeToDiff(change: { path: string; kind: unknown; diff: string }): DiffFile {
  const kind = (change.kind as { type?: string } | null | undefined)?.type ?? change.kind;
  const d = change.diff ?? '';
  // File contents can contain Markdown separators or patch examples; only a leading
  // patch header identifies the input as a diff.
  const isPatch = /^(?:@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- [^\n]+\n\+\+\+ [^\n]+|diff --git (?:a\/|"))/.test(d);
  if (kind === 'add' && !isPatch) {
    const content = d.endsWith('\n') ? d.slice(0, -1) : d;
    const lines: DiffLine[] = (d === '' ? [] : content.split('\n')).map((t, i) => ({ kind: 'add' as const, text: t, newNo: i + 1 }));
    if (lines.length && !d.endsWith('\n')) lines.at(-1)!.noNewline = true;
    return { path: change.path, lines, added: lines.length, removed: 0, isNew: true };
  }
  if (kind === 'delete' && !isPatch) {
    const content = d.endsWith('\n') ? d.slice(0, -1) : d;
    const lines: DiffLine[] = (d === '' ? [] : content.split('\n')).map((t, i) => ({ kind: 'del' as const, text: t, oldNo: i + 1 }));
    if (lines.length && !d.endsWith('\n')) lines.at(-1)!.noNewline = true;
    return { path: change.path, lines, added: 0, removed: lines.length, isDeleted: true };
  }
  const parsed = parseUnifiedDiff(
    d.startsWith('@@') ? `--- ${encodeGitPath(`a/${change.path}`)}\n+++ ${encodeGitPath(`b/${change.path}`)}\n${d}` : d,
  );
  const f = parsed[0] ?? { path: change.path, lines: [], added: 0, removed: 0 };
  return { ...f, path: change.path, isNew: kind === 'add' || f.isNew, isDeleted: kind === 'delete' || f.isDeleted };
}

/** Preserve diff control records when copying a line to a patch. */
export function diffLineText(line: DiffLine): string {
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'ctx' ? ' ' : '';
  return sign + line.text + (line.noNewline ? '\n\\ No newline at end of file' : '');
}

/** What a row says in place of lines it does not show (the file is binary, or too large to read), or null when it shows its lines. */
export function unshownNote(file: Pick<DiffFile, 'binary' | 'tooLarge'>): string | null {
  if (file.binary) return 'Binary file';
  if (file.tooLarge === undefined) return null;
  const kb = file.tooLarge / 1000;
  return `File too large to show (${kb >= 1000 ? `${(kb / 1000).toFixed(1)} MB` : `${Math.round(kb)} KB`})`;
}

/** The lines added and removed over `files`: the one total the Changes pane's header, the summary's Branch changes and a turn's edited files all show. */
export function diffTotals(files: readonly { added: number; removed: number }[]): { added: number; removed: number } {
  return files.reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 });
}

/** Serialize a file patch, supplying the hunks raw create/delete content lacks. */
export function diffFileText(file: DiffFile): string {
  const oldName = file.oldPath ?? file.path;
  const oldPath = encodeGitPath(`a/${oldName}`);
  const newPath = encodeGitPath(`b/${file.path}`);
  const from = file.isNew ? '/dev/null' : oldPath;
  const to = file.isDeleted ? '/dev/null' : newPath;
  const header = `diff --git ${oldPath} ${newPath}\n`;
  let metadata = '';
  if (file.isNew) metadata = header + `new file mode ${file.mode ?? '100644'}\n`;
  else if (file.isDeleted) metadata = header + `deleted file mode ${file.mode ?? '100644'}\n`;
  else if (oldName !== file.path) {
    const operation = file.isCopy ? 'copy' : 'rename';
    metadata = header + `${operation} from ${encodeGitPath(oldName)}\n${operation} to ${encodeGitPath(file.path)}\n`;
  }
  if (file.oldMode || file.newMode) {
    metadata ||= header;
    if (file.oldMode) metadata += `old mode ${file.oldMode}\n`;
    if (file.newMode) metadata += `new mode ${file.newMode}\n`;
  }
  if (file.binary) return (metadata || header) + `Binary files ${from} and ${to} differ\n`;
  // the placeholder stays in the text: a copy says the file is too large, and a Viewed mark notices its size change
  if (file.tooLarge !== undefined) return (metadata || header) + `Large file, not shown: ${file.tooLarge} bytes\n`;
  if (!file.lines.length && metadata) return metadata;
  let hunk = '';
  if (!file.lines.some((line) => line.kind === 'hunk')) {
    if (file.isNew) hunk = `@@ -0,0 +1,${file.added} @@\n`;
    else if (file.isDeleted) hunk = `@@ -1,${file.removed} +0,0 @@\n`;
  }
  return metadata + `--- ${from}\n+++ ${to}\n` + hunk + file.lines.map(diffLineText).join('\n') + '\n';
}

/** A kept file's serialization, made once: a file kept by one poll is compared again by the next. */
const serializations = new WeakMap<DiffFile, string>();
function serialized(file: DiffFile): string {
  let text = serializations.get(file);
  if (text === undefined) serializations.set(file, (text = JSON.stringify(file)));
  return text;
}

/**
 * A diff read again (the Changes pane polls Git) with each file that did not change kept as the object it was, and
 * the previous list itself when nothing changed: what renders a file (its syntax colors) is redone only for the files
 * that did, and an unchanged poll renders nothing (#2049).
 */
export function reuseDiffFiles(previous: readonly DiffFile[], next: DiffFile[]): DiffFile[] {
  const before = new Map(previous.map((file) => [file.path, file]));
  let changed = previous.length !== next.length;
  const kept = next.map((file, index) => {
    const old = before.get(file.path);
    const same = old !== undefined && serialized(old) === JSON.stringify(file);
    if (!same || previous[index] !== old) changed = true;
    return same ? old : file;
  });
  return changed ? kept : (previous as DiffFile[]);
}
