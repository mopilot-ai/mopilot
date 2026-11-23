// Desktop shortcut catalog and resolution shared by menus, browser contents, Settings and renderer dispatch.
/** @typedef {'app' | 'chat' | 'composer' | 'workspace' | 'browser' | 'terminal'} ShortcutScope */
/** @typedef {{ id: string, title: string, desc: string, def: string | null, aliases: string[], windows?: string[], scope: ShortcutScope, menu: boolean, repeat: boolean, appFocus?: boolean }} ShortcutAction */
/** @typedef {Record<string, string | null>} Keybindings */
/** @type {ShortcutAction[]} */
export const SHORTCUT_ACTIONS = [];
/**
 * `appFocus`: the key is the app's only while focus is in the app's own UI; a browser page or a terminal with focus keeps
 * it (the page's find bar, a shell's Ctrl+F), so it is never a native menu accelerator either.
 * @param {string} id @param {string} title @param {string[]} keys @param {ShortcutScope} scope @param {{menu?: boolean, windows?: string[], repeat?: boolean, desc?: string, appFocus?: boolean}} [options]
 */
function add(id, title, keys, scope = 'app', options = {}) {
  SHORTCUT_ACTIONS.push({
    id,
    title,
    desc: options.desc ?? title,
    def: keys[0] ?? null,
    aliases: keys.slice(1),
    scope,
    menu: options.menu ?? (scope !== 'browser' && scope !== 'terminal'),
    repeat: options.repeat ?? false,
    windows: options.windows,
    ...(options.appFocus ? { appFocus: true } : {}),
  });
}
add('command-menu', 'Open command menu', ['⇧⌘P', '⌘K'], 'app', { menu: true });
add('settings', 'Settings', ['⌘,'], 'app', { menu: true });
add('shortcuts', 'Keyboard shortcuts', ['⌘/'], 'app', { menu: true });
add('open-folder', 'Open folder', ['⌘O'], 'app', { menu: true });
add('back', 'Navigate back', ['⌘['], 'app', { menu: true, repeat: true });
add('forward', 'Navigate forward', ['⌘]'], 'app', { menu: true, repeat: true });
// The whole window's zoom (shared/zoom.mjs); the ids predate it and stay, so saved rebindings keep working.
add('font-increase', 'Zoom in', ['⇧⌘=', '⌘=', '⌘NumpadAdd'], 'app', { menu: true, repeat: true });
add('font-decrease', 'Zoom out', ['⌘-', '⌘NumpadSubtract'], 'app', { menu: true, repeat: true });
add('font-reset', 'Actual size', ['⌘0', '⌘Numpad0'], 'app', { menu: true });
add('toggle-sidebar', 'Toggle sidebar', ['⌘B', '⇧⌘S'], 'app', { menu: true });
add('toggle-bottom-panel', 'Toggle bottom panel', ['⌘J'], 'app', { menu: true });
add('open-terminal', 'Toggle terminal', ['⌃`'], 'app', { menu: true, windows: ['⌘`'] });
add('clear-terminal', 'Clear terminal', ['⌃L', '⌘K'], 'terminal', { windows: ['⌘L', '⌘K'] });
add('clear-unreads', 'Clear all unread indicators', ['⇧Escape'], 'app', { menu: true });
add('close-tab', 'Close current tab or window', ['⌘W'], 'workspace', { windows: ['⌘W', '⌘F4'] });
add('close-other-tabs', 'Close other tabs', ['⌥⌘W'], 'workspace');
add('new-chat', 'New chat', ['⌘N', '⇧⌘O'], 'app', { menu: true, desc: 'Start a new chat' });
add('new-standalone', 'New standalone chat', ['⌥⌘O'], 'app', { menu: true });
add('quick-chat', 'Quick chat', ['⌥⌘N'], 'app', { menu: true });
add('temporary-chat', 'New temporary chat', ['⇧⌘N'], 'app', { menu: true });
add('archive', 'Archive chat', ['⇧⌘A'], 'chat');
add('mark-unread', 'Mark as unread', ['⇧⌘U'], 'chat');
add('pin', 'Pin or unpin chat', ['⌥⌘P'], 'chat');
add('rename', 'Rename chat', ['⌥⌘R'], 'chat');
add('side-chat', 'Open side chat', ['⌥⌘S'], 'chat');
add('search', 'Search chats', [], 'app', { menu: true });
add('prev-chat', 'Previous chat or tab', ['⌃⇧Tab', '⇧⌘[', '⌥⌘ArrowLeft'], 'workspace', {
  windows: ['⇧⌘Tab', '⇧⌘[', '⌘PageUp'],
  repeat: true,
});
add('next-chat', 'Next chat or tab', ['⌃Tab', '⇧⌘]', '⌥⌘ArrowRight'], 'workspace', { windows: ['⌘Tab', '⇧⌘]', '⌘PageDown'], repeat: true });
add('next-attention', 'Next chat needing attention', ['⌥⌘A'], 'app', { menu: true });
// split view, as Claude Desktop's Code tab: ⌃] / ⌃[ cycle the panes, ⌃⌘W closes the focused split pane. The two are
// never native accelerators (menu: false), so a terminal keeps them: ⌃[ is its Escape (TERMINAL_KEYS below)
add('next-pane', 'Focus next split view pane', ['⌃]'], 'app', { menu: false, repeat: true });
add('prev-pane', 'Focus previous split view pane', ['⌃['], 'app', { menu: false, repeat: true });
add('close-split', 'Close split view', ['⌃⌘W'], 'app', { menu: true, windows: ['⌃⌥W'] });
for (let n = 1; n <= 9; n++) add(`chat-${n}`, `Go to chat ${n}`, [`⌘${n}`], 'app');
for (let n = 1; n <= 6; n++) add(`recent-${n}`, `Open recent chat ${n}`, [`⌥⌘${n}`], 'app');
add('model-picker', 'Open model picker', ['⌃⇧M'], 'composer', { windows: ['⇧⌘M'] });
add('project-picker', 'Open project picker', ['⌥⇧⌘O'], 'composer');
add('start-voice', 'Start voice chat', ['⌃⇧V'], 'composer', { windows: [] });
add('toggle-activity', 'Toggle activity view', ['⌥⌘U'], 'app', { menu: true });
add('environment-action', 'Run environment action 1', ['⇧⌘D'], 'chat', { windows: ['⇧◆D'] });
add('search-files', 'Search files', ['⌘P'], 'app', { menu: true });
add('toggle-files', 'Toggle file tree', ['⇧⌘E'], 'app', { menu: true });
add('open-changes', 'Open review tab', ['⌃⇧G'], 'app', { menu: true, windows: ['⇧⌘G'] });
add('toggle-workspace', 'Switch between chat and tabs', ['⌥⌘B'], 'workspace');
add('open-browser-tab', 'Open browser tab', ['⌘T'], 'app', { menu: true });
add('cycle-layout', 'Cycle workspace layout', ['⇧⌘B'], 'workspace');
add('full-view', 'Enter or exit full view', ['⇧⌘F'], 'workspace');
add('browser-address', 'Focus browser address bar', ['⌘L'], 'browser');
add('browser-back', 'Browser back', ['⌘ArrowLeft'], 'browser', { windows: ['⌥ArrowLeft'], repeat: true });
add('browser-forward', 'Browser forward', ['⌘ArrowRight'], 'browser', { windows: ['⌥ArrowRight'], repeat: true });
add('browser-reload', 'Reload browser page', ['⌘R'], 'browser');
add('browser-reload-cache', 'Reload browser page without cache', ['⇧⌘R'], 'browser');
add('browser-copy-url', 'Copy browser URL', ['⇧⌘C'], 'browser');
add('browser-annotate', 'Toggle browser comment mode', ['⇧⌘.'], 'browser');
// the page's find bar (src/components/panels/browserPanel/FindBar.tsx), as Claude Desktop's and the ChatGPT app's
add('browser-find', 'Find in page', ['⌘F'], 'browser');
add('browser-find-next', 'Find next in page', ['⌘G'], 'browser', { windows: ['⌘G', 'F3'], repeat: true });
add('browser-find-previous', 'Find previous in page', ['⇧⌘G'], 'browser', { windows: ['⇧⌘G', '⇧F3'], repeat: true });
// the page's zoom for its site, in place of the window's while the page has focus (Chrome's keys)
add('browser-zoom-in', 'Zoom page in', ['⇧⌘=', '⌘=', '⌘NumpadAdd'], 'browser', { repeat: true });
add('browser-zoom-out', 'Zoom page out', ['⌘-', '⌘NumpadSubtract'], 'browser', { repeat: true });
add('browser-zoom-reset', 'Fit page to pane', ['⌘0', '⌘Numpad0'], 'browser');
add('copy-cwd', 'Copy working directory', ['⇧⌘C'], 'app', { menu: true });
add('copy-code', 'Copy last code block', ['⇧⌘;'], 'chat');
// the chat's prompts and replies (src/components/thread/view/ChatFind.tsx), on every harness
add('find-in-chat', 'Find in chat', ['⌘F'], 'chat', { menu: false, appFocus: true });
add('new-window', 'Open in new window', [], 'chat');
add('move-to-background', 'Move to background', [], 'chat', { menu: false });
add('toggle-changes', 'Toggle changes panel', [], 'app', { menu: true });

