# Critical user journey coverage

Every critical user journey (CUJ) has an end-to-end regression test for Codex and for Claude Code, or a written reason why not. The journeys and their status per harness are listed in [`journeys.json`](journeys.json): the original 22 (P0/P1/P2), the five P0 journeys in `design-v2.json` `newJourneys` (27 in all), and the gap list below. Each of the 27 is walked twice, once per first-class harness, so there are 54 journey x harness cells. `tests/journeyMatrix.test.ts` checks that every spec named there exists, that every journey has a row here, and that the numbers below match the file.

All specs live in `tests/e2e`, run the real Electron app against the fakes (`fixtures/fake-codex.mjs`, `fixtures/fake-claude.mjs`, `tests/fixtures/fake-acp-agent.mjs`, `fixtures/fake-helper.ts`), and are named `cuj-<journey-id>.spec.ts` when they were written for a journey. Older specs that cover part of a journey keep their names and are listed too. How to run and write them: `TESTING.md` section 2.4 and 4.

## How to read the tables

- **Covered**: a spec walks the journey's main steps on that harness, asserting what the app showed and what it sent to the fake.
- **Partial**: some steps are walked; the gaps column says which are not.
- **None**: no spec touches the journey on that harness.
- Gaps are listed even for Covered cells. "Not in the app yet" means the design describes a step that the app does not offer today, so there is nothing to test; it is listed so nobody mistakes the missing assertion for an oversight.

## Numbers

| | Covered | Partial | None |
|---|---|---|---|
| Before this work (54 cells) | 3 | 42 | 9 |
| After (P0 and P1 specs added) | 45 | 7 | 2 |
| Gap list, first-class harnesses (18 journeys, 36 cells) | 21 | 13 | 2 |
| Gap list, ACP (18 cells) | 1 | 2 | 15 |

Per priority, after: P0 24 of 24 cells Covered; P1 21 Covered, 1 Partial; P2 0 Covered, 6 Partial, 2 None (see the reasons below).

## P0 journeys

