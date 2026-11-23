// The note field under a quoted annotation, saved on Enter without submitting the composer.

import { useState } from 'react';
import { Dictation } from '../ui/Dictation';
import { Trash2 } from '../ui/icons';

/** Enter saves just this annotation; it never submits the main composer. */
export function AnnotationComment({
  initial = '',
  value,
  onSave,
  onCancel,
  onChange,
  onDelete,
}: {
  initial?: string;
  /** A retained annotation can be edited by another surface, or consumed by the composer. */
  value?: string;
  onSave: (comment: string) => void;
  onCancel: () => void;
  onChange?: (comment: string) => void;
  /** An annotation already in the draft can be deleted from its own editor, as Codex's comment editor does. */
  onDelete?: () => void;
}) {
  const [comment, setComment] = useState(initial);
  const shown = value ?? comment;
  return (
    <form
      className="annotation-comment-input"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(shown.trim());
      }}
    >
      <input
        autoFocus
        aria-label="Annotation comment"
        placeholder="Add an optional comment…"
        value={shown}
        onChange={(e) => {
          setComment(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.keyCode === 229) {
            if (e.key === 'Enter') e.preventDefault();
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <Dictation
        onText={(text) => {
          const next = shown ? `${shown} ${text}` : text;
          setComment(next);
          onChange?.(next);
        }}
      />
      {onDelete && (
        <button type="button" className="icon-btn xs" aria-label="Delete annotation" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      )}
    </form>
  );
}
