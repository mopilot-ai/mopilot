// Opens a composer control (a picker's popover) when a composer command (a shortcut's, a slash command's) is for its own composer.
import { useEffect } from 'react';
import { ownsComposerCommand } from '../../lib/shortcutFocus';

/** On `name` for the composer holding `a.anchor` (lib/shortcutFocus.ts dispatchComposerCommand), open `a`. */
export function useComposerCommandOpen(name: string, a: { anchor: HTMLElement | null; setOpen: (open: boolean) => void }) {
  useEffect(() => {
    const h = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) a.setOpen(true);
    };
    window.addEventListener(name, h);
    return () => window.removeEventListener(name, h);
  }, [name, a]);
}
