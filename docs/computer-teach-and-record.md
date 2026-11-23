# Teach mode, full control and Record a skill

Three computer-use features that follow Claude Desktop's: the agent guides the user step by step (teach mode), asks for the real mouse and keyboard up front (full control), and the user records a task for the chat to turn into a skill. They work on every harness through the shared `desktop_*` tools (`mopilot_computer` for Claude Code) and the shared composer attachment path, never through a harness name.

## Teach mode (`desktop_request_teach_access`, `desktop_teach_step`, `desktop_teach_batch`)

- `request_teach_access` is the access card in its teach wording ("Allow Claude Code to guide you through <reason>?"). It always asks, and it carries the mouse and keyboard consent, because a Next click runs the step's actions.
- `teach_step` shows one tooltip near `anchor` (a pixel of the latest screenshot; none centers it) and waits for **Next** or **Exit**. On Next it runs `actions` through `desktop_batch` (the same gate, app tiers, takeover wait and irreversible-action cards), takes a fresh screenshot and returns both. On Exit it returns `{exited:true}` and the tour is over.
- `teach_batch` queues several steps in one call. All steps are validated first; coordinates refer to the screenshot before the batch; it ends with one screenshot.
- The tooltip is one always-on-top window (`electron/capabilities/teachOverlay.cjs`) that is left out of screenshots. While the agent works it is click-through and says "Esc to stop", so the agent's clicks land on the app below.
- One tour on the Mac at a time. It ends at Exit, at the turn's end, on Esc or Stop, when the chat is forgotten and when the app quits.
- Unattended and read-only chats are refused: nobody could click Next.

## Full control (`desktop_request_full_control`, `desktop_release_full_control`)

`request_full_control` asks the takeover card now (with the reason "the real pointer and keyboard"), instead of at the first screen input. `release_full_control` lets go of the desktop and the consent, so the next screen input asks again. Background control (`desktop_app_*`) never needs it.

## Record a skill

- Composer **+** → **Record a skill** → **Start recording**. A pill at the top of the screen shows the time, **Discard** and **Done**. The limit is 10 minutes (the pill warns 30 s before) or 5000 events; the recording ends at either with what it has, and says which.
- The helper (`native/helper/.../WatchRecord.swift`) reports what a person does as `record.event`: a click (app, window, the element's role and label, button, modifiers) and a key press (text typed, or a shortcut). Only a person's own input is reported (not the helper's, and not input another process posts, unless a check asks for it), and only what reached the app. The app and the password-field check are read when the key is pressed, not later. Clicks and keys in an app on the computer-use deny list, or in MoPilot, are dropped. Keys typed into a password field are never read (one "secret typed" step stands for them) and no field value is read.
- `electron/capabilities/watchRecord.cjs` keeps the events and, on Done, turns them into a `<sage-computer-history>` block (`watchRecordSteps.cjs`): a preamble that says the lines are quoted data, the steps, and what to do with them (reproduce the **outcomes**, not the clicks; prefer tools, scripts and APIs; draft a skill and save it only after the user approves).
- The block reaches the chat as a Computer History attachment, so each harness gets it the way it gets shared memories (Codex: the turn's untrusted context; Claude Code and ACP: ahead of the message), it is hidden from the message as shown, and a harness switch does not carry it. The composer gets the first line "Turn this recording into a skill."
- Recordings are not stored. Discard, an error and quitting keep nothing.

## Not yet

- Text composed with an input method (pinyin, dead keys) is recorded as the keys pressed, not the composed characters.
- A recording has no screenshots (Claude Desktop's has keyframes and optional voice narration). The steps name the app, window and element instead.
- The skill is drafted and saved by the agent with its own tools, not by an app tool with an approval card.

## Checking it

- Unit tests: `tests/desktopTeach.test.ts`, `tests/teachOverlay.test.ts`, `tests/watchRecord*.test.ts`, `tests/composerRecordMenu.test.ts`; the helper's key naming, `swift test --filter WatchRecordTests` in `native/helper`.
- The helper's event tap needs Accessibility, so it is checked in a VM with a helper built from the branch: start recording, make clicks and key presses with `cliclick`, and read the `record.event` notifications.
