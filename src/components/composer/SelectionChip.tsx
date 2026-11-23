// The composer's selection and annotation pill, with a numbered list of quoted text and comments.

import { useEffect, useRef, useState } from 'react';
import { MessageSquareText, Pencil, Trash2, X } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { AnnotationComment } from './AnnotationComment';
import { rangeLabel } from '../diff/DiffComments';
import type { DiffCommentRange } from '../../../shared/diffComments.mjs';
import { pluralize } from '../../lib/format';

type Selection = string | { text?: string; annotation?: string; annotationId?: string; diff?: DiffCommentRange };

/** The annotation pill opens a numbered list, with each comment beside its selected text. */
export function SelectionChip({
  selections,
  onRemove,
  onEdit,
  onRemoveSelection,
  align = 'start',
}: {
  selections: Selection[];
  onRemove?: () => void;
  onEdit?: (index: number, comment: string) => void;
  onRemoveSelection?: (index: number) => void;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setPinned(false);
    setEditing(null);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  // once the last selection goes, the list closes, so new selections don't reopen it
  if (!selections.length && open) close();
  if (!selections.length) return null;
  const annotated = selections.some((s) => typeof s !== 'string' && (s.annotationId || s.annotation !== undefined));
  const noun = selections.every((s) => typeof s !== 'string' && s.diff) ? 'comment' : annotated ? 'annotation' : 'selection';
  const label = pluralize(selections.length, noun);
  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closeTimer.current);
    if (!pinned && editing === null) closeTimer.current = setTimeout(() => setOpen(false), 160);
  };
  return (
    <div className="selection-chip-wrap" onMouseEnter={show} onMouseLeave={hide}>
      <div ref={anchorRef} className="selection-chip">
        <button
          type="button"
          className="selection-chip-trigger"
          aria-label={`View ${label}`}
          aria-expanded={open}
          onClick={() => {
            clearTimeout(closeTimer.current);
            if (pinned) close();
            else {
              setOpen(true);
              setPinned(true);
            }
          }}
        >
          <MessageSquareText className="selection-chip-icon" size={14} strokeWidth={1.6} />
          <span className="selection-chip-label">{label}</span>
        </button>
        {onRemove && (
          <button type="button" className="selection-chip-remove" onClick={onRemove} aria-label="Remove all annotations">
            <span>
              <X size={12} strokeWidth={2} />
            </span>
          </button>
        )}
      </div>
      <Popover
        anchor={anchorRef.current}
        open={open}
        onClose={close}
        placement={align === 'end' ? 'top-end' : 'top-start'}
        className="selection-pop"
      >
        <div onMouseEnter={show} onMouseLeave={hide}>
          {selections.map((selection, index) => {
            const s = typeof selection === 'string' ? { text: selection } : selection;
            return (
              <div className="selection-pop-item" key={s.annotationId ?? index}>
                <span className="selection-pop-number">{index + 1}.</span>
                <div className="selection-pop-content">
                  <div className="selection-pop-label">
                    {'diff' in s && s.diff ? `${s.diff.path} · ${rangeLabel(s.diff)}:` : 'Selected text:'}
                  </div>
                  <div className={`selection-pop-text${'diff' in s && s.diff ? ' code' : ''}`}>{s.text}</div>
                  {editing === index && onEdit ? (
                    <AnnotationComment
                      key={s.annotationId ?? index}
                      initial={s.annotation}
                      onSave={(comment) => {
                        onEdit(index, comment);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <>
                      <div className="selection-pop-label">User comment:</div>
                      <div className={`selection-pop-text ${s.annotation ? '' : 'empty'}`}>{s.annotation || 'No comment'}</div>
                    </>
                  )}
                </div>
                {(onEdit || onRemoveSelection) && (
                  <div className="selection-pop-actions">
                    {onEdit && (
                      <button
                        type="button"
                        className="icon-btn xs"
                        aria-label={`Edit annotation ${index + 1}`}
                        onClick={() => {
                          clearTimeout(closeTimer.current);
                          setPinned(true);
                          setEditing(index);
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                    {onRemoveSelection && (
                      <button
                        type="button"
                        className="icon-btn xs"
                        aria-label={`Delete annotation ${index + 1}`}
                        onClick={() => {
                          setEditing(null);
                          onRemoveSelection(index);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
