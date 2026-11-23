// Diff rendering: diff lines, inline and side-by-side views.

import { fileName } from '../../lib/paths';
import { isWin } from '../../lib/platform';
import { useCopyConfirm } from '../../session/copyConfirm';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { tokenizeLines, langFromPath } from '../../lib/highlight';
import { useResolvedDark } from '../markdown/Markdown';
import { Check, Copy } from '../ui/icons';
import { noteIgnored } from '../../lib/ignored';
import { relPath } from '../../lib/paths';
import { withKeys } from '../../lib/listKeys';
import { DiffCommentSurface } from './DiffCommentSurface';
import {
  commentRange,
  DiffCommentBox,
  DiffCommentButton,
  useDiffCommentPicker,
  type DiffCell,
  type DiffCommenting,
  type DiffCommentPicker,
} from './DiffComments';

import { diffFileText, diffLineText, unshownNote, type DiffFile, type DiffLine } from '../../lib/diff';
export { parseUnifiedDiff, fileChangeToDiff, type DiffFile, type DiffLine } from '../../lib/diff';

/** A diff line's place in the file: its kind and line numbers (a hunk or meta line's equal neighbors are counted apart). */
const lineKey = (l: DiffLine) => JSON.stringify([l.kind, l.oldNo, l.newNo]);
/** A highlighted line's colored runs, keyed by their text (fixed for the line). */
const tokenKeys = (tk: [string, string][]) => withKeys(tk, ([t]) => t);

