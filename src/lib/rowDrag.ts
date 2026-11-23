// Drag props for a sidebar row that can hold an inline text field (a rename): the row drags, except while the field has
// focus, so a mouse drag in the field selects its text instead of moving the row.
import { useState, type FocusEvent } from 'react';

/**
 * Chromium starts a drag of the nearest draggable ancestor when the mouse moves with the button down, even inside an
 * <input>, so a row stays draggable only while no input in it has focus. Spread the result on the draggable row.
 */
export function useRowDrag() {
  const [typing, setTyping] = useState(false);
  return {
    draggable: !typing,
    onFocus: (e: FocusEvent) => setTyping((e.target as Element).tagName === 'INPUT'),
    onBlur: () => setTyping(false),
  };
}
