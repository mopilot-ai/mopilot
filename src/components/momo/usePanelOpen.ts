// Whether MoMo's right panel is shown when the window has room for it: this viewer's own choice, kept in the browser's storage (it can be missing or throw there, so the panel is on by default and a failed save is only a choice not kept).
import { useState } from 'react';
import { noteIgnored } from '../../lib/ignored';

const KEY = 'momo.panelOpen';

export function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, set] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'off';
    } catch (error) {
      noteIgnored('read whether MoMo’s right panel is shown', error);
      return true;
    }
  });
  return [
    open,
    (next) => {
      set(next);
      try {
        localStorage.setItem(KEY, next ? 'on' : 'off');
      } catch (error) {
        // the choice holds for this window only
        noteIgnored('keep whether MoMo’s right panel is shown', error);
      }
    },
  ];
}
