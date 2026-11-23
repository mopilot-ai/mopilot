# Composer Goal selection

## Reference and behavior

The user-supplied Codex screenshots show a target icon and `Goal` beside the permission picker after choosing Goal. Hovering shows a gray capsule, a filled circle with an X, and `Clear goal`. The objective remains plain text in the composer.

MoPilot now uses that interaction for selection through both the Add menu and the slash menu. Clearing the pending selection preserves text and attachments and does not clear an already running goal. An empty or whitespace objective cannot send attachments alone. Selection is kept with the in-memory draft for each chat and the new-chat composer; it is not persisted across app restarts.

Sending uses the current typed capability binding through the existing main-process send/queue services:

- Codex: native goal request via the existing `goal` send option.
- Claude Code: native `/goal` command.
- ACP: the advertised Goal passthrough template, when the harness declares a Goal command.
- An absent, disabled, routed, or unusable Goal binding: disabled menu entry with a reason; a pending selection cannot send until the capability becomes usable again. MoPilot does not invent a goal loop for harnesses that do not offer one.

Compatibility and chat-reference failures keep the draft and pending selection. Existing send-service error reporting and queue behavior remain in effect after dispatch. Current capabilities determine dispatch after a harness switch. Literal objective content is preserved, including multiline text and replacement-pattern characters.

## Verification

Run `npm run test:coverage -- --changed --suite composer-goal` before merging, or pass `--changed=<base>` with the pre-change base commit when checking an already merged change. The command measures the actual Composer, its mode chips (ComposerModeChips, with the Goal chip), draft hook, and capability adapter under focused React/DOM unit tests, then enforces 100% coverage of changed executable lines, branches, and functions.

The complete new Goal chip and capability adapter and the modified draft hook also reach 100% line, branch, and function coverage. The large existing Composer is measured only for changed behavior; this is not a claim of 100% coverage of the entire composer. Store changes are type-only. CSS is reviewed separately.

The unit journey covers default/empty state, both menus, selection, cancellation, actual send-service calls and reset, capability and reference failures, retry, per-chat draft restoration, new-chat drafts, native ACP command dispatch, and switching between Codex and Claude bindings. IPC/network services, unrelated controls, and the rich input component are mocked boundaries. No extra app instance, build, broad regression suite, or E2E suite is used. The screenshots establish the visual reference; these unit tests do not establish complete runtime or pixel parity with Codex.
