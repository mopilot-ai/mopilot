// Focus ownership for window shortcuts and targeted composer commands, including side chats and ACP pickers.
import { isEditingShortcut } from '../../shared/shortcutKeys.mjs';
import { platform } from './platform';
import { imeComposing } from './focus';

/** Hints and dispatch yield to the same dialogs, popovers and shortcut recorder. */
export const shortcutsBlocked = () =>
  !!document.querySelector('.popover-layer, [role="dialog"], [role="alertdialog"], .palette-backdrop, .sketch-backdrop, .kbd-recording');

export function shortcutScope(target: Element | null): 'terminal' | 'browser' | 'app' {
  return target?.closest('.term-view') ? 'terminal' : target?.closest('.browser-pane') ? 'browser' : 'app';
}

/** Text controls retain native editing and ordinary text, including Shift-modified characters. */
export function textOwnsShortcut(combo: string | null, target: Element | null) {
  if (!combo || !target?.closest('input, textarea, [contenteditable="true"]')) return false;
  return isEditingShortcut(combo, platform) || (!/[⌃⌥⌘◆]/.test(combo) && !/^(?:⇧)?(?:Escape|F\d+)$/.test(combo));
}

/**
 * Esc on a Settings page is its Back to app while focus is on the page, its sidebar or nowhere; a field keeps Esc (clear,
 * cancel), and so does anything else on screen, such as a side pane's chat.
 */
export function leavesSettings(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { isComposing?: boolean; keyCode?: number },
  route: { name: string },
  target: Element | null,
) {
  // an input method's Escape ends its composition
  if (e.key !== 'Escape' || imeComposing(e) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || route.name !== 'settings') return false;
  if (!target || target === document.body || target === document.documentElement) return true;
  return (
    !!target.closest('.settings-page, .settings-nav') &&
    !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  );
}

/**
 * A composer command (a shortcut's, a slash command's) for the composer holding focus, else the main composer: the
 * focused pane's. It bubbles from that composer, so only its own pickers take it.
 */
export function dispatchComposerCommand(
  name: 'open-model-picker' | 'open-project-menu' | 'start-voice' | 'open-sketch' | 'open-permission-picker',
) {
  const focused = document.activeElement?.closest<HTMLElement>('[data-composer-chat]');
  const owner = focused ?? document.querySelector<HTMLElement>('[data-composer-main="true"]');
  owner?.dispatchEvent(new CustomEvent(name, { bubbles: true }));
}

/** Legacy slash-command events target the main composer; bubbling shortcuts target their own composer. */
export function ownsComposerCommand(event: Event, anchor: HTMLElement | null) {
  const owner = anchor?.closest('[data-composer-chat]');
  return event.target === window ? owner?.getAttribute('data-composer-main') === 'true' : !!owner && owner.contains(event.target as Node);
}