### first-launch-harness-detect

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-first-launch-harness-detect`, `cuj-codex` (first launch), `versions`, `brand` | Main view opens with the fake's models in the picker; Settings Overview shows Codex Ready with models and account; About shows the CLI path and version; a Codex below the minimum version says it does not work (Claude carries on) | The Retry button on "Couldn't connect to Codex"; install guidance for a missing Codex (the app only shows the error); choosing between several CLI binaries (the fakes have one) | Covered |
| Claude Code | `cuj-first-launch-harness-detect`, `cuj-claude` (Claude only, nothing usable, both signed in), `env-snapshot`, `welcome` | Claude alone opens the main view and Codex shows Not installed (default falls back for the run only); nothing usable shows the welcome flow with Sign in and Re-check; both signed in show the plan and account; Overview badges Ready / Signed out; About path and version; CLI found through the login shell PATH | The CLI selector with several candidates (the fake is one binary) | Covered |

### model-effort-fast

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-model-effort-fast`, `codex-session-settings`, `composer-menus` | Pick a model; effort slider (Ultra only where the model lists it); Fast on a model with the priority tier and off, with its reason, on one without; Reset to default; model, effort and `serviceTier` reach `turn/start`; each chat keeps its own; `/status` shows harness and model; "This chat only / Make default" footnote | `config.toml` default model; context and token numbers in `/status` are not asserted; the "Model changed to …" line shows on both | Covered |
| Claude Code | `cuj-model-effort-fast`, `composer-menus`, `caps` | Pick Sonnet then Opus; effort slider; no Fast toggle where the account has extra usage off (`fast-ineligible-account`, also on a model with Fast); Reset to default; the model-change line in the chat; the new model reaches the CLI (`set_model` / `apply_flag_settings`); `/status`; model scope footnote | Fast switched on for a Claude model (the fake's account blocks it); context and token numbers | Covered |

### sign-in-auth

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-sign-in-auth`, `welcome`, `accounts` | Nothing signed in: welcome flow, "My ChatGPT account", Sign in with ChatGPT opens the auth URL (the browser is stubbed), the login completes, Start, first chat runs; the API-key route signs in with no browser; Log out in Settings returns to the welcome flow and a second sign-in works | Signing in from the model picker or the avatar menu; recovering from an expired token; the third-party endpoint field | Covered |
| Claude Code | `cuj-sign-in-auth`, `welcome`, `cuj-claude` (nothing usable) | Welcome flow, "My Claude subscription", `claude auth login` runs in the embedded terminal, the app re-checks and Claude Code is ready, first chat runs; Log out runs `claude auth logout` in a terminal tab, Re-check, welcome again, second sign-in; API key and MoPilot-credits steps (`welcome`) | `ANTHROPIC_*` variables from the shell; API key with a custom endpoint; recovering from the picker's Re-check | Covered |

### daily-chat-loop

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-daily-chat-loop`, `cuj-codex`, `multi-window`, `harness-crash`, `settings-reasoning`, `codex-plan-review-compact`, `codex-background`, `external-writes` | Send with an attached image (a `localImage` input); a follow-up queued while a turn runs and sent with Steer now (`turn/steer`, joins the turn); Stop; edit the last message (`thread/revert`) and send again; `/compact`; reasoning shown or hidden; background terminal and sub-agent; another app's turn greys the composer | `@` file mention on Codex (the fake has no `fuzzyFileSearch`); sketches; dictation | Covered |
| Claude Code | `cuj-daily-chat-loop`, `cuj-claude`, `claude-sessions`, `claude-review`, `file-search`, `claude-tasks`, `external-writes` | Send with an attached image (an image block first); a follow-up queued and taken back, then Stop; edit the last message (file checkpoint rewind) and send again; `/compact` passes through as typed; `@` mention and Search Files; background agent outlives Stop | **Steer now on Claude**: with the fake a steered message (priority `now`) never gets a reply, so it is not walked (see Findings); sketches | Covered |

### review-diff-and-commit

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-review-diff-and-commit` | Approve a file edit in a git project; "Edited hello.txt +2" card; Undo and Redo (the file is removed and written back); View changes opens Last Turn with the file; Uncommitted scope lists it; commit with a message (checked with `git log`) | Split diff, Branch scope; push and pull request (`gh`); the Summary panel's PR row | Covered |
| Claude Code | `cuj-review-diff-and-commit` | The same flow through Claude's `Write` tool call and its structured result | The same | Covered |

### new-chat-default-harness

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-new-chat-default-harness`, `cuj-codex`, `mini`, `projects` | Default harness setting in Settings; picking a harness in a new chat runs it there and becomes the next default; a project sets the thread's folder; temporary chat opens from the menu, starts an ephemeral thread and never reaches the sidebar; Mini bar | Tray "New chat"; choosing an account when several exist | Covered |
| Claude Code | `cuj-new-chat-default-harness`, `cuj-claude`, `claude-sessions`, `mini`, `projects` | Default moves to Claude Code; chat in a project runs in that folder; temporary chat (`--no-session-persistence`) is not listed; Mini bar | Tray "New chat"; account choice | Covered |

### permissions-approvals

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-permissions-approvals`, `composer-menus`, `harness-crash` | Mode menu (Read-only, Ask for approval, Full access) and the Full access banner; command approval allowed once and denied with Esc, each decision checked in what the app answered; file-edit approval allowed and denied with a note that reaches Codex as the next message | "Allow similar commands" (execpolicy amendment) and "Allow for this session"; network and permission requests; persistent rules in `config.toml` | Covered |
| Claude Code | `cuj-permissions-approvals`, `claude-commands`, `claude-plan`, `composer-menus` | Bash and Write approvals allowed once and denied; Read-only mode (`dontAsk`) refuses a write and Bash with no card; the denial note and multiSelect questions (`claude-commands`) | Full access banner on a Claude chat (the banner code is shared and tested on Codex); sandbox rules | Covered |

### goal-and-away

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-goal-and-away`, `cuj-codex-goal`, `codex-goal-quit`, `exit-gate`, `computer-use` (unattended) | `/goal` shows a bar, the goal mark and one `thread/goal/set`; the goal's own round asks for a Mac app nobody authorized: refused, paused, one notification (none of its calls reach the helper); the chat is on screen, so the authorization card for the refused app (Allow once / in this chat / Always allow / Deny) comes up as soon as the stopped turn ends; a new chat shows no card; clicking the notification opens the paused chat with the same card, not a second one; once it is answered the bar says Paused, and Resume runs the goal to completion with one "Goal complete" notification; Pause, Clear; Quit pauses and the restart shows "Paused when MoPilot quit"; the quit dialog | The bar's "token budget (soft)" text (`/goal` has no budget in the fake); the card sits in the composer's place, so the goal bar returns once it is answered | Covered |
| Claude Code | `cuj-goal-and-away`, `cuj-claude` (goals), `account-switching` | `/goal` runs, the bar counts rounds to Complete; Pause, Resume, Clear; the usage-limited login hands over to the second one and the goal and plan mode carry over; completion and the notification open the chat | The Stop-hook "Goal check #n" folding and the 30-round limit; the hand-over keeps the goal active and the one notification is "Goal complete" | Covered |

### plan-then-execute

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-plan-then-execute`, `codex-plan-review-compact`, `multi-window` | `/plan` turns the chip on; a command approval while planning (number key 1); one plan card; the chip stays on; Implement this plan sends the execution in default mode; the file edit asks; Edited card and the Changes panel; edit the last message reverts (`thread/revert`) and keeps the plan | Shift+Tab for Plan and the "Implement this plan" permission choices: **not in the app yet** (a button, and Plan from `/plan` or the + menu) | Covered |
| Claude Code | `cuj-plan-then-execute`, `claude-plan`, `claude-sessions` | Plan from the + menu; one plan card with its file; Approve plan answers `setMode`; the chip goes off; the edit asks; Changes panel; edit the message rewinds the files (dry run, then real) | The question card inside plan mode (walked separately in `claude-commands`); Shift+Tab and the permission choice: not in the app yet | Covered |

### control-a-mac-app

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-control-a-mac-app`, `computer-use` | Settings guide for the first grant and Open System Settings; the card ("Allow Codex to control Notes?", Allow in this chat from its menu); "Controlling Notes" bar; take-over pauses, Resume; a second chat waits with "Waiting: another chat is controlling your Mac" and View; a physical Esc stops the turn, releases the desktop and lets the waiting chat run; element list and OCR text for a text-only model; vision consent card | The window glow and the tray's Stop item (native, not visible to Playwright); the Codex tool list without `cua_repl` | Covered |
| Claude Code | `cuj-control-a-mac-app`, `computer-use`, `echo` | The same, plus levels (View only unavailable for a click), Allow once / in this chat / always, the confirm-delete card, Settings grants and deny list, the remote switch off | The read-only tier rejecting a click with a reason: not in the app yet (no such tier setting); the glow and tray | Covered |

### use-my-chrome

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-use-my-chrome` | Settings Browser: choose Your Chrome, extension link, connection test (says the Playwright Extension is missing); the site card on the first visit; the call goes to Your Chrome (no built-in tab); back on the built-in browser the saved read-only site, a local server, asks again before a click; Read only on that card refuses the click; Read and write in Settings and the click goes through | A successful connection (needs a real Chrome with the extension); the per-chat tab group closing with the chat | Covered |
| Claude Code | `cuj-use-my-chrome`, `browser` | The same, plus every session starts with `--no-chrome`; site list and Remove in Settings | The same; the one-time notice for people who had Claude in Chrome on | Covered |

### unattended-scheduled-task

| Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|
| Codex | `cuj-unattended-scheduled-task`, `scheduled-run`, `computer-use` (unattended) | A task with computer control allowed and "Wait and notify" becomes due on the scheduler's tick (main's scheduler, its clock moved on): chat marked `unattended`; the new Mac grant is refused with the reason, no card, helper untouched (opening the run queues the grant's card behind the command approval); the command approval waits, an hour without an answer marks the run Needs attention on the Scheduled page, the notification opens the card, allowing finishes the run; Run now starts another | A per-task app list (not in the dialog); a single-notification count across both reasons is asserted only for the refusal | Covered |
| Claude Code | `cuj-unattended-scheduled-task`, `scheduled-run` | The same on Claude Code; computer control off is refused with its own reason; the dialog's fields. Both harnesses also run it with the default desktop tools: the run's `desktop_request_access` (Claude Code: `request_access` on `mopilot_computer`) is refused and paused, the deferred access card comes up in the open run once its turn ends (focused window or not), and Allow lets the next `app_screenshot` call run without a card | The same | Covered |

## P1 journeys

| Journey | Harness | Specs | Steps covered | Gaps | Status |
|---|---|---|---|---|---|
| switch-harness-handoff | Codex | `cuj-claude` (handoff, goal switch), `entries-routing` | Switch a Codex chat to Claude Code with the sheet (Comes along / Stays behind / Changes), handoff block, v2 segments; switch back with the catch-up divider; goal ticked to continue | Quota-limit suggestion; approvals, edit and rating in a switched chat; fork of a switched chat | Covered |
| switch-harness-handoff | Claude Code | `cuj-claude` | The same flow from the Claude side | The same | Covered |
| multi-account-relay | Codex | `cuj-multi-account-relay`, `accounts` | Two ChatGPT accounts listed, In use, Use switches (tokens handed to Codex); a turn on the CLI's own login ends on `usageLimitExceeded`, the chat moves to the second account with "Usage limit reached. Continued on second@example.test" in it, main sends "Continue where you left off." and the next message runs; the app-server's token refresh fails with no account to move to: the banner says the sign-in expired, Sign in again opens the sign-in, "Signed in again as …", and the next message runs | Adding a second account from the app (the fake signs every new login in as one identity); API key fallback; usage per account is in `cuj-usage-billing` | Covered |
| multi-account-relay | Claude Code | `cuj-multi-account-relay`, `account-switching`, `cuj-goal-and-away` | Usage-limited login hands over, note in the chat (kept after reload), goal and plan carried; a login whose token lapsed (`auth status` still says logged in, the turn ends on `authentication_failed`) shows "Your Claude Code sign-in … has expired" with Sign in in terminal, which runs `claude auth login` and lets the next message run (walked with Codex also installed; with nothing else usable the welcome flow takes the screen instead) | Add account (a terminal login of a second account); API key fallback | Covered |
| plugins-and-skills | Codex | `cuj-plugins-and-skills`, `extensions` | Plugins page on the default harness's tab; Install and Uninstall (`plugin/install`, `plugin/uninstall`), the sidebar's Installed list; a personal skill turned off and on (`skills/config/write`); Try now sends the skill as a skill input | Add a marketplace; plugin detail page | Covered |
| plugins-and-skills | Claude Code | `cuj-plugins-and-skills`, `extensions`, `claude-commands` | Claude tab, Skills tab, "Install with claude plugin" types the command into a terminal, a skill from the `/` menu goes to the CLI as typed | The Skills tab lists skills found on disk (`~/.claude/skills`, the project's `.claude/skills`) before any session has run; plugin skills appear once a session reports them | Covered |
| worktree-environments | Codex | `cuj-worktree-environments` | Worktree toggle on a project with `environment.toml`; the thread runs in `~/.mopilot/worktrees/<id>/demo` on a `mopilot/` branch; setup runs first; Settings → Git lists it; cleanup on archive | Project Actions; automatic cleanup of old worktrees | Covered |
| worktree-environments | Claude Code | `cuj-worktree-environments`, `worktrees` | The same, with the session's folder and setup ordering checked | The same | Covered |
| scheduled-tasks | Codex | `cuj-scheduled-tasks`, `scheduled-run`, `cuj-unattended-scheduled-task` | Open Scheduled; start from a template; instructions, Daily, Run with, new-chat toggle; saved to `automation.toml`; Run now starts the chat with the prompt; Pause and Resume; Edit shows the saved values and saves; the scheduler tick | Advanced fields besides Run with; the "task started" notification | Covered |
| scheduled-tasks | Claude Code | `cuj-scheduled-tasks`, `scheduled-run`, `cuj-unattended-scheduled-task` | The same with `harness = "claude"`, saved under `~/.mopilot/automations` (Codex tasks stay in `$CODEX_HOME/automations`) | The same | Covered |
| side-chat-fork-selection | Codex | `cuj-side-chat-fork-selection`, `codex-session-settings`, `codex-background` | Select a reply passage: Ask in side chat opens an ephemeral fork with the passage attached and answers in the pane; Add to chat attaches it to the main composer; Fork into new chat; Fork chat from here; a sub-agent thread opens beside the chat | Fork into a new window; selection with several passages | Covered |
| side-chat-fork-selection | Claude Code | `cuj-side-chat-fork-selection`, `claude-sessions` | The same through Claude's session fork | The same | Covered |
| usage-billing | Codex | `cuj-usage-billing`, `accounts` | Plan limits on the account row (58% and 90% left from 42% and 10% used); the Pay with row offers an API key form with an endpoint field, Cancel returns to Subscription | Saving a key: the app checks it with OpenAI first, and the tests never reach the network; credits and reset vouchers; opening the console | Partial |
| usage-billing | Claude Code | `cuj-usage-billing` | Plan limits from `/usage` (88% and 66% left); API key with a gateway endpoint: the next session starts with a key and that base URL; back to Subscription: it starts without; Remove key | Credits; opening the console | Covered |
| instructions-and-import | Codex | `cuj-instructions-and-import` | Edit and save the user `AGENTS.md`; Extensions → Import offers Claude Code's setup, Import sends the migration items, "Nothing to import" after, the sync source is counted | Project-level instructions; keeping imports in sync over time | Covered |
| instructions-and-import | Claude Code | `cuj-instructions-and-import`, `instructions` | Edit and save the user `CLAUDE.md`; `/init` reaches the CLI as typed; no import section (Claude Code reads `~/.claude`) | Project-level `CLAUDE.md` | Covered |
| manage-search-archive | Codex | `cuj-manage-search-archive`, `cuj-codex`, `chat-search` | Pin (listed under Pinned), rename, Cmd+K search, archive, find it in Archived chats and Unarchive, archive again and Delete permanently (`thread/delete`) | Copy chat ID and the resume command (native context menu); export | Covered |
| manage-search-archive | Claude Code | `cuj-manage-search-archive`, `cuj-claude`, `chat-search` | The same; deleting removes the session transcript | The same | Covered |
| configure-mcp | Codex | `cuj-configure-mcp`, `echo`, `tool-calls` | Settings → Codex → Extensions → MCPs: add a STDIO server (`mcp_servers."notes"` written to `config.toml`), listed, turned off and on (`enabled`), edited, uninstalled | Streamable HTTP and OAuth; calling the server in a chat | Covered |
| configure-mcp | Claude Code | `cuj-configure-mcp`, `extensions` | The form previews `claude mcp add --scope user …`, nothing runs until the button, the server is then listed as connected, Remove runs `claude mcp remove` | Toggle; MCP status inside a chat | Covered |
| code-review | Codex | `codex-plan-review-compact`, `cuj-pr-and-ci` | Inline `/review` shows its result once; the Code Review page lists my pull request (fake gh), shows its diff and checks, and Review in a new chat starts the review | The team review lists | Covered |
| code-review | Claude Code | `claude-review`, `cuj-pr-and-ci` | `/code-review` with a screenshot, findings card; the Code Review page is harness-neutral (walked once, on the default harness) | Starting the page review on Claude Code specifically | Covered |

## P2 journeys (not covered, with reasons)

| Journey | Harness | Existing specs | Why the rest stays uncovered |
|---|---|---|---|
| personalize | both | `keybindings`, `notifications`, `settings-reasoning`, `update-channel` | Appearance and sidebar tweaks are renderer-only and identical for both harnesses; there is no harness difference to regress. Partial |
| cloud-and-remote | Codex | none (Codex's own device pairing was removed for Settings → Computer access, #1873) | Codex Cloud needs Codex's cloud service and SSH needs a host; the fake supports neither. Claude Code: none, the journey is Codex-only |
| advanced-config-hooks | Codex | none | Codex `config.toml` features and memory have no scripted fake behaviour. None. Claude Code: `extensions` lists hooks read-only. Partial |
| voice-and-dictation | both | `dictation-engine`, `entries-routing` (speech stays in the current chat) | Microphone and speech recognition are native; the settings and current-chat operation menu use fakes; real transcription remains a provider-specific check. Partial |

## Gap list

The 27 journeys above came from the multi-harness design, so they cover what a single chat on one harness does. An audit on 2026-10-19 compared them with the journeys of Claude Desktop (its Code tab) and the ChatGPT desktop app (Codex), and with MoPilot's own features, and found journeys with no spec. They are listed here in three tiers; a journey already above that is part of the gap keeps its row above and is listed again with what is missing. Specs come later, one journey at a time, under the release-only rule for E2E (AGENTS.md); a new spec moves its cells and the numbers above. The reference products' behavior is from their documentation and use, not from a recorded walk; record the reference interaction when a spec is written (AGENTS.md, multi-harness feature development).

### Tier A: MoPilot's own features

MoPilot's own features (the product moat): no reference product has them, so nothing else will catch a regression.

| Journey | Priority | Reference | Codex | Claude Code | ACP | Specs today | What is missing |
|---|---|---|---|---|---|---|---|
| multi-account-relay | P1 | (listed above) | Covered | Covered | not tracked | `cuj-multi-account-relay`, `accounts`, `account-switching`, `cuj-goal-and-away` | Add a second account from the app (a new sign-in that lands as a new account), and the API key fallback once every subscription is out, on both harnesses. |
| built-in-browser | P0 | MoPilot | Covered | Covered | None | `cuj-built-in-browser`, `browser` | Covered on Codex and Claude Code (cuj-built-in-browser): the sign-in hand-off with Done, continue, the sign-in kept for a chat on the other harness, Take over keeping the tab. Left: ACP, a page that blocks the agent (bot check), Hand back. |
| cross-session-messaging | P0 | MoPilot | Covered | Covered | Partial | `cuj-cross-session-messaging` | Walked: Codex asks Claude Code, Claude Code asks an ACP chat, a chat switched from Claude Code to Codex receives a queued request and replies with every window closed, an archived recipient shows Blocked with its reason. Missing: an ACP chat as the sender, the @ picker and the Message another chat dialog as entry points, restart with a request in flight. |
| orchestrator-chat | P0 | MoPilot | Partial | Covered | None | `cuj-orchestrator-chat` | Walked: a Claude Code orchestrator keeps a task list, starts a Codex and a Claude Code session, a start on a missing harness fails with nothing left behind, the Codex session finishes with every window closed, the woken parent wraps up by itself. Missing: Codex and ACP as the orchestrator, ACP children, the cap on sessions working at once, offer / own_initiative cards. |
| acp-harness-daily-loop | P0 | MoPilot | Partial | Partial | Covered | `cuj-acp-harness-daily-loop`, `acp`, `acp-admission`, `acp-switch`, `acp-commands` | MoPilot's built-in browser and computer-use tools from an ACP chat (only sage-mcp's debug echo is walked), and a switch back from the ACP chat to Claude Code or Codex. |
| control-across-switch | P0 | MoPilot | Covered | Covered | None | `cuj-control-across-switch` | Covered both ways between Codex and Claude Code (cuj-control-across-switch): the app grant and the site grant carry over the switch with no second card, and Stop lets go of the app. Left: a switch to an ACP harness, Your Chrome tabs. |

### Tier B: parity with the reference products

Parity with Claude Desktop (Code tab) and the ChatGPT desktop app (Codex): journeys a user of either expects.

| Journey | Priority | Reference | Codex | Claude Code | ACP | Specs today | What is missing |
|---|---|---|---|---|---|---|---|
| code-review | P1 | (listed above) | Covered | Covered | not tracked | `cuj-pr-and-ci`, `codex-plan-review-compact`, `claude-review` | The Code Review page is covered against a fake gh (cuj-pr-and-ci): my pull request listed, its diff and checks, Review in a new chat. Left: the team review lists, reviewing on Claude Code from the page (the default harness runs it). |
| cloud-and-remote | P2 | (listed above) | Partial | None | not tracked | `extensions` | Both reference products run work away from the desk (cloud tasks, remote control from another device). Needs a product decision on scope before a spec; until then it stays P2. |
| pr-and-ci | P1 | Claude Desktop, ChatGPT desktop | Covered | Covered | None | `cuj-pr-and-ci` | Covered on both harnesses against a fake gh (cuj-pr-and-ci): Create (the in-app form, electron/platform/prCreate.cjs), Track pull request, the failing check in the Changes card, Auto-fix (from the PR's menu) sending it to the chat once. Left: pushing (the agent runs git push itself), review comments, merge conflicts. |
| preview-my-app | P1 | Claude Desktop | Covered | Covered | None | `cuj-preview-my-app` | Covered on both harnesses (cuj-preview-my-app): browser_preview_start asks on the Dev server card, the page opens in the built-in browser after the site card, preview_list, and Deny refuses. Left: launch.json configurations, preview_stop and logs, ACP. |
| terminal-and-background-work | P1 | Claude Desktop, ChatGPT desktop | Partial | Partial | None | `terminal`, `claude-tasks`, `codex-background` | One journey through the terminal panel, a command the agent leaves running and sub-agents: list them, open one, stop one, and keep them across Stop of the turn. Launch decision (2026-10-20): no new spec; terminal, claude-tasks and codex-background cover the pieces. |
| context-attachments | P1 | Claude Desktop, ChatGPT desktop | Covered | Covered | None | `cuj-context-attachments`, `file-search`, `cuj-daily-chat-loop` | Covered on both harnesses (cuj-context-attachments): a PDF and a folder from the + menu and an @ file reach the harness in its form; a removed chip is not sent. Found #1719 (text typed right after an @ pick lands inside the file name). Left: drop, pasted screenshot (regressions.spec), ACP. |
| quick-entry-and-windows | P1 | Claude Desktop, ChatGPT desktop | Partial | Partial | None | `mini`, `multi-window` | The global shortcut opens Quick Chat over another app, the prompt becomes a chat, it opens in its own window, and the tray's New chat and Stop work with the main window closed. Launch decision (2026-10-20): no new spec; mini and multi-window cover the pieces. |
| parallel-chats-and-status | P1 | Claude Desktop, ChatGPT desktop | Covered | Covered | None | `cuj-parallel-chats-and-status`, `notifications` | Covered (cuj-parallel-chats-and-status): a Codex and a Claude Code chat at once, Working and Awaiting approval in the sidebar, the approval answered in its own chat, the finished chat marked unread and notified. Left: ACP, more than two chats, the Priority list. |
| connectors-directory | P2 | Claude Desktop, ChatGPT desktop | None | None | None | none | Connect a remote MCP server or connector that signs in with OAuth, use it in a chat, and disconnect it. configure-mcp covers a local STDIO server added by hand. Deferred after launch (P2). |

### Tier C: lifecycle and robustness

Lifecycle and robustness: install, update, quit, crash, errors and running with no window.

| Journey | Priority | Reference | Codex | Claude Code | ACP | Specs today | What is missing |
|---|---|---|---|---|---|---|---|
| update-and-migrate | P1 | MoPilot | Covered | Covered | None | `cuj-update-and-migrate`, `persist-migration`, `downgrade`, `update-channel` | Squirrel's quitAndInstall itself (it needs a signed, packaged build; the spec quits through the same before-quit path); composer drafts, which are kept for the app's run only; the ACP harness. |
| quit-crash-restore | P1 | MoPilot | Covered | Partial | Partial | `cuj-quit-crash-restore`, `harness-crash`, `exit-gate`, `codex-goal-quit`, `acp` | After the app is killed, a Claude chat whose turn it left mid-way reads as running in another app for up to a minute (#1744); queued messages and composer drafts across an app restart (not in the app yet: both are kept for the app's run only); the ACP harness quitting mid-turn with an approval waiting. |
| errors-limits-offline | P1 | Claude Desktop, ChatGPT desktop | Partial | Covered | None | `cuj-errors-limits-offline`, `account-switching` | Sign in on a Codex turn that failed on its own lapsed login (#1745); a real network drop (the fakes model the harness retrying a failing stream); a Retry on a turn that already ended in an error (not in the app yet: Retry is on the running turn's banner); the ACP harness. |
| no-window-background | P1 | MoPilot | Partial | Partial | None | `scheduler-no-window`, `account-switching`, `cuj-cross-session-messaging`, `cuj-orchestrator-chat` | Walked with every window closed: a scheduled task, a queued cross-session request delivered and answered, an orchestrator child that finishes and wakes its parent. Missing: the notification that opens the right chat, and any of it on an ACP chat. |
| adopt-existing-sessions | P1 | Claude Desktop, ChatGPT desktop | Covered | Covered | None | `cuj-adopt-existing-sessions`, `native-thread-adoption`, `external-writes` | Bulk import of many threads and sessions at first launch (paging); the ACP harness. |
| keyboard-and-accessibility | P2 | Claude Desktop, ChatGPT desktop | Partial | Partial | None | `keybindings` | The daily chat loop with the keyboard only (new chat, send, approve, Stop, switch chat) and every control named for VoiceOver. Deferred after launch (P2). |

### Out of scope

- Image generation, Canvas and Artifacts, web search and deep research as product features, voice conversation mode and memory across chats belong to the reference products' consumer chat, not to a desktop host for coding agents. They become journeys only if MoPilot adds them.

## Findings from writing these tests

Real behaviours found while writing the specs. Two were fixed in the same PR (they blocked the journeys outright); the rest are listed for the owner.

Fixed:

- The side pane's resize handle covered the whole pane (the new open/close animation gave every child of `.side-pane` a `min-width` of the pane width), so nothing inside Changes, Files or the side chat could be clicked. Fixed in `app.css` in this PR.
- The composer crashed a Claude chat when capabilities had not loaded yet (`reading 'layer'`). Found by `cuj-review-diff-and-commit`; the same fix landed on main first (#151), so this PR does not touch it.

Fixed since the first version of this audit:

- A Codex chat shows no "model changed" line after a per-chat model pick; a Claude chat does (`modelChangeNote` is given the saved default model on the Codex path, not the chat's pick). Fixed in #163.
- Claude `/goal` through a usage-limit hand-over: the chat's notification says "Goal stopped before it was met" and the later completion sends no "Goal complete" notification. Fixed in #166.
- The model-change note ("模型改为 ...") and the quota suggestion toast ("额度已用完 ...", "在 Codex 上继续") are in Chinese; UI strings are English by decision. Fixed in #163.
- Settings → Codex → Extensions shows the MCP editor and the Hooks section together, and the Hooks header's Refresh button sits over the editor's Save button, so Save cannot be clicked with the mouse until the page scrolls differently (the test clicks it directly). Fixed in #164.
- The Claude Skills tab is empty until a Claude session has run in that folder, because skills only arrive in a session's init message. Fixed in #169.
- Logging out Claude Code from Settings opens a terminal tab that only runs once the app is back on a chat (the side pane is not shown on the Settings page). Fixed in #168.
- A window opened after linked-session work finished (every window closed, or a restart) showed briefs and wake-ups as plain messages and no task list or wrap-up box; peer messages and the PR row could show "invalid_source_window" / "Unknown app window" in a chat open at startup. The window's first reads went to main before boot sent `session:ready`, main refused them, and nothing read again. Found by `cuj-orchestrator-chat`; reads now wait for `windowReady()` (`src/lib/windowReady.ts`), in the PR that added that spec.

Not fixed:

- A linked session's sidebar row shows the harness's generated title, not the title `start_session` gave it (#1722). `cuj-orchestrator-chat` checks the titles in the journal until then.
- The card of a peer message to an archived chat names it by its id: the window's thread list leaves archived chats out. Found by `cuj-cross-session-messaging`.
- A Codex recipient's peer gate reads the Codex login from the account pool, which lists only `$CODEX_HOME/auth.json`. A Codex CLI that keeps its login in the keychain (`cli_auth_credentials_store`) or uses an environment key would read as `login_required`. The spec seeds `auth.json`, as a signed-in user has it; not checked against a real keychain login.
- From the tier C lifecycle specs: after MoPilot is killed, a Claude chat whose turn it left mid-way reads as running in another app until the transcript has been quiet for a minute (#1744), and a Codex turn that fails on the app-server's own lapsed login offers no Sign in, while Claude Code's does (#1745). With only one harness installed, a lapsed login sends the app back to its first-run page and the chat is no longer on screen (in #1745).
- Claude "Steer now" with the fake never gets a reply. It may be the fake (the real CLI folds a priority `now` message into the running turn); it needs a check against the real CLI before a test can assert it.