// Reference shortcuts left out on purpose: reopen closed tab (needs tab
// history), recent models (needs model history), app-level undo/redo (needs an action history; editor undo stays
// native), go to line (file previews have none), chat link (needs an external URL handler), conversation path (not
// portable across harnesses), and the Chat/Work/Codex surface switch and Appshots (MoPilot has neither).
/** @param {ShortcutAction} action @param {Keybindings} bindings @param {string} [platform] */
export function bindingsFor(action, bindings, platform = 'darwin') {
  if (Object.hasOwn(bindings, action.id)) return bindings[action.id] ? [bindings[action.id]] : [];
  return platform !== 'darwin' && action.windows !== undefined ? action.windows : action.def ? [action.def, ...action.aliases] : [];
}
/** @param {ShortcutScope} a @param {ShortcutScope} b */
export function scopesOverlap(a, b) {
  return a === b || !(['browser', 'terminal'].includes(a) || ['browser', 'terminal'].includes(b));
}
/** Effective bindings, with explicit customizations taking priority over defaults. */
export function effectiveBindings(/** @type {ShortcutAction} */ action, /** @type {Keybindings} */ bindings, platform = 'darwin') {
  const keys = bindingsFor(action, bindings, platform);
  return keys.filter(
    (key) =>
      !SHORTCUT_ACTIONS.some(
        (other) =>
          other.id !== action.id &&
          Object.hasOwn(bindings, other.id) &&
          bindings[other.id] === key &&
          !Object.hasOwn(bindings, action.id) &&
          scopesOverlap(action.scope, other.scope),
      ),
  );
}
/** @param {string} combo @param {Keybindings} bindings @param {ShortcutScope} [scope] @param {string} [platform] */
/** Control keys a shell needs (tmux's prefix, Escape, telnet's escape): in a focused terminal no app action takes them. */
const TERMINAL_KEYS = new Set(['⌃B', '⌃[', '⌃]']);
export function resolveShortcut(combo, bindings, scope = 'app', platform = 'darwin') {
  if (scope === 'terminal' && TERMINAL_KEYS.has(combo)) return null;
  const local = scope === 'browser' || scope === 'terminal';
  const candidates = SHORTCUT_ACTIONS.filter(
    (a) =>
      (a.scope === scope || (a.scope !== 'browser' && a.scope !== 'terminal' && !(local && a.appFocus))) &&
      effectiveBindings(a, bindings, platform).includes(combo),
  );
  return candidates.find((a) => a.scope === scope) ?? candidates[0] ?? null;
}
/** Platform roles remain reserved for new assignments; legacy overrides are retained and routed contextually. */
export function nativeRoleBindings(platform = 'darwin') {
  return platform === 'darwin'
    ? {
        undo: '⌘Z',
        redo: '⇧⌘Z',
        cut: '⌘X',
        copy: '⌘C',
        paste: '⌘V',
        pasteAndMatchStyle: '⌥⇧⌘V',
        selectAll: '⌘A',
        quit: '⌘Q',
        hide: '⌘H',
        hideOthers: '⌥⌘H',
        togglefullscreen: '⌃⌘F',
        minimize: '⌘M',
      }
    : {
        undo: '⌘Z',
        redo: '⌘Y',
        redoAlias: '⇧⌘Z',
        cut: '⌘X',
        copy: '⌘C',
        paste: '⌘V',
        selectAll: '⌘A',
        quit: '⌘Q',
        windowClose: '⌥F4',
        togglefullscreen: 'F11',
        minimize: '⌘M',
      };
}
/** @param {string} id @param {string} combo @param {Keybindings} bindings @param {string} [platform] */
export function bindingConflict(id, combo, bindings, platform = 'darwin') {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
  const native = Object.entries(nativeRoleBindings(platform)).find(([, key]) => key === combo);
  if (action && native) return { ...action, id: `native-${native[0]}`, title: `System ${native[0]}` };
  return SHORTCUT_ACTIONS.find(
    (a) => a.id !== id && action && scopesOverlap(a.scope, action.scope) && effectiveBindings(a, bindings, platform).includes(combo),
  );
}
