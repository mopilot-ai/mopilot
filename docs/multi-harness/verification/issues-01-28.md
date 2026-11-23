# Design issues D-1 to D-28: verification against main

Checked against `origin/main` at 9d1dd2d (after #148). Each row was decided by reading the current
code, then running the guarding tests (`node --test` for unit tests, `e2e.sh` for Playwright specs
against the fakes in `tests/e2e/fixtures`). Status is the state of main before the follow-up PR that
goes with this file; rows marked "fixed in this PR" say what was wrong and what changed.

Legend: **fixed**, **partial** (what is missing is named), **not fixed**. "Real CLI" means the
behaviour can only be confirmed against the real `claude` or `codex` binary, which the fakes cannot
stand in for.

| D | Title | Status | Evidence | Guarding test |
|---|---|---|---|---|
| D-1 | Claude `/goal` downgraded to a plain message | fixed | `src/harness/goalCommand.ts:7` sends `/goal <objective>` as typed on a Claude chat (`human: true`); `src/harness/claude.ts:666-720` keeps the goal bar from the CLI's own messages; no more toast | `tests/claudeGoals.test.ts`; `cuj-claude.spec.ts` "/goal on Claude" (rounds to complete, Pause and Resume). Multi-round behaviour on the real CLI: real CLI |
| D-2 | Codex goal resumes itself after Esc/Stop | fixed | `src/store/store.ts:1691` `interrupt()` calls `pauseCodexGoal` (`src/harness/adapters/codexSemantics.ts:13`: `thread/goal/set paused`, then interrupt); goal is read on open (`store.ts:926`) and shown in the goal bar with Resume | `tests/codexGoals.test.ts` "pause sets paused first"; `cuj-codex-goal.spec.ts`, `codex-goal-quit.spec.ts` |
| D-3 | Plan silently dropped when an approval card replaces the composer | fixed | plan is the chat's `SessionState.plan` in main (`src/store/session/sessionState.ts`), not a `useState` in Composer; Claude's chip follows the mode the CLI reports, Codex's follows `thread/settings/updated` (`electron/harness/codex.cjs:680`) | `claude-plan.spec.ts` (new test "a question card in the middle of a plan keeps Plan mode on", added in this PR), `multi-window.spec.ts` plan test, `tests/codexAdapter.test.ts` |
| D-4 | `/review` calls Codex `review/start` in a Claude chat | fixed | on Claude the typed `/review` is the CLI's alias of `/code-review` and goes out as typed (`src/components/Composer.tsx` submit, `src/harness/commands.ts:70`); the menu's Review entry gives way to the native command. `startReview` (`store.ts:1909`) still refuses non-Codex chats, now only as a backstop | `claude-commands.spec.ts` "/review low", `claude-review.spec.ts`, `tests/commands.test.ts` |
| D-5 | `/` menu lists only Codex skills in a Claude chat | fixed | `useClaudeCommands` (`src/harness/claude.ts:799-816`) feeds `claudeCommands()` from supportedCommands, init skills and `commands_changed`; Codex skills load only when there is no Claude catalog (`Composer.tsx` `useSlashItems`) | `claude-commands.spec.ts` (menu, skill, `commands_changed`), `tests/commands.test.ts` |
| D-6 | `ultracode` keyword does nothing on Claude | fixed | `electron/claude.cjs:570` adds `origin: {kind: 'human'}` only for typed text; Sage-written messages (handoff, scheduled, continue) don't carry it | `tests/claudeSessions.test.ts` "only typed messages carry origin human"; the keyword starting a Workflow on the real CLI: real CLI |
| D-7 | Claude session lacks Claude Code's system prompt | fixed | `electron/claude.cjs:544` `systemPrompt: {type: 'preset', preset: 'claude_code', snapshot: true}` | `tests/claudeSessions.test.ts` "sessions start with Claude Code's own system prompt"; `cuj-claude.spec.ts` "session defaults". Behaviour compared with the terminal: real CLI |
| D-8 | Claude chat feedback uploaded to OpenAI | fixed | `canFeedback` is Codex-only (`src/harness/entries.ts:8`) and used by the dialog (`Dialogs.tsx:80`), the `/` menu and reply thumbs; `sendFeedback` passes a thread only for a Codex segment (`store.ts:852`) | `tests/entries.test.ts`, `entries-routing.spec.ts` |
| D-9 | Temporary chat persists under Claude | fixed | `startClaudeThread({ephemeral})` (`claude.ts:410`) and `options.persistSession = false` for `opts.ephemeral` (`electron/claude.cjs:645-648`) | `claude-sessions.spec.ts` "a temporary chat is unpersisted", `tests/claudeSessions.test.ts` "temporary chats are unpersisted" |
| D-10 | Codex `/goal` wrong thread id, duplicate message, no status | fixed | goal calls use `nativeOf` (`codexSemantics.ts`, `store.ts:1716`); a goal is set with `thread/goal/set` only (the server starts the turn, `electron/session/controller.cjs:152`); `clear`, `pause`, `resume` parsed (`src/lib/codexGoals.ts`); `thread/goal/updated` and `cleared` feed the goal bar (`store.ts:2007`) | `tests/codexGoals.test.ts`, `cuj-codex-goal.spec.ts` |
| D-11 | `/goal` goes to the old harness during a pending switch | fixed | `runGoalCommand` uses `composerHarness` (pending switch aware); the switch sheet pauses the old goal on confirm (`HarnessPicker.tsx:588`) and sets it again on the target after the handoff (`src/harness/switch.ts:260-271`) | `cuj-claude.spec.ts` "switch with a goal", `tests/switchPlan.test.ts` |
| D-12 | Approved Claude plan runs in default permission | fixed | `planApproval` appends `updatedPermissions: [{type: 'setMode', ...}]` (`electron/claude.cjs:513`), restoring the chat's own mode; the plan shows once as a plan card | `claude-plan.spec.ts` round trip, `tests/claudeSessions.test.ts` "an approved plan goes back to the mode before plan" |
| D-13 | Codex Plan off sends no `default`; no Implement button | fixed | every `turn/start` sends `collaborationMode.mode` (`electron/harness/codex.cjs:173`); chip follows `thread/settings/updated` and resume; "Implement this plan" button (`ThreadView.tsx:321`). Presets are not read from `collaborationMode/list` (the mode and a model are enough) | `tests/codexAdapter.test.ts`, `codex-plan-review-compact.spec.ts` |
| D-14 | `/init` writes AGENTS.md in a Claude chat | fixed | `init` is in Claude's native catalog and passes through; Codex keeps the polyfill (`commands.ts:41`) and asks before replacing AGENTS.md | `tests/commands.test.ts` (Claude provider, passthrough); no e2e sends `/init` |
| D-15 | Codex Ultra and Claude ultracode not selectable | fixed | Codex: `ultra` stays in the model's effort list (`select.ts:53`); Claude: every `applyFlagSettings({effortLevel})` carries the session's ultracode (`electron/claude.cjs:567-577`), switch in the `/` menu and in the switch sheet | `tests/claudeSessions.test.ts` (effort change keeps ultracode), `claude-tasks.spec.ts` "ultracode is a session switch", `codex-session-settings.spec.ts` |
| D-16 | `/rename` fails silently on Claude | fixed | the command calls `renameThread` (`Composer.tsx` SLASH_COMMANDS rename) and `runIntercepted` catches and toasts | `claude-commands.spec.ts` "/rename in a Claude chat" (added in this PR) |
| D-17 | Esc kills Claude background tasks; idle reaper closes Monitor and loop | fixed | `perTaskStopAffordance: true` (`electron/claude.cjs:536`), `stopTask` per task, reaper skips sessions where `keepAlive(tasks, sched)` (`:1364`) | `claude-tasks.spec.ts` "a background agent outlives Stop", `tests/claudeTasks.test.ts` |
| D-18 | Workflow, background task and sub-agent progress invisible | fixed | `ClaudeTranslator` maps `task_*` and `background_tasks_changed` into one task panel, cards for Workflow, Agent, Skill and Monitor; Codex child threads open read-only | `tests/claudeTasks.test.ts`, `tests/tasksPanel.test.ts`, `claude-tasks.spec.ts`, `codex-background.spec.ts` |
| D-19 | Image messages break commands, keywords and `@files` on Claude | fixed | `buildClaudeMessage` orders blocks: handoff, images, text last (`electron/claudeMessage.cjs`) | `tests/claudeMessage.test.ts`, `claude-review.spec.ts` (BMP screenshot, command last) |
| D-20 | `/` popover takes over a typed command of the same name | fixed in this PR (was partial) | one registry (`commands.ts`) feeds menu and typed input; prefix match, no substring. Still wrong on main: `/usage` + Enter opened Sage's billing page because Composer kept its own `usage` entry and selected it on Enter. Now `usage` is dropped from `SAGE_SLASH` and Enter on a fully typed native command sends it (`Composer.tsx` `exactNative`) | `claude-commands.spec.ts` "a typed /usage with Enter" (added; failed before the fix), `tests/commands.test.ts` |
| D-21 | Status dialog and MCP list show Codex data in a Claude chat | fixed | `statusRows` is one template over the current segment; `loadMcpRows(harness, threadId)` per harness | `tests/entries.test.ts` ("Status is one template", "MCP rows per harness") |
| D-22 | Codex plugin mentions become `@plugin://` text on Claude | fixed in this PR (was partial) | `+` panel lists Codex plugins only for Codex (`entries.ts:16`). Still wrong on main: "Try now" on the Codex plugin and skill pages inserted `plugin://id` or `/skill` into a Claude composer. Now the composer refuses with a message (`codexAttachBlocked`). Claude's own plugins are not listed in the `+` panel; they appear in the Claude Extensions page instead | `tests/entries.test.ts` (extended in this PR) |
| D-23 | Voice hotkey bypasses harness check | fixed | `startVoiceChat` routes through `voiceRoute` (`entries.ts:83`) before creating a chat | `tests/entries.test.ts`, `entries-routing.spec.ts` "voice from a Claude Code chat asks once" |
| D-24 | Claude chat can't open in a new window | fixed | `threadHash`/`threadFromHash` encode and decode (`src/lib/deepLink.ts`); the route is set before the Codex connection (`store.ts:715`) | `tests/deepLink.test.ts`; no e2e opens a Claude chat in a second window |
| D-25 | ⌘K search misses Claude chats | fixed | search merges Codex `thread/list`+`thread/search` with `searchClaudeThreads` and ACP threads (`store.ts:840-848`) | `tests/chatSearch.test.ts`, `chat-search.spec.ts` |
| D-26 | `/logout` and menu Log Out delete the active Codex account | fixed in this PR (was not fixed) | `/logout` ran `store.logout()` which removes `accounts.active`, and the app menu did the same, whatever the chat's harness. Both now open Settings > Accounts & billing so the user picks the account (`Composer.tsx` SLASH_COMMANDS, `App.tsx` `logout` command) | `claude-commands.spec.ts` "/logout in a Claude chat" (added; the command no longer reaches Codex) |
| D-27 | Permission button shows read-only as Ask for approval | fixed | permission menu has a Read-only row with per-harness text (`src/harness/permissionsMenu.ts`) | `tests/composerStrip.test.ts`, `composer-menus.spec.ts` |
| D-28 | Mid-session Full access or read-only may not apply on Claude | fixed in this PR (was partial) | Full access: every session starts with `allowDangerouslySkipPermissions: true` (`electron/claude.cjs:534`), so `setPermissionMode('bypassPermissions')` is valid later. Read-only: the tool whitelist (`allowedTools`) was only set at process start, so a live switch into read-only ran `dontAsk` without it. Now `send()` restarts an idle process (resuming from disk, like an account move) when a chat moves into or out of read-only (`wantsReadOnly`), and a plan started in a read-only chat keeps the whitelist for after approval | `tests/claudeSessions.test.ts` "moving a live chat into or out of read-only restarts its CLI" (added). What the real CLI does with `dontAsk` and the whitelist: real CLI |

## Counts

Before this PR: 24 fixed, 3 partial (D-20, D-22, D-28), 1 not fixed (D-26), 0 no longer applicable.
After this PR: 28 fixed. Five of them still want one real-CLI check (D-1 multi-round loop, D-6
keyword, D-7 comparison with the terminal, D-15 Codex Ultra on a model that lists it, D-28
read-only on the real CLI).

## Not fully verified, and next steps

- **Real-CLI checks (D-1, D-6, D-7, D-15, D-28):** the fakes model these but cannot prove the real
  CLI does the same. Next step: one single-turn run each on the cheapest model in a temp dir
  (`/goal` with a one-round condition, "ultracode" in a typed message, `/status`-style prompt
  compared with the terminal, read-only mode asked to run Bash).
- **D-24 has no e2e for a Claude chat in a second window.** Next step: extend
  `multi-window.spec.ts` with a Claude chat and `native.win.open('thread=' + id)`.
- **D-14 has no e2e that sends `/init` on Claude.** Next step: add `/init` to the fake catalog test
  in `claude-commands.spec.ts` (the fake already lists it).
- **D-4:** `startReview` keeps a toast for non-Codex chats. It is unreachable while Claude's catalog
  is loaded; if the catalog has not loaded yet, a typed `/review` on the home page of a Claude
  default would still create a Codex thread. Next step: make `startReview` use the composer harness
  for the new thread, or hold the command until the catalog arrives.
- **D-22:** Claude's own plugins are not offered as `@` mentions. Left out on purpose: Claude plugins
  surface as skills and commands, which the `/` menu already lists.

## Other findings from the run (outside D-1 to D-28)

- `src/styles/app.css` on main at 9d1dd2d was missing a `}` after `.welcome code` (merge of #139 over
  the welcome page), so the Extensions page CSS was nested under it and `tests/styles.test.ts` failed.
  Someone fixed it on main while this was under review.
- `claude-sessions.spec.ts` "Fork chat from here" failed on main at 9d1dd2d (a Claude fork crash); it was
  fixed by #155 while this was under review.
- Unit tests that need the native `sage-mcp` build or a real dsh ("admitted: initialize ...",
  "contract: dsh", the sage-mcp pid and hello tests) failed or timed out here (SwiftPM was building).
  They are unrelated to D-1 to D-28 and were not rerun.
