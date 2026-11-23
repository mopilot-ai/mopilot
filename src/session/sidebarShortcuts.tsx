// Numbered sidebar navigation and held-modifier hints share the rendered rows as their target owner.
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { SHORTCUT_ACTIONS, effectiveBindings, resolveShortcut } from '../../shared/shortcuts.mjs';
import { comboFromEvent, nativeShortcutAccelerator } from '../../shared/shortcutKeys.mjs';
import { useStore, get as getState } from '../store/core';
import { platform, shortcutLabel } from '../lib/platform';
import { shortcutsBlocked, shortcutScope, textOwnsShortcut } from '../lib/shortcutFocus';

import { SIDEBAR, sidebarShortcutTargets, type Target } from '../lib/sidebarShortcutTargets';
export { sidebarShortcutTargets, numberedSidebarChat } from '../lib/sidebarShortcutTargets';

export const SidebarShortcutContext = createContext<ReadonlyMap<Element, string>>(new Map());

/** One observer and one modifier listener per sidebar, including changes local to its nested lists. */
export function useSidebarShortcutHints(root: RefObject<HTMLElement | null>) {
  const bindings = useStore((s) => s.prefs.keybindings);
  const [targets, setTargets] = useState<Target[]>([]);
  const [modifiers, setModifiers] = useState('');
  const held = useRef('');
  const browser = useRef<string | null>(null);
  useEffect(() => {
    const sidebar = root.current;
    if (!sidebar) return;
    let disposed = false;
    let revealed = false;
    let pending: object | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelReveal = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      revealed = false;
    };
    // the page is watched for rows coming and going only while a modifier is held: nothing is shown otherwise
    const observer = new MutationObserver(() => refresh());
    let watching = false;
    const watch = () => {
      if (!!held.current === watching) return;
      watching = !!held.current;
      if (!watching) return observer.disconnect();
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'inert', 'data-sidebar-chat'],
      });
    };
    const refresh = () => {
      if (disposed) return;
      watch();
      if (browser.current) {
        const s = getState();
        if (s.paneActive !== browser.current || !s.diffPanel.open) {
          clear();
          return;
        }
      }
      if (!held.current || shortcutsBlocked()) {
        cancelReveal();
        setModifiers('');
        return;
      }
      if (!revealed) {
        if (!pending) {
          const owner = (pending = {});
          timer = setTimeout(() => {
            if (disposed || pending !== owner) return;
            timer = null;
            pending = null;
            revealed = true;
            refresh();
          }, 500);
        }
        return;
      }
      setTargets(sidebar.matches(SIDEBAR) ? sidebarShortcutTargets(sidebar) : []);
      setModifiers(held.current);
    };
    const clear = () => {
      held.current = '';
      browser.current = null;
      cancelReveal();
      watch();
      setModifiers('');
    };
    const key = (e: KeyboardEvent) => {
      if (browser.current) clear();
      browser.current = null;
      held.current =
        e.isComposing || e.keyCode === 229 || comboFromEvent(e, platform === 'darwin')
          ? ''
          : comboFromEvent(
              { key: '', code: '', metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey },
              platform === 'darwin',
            )!;
      refresh();
    };
    const browserModifiers = (event: Event) => {
      const { paneId, combo } = (event as CustomEvent<{ paneId: string; combo: string }>).detail;
      if (!combo) {
        if (browser.current === paneId) clear();
        return;
      }
      const s = getState();
      if (s.paneActive !== paneId || !s.diffPanel.open) return;
      if (browser.current !== paneId) clear();
      browser.current = paneId;
      held.current = combo;
      refresh();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    window.addEventListener('blur', clear);
    window.addEventListener('browser-shortcut-modifiers', browserModifiers);
    document.addEventListener('focusin', refresh);
    document.addEventListener('focusout', refresh);
    document.addEventListener('visibilitychange', clear);
    refresh();
    return () => {
      disposed = true;
      cancelReveal();
      held.current = '';
      browser.current = null;
      observer.disconnect();
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('browser-shortcut-modifiers', browserModifiers);
      document.removeEventListener('focusin', refresh);
      document.removeEventListener('focusout', refresh);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [root]);
  const hints = new Map<Element, string>();
  const target = document.activeElement;
  const scope = browser.current ? 'browser' : shortcutScope(target);
  if (modifiers)
    for (const t of targets) {
      const action = SHORTCUT_ACTIONS.find((a) => a.id === t.action)!;
      const binding = effectiveBindings(action, bindings ?? {}, platform).find(
        (k) =>
          k.replace(/[^⌃⌥⇧⌘◆].*$/, '') === modifiers &&
          (!browser.current || !!nativeShortcutAccelerator(k, platform)) &&
          !textOwnsShortcut(k, target) &&
          resolveShortcut(k, bindings ?? {}, scope, platform)?.id === action.id,
      );
      if (binding) hints.set(t.row, shortcutLabel(binding));
    }
  return hints;
}

/** Shortcut metadata never changes the row's accessible name or takes keyboard focus. */
export function SidebarChatShortcut({ row }: { row: RefObject<HTMLElement | null> }) {
  const hint = useContext(SidebarShortcutContext).get(row.current!);
  return hint ? (
    <kbd className="chat-shortcut-hint" aria-hidden="true">
      {hint}
    </kbd>
  ) : null;
}
