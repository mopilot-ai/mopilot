// A <textarea> standing in for ComposerInput in composer tests that mock it: value, onChange and onKeyDown as the editor reports them, plus the editor contract's replaceRange and setCaretAfter (ComposerInputElement).
import React, { createElement } from 'react';

export const TextareaEditor = React.forwardRef(({ value, attachments, onChange, onKeyDown, disabled }: any, ref: any) =>
  createElement('textarea', {
    ref: (el: any) => {
      if (el) {
        // replaceRange inserts at a range and reports the change; setCaretAfter puts the caret once the box shows that text
        el.replaceRange ??= (start: number, end: number, text: string) => {
          el.setRangeText(text, start, end, 'end');
          onChange(el.value, attachments, el.selectionStart);
        };
        el.setCaretAfter ??= (text: string, at: number) => {
          if (el.value === text) el.setSelectionRange(at, at);
        };
      }
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    value,
    disabled,
    onKeyDown,
    onChange: (e: any) => onChange(e.target.value, attachments, e.target.selectionStart),
  }),
);
