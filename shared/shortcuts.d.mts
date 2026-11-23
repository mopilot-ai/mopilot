// Shared desktop shortcut catalog contracts.
export type ShortcutScope = 'app' | 'chat' | 'composer' | 'workspace' | 'browser' | 'terminal';
export interface ShortcutAction {
  id: string;
  title: string;
  desc: string;
  def: string | null;
  aliases: string[];
  windows?: string[];
  scope: ShortcutScope;
  menu: boolean;
  repeat: boolean;
  /** the key is the app's only while focus is in its own UI: a browser page or terminal keeps it */
  appFocus?: boolean;
}
export type Keybindings = Record<string, string | null>;
export const SHORTCUT_ACTIONS: ShortcutAction[];
export function bindingsFor(action: ShortcutAction, bindings: Keybindings, platform?: string): string[];
export function effectiveBindings(action: ShortcutAction, bindings: Keybindings, platform?: string): string[];
export function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean;
export function resolveShortcut(combo: string, bindings: Keybindings, scope?: ShortcutScope, platform?: string): ShortcutAction | null;
export function bindingConflict(id: string, combo: string, bindings: Keybindings, platform?: string): ShortcutAction | undefined;
export function nativeRoleBindings(platform?: string): Record<string, string>;