export function DiffLines({ file, maxHeight }: { file: DiffFile; maxHeight?: number }) {
  const dark = useResolvedDark();
  const [tokens, setTokens] = useState<[string, string][][] | null>(null);
  const lang = langFromPath(file.path);
  const body = useMemo(() => file.lines.filter((l) => l.kind !== 'hunk' && l.kind !== 'meta'), [file]);
  useEffect(() => {
    let alive = true;
    setTokens(null);
    if (body.length > 4000 || lang === 'text') return;
    tokenizeLines(body.map((l) => l.text).join('\n'), lang, dark)
      .then((t) => alive && setTokens(t))
      // the diff stays readable without syntax colors
      .catch((e) => noteIgnored(`highlight a ${lang} diff`, e));
    return () => {
      alive = false;
    };
  }, [body, lang, dark]);

  let bi = 0;
  return (
    <div className="diff-lines" style={{ maxHeight }}>
      <table>
        <tbody>
          {withKeys(file.lines, lineKey).map(({ key, item: l, index: i }) => {
            if (l.kind === 'hunk') {
              if (i === 0 && /^@@ -1(,\d+)? \+1(,\d+)? @@/.test(l.text)) return null;
              return (
                <tr key={key} className="diff-hunk">
                  <td className="ln" />
                  <td className="ln" />
                  <td className="code">{l.text.replace(/^@@ .*? @@ ?/, '') || '⋯'}</td>
                </tr>
              );
            }
            const tk = tokens?.[bi++];
            return (
              <tr key={key} className={`diff-${l.kind}`}>
                <td className="ln">{l.oldNo ?? ''}</td>
                <td className="ln">{l.newNo ?? ''}</td>
                <td className="code">
                  <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
                  {tk
                    ? tokenKeys(tk).map(({ key: tokenKey, item: [t, c] }) => (
                        <span key={tokenKey} style={{ color: c }}>
                          {t}
                        </span>
                      ))
                    : l.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline diff card (used in chat steps): single gutter, word marks    */
/* ------------------------------------------------------------------ */
function wordSpans(a: string, b: string): [number, number] {
  // common prefix/suffix; returns the changed range [start, endFromEnd] for b
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return [i, j];
}

/** A note shown under a line, such as a review finding: a line of the new file unless `side` is L (the old one). */
export interface LineNote {
  line: number;
  side?: 'L' | 'R';
  key: string;
  node: ReactNode;
}

/** A row's line numbers in the old (L) and new (R) file. */
type RowLines = { L?: number; R?: number };

/** Which row each note goes under: the last row at or before its line on its side, else the first row. */
function notesByRow(lines: RowLines[], notes: LineNote[]): Map<number, ReactNode[]> {
  const out = new Map<number, ReactNode[]>();
  for (const note of notes) {
    let at = 0;
    lines.forEach((row, i) => {
      const n = row[note.side ?? 'R'];
      if (n !== undefined && n <= note.line) at = i;
    });
    out.set(at, [...(out.get(at) ?? []), <Fragment key={note.key}>{note.node}</Fragment>]);
  }
  return out;
}

/** The text of a diff's lines, so a comment range is dropped when they change (useDiffCommentPicker). */
const linesFingerprint = (file: DiffFile, commenting: DiffCommenting) =>
  JSON.stringify([
    commenting.chatId,
    commenting.workspace,
    commenting.path,
    file.lines.map((l) => `${l.oldNo ?? ''},${l.newNo ?? ''}:${diffLineText(l)}`),
  ]);

/** A diff line as a commentable cell on `side`: by default deleted lines are on the old side, the rest on the new. */
function cellOf(l: DiffLine | undefined, side: DiffCell['side'] = l?.kind === 'del' ? 'L' : 'R'): DiffCell | undefined {
  if (!l) return undefined;
  const line = side === 'L' ? l.oldNo : l.newNo;
  if (line === undefined) return undefined;
  return { side, line, sign: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ', text: l.text };
}

/** The comment box under row `row` of column `col`, when that is where the picked range ends. */
function commentBoxAt(
  picker: DiffCommentPicker,
  commenting: DiffCommenting | undefined,
  cells: (DiffCell | undefined)[],
  col: number,
  row: number,
) {
  const p = picker.picking;
  if (!commenting || !p || p.col !== col || picker.boxRow !== row) return null;
  const range = commentRange(cells, p.anchor, p.head, commenting.path, commenting.workspace);
  return (
    <DiffCommentBox
      range={range}
      onCancel={picker.close}
      onAdd={(comment) => {
        if (commenting.onAdd(range, comment) !== false) picker.close();
      }}
      onPost={
        commenting.onPost &&
        (async (comment) => {
          const posted = await commenting.onPost!(range, comment);
          if (posted) picker.closeIf(p);
          return posted;
        })
      }
    />
  );
}

/** A line number cell, with the add-comment button when the diff takes comments. */
function LineNumber({
  cell,
  commenting,
  picker,
  col,
  row,
}: {
  cell: DiffCell | undefined;
  commenting?: DiffCommenting;
  picker: DiffCommentPicker;
  col: number;
  row: number;
}) {
  return (
    <span className="idiff-ln">
      {commenting && cell && (
        <DiffCommentButton picker={picker} col={col} row={row} label={`line ${cell.side === 'L' ? 'L' : ''}${cell.line}`} />
      )}
      {cell?.line ?? ''}
    </span>
  );
}

export function InlineDiff({
  file,
  cwd,
  maxHeight = 360,
  bare = false,
  notes = [],
  commenting,
}: {
  file: DiffFile;
  cwd?: string | null;
  maxHeight?: number;
  bare?: boolean;
  /** shown under their lines (the Changes pane's review findings) */
  notes?: LineNote[];
  /** lets the user comment on lines (the Changes pane) */
  commenting?: DiffCommenting;
}) {
  // only a diff that takes comments needs its lines' fingerprint
  const takesComments = !!commenting;
  const fingerprint = useMemo(() => (commenting ? linesFingerprint(file, commenting) : ''), [file, commenting]);
  const picker = useDiffCommentPicker(fingerprint);
  const { copied, copy } = useCopyConfirm();
  const dark = useResolvedDark();
  const lang = langFromPath(file.path);
  const body = useMemo(() => file.lines.filter((l) => l.kind !== 'hunk' && l.kind !== 'meta'), [file]);
  const [tokens, setTokens] = useState<[string, string][][] | null>(null);
  useEffect(() => {
    let alive = true;
    setTokens(null);
    if (body.length > 3000 || lang === 'text') return;
    tokenizeLines(body.map((l) => l.text).join('\n'), lang, dark)
      .then((t) => alive && setTokens(t))
      // the diff stays readable without syntax colors
      .catch((e) => noteIgnored(`highlight a ${lang} diff`, e));
    return () => {
      alive = false;
    };
  }, [body, lang, dark]);

  // pair deletions with following additions for word-level highlights
  const marks = useMemo(() => {
    const m = new Map<number, [number, number]>();
    for (let i = 0; i < body.length; i++) {
      if (body[i].kind !== 'del') continue;
      let j = i;
      while (j < body.length && body[j].kind === 'del') j++;
      const dels = body.slice(i, j);
      let k = j;
      while (k < body.length && body[k].kind === 'add') k++;
      const adds = body.slice(j, k);
      for (let n = 0; n < Math.min(dels.length, adds.length); n++) {
        const a = dels[n].text;
        const b = adds[n].text;
        const [p1, s1] = wordSpans(a, b);
        if (p1 + s1 < Math.max(a.length, b.length)) {
          m.set(i + n, [p1, s1]);
          m.set(j + n, [p1, s1]);
        }
      }
      i = k - 1;
    }
    return m;
  }, [body]);

  const renderText = (idx: number, text: string) => {
    const tk = tokens?.[idx] ?? [[text, '']];
    const mark = marks.get(idx);
    if (!mark)
      return tokenKeys(tk).map(({ key, item: [t, c] }) => (
        <span key={key} style={{ color: c || undefined }}>
          {t}
        </span>
      ));
    const [start, endFromEnd] = mark;
    const end = text.length - endFromEnd;
    const out: React.ReactNode[] = [];
    let pos = 0;
    for (const [t, c] of tk) {
      const a = pos;
      const b = pos + t.length;
      pos = b;
      const segs: [number, number, boolean][] = [];
      const cuts = [a, Math.max(a, Math.min(b, start)), Math.max(a, Math.min(b, end)), b];
      for (let x = 0; x < 3; x++) if (cuts[x + 1] > cuts[x]) segs.push([cuts[x], cuts[x + 1], x === 1]);
      // a segment's start in the line's fixed text tells it apart: segments never overlap and are never empty
      for (const [s0, s1, hl] of segs)
        out.push(
          <span key={s0} className={hl ? 'word-mark' : undefined} style={{ color: c || undefined }}>
            {text.slice(s0, s1)}
          </span>,
        );
    }
    return out;
  };

  const byRow = notesByRow(
    body.map((l) => ({ L: l.kind === 'add' ? undefined : l.oldNo, R: l.kind === 'del' ? undefined : l.newNo })),
    notes,
  );
  const columns = useMemo(() => [body.map((l) => cellOf(l))], [body]);
  const cells = columns[0];
  const unshown = unshownNote(file);
  const rows = unshown ? (
    <div className="diff-binary">{unshown}</div>
  ) : (
    <DiffCommentSurface columns={columns} picker={picker} identity={fingerprint} enabled={takesComments} maxHeight={maxHeight}>
      {withKeys(body, lineKey).map(({ key, item: l, index: i }) => (
        <Fragment key={key}>
          <div
            className={`idiff-row ${l.kind}${picker.inRange(0, i) ? ' commenting' : ''}`}
            onMouseEnter={commenting ? (e) => picker.enter(0, i, e.buttons) : undefined}
          >
            <LineNumber cell={cells[i]} commenting={commenting} picker={picker} col={0} row={i} />
            <span className="idiff-code" data-diff-col={0} data-diff-row={i}>
              {renderText(i, l.text)}
            </span>
          </div>
          {byRow.get(i)}
          {commentBoxAt(picker, commenting, cells, 0, i)}
        </Fragment>
      ))}
    </DiffCommentSurface>
  );
  if (bare) return <div className="idiff bare">{rows}</div>;
  return (
    <div className="idiff">
      <div className="idiff-head">
        <span className="idiff-name" title={file.path}>
          {fileName(relPath(file.path, cwd), isWin)}
        </span>
        <span className="diff-stat">
          <span className="plus">+{file.added}</span> <span className="minus">-{file.removed}</span>
        </span>
        {/* keyed by the path, not the diff: the check goes when the view moves to another file, and the whole
            patch is not held in state behind it */}
        <button
          className="icon-btn xs idiff-copy"
          title="Copy diff"
          onClick={() => copy(file.binary ? diffFileText(file) : body.map(diffLineText).join('\n'), file.path)}
        >
          {copied === file.path ? <Check size={13} className="copy-check" /> : <Copy size={13} />}
        </button>
      </div>
      {rows}
    </div>
  );
}

/** Side-by-side diff (old | new). */
export function SplitDiff({ file, notes = [], commenting }: { file: DiffFile; notes?: LineNote[]; commenting?: DiffCommenting }) {
  // only a diff that takes comments needs its lines' fingerprint
  const takesComments = !!commenting;
  const fingerprint = useMemo(() => (commenting ? linesFingerprint(file, commenting) : ''), [file, commenting]);
  const picker = useDiffCommentPicker(fingerprint);
  const rows = useMemo(() => {
    const out: { left?: DiffLine; right?: DiffLine }[] = [];
    const body = file.lines.filter((l) => l.kind !== 'hunk' && l.kind !== 'meta');
    for (let i = 0; i < body.length; ) {
      const l = body[i];
      if (l.kind === 'ctx') {
        out.push({ left: l, right: l });
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < body.length && body[i].kind === 'del') dels.push(body[i++]);
      while (i < body.length && body[i].kind === 'add') adds.push(body[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k], right: adds[k] });
    }
    return out;
  }, [file]);
  const byRow = notesByRow(
    rows.map((r) => ({ L: r.left?.oldNo, R: r.right?.newNo })),
    notes,
  );
  // each half numbers its lines in its own file, context lines too
  const columns = useMemo(() => [rows.map((r) => cellOf(r.left, 'L')), rows.map((r) => cellOf(r.right, 'R'))], [rows]);
  /** One half of a row: the old file (column 0) or the new one (column 1). */
  const half = (l: DiffLine | undefined, col: number, index: number) => (
    <div
      className={`idiff-row ${l && l.kind !== 'ctx' ? l.kind : ''} ${!l ? 'empty' : ''}${picker.inRange(col, index) ? ' commenting' : ''}`}
      onMouseEnter={commenting ? (e) => picker.enter(col, index, e.buttons) : undefined}
    >
      <LineNumber cell={columns[col][index]} commenting={commenting} picker={picker} col={col} row={index} />
      <span className="idiff-code" data-diff-col={col} data-diff-row={index}>
        {l?.text ?? ''}
      </span>
    </div>
  );
  const unshown = unshownNote(file);
  if (unshown)
    return (
      <div className="idiff bare split">
        <div className="diff-binary">{unshown}</div>
      </div>
    );
  return (
    <div className="idiff bare split">
      <DiffCommentSurface columns={columns} picker={picker} identity={fingerprint} enabled={takesComments}>
        {/* a file merged from several edits repeats line numbers: withKeys tells the repeats apart */}
        {withKeys(rows, (r) => JSON.stringify([r.left?.oldNo, r.right?.newNo])).map(({ key, item: r, index }) => (
          <Fragment key={key}>
            <div className="split-row">
              {half(r.left, 0, index)}
              {half(r.right, 1, index)}
            </div>
            {byRow.get(index)}
            {commentBoxAt(picker, commenting, columns[0], 0, index)}
            {commentBoxAt(picker, commenting, columns[1], 1, index)}
          </Fragment>
        ))}
      </DiffCommentSurface>
    </div>
  );
}
