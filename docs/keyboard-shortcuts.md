# Desktop keyboard shortcuts

MoPilot uses the applicable Codex desktop defaults documented in OpenAI's
[Commands reference](https://learn.chatgpt.com/docs/reference/commands) (reference checked October 15, 2026).
The shared `shared/shortcuts.mjs` catalog owns default keys, aliases, platform differences,
focus scopes and the deferred feature list. Settings → Keyboard shortcuts shows the effective bindings.

## Supported behavior

- App navigation, new/standalone/temporary/quick chats, chat organization, displayed sidebar and recent-chat
  selection, settings, command menu, file search, activity and attention navigation use existing MoPilot actions.
- The command menu uses the existing search palette, including its quick actions and Settings entries.
  Search chats remains separately assignable without a default binding.
- Model and project picker commands target the focused composer, including side chats. Admitted ACP chats
  open their existing model/configuration picker, or explain when no choices are available. Project selection
  changes the existing new-chat project target. It does not move an existing chat to a different project.
- The environment shortcut runs the first configured action through the same project ownership rules and
  terminal operation as the chat menu. A changed chat or project invalidates a pending environment read.
- Previous/next selects pane tabs while the workspace owns focus, and chats otherwise. Close closes the
  focused workspace tab, or the window when no workspace tab owns focus. Close-other-tabs leaves other chats'
  tabs alone. Full view and layout cycling use MoPilot's existing hidden, split and full pane states.
- Browser address, history, reload, reload without cache, URL copying and annotation shortcuts apply to
  the visible built-in browser pane, for both native views and guest pages. In a browser, URL copying takes
  precedence over working-directory copying. Browser chrome commands do not control external Chrome.
  Separate guest popup windows retain page input and do not forward pane shortcuts to their opener;
  return to the pane to use its toolbar shortcuts.
- Move to background remains assignable without a default, preserving shell Ctrl+B input.
- Terminal clear clears xterm scrollback without sending input to the shell. Ordinary terminal input stays
  with xterm. Toggling a right-pane terminal preserves its existing shell.
- Voice shortcuts target the active composer and share its cancellation and cross-harness confirmation flow.
- Font shortcuts change the existing chat font-size preference. Native full screen, quit and editor
  undo/redo remain provided by Electron. Composer prompt recall and approval Enter/Escape remain provided
  by their existing owners, including the additional confirmation required for destructive approvals.

## Customization and ownership

A saved custom binding replaces all default aliases for its action; removing a binding disables every
alias. Restore default removes that override. Existing customizations are preserved. A custom binding
wins over a conflicting default in the same scope. New conflicting edits are rejected in Settings and
again by the authoritative preference writer, so stale windows cannot introduce conflicts. New assignments
also reserve system editing, quit, hide, minimize and full-screen keys. Legacy overrides remain saved;
when they overlap system roles, the app action replaces the role accelerator. Editing combinations
use renderer dispatch outside text controls and retain native editing inside inputs and browser pages.

Bindings are saved independently per action. Accepted writes reach every window only after persistence.
A failed save leaves the recording and an error available for retry. Contextual browser and terminal
bindings can share a key with app actions; only the current owner handles the key. Native menu and renderer
handling share the catalog, and repeated one-shot keys, IME composition and modal controls do not trigger
background actions. Shortcut hints follow effective bindings rather than restating defaults.

## Deferred equivalents

These reference capabilities need additional product behavior and have no substitute default binding:

- In-chat find, next match and previous match.
- Reopening closed tabs.
- Recent-model history.
- Application-action undo and redo (ordinary editor undo/redo remains available).
- Go to line in file previews; browser address focus is supported.
- Shareable chat links and conversation-path copying across harnesses.
- Switching among Chat, Work and Codex surfaces.
- Appshots.

The catalog records the reason for each deferred group. In particular, Cmd/Ctrl+F does not open global
chat search. This is shortcut compatibility for existing MoPilot features, not a claim of complete Codex
interaction parity. Real-app verification belongs to release validation under AGENTS.md.
