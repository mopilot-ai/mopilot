// Let xterm retain shell input while clearing its scrollback through the owning desktop shortcut.
import { resolveShortcut, SHORTCUT_ACTIONS, effectiveBindings, type Keybindings } from '../../shared/shortcuts.mjs';
import { comboFromEvent, toAccelerator, nativeShortcutAccelerator } from '../../shared/shortcutKeys.mjs';

export function terminalShortcut(event: KeyboardEvent, bindings: Keybindings, clear: () => void, platform: string) {
  if (event.type !== 'keydown' || event.isComposing) return true;
  const combo = comboFromEvent(event, platform === 'darwin');
  const action = combo && nativeShortcutAccelerator(combo, platform) && resolveShortcut(combo, bindings, 'terminal', platform);
  if (!action || action.scope !== 'terminal') return true;
  event.preventDefault();
  event.stopPropagation();
  // A native menu binding (Cmd+K) already sends the contextual command; do not clear twice.
  const menuOwns = SHORTCUT_ACTIONS.some((a) => a.menu && effectiveBindings(a, bindings, platform).includes(combo) && toAccelerator(combo));
  if (!menuOwns && !event.repeat) clear();
  return false;
}
