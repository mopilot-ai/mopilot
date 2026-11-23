# Multi-harness design v2 (MoPilot)

Generated from `design-v2.json` (Chinese). Fixed decisions: only Codex and Claude Code are first-class; every other harness is basic tier on one generic ACP adapter; each harness's own commands pass through natively; computer use and browser control are core and work for every harness.


## Thesis

Sage (product name MoPilot) is the host for multiple coding harnesses: the UI keeps the look of ChatGPT/Codex, each harness declares its own capabilities, and Sage only polyfills what a harness lacks and what must be consistent across all harnesses.
1. Eight independent axes: Harness, Provider, Account, Model and session config, Target, Chat and segments, Sage platform services, Sage shared capabilities. HarnessKind = 'codex' | 'claude' | 'acp:<id>'. There are exactly two first-class harnesses: Codex (app-server JSON-RPC) and Claude Code (Agent SDK), each with a dedicated adapter, and both instances live in Electron main. dsh, opencode, Kimi Code, Qwen Code, Copilot CLI, Cursor CLI, Gemini CLI and Goose are all basic tier: they go through the same generic ACP adapter plus one quirks file per harness (opencode uses 'opencode acp'), appear in the picker only after passing runtime admission, and carry a Basic badge. The recommended DeepSeek path is Claude Code plus the DeepSeek Provider; dsh exists separately as a basic-tier harness. The MoPilot gateway is a Provider under Codex and Claude Code; for basic-tier harnesses, the Provider and credentials are managed by the harness itself, and Sage injects no key.
2. Capabilities are negotiated. Each adapter declares in three layers: static info, connect-time negotiation, and dynamic session state (held by main, with a rev; a window takes a snapshot first, then applies patches). 34 semantics (goal, plan, review, multiAgent, compact, init, skills, plugins, and so on) each get one binding: rpc, passthrough, config, polyfill, route, or none with a Why. The effective capability is the intersection of six layers: harness, provider, model, account, feature flag, and session. Components read only this result, and no harness name appears in them. CLI versions only set a minimum version and known-bad versions; each capability that depends on undocumented behavior gets a runtime probe, and a failed probe turns off only that one item.
3. One presentation rule, based only on Why.layer: native; Sage polyfill (small label “by MoPilot”); route to another harness (state the target harness, the account, and “this is a new chat”, with a confirmation dialog the first time it crosses vendors); grey out with the reason and a fix action; hide. Never silently degrade into a plain message. The app UI is in English, and the English copy is authoritative.
4. Native first, pass through by default. A harness's own commands and workflows are handed to the harness verbatim, and state follows what the harness reports. Sage intercepts only three kinds: pure UI commands, commands that only have an interactive implementation (a static list determined per CLI version, plus init.terminal_slash_commands), and commands that would break the session. Claude's / commands must go in the last content block. If a basic-tier harness has never pushed a command catalog, any typed /xxx is passed through verbatim.
5. Polyfills serve only the first-class harnesses, under three criteria: state ownership is stated; the difference can be explained in one sentence; any extra model spend is user-initiated with a visible budget. The polyfill engines are reduced to init (Codex has no /init), shell (Claude has no '!'), and archive/search (Sage metadata). Claude's /goal has no pause, so Sage holds a pause that meets the criteria: Stop or Pause = interrupt() then send '/goal clear', the condition is stored in Sage, and Resume re-sends '/goal <condition>'; the GoalBar is labeled “by MoPilot” and states that the turn count restarts. The goalLoop, goal_report, planGuard and review polyfills are all deleted; basic-tier harnesses get no polyfill that does a harness's job for it.
6. Platform services and shared capabilities belong to Sage. fs, terminal, search, projects, scheduled tasks, worktrees and notifications are implemented in Electron main and do not go through Codex. Computer use and browser control are core capabilities and must work on every harness, including the basic tier. There are three injection channels: Claude gets one in-process SDK MCP server per session (alwaysLoad), Codex uses mcp_servers in the thread config (thread/start and thread/resume), and basic-tier harnesses use mcpServers in session/new; a basic-tier harness whose injection does not succeed is not admitted. The injected server name carries a per-session random suffix, sage-mcp is a signed native helper, and the Electron fuses turn off RunAsNode. Authorization is enforced only inside Sage's tool handlers; the agent can never control MoPilot itself or system security UI; an unattended turn can only use apps that have already been authorized; the user moving the mouse takes over immediately; when there is no vision model at all, it works from an AX plus local OCR element table.
7. Accounts fail over automatically only within the same Provider and the same billing method, and switching from a subscription to pay-as-you-go always asks first. Changing Provider is a single user-confirmed switch: it opens a new segment with a handoff, does not resume the original session, and states where the data goes. Subscriptions, API keys and MoPilot credits are all account rows under some Provider, managed in one place only (Accounts & billing), and can be chosen per chat; a switch only affects the next session start, does not interrupt a running turn, and does not rewrite the CLI's own credential files. After an account or segment change, the adapter re-applies the goal and plan mode to the new session and inserts a note into the chat.
8. Parity is required only between the two first-class harnesses: the P0 journeys (including five new ones: leave after setting a goal, plan first then execute, control a Mac app, use my Chrome, and scheduled tasks while nobody is around), plus goal, plan, multi-agent, review, init, compact, skills, computer use and browser, must all be completable on both Codex and Claude Code. Basic-tier harnesses only commit to basicTierContract: the core session journeys, passthrough of native commands and modes, and computer use plus browser. Native-only operations such as realtime conversation, Codex Cloud and output style may differ, with accurate capability labels. Speech input follows the shared current-chat contract in [VOICE.md](VOICE.md); it never implicitly opens another harness.
Delivery: one target design and eleven work packages (WP0–WP10), ordered only by dependency, all part of the final architecture and shipped in the same release; before public release there are two internal dogfood rings (Ring 0 internal, Ring 1 trusted users). There is no “stop the bleeding first, refactor later” and no transitional code to delete later; the work packages merge into one long-lived release branch in dependency order, and half-finished work is never merged to trunk. The conformance checks for Claude Code 2.1.295 (Agent SDK 0.3.295) and codex-cli 0.162.0-alpha.17.2 have been measured, and the results are written directly into this version; items not yet measured (admission of the 8 basic-tier harnesses, per-thread shutdown of node_repl and codex_apps, whether Claude's Stop hook survives restartResume, re-testing on the Codex stable release, process-kill scenarios) are written as conformance checks that choose between branches already written out. #16 has already completed the rename (MoPilot, ai.mopilot.code), Developer ID signing, hardened runtime, notarization and Squirrel auto-update; the computer use helper and sage-mcp join that signing chain directly. Line numbers are as of 7a5bf12. The last work package runs the full acceptance suite in a real Electron release build and checks the 84 issues one by one.

## How Sage relates to harnesses

**lede**: Sage is not a harness and should not grow into one. A harness is the agent loop itself: calling the model, assembling context, executing tools, deciding whether a turn is over, whether to keep chasing a goal, compacting, and saving sessions, with session state following what it reports. Sage is the host, standing outside the loop, a relationship like VS Code and a language server, or Zed and the ACP agents it mounts. In one sentence: the harness decides what to do in this turn and whether to take another turn; Sage decides which tools to give it, makes it stop when the user asks, and shows you the results.

**roles**: 
- **role**: UI shell
  
  **does**: Renders chats, takes input, and shows approval cards, the GoalBar, and the Plan chip.
  
  **rel**: Draws whatever the harness reports, and only the controls it declared; controls held by Sage (pause and limit of a Claude goal) are marked "by MoPilot".
- **role**: Platform services
  
  **does**: Files, terminal, search, projects, worktrees, scheduled tasks, notifications, dictation.
  
  **rel**: Independent of sessions and does not pass through any harness.
- **role**: Tool provider
  
  **does**: Computer use, browser, vision fallback.
  
  **rel**: Sage acts like an MCP tool server; when to call it is decided by the harness's loop; authorization is enforced inside Sage's handlers.
- **role**: Outer orchestration
  
  **does**: The init and shell polyfills, for first-class harnesses only; pausing and resuming a Claude goal.
  
  **rel**: Drives the harness from outside like a user: sending messages, interrupting, re-sending commands, without reaching into the loop.

**bounds**: 
- Sage does not call a model directly to do the agent's work. The only exception is vision fallback, which is a tool that internally calls an image-reading model, like an ordinary MCP tool.
- Do not rewrite the harness's context and do not fake the harness's state. So when a basic-tier harness has no compact it is not offered, and no new session is made to pose as compaction; pausing a Claude goal really clears the goal, the GoalBar states that MoPilot remembers the condition, and resuming sets a new one.
- State held by Sage itself must be labeled with its ownership: the pause condition and round limit of a Claude goal, and the transcript Sage stores itself for harnesses like dsh that have no history replay, are marked in the UI with "by MoPilot" or "History is kept by MoPilot".
- A polyfill engine may use only the actions in the adapter contract: send, interrupt, setMode, setConfig, and tool injection.
- A polyfill must satisfy three criteria: state ownership stated, the difference explained in one sentence, and any extra spend initiated by the user and with a visible budget; and it serves only first-class harnesses. If these are not met, there is no polyfill, and the capability is hidden or redirected to a first-class harness that can do it.

## Basic-tier contract

**scope**: Applies to all basic-tier harnesses: dsh, opencode, Kimi Code, Qwen Code, Copilot CLI, Cursor CLI, Gemini CLI, and Goose, integrated through the generic ACP adapter (ACP v1 only) plus their own quirks files. Basic-tier harnesses are user-installed; Sage does not distribute them, pin their versions, or inject Provider and key.

**admission**: 
- Static: quirks must declare privacyDefaults (the default uploads and telemetry to turn off) and admission; if missing, it does not enter the picker.
- Runtime: the bin is detected using the login shell's PATH; initialize succeeds; after session/new with sage-mcp (server name sage_<nonce>), a handshake is received within 10 seconds; the privacy check declared in quirks passes (for dsh, --dump-config confirms session-log-deepseek is off).
- Conformance: image return in tool results, with the model able to read out a random word in the image (using a vision-capable model); when modality is unknown, the element table and locate and describe are usable.
- If any fails: it does not enter the picker and a new chat cannot be created; Settings → Other harnesses shows "Installed · Can't run in MoPilot" and the specific reason (for example "MoPilot can't give it computer and browser control"). A state of "in the picker but computer use is unusable" is not allowed.

**guaranteed**: 
- Detection and admission: see admission; once passed, it appears in the picker with a Basic badge, and the hover explains the differences and links to the list of differences.
- Login: shows ACP authMethods; logins that need a terminal are completed in Settings' embedded terminal (the platform pty) and re-detected automatically after exit.
- Create a chat (local directory or a worktree created by Sage), send text and images (when promptCapabilities.image is true), and display streamed messages, thinking, tool calls, and the diffs inside tool_call.
- Approvals: session/request_permission is rendered verbatim from the options the harness gives as a generic approval card (label taken from the originating segment); tools of sage_<nonce> are automatically allow-once, and the same action is asked about only once.
- Cancel: Stop and Esc = session/cancel; if a tool call still arrives afterwards while no prompt is in flight, send cancel once more and treat it as unattended.
- Resume: after restarting the app, reopening a chat shows the full history (session/load when loadSession exists, otherwise replay Sage's own stored transcript and then session/resume), and sending can continue.
- Computer use: the same tools, authorization card, no-go zone table, unattended rules, takeover rules, global desktop lock, and Esc emergency stop as the first-class tier; injected via session/new mcpServers. When model modality is unknown, give both a screenshot and the element table and inject locate and describe; with no vision backend, work from AX plus a local OCR element table.
- Browser control: the same browser_* tools for the in-app browser (sage_browser_* while Your Chrome is the active channel) and site permissions, injected through the same channel.
- Sage-side metadata: title (first message truncated), rename, archive, pin, unread, project membership, ⌘K search (title plus transcript index), export, copy session ID.
- Platform services work as usual: terminal panel, @ files, Files panel, instruction file editing (instructionsFiles come from quirks), notifications.
- Privacy: the default uploads declared in quirks are turned off in the launch arguments and verified before launch, and launch is refused if verification fails.
- Unattended: tool calls arriving when there is no in-flight user prompt, and those more than 10 minutes after the last physical input, are always unattended; when a new authorization is needed or an irreversible category is hit, reject the call, session/cancel, and send one notification.
- MoPilot's plugins: their MCP servers in session/new (stdio unless quirks mcpStdio is false; http and sse when initialize advertises them), and their skills and commands in the / menu and through plugin_skills and plugin_skill_read. Hooks, agents and app connectors are not run, and say so.

**optionalIfDeclared**: 
- Native command pass-through: when the harness pushes available_commands_update, commands enter the / menu (with a source label), typed text is passed through verbatim, and typing a command not in the catalog shows a line of explanation plus "Send as plain text"; for a harness that has never pushed one, any typed /xxx is passed through verbatim, without interception or prompts.
- goal pass-through: if the command catalog has /goal (Kimi, Qwen) it is passed through, with output rendered in the command output style and no GoalBar drawn. Copilot's autopilot is passed through as a mode.
- plan: the Plan chip appears only if modes or a category-mode configOption contains plan and quirks marks which one it is, with toggling via session/set_mode or set_config_option; Cursor's cursor/create_plan is rendered as a plan card only if quirks writes a mapping.
- modes and permissions: the harness's modes are listed under their original names; quirks may optionally mark each mode with an anchor (readOnly, ask, auto, full), and unmarked ones are treated as ask (affecting only the computer use authorization table); a menu with no modes shows only "Set by {label}".
- configOptions: model, thought_level, and other categories are rendered verbatim as generic controls, saved per chat, and take effect on the next turn per ACP.
- review, init, compact, skills, /swarm, /fleet, etc.: passed through as long as they are in the command catalog.
- fork: if sessionCapabilities.fork exists, provide Fork chat from here.
- Usage: usage_update drives the context ring.
- resumeCommand: Copy resume command is shown only after quirks provides it and conformance verifies it.
- Injection form: stdio sage-mcp by default; when a harness takes no stdio MCP server, quirks declares it (`mcpStdio: false`), and if its initialize advertises http, main itself serves an MCP endpoint (Streamable HTTP) on 127.0.0.1 with the same per-session token, sent as an Authorization header, and a peer check (the process holding the TCP connection must be the harness or one it started). Injection itself is an admission condition, not optional.

**notProvided**: 
- Sage polyfills: goal, plan, review, init, compact, '!' shell, per-turn deeper reasoning, speed tier. There is no goalLoop, planGuard, or goal_report.
- GoalBar and the task panel (sub-agents are rendered only as generic Agent or tool cards and can only be stopped as a whole).
- Temporary chats (⇧⌘N routes to Claude Code or Codex).
- Segment handoff with first-class harnesses: switching offers only "new chat with summary".
- Sage-managed Provider, key injection, MoPilot credits, multiple accounts, account switching, per-chat account selection, quota bars.
- rewind, edit message, Diff undo.
- Per-harness Extensions, MCP, and Skills settings pages (only the Overview in the Other harnesses page); plugins come from the shared Plugins page.
- Feedback upload (hidden).
- Sage distributing or pinning harness versions (Settings shows each harness's version and runs its own install channel's update, #1285); the harness's own TUI sessions appearing in the sidebar.

## Claude goals under the real CLI behavior

**summary**: Claude Code's /goal is a session-level Stop hook: after '/goal <condition>' is set, the CLI works repeatedly within the same turn, each time the turn wants to end it checks the condition with a small model, and if not met it continues with a synthetic user message "Stop hook feedback", and when met the turn ends. It has no pause, resume, or budget (usage is only '[<condition> | clear]'), the goal is still active after interrupt(), a '/goal clear' queued during the loop executes only after the loop ends, and the local CLI does not emit active_goal. Sage therefore: builds state from synthetic messages and the transcript; holds the pause and the round limit itself, satisfying the three polyfill criteria.

**snapshotSources**: 
- 'Goal set: <condition>' synthetic assistant message (model '<synthetic>'): status=active, objective=<condition>, rounds=0, and the condition is also written into the chat metadata (needed after an account switch or crash).
- 'Stop hook feedback:\n[<condition>]: <reason>' synthetic user message (isSynthetic:true): rounds+1, lastReason=<reason>; folded in the chat into one line "Goal check #n: <reason>".
- The transcript jsonl's goal_status record (met, condition, reason, sentinel): when met=true, status=complete; Sage already watches this file (#17).
- 'Goal cleared: <condition>' and 'No goal set': status is cleared; if it is a clear Sage issued for a pause, status=paused, pauseBy=sage.
- 'Goal active: <condition> (not yet evaluated)' (when the user manually sends '/goal' to look): used for reconciliation and does not change rounds.
- active_goal is not used (it is emitted only under CLAUDE_CODE_REMOTE), and CLAUDE_CODE_REMOTE is not set (the side effects are too big).

**controls**: 
**pause**: Stop or Pause: first interrupt(), and if the goal is still active send '/goal clear' (a local command that costs no tokens and executes immediately only after the interrupt takes effect), and store the condition in meta.goalHeld = {condition, heldAt, roundsBefore}. GoalBar: "Goal paused (kept by MoPilot) · Round count restarts when resumed [Resume] [Clear]".

**resume**: Resume: re-send '/goal <condition>' (as the last content block, with origin human since the user clicked it), clear meta.goalHeld, and count rounds from 0.

**clear**: Clear: when the goal is active, interrupt() first then '/goal clear'; when already paused, only delete meta.goalHeld and send no message.

**budget**: The round limit is counted by Sage (budgetBy=sage): metered-billing accounts default to 30 rounds and subscription accounts default to none; at the limit, interrupt() first then '/goal clear', the condition goes into meta.goalHeld, a note "Reached the limit (30 rounds). Goal paused · Limit set by MoPilot [10 more rounds] [Clear]" is inserted into the chat, and one notification is sent. Only queuing '/goal clear' does not stop a running loop (measured on 2.1.295), so interrupt must come first.

**criteria**: 
- State ownership stated: the paused condition is stored in Sage's chat metadata and the GoalBar is marked "kept by MoPilot"; while the goal is running, state still comes only from the CLI's synthetic messages.
- Difference explained in one sentence: "Round count restarts when resumed" — resuming amounts to setting the same goal again, and the CLI does not know how many rounds ran before.
- Extra spend is initiated by the user and has a visible budget: it starts again only when the user clicks Resume or [10 more rounds]; under metered billing the default is 30 rounds, and the GoalBar shows the limit and where it came from.

**carryOver**: 
- Account switch within the same Provider (restartResume): after closing the process and resuming, the adapter first uses setPermissionMode to restore plan mode, and when the goal is active re-sends '/goal <condition>' (the condition taken from metadata, with this turn handled as unattended and without origin human), and inserts the note "Max limit reached. Continued on b@x.com · Goal and plan mode carried over". Measured (C17, 2.1.295): the goal and its Stop hook survive resume, and a new '/goal <condition>' replaces the old goal, so no clear is needed before re-sending.
- Provider switch within the same harness (starting a new segment): "Continue this goal" in the SwitchSheet is checked by default; when checked, after the new segment starts, re-send '/goal <condition>', and the old segment does interrupt then clear.
- Cross-harness switch (Claude → Codex): the old Claude segment does interrupt then clear, with the condition going into meta.goalHeld; the SwitchSheet does not carry it over by default, and when checked, runs thread/goal/set with the same condition on Codex.
- Quitting the app: the quit gate does interrupt then clear on active goals, with the condition going into meta.goalHeld; after restart the GoalBar shows paused and does not resume automatically.
- Reopening after a crash or forced quit: if the metadata has an active goal and no goalHeld, Sage sends '/goal clear' (a local command) before sending the next user message, turning the condition into a Sage-held pause, to prevent the next unrelated message from continuing the old goal.
- Temporary chats cannot set a goal (pinned account, no account switching).

**unattended**: Follow-up check rounds driven by the Stop hook, and a /goal re-sent automatically after an account switch, are not just initiated by the user and are handled as unattended: computer use may use only authorized apps; when a new authorization is needed the handler rejects the call, Sage does interrupt then clear (the condition goes into goalHeld), and sends one notification.

**edgeCases**: 
- The user types '/goal clear' by hand in a Claude chat: passed through verbatim; if the goal loop is running, Sage does interrupt() first and then sends it, to avoid it queuing until the loop ends.
- The user runs claude --resume on the same session in a terminal and operates the goal: reconciled as an external write, with the transcript as the source of truth; when meta.goalHeld conflicts with the transcript, discard goalHeld and show "Goal changed in another app".
- When hooks are disabled (disableAllHooks, allowManagedHooksOnly) or the workspace is untrusted, the CLI rejects /goal: the rejection text is shown verbatim and no GoalBar appears.
- The CLI itself pausing a goal because of quota (the string has "Goal paused · usage limit reached", not measured): recognized from the synthetic message as status=usageLimited, and the GoalBar shows the reason.

**verify**: Measured (2.1.295, C4, C11): '/goal' is recognized only in the last block; the formats of 'Goal set:' and 'Stop hook feedback'; the goal is still active after interrupt; a queued clear waits until the loop ends; there is no active_goal. Measured (C17, C18): the Stop hook is preserved after restartResume; a '/goal clear' sent right after interrupt() executes at once. To be measured: whether the goal is still there after reopening following a crash.

## Decisions and premises

1. Decision: the only first-class harnesses are Codex and Claude Code; dsh, opencode, Kimi Code, Qwen Code, Copilot CLI, Cursor CLI, Gemini CLI, and Goose are all basic tier, go through generic ACP plus quirks, and appear in the picker only after passing runtime admission. Premise: the basic-tier contract contains only the core session journey, native commands and mode pass-through, computer use, and the browser.
2. Decision: opencode goes through opencode acp as a basic-tier harness, not opencode serve. Premise: the basic tier requires only the core journey and the shared tools; ACP's session/new mcpServers actually solves the problem that serve can inject MCP only at the instance level; the lost diff, revert, share, todo, and provider login are not in the basic-tier contract.
3. Decision: dsh is a basic-tier harness installed by the user; Sage does not distribute it, pin its version, or isolate DSH_HOME, and adds only --patch (turning off session-log-deepseek, changing the acp row's model to deepseek-flash) and DSH_TELEMETRY_DISABLED=1; before launch, --dump-config verifies that session logging is off, and launch is refused if the check fails. Premise: session logs are uploaded by default up to 8 MiB, which is a privacy floor that must be turned off at every tier, and must fail closed.
4. Decision: goal is provided only at the first-class tier (Codex rpc, Claude passthrough); Claude's pause and round limit are held by Sage (interrupt() then '/goal clear', with Resume re-sending), satisfying the three polyfill criteria; if a basic-tier harness has a native /goal it is passed through, otherwise it is not provided. No goalLoop and no goal_report. Premise: in Claude 2.1.295 the goal loop was measured to run within a single turn, the goal stays active after Stop, a /goal clear queued during the loop waits until the loop ends, and there are no pause or budget subcommands.
5. Decision: goal budget defaults: goals on subscription accounts have no limit; under metered billing (API key, MoPilot credits, DeepSeek key), Codex defaults to tokenBudget 2M (a soft limit, settled per turn, stated in the UI) and Claude defaults to 30 rounds (Sage counts Stop hook feedback, and the UI is labeled "Limit set by MoPilot"); both can be changed in settings; when switching to a metered-billing Provider, the SwitchSheet's Changes column states the new budget. Premise: unattended autonomous work under metered billing keeps spending money, so the user must be able to see the limit; spending on subscription accounts is already capped by the plan quota.
6. Decision: a first-class harness's model, effort, and speed tier are saved per chat, with each instance additionally storing new-chat defaults; choosing on the new-chat page changes the defaults, while choosing in an existing chat changes only that chat; the first time the model is changed in a Codex chat after the upgrade, a one-time notice is shown. Codex therefore differs from the official Codex desktop's global behavior. Premise: the two first-class harnesses in the same app must behave consistently.
7. Decision: a scheduled task lives where its harness's own app can run it, and each scheduled time runs once. Codex tasks stay in `$CODEX_HOME/automations` (the official Codex app runs them too). Claude Code and basic-tier tasks live in `~/.mopilot/automations`, shared by every MoPilot build and profile; a Claude Code task is also registered in Claude Desktop's local scheduled tasks while Desktop is closed. MoPilot's scheduler claims each time in a shared run ledger (`~/.mopilot/automation-runs`) before it runs it, leaves a task to its native app while that app is open, and otherwise records the run in the app's own store first, so the app does not catch it up again. A time missed while nothing was open is caught up once, for the latest missed time within 7 days (Claude Desktop's documented rule, and what the Codex app was seen to do). Premise: the official Codex app does not recognize the harness field and would run other harnesses' tasks as Codex tasks, so none are written to its folder.
8. Decision: Claude and basic-tier segments provide no feedback upload and the entry point is hidden; Codex segments keep using feedback/upload as before; likes on Claude replies go only to MoPilot's own telemetry (when the user has consented). Premise: never upload chats across vendors.
9. Decision: dictation defaults to macOS local recognition for new users; users already using ChatGPT transcription before the upgrade keep their existing engine; ChatGPT-account transcription or MoPilot-credits transcription is optional, and the settings page states where the audio goes. Premise: local recognition needs no account; the Chinese and punctuation quality for existing users must not drop because of the upgrade.
10. Decision: for new users of the distributed version, the default billing path is MoPilot credits or the user's own API key; Claude subscription login and ChatGPT login are kept, and statements like "personal use" are changed to neutral text in a hover; the billing mode of existing users never changes because of an upgrade.
11. Decision: DeepSeek offers only deepseek-flash, without listing deepseek-v4-pro separately; the recommended path is Claude Code plus the DeepSeek Provider; the text-only fallback path is built anyway, serving GLM text models, Kimi K2, and users' own text-only endpoints. Premise: DeepSeek has already routed v4-pro to V4.1 Flash and plans to retire it.
12. Decision: no Codex·DeepSeek is provided; Codex's thread-level Provider (thread/start.modelProvider plus the thread config's model_providers.<id>, with credentials only through auth.command) serves only MoPilot and custom Responses endpoints, on the main branch. codex-cli 0.162 was measured to accept model_providers in the thread config (both nested and dotted keys work), so the fallback of "put it in the app-server launch arguments and restart when the definition changes" is not needed. auth.command executes immediately at thread/start, so Sage's key helper must be fast (reading the keychain cache, returning within 200ms) and non-interactive, and exit non-zero immediately on failure.
13. Decision: the worktree default branch prefix is mopilot/, the root directory is ~/.mopilot/worktrees, and the projectless directory is ~/Documents/MoPilot; existing settings and existing worktrees are not migrated. Premise: the product name has been settled as MoPilot and will not change again.
14. Decision: conformance tests are run by the release owner on this machine with a dedicated test account against the real CLIs, one full run before each release ring, and once a week during Ring 1 against the latest stable versions of Claude Code and Codex, with results checked in; golden replays of recorded sessions and the boundary test run on every PR in CI (.github/workflows/ci.yml, macos-14). The previous version's statement that "the repo has no CI" was wrong. Premise: real-CLI scenarios consume quota, and the project convention requires verifying in the real Electron app.
15. Decision (revised): Claude Code uses the vendor-native Claude in Chrome the way the official Claude Code does. A user session passes extraArgs {chrome: null} only when the remote switch native.claude.chrome is on (default on), the session bills a claude.ai subscription (OAuth, not routed through Bedrock or Vertex), and the Claude extension's native host is installed on this Mac; every other session, and every helper query, passes {'no-chrome': null}. Where Claude in Chrome runs, MoPilot hides its own Chrome tools so there is one controller; elsewhere "Your Chrome" and the in-app browser are provided by MoPilot's browser channel for every harness. Premise: vendor-native control matches the official product where its runtime exists, and MoPilot's own tools keep the core outcome everywhere else. The user is never asked to open the ChatGPT or Claude desktop apps; vendor plugins and extensions may be used inside MoPilot.
16. Decision: Codex's Sage tools go only through the thread config's mcp_servers.sage_<nonce> (carried by both thread/start and thread/resume), with default_tools_approval_mode="approve" and observation tools with readOnlyHint; dynamicTools is not used (under forced code mode images are data-URL strings, and the model cannot see them without calling image()); the namespaceTools capability flag from the previous version of the design does not exist, and the related branches are deleted. Codex's own Browser and Computer use (the bundled plugin unified-computer-use@openai-bundled) is switched on per thread on the native path (remote switch native.codex.enabled, default on, and the vendor runtime for that surface installed on this Mac: the plugin from the installed ChatGPT app, the OpenAI Chrome extension, the Codex Computer Use app), and MoPilot then hides its own equivalent tools; managed threads (switch off or runtime missing) and MoPilot's helper threads set plugins["unified-computer-use@openai-bundled"].enabled=false (verified). node_repl is turned off per thread with mcp_servers.node_repl.enabled=false, and for codex_apps a per-thread switch is to be found, both verified by WP0's X14; when it cannot be turned off, node_repl makes computer use on Codex segments marked "needs verification" with the helper's event tap as a backstop, and codex_apps goes through Codex's MCP approval and is not auto-approved when unattended.
17. Decision: the CLI version policy is "a minimum version plus known-bad versions": anything above the minimum version and not on the bad list works as usual and is only marked "unverified" in the compatibility table; each capability that depends on unpublished behavior gets its own runtime probe, and a failed probe turns off only that one item; when session startup fails, an incompatibility notice and an entry point for manually specifying the CLI path are shown. Premise: the Claude CLI updates almost daily, and putting a "needs verification" badge on the whole harness would make the badge meaningless.
18. Decision: the Settings information architecture has a budget: at release the sidebar has no more than today's 21 items and the total number of setting rows is no more than today's plus 10; accounts live only in Accounts & billing; one page per first-class harness; basic-tier harnesses fold into a single Other harnesses page; "Sage tools" is renamed Built-in tools. Premise: today there are about 32 navigable pages and about 150 setting rows, and the new design must not be more complex than today.
19. Open (needs a new review): if in the future a Sage-held goal loop is to be added for some basic-tier harness that has no native goal, it can only be re-reviewed as a new work package. This version removes goalLoop and goal_report, and keeps no code or interface reserved for it.
20. Decision: Copilot CLI and Cursor CLI ship with their remote switches off by default in the public release; turning one on changes only the switch default, not the architecture.
21. Decision: plugins are a capability of every harness (semantic plugins): installed once in MoPilot's store and delivered natively per harness family, with what a harness can't run (Codex app connectors elsewhere, hooks and agents on the basic tier) labelled with its reason, never dropped silently. Premise: Claude Code's plugin layout is already what Codex installs natively, and ACP's session/new mcpServers plus MoPilot's tool channel cover the basic tier's MCP and skills. Remote switches plugins.codex, plugins.claude and plugins.acp turn delivery off per family.

22. Decision: Claude Code and Codex stay first-class. The upstream ACP adapters for them (claude-agent-acp, codex-acp) carry the core loop but not accounts, usage, in-place switching or the vendor-native browser and computer control MoPilot governs; they stay behind a developer flag as a comparison lane. Premise and evidence: [ACP as the boundary for the first-class harnesses](#acp-as-the-boundary-for-the-first-class-harnesses-spike-1320).

## ACP as the boundary for the first-class harnesses (spike #1320)

**Question.** Can Claude Code and Codex run behind upstream-maintained ACP adapters, through the generic ACP adapter
and a quirks file each, with no user-visible loss? If not, what is the smallest first-class surface MoPilot still
has to own?

**What was run (2026-10-17).** `@agentclientprotocol/claude-agent-acp` 0.93.0 (the renamed Zed `claude-code-acp`; it
wraps Agent SDK 0.3.300 and was pointed at the user's Claude Code 2.1.302) and `@agentclientprotocol/codex-acp` 2.2.2
(TypeScript over `codex app-server`, pointed at codex-cli 0.163.0-alpha.10.2). Both were installed into a scratch
prefix and wired in as `quirks/claude-acp.cjs` and `quirks/codex-acp.cjs`, listed only when an unpackaged build's
`MOPILOT_FLAGS` turns `harness.acp.claude-acp.enabled` or `harness.acp.codex-acp.enabled` on (both ship off). The same
tasks ran on all four paths in one dev instance over CDP, on a copy of real user data and the CLIs' own logins.
Computer use and browser use ran in the benchmark VM. Per-run evidence is on #1320.

### Feature diff

"Same" means a user would not notice a difference in the journey; "degraded" means the outcome holds but something
the user sees or relies on is worse; "missing" means the outcome does not exist on the ACP path.

| Area | Claude Code over ACP | Codex over ACP |
| --- | --- | --- |
| Streaming and step rows | Same: text streams, "Worked for", step summaries. The harness shows as its raw id (`claude-acp`). | Degraded: MCP tool calls read "Ran commands"; an edit made through a command gets no "Edited 1 file" row. |
| Approvals | Degraded: the same card and outcome, but it names the harness id and the absolute path, says "Yes" for "Allow once", and the edited-file row counted +2 −2 for a +1 −1 change. | Degraded: the card loses the model's reason for the command ("Run command" and quoted argv only). |
| Plan and goals | Degraded: plan is a mode (shown as Read-only, with the Plan chip), but plan approval arrives as a generic tool card with the plan as raw JSON. `/goal` passes through; there is no goal bar or goal state. | Degraded: `/plan` and the `collaboration_mode` option pass through; `/goal` passes through; no goal bar, and goals are not paused and recovered across a restart (codexGoals). |
| Resume and compaction | Same: `session/load` reopened the chat after an app restart with its context; `/compact` kept it. | Same, except no "Context compacted" marker. |
| Usage and accounts (#1294, #1308) | Missing: per-turn tokens only. No account mark, plan quota, account pool, failover or switching. | Missing: same. The first-class picker shows each account's remaining quota; the ACP path has one process per harness on the CLI's default login. |
| Plugins and skills | Degraded: the harness's own skills and commands pass through, but only after the first turn (7 commands before it, 78 after). MoPilot's plugins' MCP servers go into `session/new` as for any basic harness. | Degraded: same (116 after the first turn). |
| Sky and Claude in Chrome | Missing: the generic adapter sends no `_meta`, so the session never gets `--chrome`; BU falls back to MoPilot's Your Chrome tools. | Regression: Codex Computer Use (`cua_repl`) and the user's `node_repl` reach the model with none of MoPilot's governance (desktop lock, overlay, Esc, node_repl off). |
| IAB, BU and CU tool injection | Same for the in-app browser: sage-mcp runs under the CLI, a grandchild of the adapter, which the tool socket accepts since #1345 (it first refused it, so the spike started over http). A multi-step IAB journey (fill a form, recover from the page's validation error, report the confirmation code, graded on the page's own report) passed, 27.5 s against 15.4 s first-class, both on Sonnet 5.5. | Degraded: the same journey passed over stdio (13.2 s against 14.0 s, GPT-6 Luna), but the step rows read `mcp.sage_<nonce>.browser_script`, and an earlier run over http failed ("the in-app browser is unavailable"): MoPilot's 62 tools sat beside the user's own 486 (Codex can defer MCP tools behind its tool search: `defer_loading`) and the model did not find them until the prompt named them. The native Browser plugin has no MoPilot backend here. |
| Harness switching mid-chat | Missing: "New chat with summary" only, as for every basic harness. | Missing: same. |
| Interrupt and Esc | Same: UI stopped in 151 ms (242 ms first-class), the running command was gone in 622 ms (313 ms). | Degraded: UI stopped in 205 ms, but the running command keeps going and nothing shows it; first-class lists it under Background terminals with Stop. |

Both paths share two generic-adapter quirks seen here: Esc pressed while a session is still opening takes about 8 s
on either path, and the ACP path then keeps the unsent message queued instead of dropping it; and an ACP chat records
the resolved folder (`/private/var/...`) while first-class records the folder as given (`/var/...`), so one folder can
show as two projects.

### 9-grid

- **Unit tests (both paths, on fakes).** The controlMatrix suite, `tests/controlMatrix*.test.ts`: 41 files, 423
  tests, all passing. It runs the real routing, grant, tab, lock and switch modules against fake harnesses, so its ACP
  cells cover the generic adapter that both spike harnesses run on; nothing in it is specific to the upstream adapters.
- **Real app, in-app browser (dev instance).** The table above, and the timings on #1320.
- **Computer use, browser use and an edge-suite slice (benchmark VM, 2026-10-17).** One run per cell; Sonnet 5.5 on
  Claude Code, GPT-6 Luna on Codex; fresh user data and Full access on each path. The four public benchmarks' data
  was not set up in the VM, so the benchmark slice is these journeys and the edge scenarios.

  | Case (graded on) | Claude Code | Claude Code (ACP) | Codex | Codex (ACP) |
  | --- | --- | --- | --- | --- |
  | CU: TextEdit, three lines, convert to plain text, save to Documents, check the title (the saved file) | pass, 45.9 s, MoPilot's desktop tools, 2 cards | pass, 42.4 s, MoPilot's desktop tools, 1 card | pass, 16.1 s, Sky (Codex Computer Use), no MoPilot card | pass, 42.9 s, MoPilot's desktop tools, 1 card; steps read "Ran commands" |
  | BU: the sign-up journey "in my Chrome" (the page's own report) | pass, 33.2 s, Claude in Chrome (`--chrome`) | fail, 12.6 s: no Claude in Chrome tools (no `--chrome`), and computer use grants a browser only at view level | pass, 15.4 s, Codex's own browser tool | fail: reached the page with Codex's own tools, then asked before ticking the rules box |
  | Edge E-S3 OAuth popup | pass, 20 s | pass, 18 s | pass, 20 s | pass, 21 s |
  | Edge E-P2b uploads and downloads | pass, 26 s | pass, 23 s | pass, 27 s | pass, 35 s |
  | Edge E-P8 checkout (one confirmation required) | pass, 20 s | pass, 15 s | fail, 48 s: asked through its own question, no MoPilot confirmation | pass, 33 s |
  | Edge E-P5d renderer crash | pass, 23 s | pass, 19 s | fail, 18 s: gave up after the crash | pass, 20 s |

  The Claude rows ran on a copy of a real signed-in Chrome profile with Claude in Chrome and default flags (a first run
  on MoPilot's own extension channel, which ships off, never finished pairing in a scratch Chrome on either Claude
  path). This is the one journey where Claude Code over ACP loses the outcome, and it is the gap migration step 2
  (`sessionMeta` passing `extraArgs: { chrome: null }`) closes. Things the VM showed that the dev instance could not:
  - Under codex-acp, Codex's own browser and computer tools reach the model next to MoPilot's, with none of
    MoPilot's governance; the BU run used them and logged no MoPilot operation.
  - The two first-class Codex failures are single runs on GPT-6 Luna on Codex's native Browser plugin path, where
    the edge checkout confirmation is the model's own question. Codex over ACP went through MoPilot's browser
    tools and confirmation card and passed. This is a first-class Codex finding for #1319, not an ACP advantage, and
    one run per cell is noise until it repeats.
  - Computer use needs someone there: a VM with no HID input for 10 minutes refuses every request as unattended, on
    every path. The driver nudges the VM's mouse.

### Cost model

Lines are at origin/main on 2026-10-17. Upstream churn is releases published 2026-08-18 to 2026-10-17 (npm).

| | First-class today | Over the upstream ACP adapter |
| --- | --- | --- |
| Claude Code transport MoPilot owns | 2,876 lines (`harness/claude/adapter.cjs`, `claudeSessions`, `claudeSessionOptions`, `claudeMessage`, `claudeTasks`, `claudeLiveOutput`, `claudeSessionTools`, `harness/claude/index.cjs`, `claudeState`, `claudeCatalog`, `claudeTranslate.ts`) | 33 lines of quirks, on the generic adapter (2,185 lines, already owned for eight harnesses) |
| Codex transport MoPilot owns | 2,239 lines (`harness/codex*.cjs`, `codexTranslate.ts`) | 39 lines of quirks |
| Tool channels | 1,662 lines (Codex thread config, plugin lifecycle, sub-agent parents, call attribution: 1,390; Claude SDK MCP and host servers: 272) | `sessionMcp` (120 lines, shared) |
| Experience layer (accounts, identity, usage, Claude in Chrome, transcripts, CLI install, presence) | 3,081 (Claude) + 1,063 (Codex) lines | Unchanged: none of it is in ACP, so all of it stays, and the parts that drive the CLI per account need a new seam into the adapter process |
| Upstream MoPilot follows | Agent SDK: 57 releases (0.3.235 → 0.3.302); Codex CLI: 31 stable (0.148 → 0.163) plus about 1,600 alphas | claude-agent-acp: 29 minor releases on 0.x (0.70 → 0.93), 162 with previews, and it pins its own Agent SDK; codex-acp: 16 releases including a major (1.6 → 2.2.2), 66 with previews, on its own `@openai/codex` range. Plus the vendors' CLIs underneath, and the ACP SDK (8 releases, 1.4 → 1.9). |

MoPilot's own change rate on the same files, over the 9 days of history this repository has (2026-10-08 to
2026-10-17): Claude Code transport 127 commits, Codex transport 82, the generic ACP adapter 64, quirks 13. Most of it
is feature work rather than following upstream, so it would not all go away.

The ACP path does remove about 5,100 lines of transport, but it does not remove an upstream: it adds one in front of
each vendor's (the adapter lags the SDK it pins, and changes as often), and every feature that makes the product
different (multi-account, usage, switching in place, Sky and Claude in Chrome under one governance, the in-app browser
behind Codex's own Browser plugin) is in the part ACP does not carry.

### Recommendation: stay, with a Claude Code hybrid behind the flag

- **Codex stays first-class.** codex-acp owns the app-server process, so MoPilot loses the hooks its experience
  is built on: the per-thread config (sage tools that are not deferred, node_repl off), the plugin lifecycle forwarding
  that puts Sky under one lock, overlay and Esc, the Browser plugin's in-app-browser backend, `additionalContext`
  notes, per-account homes and the relay. No quirk or launch variable reaches them (`CODEX_CONFIG` covers config only).
- **Claude Code stays first-class by default; a hybrid is plausible.** claude-agent-acp exposes what MoPilot
  needs as session options (`_meta.claudeCode.options`: `extraArgs`, `settingSources`, env), and Claude Code's account
  is its config folder, which a per-account adapter process can carry. The gaps are presentation and two seams, not
  missing protocol. Every journey that ran on it (in-app browser, computer use, the edge slice) passed on the same tools
  and cards as first-class.
- **Keep the spike quirks** as a developer-flag lane: when a vendor release breaks a first-class adapter, the
  upstream adapter is a ready comparison and a possible stopgap.

**Migration steps for the Claude Code hybrid** (each is its own pull request; the default does not change until the
last one passes):

1. Tool socket: accept a process the harness started further down, not only a direct child, so sage-mcp works over
   stdio for any ACP adapter that runs its CLI underneath. Done in #1345; the spike quirks dropped their http
   workaround.
2. Quirks hook `sessionMeta(ctx)` for `session/new`, `session/load` and `session/resume`, used to pass `extraArgs`
   (`--chrome` under the same rules as decision 15), `settingSources` and per-chat env.
3. One adapter process per (harness, account) in `AcpHost`, with the account's `CLAUDE_CONFIG_DIR`, so the account
   pool, failover and usage reads keep working; account and usage surfaces read the existing Claude identity layer.
4. Presentation in the shared ACP path, which every basic harness also gains: the harness label from its quirks,
   permission option names mapped to "Allow once"/"Deny", relative paths, plan approval rendered as a plan card, diff
   counts from the diff itself, and the harness's commands from the admission catalog before the first turn.
5. Goals and background tasks: implement the adapters' goal and async-task extensions, or keep `/goal` passthrough
   and say there is no goal bar.
6. Switching in place: hand a Claude Code (ACP) segment over with the same transcript import first-class uses.
7. Exit criteria to make it the default: every row above "same" for Claude Code, the controlMatrix suite and the
   edge suite green on the ACP cells, the benchmark slice within noise of first-class, and four weeks of
   claude-agent-acp releases without a regression in that suite.

Re-run this spike when ACP itself (not a vendor extension) carries accounts, usage limits, goals and background tasks,
or when codex-acp exposes the app-server's thread config and plugin lifecycle to its client.

## Risks

1. One release with eleven work packages landing at the same time: the integration surface is large, and problems will concentrate at the end. Mitigation: each work package has its own exit checks; golden replays and the boundary test run on every PR in CI; work packages are merged in dependency order into one long-lived release branch, and trunk does not take half-finished work; Ring 0 starts around week 12, exposing integration problems more than four months before the public release.
2. dsh is a developer preview, user-installed, with breaking changes almost every week; a change in the patch format could invalidate the privacy patch. Mitigation: validation with --dump-config before launch, with no launch if it fails (fail-closed); versions that fail admission show "Installed · Can't run in MoPilot"; packet capture in acceptance.
3. opencode acp coverage is incomplete (no undo/redo, diff, share, todo, or provider login), and ACP behavior may differ between the v1 and v2 lines. Mitigation: these are not in the basic-tier contract; the admission check looks only at the core journey and tool injection.
4. Dependence on unpublished or changing behavior. Claude: goal state is assembled from the text prefixes of synthetic messages ('Goal set:', 'Goal cleared:', 'Stop hook feedback') and the transcript's goal_status, which breaks if the CLI changes its wording; getSettings exists at runtime but is not declared in d.ts; perTaskStopAffordance, the origin rule, and "/ commands are recognized only in the last block" are all measured behavior. Codex: forced code mode determines how tool results reach the model; pausing a goal cannot stop a turn that is running, and tokenBudget is a soft limit; the key name by which plugins turns off cua_repl, the MCP approval semantics of the thread config, and the latency of thread/search. Mitigation: each item has a runtime probe or a golden fixture; during Ring 1, conformance runs weekly against the latest stable versions; a failed probe turns off only the corresponding capability.
5. Parts held by Sage differ from the native implementation: resuming a Claude goal after pause means setting a new goal, with the round count starting from 0 and the CLI not knowing how many rounds ran before; when the user manually runs /goal on the same session in a terminal, Sage's paused state is overwritten by the external write. Mitigation: the GoalBar states "Round count restarts when resumed"; external writes follow the reconciliation rule, with harness state as the source of truth; Codex's init polyfill clearly says "by MoPilot".
6. Multi-process resources: one ACP process per basic-tier instance, plus one SDK process per Claude session and the app-server, so memory usage rises. Mitigation: start on demand and reclaim when idle (no reclaiming when there are tasks or cron).
7. Computer use security issues: prompt injection cannot be eliminated; the agent may try to control MoPilot itself or system security UI; project config may pre-allow tools; an upstream tool's readOnlyHint may mislead the approval layer; the user and the agent fight over the pointer. The no-go zone table, input validation by source pid, irreversible-action gating, and takeover rules must be enforced in the helper and handlers; cua-driver has no ready-made support for excluding windows from screenshots, so the helper has to capture them itself; Electron fuses and the signed sage-mcp make "verify the peer" actually hold.
8. Unattended autonomous work (Codex goal continuation, Claude's goal loop within one turn, sub-agents, scheduled tasks, and basic-tier autonomous work outside a prompt: dsh round-driver, Kimi /goal, Copilot autopilot) calls tools and keeps spending money while the user is away. This is contained by the unattended rules (only authorized apps may be used, otherwise the goal is paused and a notification is sent), the default budget under metered billing, and the basic-tier rule that "tool calls outside a prompt always count as unattended".
9. Collateral damage across Providers or billing modes: if the account-switch logic is not isolated by Provider and billing mode, a subscription chat would be moved to MoPilot, DeepSeek, or a metered API key, changing the model, cost, and data destination, and the DeepSeek endpoint does not yet support redacted_thinking, so resume may fail outright. The contract and conformance must both cover this, and cross-Provider switches in telemetry should be 0.
10. MoPilot gateway: newly released models are rejected with a 400 until priced at the gateway; the CLI's background models (Claude auto mode classifier, Codex's codex-auto-review) depend on prices preset at the gateway; DeepSeek peak and off-peak pricing needs to be kept in sync.
11. Signing and TCC: signing is done only in release builds with MOPILOT_SIGN_IDENTITY set, and TCC and auto-update can be verified only on release builds; the helper and sage-mcp need separate signing, and the helper needs separate entitlements and inside-out signing; Screen Recording needs re-confirming roughly monthly; disclaim depends on private APIs and makes the CLI pop up its own permission dialog when it accesses ~/Documents; after turning off the RunAsNode fuse, anything that depends on ELECTRON_RUN_AS_NODE (@playwright/mcp) must be changed to go through utilityProcess. The bundle id has already reset authorizations once because of the rename and cannot be changed again.
12. Version drift: the Codex CLI, Claude CLI, and all basic-tier harnesses are user-installed and Sage cannot pin them; cua-driver is not embedded (WP8-3), @playwright/mcp depends on playwright's alpha versions, and @agentclientprotocol/sdk releases a version every week. Dependencies distributed with the app are pinned to exact versions and the regression suite is run on every upgrade; user-installed ones are covered by "minimum version plus known-bad versions" and runtime probes.
13. Data migration: moving claudeArchived, pinned, and worktreeOf into threads/<id>.v2.json touches user data; the old readSegments reads any json with a segments array, and would route an acp segment the wrong way. Mitigation: before any window opens, idempotent, atomic writes, with a completion marker; v2 uses a file name the old version does not read, and acp segments are never mirrored back to the old files; back up first; after rolling back to the old version the old data is visible but new changes after migration are not; if re-encrypting the built-in browser cookies fails, prompt the user to log in again.
14. UI clutter: badges, greyed-out items, status bars, polyfill notes, and new Settings entries all add elements and drift from the ChatGPT style. This is controlled by "harness-layer differences are hidden in context menus", the Composer keeping only two slots, source badges appearing only in menus and hovers, Applies to appearing only when it is not all harnesses, and the Settings page and row budget.
15. The semantic layer abstracts too much: unified names may cover native features, and users familiar with Claude Code and Codex cannot find the original names. Keep native names, native commands (including aliases), and source labels, and use the original names in toggle wording.
16. High regression cost: 27 journeys (22 existing plus 5 new) times 2 first-class harnesses, multiple Providers and models, plus contract scenarios for 8 basic-tier harnesses, all also tested on the real Electron release build, and real-CLI scenarios consume quota. Golden replays cover day-to-day development and run in CI, and real CLIs run only before release rings and weekly during Ring 1.
17. Concurrency in the same workspace: automatic goal continuation on an old segment, two chats changing code in the same cwd at once, and external clients (the official Codex desktop, claude --resume in a terminal) writing the same session at the same time can overwrite one another. Pause the old goal on switch; show a notice when an agent is already running in the same cwd; grey out the Composer when an external turn is running.
18. Basic-tier admission failures: whether Cursor (MCP may recognize only .cursor/mcp.json) and Copilot honor session/new mcpServers is unverified; if not, they are not admitted and users see "Installed · Can't run in MoPilot". Also: users expect opencode and dsh to have a first-class experience, so the release notes must state the scope of the basic tier clearly.
19. Native tools in Codex threads other than cua_repl: the user's own node_repl (connected to Sky CUA and browser-use) and codex_apps (302 connector tools, including side-effecting ones like doordash_checkout) appear in every thread by default. If X14 proves they cannot be turned off, Codex segments would have two sources of computer control at once. Mitigation: computer use on Codex segments is marked "needs verification"; the helper's event tap drops all synthetic events landing on MoPilot windows; codex_apps calls go through Codex's MCP approval and are not auto-approved when unattended.
20. Codex's auth.command executes immediately at every thread/start: a slow key helper makes every Codex thread start slowly, and if it triggers a keychain authorization dialog, thread startup would hang. Mitigation: the helper reads a cached item that main has pre-placed in the keychain (access control allowing only the signed helper), returns within 200ms, and exits non-zero immediately on failure; conformance tests the startup time.

## Roadmap

### WP0 Conformance probes, release infrastructure, and the gateway capability table

Depends on: none

In the first week, get three kinds of things done: checks that decide design branches (bring the already-completed Claude 2.1.295 and Codex 0.162 probes into the repo and run the remaining ones, and run admission probes against the 8 basic-tier harnesses); things that can only be verified on a signed build (computer use helper prototype, native dependency packaging, Electron fuses); and things other work packages read directly (remote kill switch, dogfood channel, the gateway /v1/models capability table and Fast pricing). No prerequisites.

Exit: Result files for both first-class harnesses are checked in, and every re-run check has a conclusion; each of the 8 basic-tier harnesses has an admission result (pass, or the reason it failed); in the signed test build, the helper's TCC grant is recorded under the helper's name, running the MoPilot binary with ELECTRON_RUN_AS_NODE=1 has no effect, and the terminal and rg can start; remote switches take effect when toggled in a dogfood build; /v1/models contains no unpriced models, and under MoPilot a Fast request is charged at the priority price or rejected with a notice.

### WP1 Harness contract, capability intersection, and chat data model

Depends on: none

Set up the types and data foundation shared by later work packages: an open harness registry (codex, claude, and 8 acp:<id> entries), three-layer descriptors, semantic bindings, the six-layer intersection and presentation rules, a segment-based chat model, session state and the adapter process boundary owned by main, and atomic persistence that can be rolled back to the old version. No prerequisites.

Exit: Unit tests cover every layer of resolveCaps and the five outcomes of present(); a fixture proves that calls with a mismatched segment kind are stopped by the assertion; two windows changing archive, pin, and prefs at the same time do not overwrite each other; after killing the process mid-migration and restarting, data is intact and counts before and after migration match; after rolling back to the 0.2.0 (7a5bf12) build, archive and pin are both still there, and the only things not visible are those added after migration; the copied resume command works in a terminal; the boundary test is in CI.

### WP2 Sage platform services, available as long as any harness is available

Depends on: WP0, WP1

Demote the Codex app-server from a global dependency to the backend of the Codex adapter, with all platform services moved into main; a user with only Claude Code or one basic-tier harness installed can also use the platform services fully. Depends on WP0 (native dependency packaging) and WP1 (chat metadata and the adapter contract).

Exit: With the codex binary moved away, in the real app: creating a projectless Claude chat, the terminal, Files and @ mentions, ⌘K finding a Claude chat, saving CLAUDE.md, and logging in to Claude in Settings can all be completed; without Codex, a Claude chat can open in a new window; a CLI installed in ~/.local/bin is detected; the terminal can open in a signed release build; archiving in two windows loses nothing; after saving the environment file, non-macOS entries are still there; with Notifications set to Never, no system notifications are received any more.

### WP3 Identity layer: Provider, Account, MoPilot billing, and the welcome page

Depends on: WP0, WP1, WP2

Keep the Harness, Provider, and Account axes separate; subscriptions, API keys, MoPilot credits, and DeepSeek keys are unified as account rows under a Provider, managed in one place only (Accounts & billing), selectable per chat, with switching that does not interrupt a turn and does not rewrite the CLI's own credentials; a new user goes from zero to the first message through a three-step welcome page. Covers first-class harnesses only. Depends on WP0 (gateway capability table, native build chain), WP1, and WP2 (pty, env snapshot).

Exit: For a user with only one ChatGPT account, after logging in to MoPilot the OpenAI group in Accounts & billing is still the single-account view, with no Share usage; for a user who has never logged in to Codex, logging in to MoPilot does not make Codex start charging; ~/.codex/auth.json is byte-identical before and after the whole flow; a Claude turn running while logging in or out of MoPilot is not interrupted; when a Claude subscription quota runs out, the chat is not moved automatically to DeepSeek, MoPilot, or an API key of the same Provider (a confirmation is asked before switching to an API key); two chats in the same Claude Code can use a subscription and MoPilot respectively; when launched from the Dock, CLAUDE_CODE_* in the user's shell takes effect for the shell Provider; on a Mac with nothing installed and only a MoPilot account, the welcome page installs Claude Code and sends the first message.

### WP4 Tool-injection seam, signed sage-mcp, and security seam

Depends on: WP0, WP1

One tool registry, one call entry point that executes only in main, three injection channels, and the security seam that makes "verify the peer" actually hold: a signed native sage-mcp, a random server name per session, token rotation, and parent-process verification. Depends on WP0 (fuses and native build chain) and WP1 (session ownership and the approval model).

Exit: The debug tool sage_debug.echo (returns an image with a random word) is called by the model and the random word is read out, on both the fake ACP agent (sessionMcp) and the existing Claude code path (sdkMcp, subscription account), with the call attributed to the correct chat; with 3 windows open, each call executes only once; observation tools are callable in the Claude read-only tier; with an MCP server named sage committed into the repo, its tools are not auto-allowed; a direct connection from the agent's bash to main's socket (without the token or with the wrong parent process) is rejected. Real verification of the Codex channel is at WP5's exit, and real verification of the basic tier is at WP6's exit.

### WP5 First-class adapters for Codex and Claude Code

Depends on: WP0, WP1, WP3, WP4

Move Codex's RPC from the renderer's store.ts into main's electron/harness/codex.cjs, and wrap Claude as an adapter on electron/harness/claude/adapter.cjs; native commands and workflows on both sides work as they are, with state following what the harness reports; crashes, external writes, version drift, and quit-and-restart all have defined paths. Depends on WP0 (conformance results), WP1, WP3, and WP4.

Exit: Conformance passes in full against the real local CLIs: on Codex, /goal on a new thread calls set only once and starts work, the chat has the user's /goal bubble, after pressing Esc the goal is paused and does not resume, and after quitting and reopening the app the goal is still paused; on Claude, /goal continues over multiple turns until the condition is met, the GoalBar turn count matches the number of Stop hook feedback entries, after pressing Stop the goal shows "paused (kept by MoPilot)", the next unrelated message does not resume the old goal, and Resume starts over; after switching accounts with an active goal on Claude, the goal is re-set with a note; /init generates CLAUDE.md on Claude and AGENTS.md on Codex; /code-review with an image takes effect; ultracode triggers a Workflow and produces a task snapshot, ultracode stays on after changing effort once, stopTask can stop one on its own, and after Stop the background subagent is still there; after Plan approval, execution follows the tier from before entering; effort in two Codex chats does not affect each other; sage_debug.echo reads out the random word on a new Codex thread, a resumed old thread, a Claude subscription, Claude+MoPilot, and Claude+DeepSeek, and the Codex tool list has no cua_repl; killing the app-server and the Claude CLI mid-turn each makes the approval cards disappear and show the reason, and the app-server restarts automatically.

### WP6 Generic ACP basic-tier adapter and 8 quirks files

Depends on: WP0, WP1, WP2, WP3, WP4

dsh, opencode, Kimi Code, Qwen Code, Copilot CLI, Cursor CLI, Gemini CLI, and Goose are integrated at the basic tier through one generic ACP adapter, promising only basicTierContract; a new harness needs only a registry entry and a quirks file. Depends on WP0 (admission probe results), WP1, WP2 (ACP client fs, terminal callbacks, and the env snapshot), WP3 (account row interface), and WP4 (sessionMcp and the fake agent), and does not depend on WP7.

Exit: Each of the 8 basic-tier harnesses either passes admission and completes every item in basicTierContract.guaranteed (create, send, streaming, approval, cancel, resume after restart, one desktop task, one browser task), or shows "Installed · Can't run in MoPilot" with the reason stated; Kimi's /goal pass-through works; typing /xxx in a dsh chat sends the text verbatim to dsh; a dsh packet capture confirms the request body has no session log, and after the patch is deliberately broken dsh refuses to start; a tool call arriving when there is no user prompt is treated as unattended.

### WP7 Semantic command layer, UI, and Settings information architecture

Depends on: WP1, WP2, WP3, WP4, WP5, WP6

All entry points are driven by descriptors and displayed by one set of presentation rules; the init and shell polyfills take effect only for first-class harnesses; Settings is rearranged under the new information architecture; the scheduler and the quit gate land here; the UI stays Codex-style, with the English copy table as the source of truth for wording. Depends on WP1, WP2, WP3, WP4 (approval model), WP5, and WP6.

Exit: In the real app, for Codex and Claude one at a time, go through the / menu, + menu, Plan, Goal, Review, Init, Compact, and Stop, then for one basic-tier harness (Kimi) go through pass-through and the hiding rules; the presentation of every entry point matches the generated capability matrix, and each of the five CapState values has at least one instance; the boundary test count is 0; around the Composer there is at most one status bar and one chip at the same time; the Settings sidebar has no more than 21 items and the total Row count is no more than today's plus 10, with Applies to matching the snapshot; run one scheduled task each on Codex and Claude; with an active goal and a background Workflow, Quit first lists what will be stopped, and after quitting the Codex goal is paused; Settings has no setting without a reader.

### WP8 Computer use, browser control, and vision fallback

Depends on: WP0, WP2, WP4, WP5, WP6, WP7

Every harness (including basic-tier ones), every login and billing mode, and every model (including text-only models) can control the browser and the desktop, with the same authorization, takeover, emergency stop, and safety floor. Depends on WP0 (helper prototype and signing chain), WP2 (pty and notifications), WP4 (channels), WP5 and WP6 (real-world testing of each harness's channel), and WP7 (approval card, status bar, Settings pages).

Exit: On a release-signed build, Codex+ChatGPT, Codex+MoPilot, Claude subscription, Claude+MoPilot, Claude+DeepSeek, Claude+a text-only custom endpoint, and every admitted basic-tier harness all complete the same set of browser tasks and desktop tasks; actions are rejected in the read-only tier; each action is asked about only once; the agent fails to click a MoPilot approval card or to open the privacy panel; neither ELECTRON_RUN_AS_NODE=1 nor a direct connection to the helper socket can control the desktop; moving the mouse mid-operation pauses the agent immediately; with two profiles running at the same time, only one agent is controlling at any moment; when cross-vendor consent is refused and there is no MoPilot, a text-only model completes the task with the AX+OCR element table; when a goal continuation needs a new authorization, the goal pauses and one notification arrives; an Always allow app needs no re-authorization after a restart; the BrowserPanel's CDP cannot reach the app's own webContents; no cua_repl appears in Codex segments.

### WP9 MoPilot gateway wrap-up, app identity, updates, and privacy

Depends on: WP0, WP1, WP3, WP7

The gateway's optional DeepSeek upstream and transcription route; app identity, updates, consent, cookies, and shortcut wrap-up; migration notes in the release notes. Depends on WP0 (gateway capability table), WP1 (migration framework), WP3 (Provider and accounts), and WP7 (quit gate).

Exit: A turn with web search is billed per call; if the DeepSeek upstream ships, Claude Code·MoPilot completes a turn with deepseek-flash; with a turn running, Restart to update first lists what will be stopped; outside /Applications the background check does not show a dialog; after turning sharing off on the web, restarting the desktop app does not change it back; Codex no longer appears in the tray and menu; after rebinding New Chat, the old key stops working; site logins in the built-in browser are still there after the upgrade, with a notice on failure.

### WP10 Conformance tests, capability matrices, and release acceptance

Depends on: WP0, WP1, WP2, WP3, WP4, WP5, WP6, WP7, WP8, WP9

Pin every harness's behavior into repeatable checks, generate two capability matrices, pass through two dogfood release rings, then complete all acceptance on the real release build and ship everything together. Depends on all earlier work packages.

Exit: All acceptance passes; the 84 issues are each verified closed; the two generated matrices match the UI presentation; once go/no-go passes, roll out 10% → 50% → 100%.
