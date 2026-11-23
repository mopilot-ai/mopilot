// Shortcut labels follow the effective catalog bindings, including user overrides and removals.
import { SHORTCUT_ACTIONS, effectiveBindings } from '../../shared/shortcuts.mjs';
import { useStore } from '../store/core';
import { platform } from '../lib/platform';
export function useShortcutHint() {
  const bindings = useStore((s) => s.prefs.keybindings);
  return (id: string) => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
    return action ? effectiveBindings(action, bindings ?? {}, platform)[0] : undefined;
  };
}
