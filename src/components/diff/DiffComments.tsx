// Commenting on diff lines in the Changes pane: the gutter's add button, picking a range, the comment box and a pending comment under its line.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageSquareText, Plus } from '../ui/icons';
import { diffCommentLines, type DiffCommentRange, type DiffSide } from '../../../shared/diffComments.mjs';

/** What a diff renders comments on: where they go and what adding one does. */
export interface DiffCommenting {
  path: string;
  workspace?: string;
  /** The draft receiving the comment; changing chats retires a picked range even for identical code. */
  chatId?: string | null;
  /** Explicit false retains the comment; existing callbacks may omit a return on success. */
  onAdd(range: DiffCommentRange, comment: string): unknown;
  /** Posts the comment on the pull request instead (true once it is there); absent where it can't go to GitHub. */
  onPost?(range: DiffCommentRange, comment: string): Promise<boolean>;
}

/** A commentable line: its side of the diff (L old, R new), number there, sign and text. */
export interface DiffCell {
  side: DiffSide;
  line: number;
  sign: string;
  text: string;
}

/**
 * The range from row `a` to row `b` of one column (either order); rows without a line in it are skipped. Row `a` is
 * where the range was started, on a line's add button, so it always has a line.
 */
export function commentRange(cells: (DiffCell | undefined)[], a: number, b: number, path: string, workspace?: string): DiffCommentRange {
  const picked = cells.slice(Math.min(a, b), Math.max(a, b) + 1).filter((c): c is DiffCell => !!c);
  const first = picked[0];
  const last = picked[picked.length - 1];
  return {
    path,
    ...(workspace ? { workspace } : {}),
    startSide: first.side,
    startLine: first.line,
    endSide: last.side,
    endLine: last.line,
    hunk: picked.map((c) => `${c.sign}${c.text}`).join('\n'),
  };
}

interface Picking {
  col: number;
  anchor: number;
  head: number;
  open: boolean;
}

/**
 * The range being commented on, per diff. Pressing a row's add button starts it, dragging over rows of the same
 * column extends it and letting go opens the comment box; Shift extends the last range instead. A keyboard press
 * opens the box for that row alone. The range is rows of the diff as shown, so it is dropped when the diff's lines
 * change (`lines`, a fingerprint of them): the pane reads git again every few seconds, and the same rows could then
 * be other lines.
 */
export function useDiffCommentPicker(lines: string) {
  const [picking, setPicking] = useState<Picking | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pickedIn, setPickedIn] = useState(lines);
  if (pickedIn !== lines) {
    setPickedIn(lines);
    setPicking(null);
    setDragging(false);
  }
  useEffect(() => {
    if (!dragging) return;
    const up = () => {
      setDragging(false);
      setPicking((p) => p && { ...p, open: true });
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [dragging]);
  const inRange = (col: number, row: number) =>
    !!picking && picking.col === col && row >= Math.min(picking.anchor, picking.head) && row <= Math.max(picking.anchor, picking.head);
  return {
    picking,
    inRange,
    /** the row the comment box goes under */
    boxRow: picking?.open ? Math.max(picking.anchor, picking.head) : -1,
    start(col: number, row: number, extend: boolean) {
      setPicking((p) => (extend && p && p.col === col ? { ...p, head: row, open: false } : { col, anchor: row, head: row, open: false }));
      setDragging(true);
    },
    /** The pointer entered a row; `buttons` 0 means the drag ended outside the window, so it ends here. */
    enter(col: number, row: number, buttons = 1) {
      if (!dragging) return;
      if (!buttons) {
        setDragging(false);
        setPicking((p) => p && { ...p, open: true });
        return;
      }
      setPicking((p) => (p && p.col === col ? { ...p, head: row } : p));
    },
    openAt(col: number, row: number) {
      setPicking({ col, anchor: row, head: row, open: true });
    },
    openRange(col: number, anchor: number, head: number) {
      setPicking({ col, anchor, head, open: true });
    },
    close: () => setPicking(null),
    /** An async post may close only the selection it started for. */
    closeIf: (expected: Picking) => setPicking((current) => (current === expected ? null : current)),
  };
}

export type DiffCommentPicker = ReturnType<typeof useDiffCommentPicker>;

/** The add button in a commentable line's gutter (shown on hover, and while its range is picked). */
export function DiffCommentButton({ picker, col, row, label }: { picker: DiffCommentPicker; col: number; row: number; label: string }) {
  return (
    <button
      type="button"
      className="diff-comment-add"
      aria-label={`Comment on ${label}`}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        picker.start(col, row, e.shiftKey);
      }}
      onClick={(e) => {
        // a mouse press already started the range (and its release opens the box)
        if (e.detail === 0) picker.openAt(col, row);
      }}
    >
      <Plus size={12} strokeWidth={2.2} />
    </button>
  );
}

/** The comment box under the picked range: Enter adds the comment, Shift+Enter starts a new line, Escape cancels. */
export function DiffCommentBox({
  range,
  onAdd,
  onPost,
  onCancel,
}: {
  range: DiffCommentRange;
  onAdd: (comment: string) => void;
  /** a failed post keeps the box and its text, to try again */
  onPost?: (comment: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState(false);
  const postBusy = useRef(false);
  const post = async (send: NonNullable<typeof onPost>) => {
    if (postBusy.current) return;
    postBusy.current = true;
    setPostError(false);
    setPosting(true);
    try {
      await send(comment.trim());
    } catch {
      setPostError(true);
    } finally {
      postBusy.current = false;
      setPosting(false);
    }
  };
  const add = () => {
    if (!posting && comment.trim()) onAdd(comment.trim());
  };
  return (
    <div className="diff-comment-wrap">
      <form
        className="diff-comment-box"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="diff-comment-head">{rangeLabel(range)}</div>
        <textarea
          autoFocus
          aria-label="Diff comment"
          placeholder="Comment on these lines for the agent…"
          rows={2}
          value={comment}
          readOnly={posting}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
        />
        {postError && <div role="alert">Couldn’t post the comment. Try again.</div>}
        <div className="diff-comment-actions">
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          {onPost && (
            <button type="button" className="btn sm" disabled={!comment.trim() || posting} onClick={() => void post(onPost)}>
              {posting ? 'Posting…' : 'Comment on GitHub'}
            </button>
          )}
          <button type="submit" className="btn primary sm" disabled={!comment.trim() || posting}>
            Add comment
          </button>
        </div>
      </form>
    </div>
  );
}

/** "Line 12", "Lines 12-14" or "Lines L5-R7", from a comment's `Lines:` as it is sent. */
export const linesLabel = (lines: string) => (/^\d+$/.test(lines) ? `Line ${lines}` : `Lines ${lines}`);

export function rangeLabel(range: Pick<DiffCommentRange, 'startSide' | 'startLine' | 'endSide' | 'endLine'>) {
  return linesLabel(diffCommentLines(range));
}

/** A comment waiting in the composer, under the line it ends on. */
export function PendingDiffComment({ range, comment }: { range: DiffCommentRange; comment: ReactNode }) {
  return (
    <div className="diff-comment-wrap">
      <div className="diff-comment-pending">
        <div className="diff-comment-head">
          <MessageSquareText size={13} strokeWidth={1.7} />
          <span>{rangeLabel(range)}</span>
          <span className="diff-comment-state">In your next message</span>
        </div>
        <div className="diff-comment-text">{comment}</div>
      </div>
    </div>
  );
}
