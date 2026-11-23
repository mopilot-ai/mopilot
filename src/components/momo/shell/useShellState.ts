// What MoMo's shell remembers and does with its keys (M0b, #4926): whether the rail is shown and which one panel is open (both kept in the prefs, so a restart brings the page back as it was left), Esc closing the open panel, and Cmd/Ctrl+B toggling the rail.
import { useEffect } from 'react';
import { imeComposing } from '../../../lib/focus';
import { modKey } from '../../../lib/platform';
import { setPrefs, useStore } from '../../../store/core';

export type ShellPanelId = 'tasks' | 'files' | 'sessions';

/** The rail's shown state: shown unless hidden by its toggle, its drag or Cmd/Ctrl+B. */
export function useRailOpen(): [boolean, (open: boolean) => void] {
  const hidden = useStore((s) => s.prefs.momoRailHidden === true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !modKey(e) || e.shiftKey || e.altKey || e.defaultPrevented || imeComposing(e)) return;
      e.preventDefault();
      setPrefs({ momoRailHidden: !hidden });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden]);
  // a drag that ends open writes the width, not the shown state again
  return [!hidden, (open) => open === !hidden || setPrefs({ momoRailHidden: !open })];
}

/** The one panel that is open, or none; the button of the open one closes it, another's switches to it. Esc closes it unless something else took the key first. A panel whose source went away is closed on screen, not left. */
export function usePanel(available: Record<ShellPanelId, boolean>): [ShellPanelId | null, (id: ShellPanelId) => void, () => void] {
  const asked = useStore((s) => s.prefs.momoPane ?? null);
  const open = asked && available[asked] ? asked : null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // an input method's Escape cancels its candidate, never the panel
      if (e.key !== 'Escape' || e.defaultPrevented || imeComposing(e)) return;
      e.preventDefault();
      setPrefs({ momoPane: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return [open, (id) => setPrefs({ momoPane: asked === id ? null : id }), () => setPrefs({ momoPane: null })];
}
