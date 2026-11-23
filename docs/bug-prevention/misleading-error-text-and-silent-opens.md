# Misleading error text and silent opens

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/misleading-error-text-and-silent-opens/` (one note per file), not below; the bullets below are the earlier notes.

The user is told about a failure in words that hide it, or not told at all. An error main threw reaches the
renderer as `Error invoking remote method 'git:run': Error: …`, so a toast built from `e.message` or
`String(e)` names an IPC channel instead of what went wrong; and a link, "open file" or "reveal in Finder" click
whose promise nobody handles does nothing and says nothing when it fails (#697 and #716 fixed the first ones;
the rest were swept together).

## Search for and ask

- Search for: `.message` and `String(` in `toast(` and `set…Error(` calls; `native.shell.` outside
  `src/session/open.ts`; local copies of an error-text helper (`const errText = …`).
- Ask: *what does the user read when this fails, and does a click that opens nothing say so?*

## Notes

- Show an error with `errorText(e)` from `src/lib/ignored.ts` (it drops Electron's wrapper and reads a thrown
  object's `message`), or hand the rejection to `toastFailure("Couldn't rename the project")` from the store,
  which shows "Couldn't rename the project: <why>". Never put `e.message`, `String(e)` or `${e}` in a toast or
  error state.
- Open through `src/session/open.ts`: `openLink` for a web page in the system browser (`WebLink` for a link in
  the UI), `openFile` for a file in its default app, `revealPath` to show it selected in Finder, `showInFinder`
  for a folder, `openPath`/`openInApp` for the user's preferred app, `openMoPilotPage` for a page of the MoPilot
  website. Each one toasts why it failed, so main must hand the failure back (return `shell.openExternal`'s
  promise rather than dropping it). Call
  `native.shell.*` directly only where the caller awaits it or handles its rejection itself.
- Lint: `plugin/raw-error-text` (the first argument of `toast(…)` or of an error setter such as `setError`,
  `setLoadError` or `setFailed`, and an `error`/`…Error` field of a state or result object, when it holds
  `e.message` or `String(e)` of a caught error named `e`, `err`, `error`, `ex` or `reason`, or `${e}` of one
  named `e`, `err` or `ex`; a string state named `error` is often interpolated already cleaned) and
  `plugin/silent-open` (a `native.shell.openExternal`, `openPath`, `reveal` or `openIn` call, or
  `native.mopilot.openWeb`, that is not awaited and whose own promise gets no `.catch` or two-argument `.then`;
  `src/session/open.ts` is the exception).
- A vendor's failure can hide its cause too: Squirrel.Mac reports any feed or download answer that is not 2xx
  as "The server sent an invalid response", naming neither the server nor the status, so a report of it could
  not tell a failing server from a proxy or firewall in between. Where the vendor's error drops what went wrong, find it out
  (the updater asks the feed and the update file again, `nativeError` in `electron/updates/updater.cjs`) and say the
  server and the status or network error, as the Windows feed check does.
- A request that changes nothing is a failure not told: macOS can keep a stale privacy grant for an older build of
  the computer-use helper, so CGRequestScreenCaptureAccess shows no prompt and the permission stays off, and the
  permission card's Request and Try again (and Settings' Request permission) dropped the answer and changed nothing
  on screen (edge3 cu-not-running, CM-H18). Read the answer of `native.computer.requestPermission` / `recheck` and,
  while the newest status reads the permission off, say "still off" with the next step (`copy('computerUse',
  'permissionStillOff')`); an unread permission is not called off. Lint: `plugin/unread-permission-answer` (such a
  call whose answer is dropped as a statement; a call returned from an arrow to a helper that drops it is not
  matched).
- A state that is still pending is not a failure: Re-check on Claude Code toasted "Claude Code: detecting" in red
  when a newer detection overtook its own (#1385). A check reports the answer of the last check under way
  (`settledDetection` in src/session/harness/claude/accounts.ts) and says nothing while it is still checking; the row's
  neutral "Checking…" stands for it. Ask of every toast built from a status: *can that status still be pending?*
- Capability health has two audiences: map structured reason codes through `shared/capabilityReasons.mjs` for
  user-facing status, and keep raw reasons, helper paths and developer commands in Copy diagnostics (#1402).
  Unknown codes must get safe fallback copy, never the diagnostic string. Sweep checklist, guide and engine rows
  together; test every producer code and malformed codes. A diagnostics collector must read recorded evidence
  without probing or starting an installation; test cold and populated services through the real IPC entrypoint.
- #1617 (recurs after #1348): a check that turns a raw failure into an actionable one must also cover the failure that happens **during** the call, not only the state seen before it. A page whose renderer went while a command ran (a navigation still loading) returned the debugger's bare "Target crashed" from all three page senders (`sendTabCommand`, the Codex plugin's `deliver`, the panel tools' `send`), and the agent gave up instead of reloading. The before-check stays; the one shared `crashedMidCommand(wc)` maps a failure to "crashed, reload" when the renderer is gone after it. Test both moments: already crashed, and crashing mid-command.
- #1621: an effect the host applies later is a close not told unless the agent is told it where it acts. The turn end closes the unmarked tabs an agent opened (CM-T01), but only `browser_tabs_create` said so: the blank tab `browser_tabs_context` opens for a chat with none closed too, and `browser_tabs_mark` offered no mark for "keep it for my next message", so an agent promised the user tabs the turn end then closed. Every tool that can create a target a later rule removes states that rule, and the tool that keeps one covers what the user may ask for; `tests/controlMatrixTabTurnEnd.test.ts` (CM-T07) fails when a tool description says it opens a tab without stating the turn end. Ask of every lifecycle rule: *which tools create what it removes, and does each one say so?*
- #1626: retained-tab guidance must cover optional-tabId operations, page-opened children inheriting temporary ownership, shared session notes and native routes that hide host tools. Pair callable-name guidance assertions with multi-tab and temporary/user/retained-parent lifecycle controls, and verify both backend notes when composing concurrent browser fixes. Deterministic tests do not establish real-model compliance.
- Sign-in advice must fit the credential the user chose: a verify that found the Anthropic key, MoPilot credits or the shell's cloud account refused read as "signed out", so Re-check (and the welcome's key step) told an API-key user to finish `claude auth login`, and the welcome's Codex key skipped the check Settings' key gets. `detect` reports a refused credential MoPilot passes on as an error named by `rejectedCredential` (electron/identity/drivers/claude.cjs), keeping "signed out" for the CLI's own login, and every Codex key goes through `addCodexApiKey`. Ask of every toast or state that says "sign in": *which credential did the user choose, and does this advice fix that one?*
- #1724: a stop or refusal MoPilot makes on purpose is told where it lasts, to the user and to the model. Computer use stopping a native turn on MoPilot itself said why only in a toast and a system notification, so the transcript read "Stopped after 11s", the card said "Opened ai.mopilot.code" and the composer suggested the same action again, and the model never learned why. Every no-go refusal and native stop now goes through one note path (`electron/capabilities/contract/controlRefusals.cjs`, reached by `noGoError`/`refuseSelf`/`noteNoGo` inside a tool call); the card and the suggestion read the refused app from the chat's notes (`src/lib/controlRefusal.ts`), and the native model gets a developer message. Ask of every deliberate stop: *does the transcript keep why, does every surface showing the step say it was refused, and is the model told?*
- Back onto a form result (ERR_CACHE_MISS): the browser pane showed Chromium's bare code with a Retry that did nothing, and an agent's Back answered a plain "Navigated", because `history()` never read the tab's failure while `navigate()` and `loaded()` did. Chromium's net errors are told in Chrome's words through `shared/netErrors.mjs` (the code stays in the notice's tooltip and in the agent's note, with what to do next), and a form result offers Resubmit and Go back. `tests/controlMatrixNavFailures.test.ts` fails when a load wait that waits for `did-stop-loading` never reads `.failure`, or when browser code interpolates a raw `errorText` / `errorDescription`. Ask of every path that loads a page (navigate, back, forward, reload, a page's own load): *does a failure here reach the caller in words?*
- #1863: a failure's internals reached the UI from main and shared code, where `plugin/raw-error-text` never looked:
  peer delivery showed its snake_case reason codes ("Delivery blocked: adapter_capability_unavailable."), a Codex that
  quit showed its exit code and panic, and settings rows showed `spawn opencode ENOENT`, `EACCES … '<path>'`,
  `ECONNREFUSED <address>`, `net::ERR_*`, an RPC method (`plugin/install:`) or `exit code 243`. Say a failure with
  `userError(e)` from `shared/userError.mjs` (main and the windows; `errorText` lives there too): it turns system
  codes, network errors and exit codes into a sentence (`{ who }` names what quit) and drops stacks and paths. Say a
  reason code through its `Record<Reason, string>` table with a generic line for an unknown code
  (`shared/peerReasons.mjs`, like `shared/capabilityReasons.mjs`); `tests/peerReasons.test.ts` fails when main gives a
  peer reason without a line. Keep the raw text in the log or diagnostics (`noteIgnored`, the mirror's log), and keep
  text the model reads detailed. Lint: `plugin/raw-internal-text` (src, electron and shared, outside the model's tool
  code and refusals) flags any `<id>.message` or `.stderr` and `${error}`, `${reason}`, `${stderr}` or `${…code}` in a
  toast, an error setter, main's `{ kind: 'toast', text }` or an `error`/`reason` field. Ask: *does this line show a
  code, stderr, an exit code, a path or an RPC method?*
- A run that succeeded must not read as a problem. Claude chats showed every hook that printed anything, and a successful SessionStart hook surfaced its Node `MODULE_TYPELESS_PACKAGE_JSON` warning (Claude Desktop shows no hook runs). `shared/hookRuns.mjs` now shows a hook on every harness only when it failed, was blocked or was cancelled, with its own reason rather than its runtime's stderr noise. Ask: *does a success show anything here, and is the line the failure's reason or its runtime's noise?*
- A helper's effective permission can remain unavailable while its System Settings switch is enabled: macOS may validate a cached identity from an older build. Do not infer an off switch from a rejected API call. CM-H18 checks the model-facing onboarding as well as the card and Settings; `shared/computerPermissionRecovery.mjs` owns their already-enabled recovery, including selecting the entry before removing it. A renderer-only recovery hint lets the model keep asking for the same ineffective toggle.
- A refusal must not guess the user's act. A Chrome tab main had dropped for a debugger detach was refused with "the user may have taken it back", and the agent told the user they had dragged it away (#2325). `chromeTab.cjs` now names the reason the extension reported (dragged out, debugging bar cancelled, closed) and blames the user only for an act the extension saw. Ask: *does this message claim a cause the code never observed?*
- One message for every rejection of a device call reads as the wrong cause. Every `getUserMedia` failure said "Microphone access was denied", including a saved microphone that was unplugged and one another app held (speech PR1). `src/session/microphone.ts` (`openMicrophone`, `classifyMicError`) asks macOS for the app's grant first, falls back to the default device when the saved one is gone, names a busy device, and offers System Settings only for a denied grant. Ask: *does each failure name have its own message, and is the action offered the one that fixes that cause?*
