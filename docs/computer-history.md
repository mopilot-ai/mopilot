# Computer History

Computer History turns what the user does in the apps and sites they allow into memories on their Mac, and lets them share those memories with a chat (#1363). This page describes how it behaves and how to check it. The decision and threat model are on the issue.

## Privacy rules

- **Off by default.** The first turn-on goes through an explainer that lists what is and is never recorded.
- **Explicit allow list.** Only the apps and sites the user adds are recorded. Subdomains of an allowed site are included.
- **Never recorded,** whatever the lists say (`electron/computerHistory/exclusions.cjs`):
  - MoPilot, the Electron runtime, password managers, Keychain Access, System Settings, sign-in prompts and the screen saver.
  - The user's computer-use deny list.
  - The in-app browser's high-risk sites: banking, payments, brokerage, crypto, password managers, account security, government identity and the private network.
  - Health sites, sign-in hosts and pages, and MoPilot's own sites.
  - These are checked when a sample is taken, when it is written and when memories are read. An allow-list edit that names one is refused by main.
- **Summaries only.** The record is the app, its front window title and, for an allowed browser, the site and path (no query or fragment), plus when and for how long.
  - Titles are redacted: emails, token-like strings, digit runs of 12 or more, one-time codes, and the brackets that could close the block.
  - No keystrokes, screenshots or field values are read.
  - A secure field in focus stops the sample.
  - The helper's `activity.sample` reads a title only for an allowed app, and an address only for an allowed browser.
- **Local only.** Entries are stored per day under `<userData>/computer-history/days/`, encrypted with Electron `safeStorage` (folder 0700, files 0600). Nothing is written in plain text, and nothing is synced.
- **Visible and stoppable.**
  - While it is on, the menu bar icon stays up (even with the tray setting off) with Pause or Resume and Manage, and the sidebar shows its status.
  - Pause, a screen lock, sleep and quit stop it at once. A sample in flight when that happens is dropped.
  - Retention defaults to 30 days (7, 14, 30 or 90). Delete removes a day; Delete all removes every day.
- **Not while idle.** Nothing is recorded after 120 s without the person's own keyboard or mouse input. Input another process posts does not count once the helper watches input.

## Sharing with a chat

The composer's + panel → **Computer History** opens a dialog:

- Pick a range (Today, Yesterday, Last 7 days) and the apps and sites to include.
- The preview is the exact text main will send.
- **Share with this chat** attaches it to the next message only. Sharing again replaces it.

Main delivers it through the chat's current adapter, chosen by the `computerHistory` capability (`electron/harness/bindings.cjs`), never by the harness's name:

| Harness | How it gets the memories | State |
| --- | --- | --- |
| Codex | `turn/start` / `turn/steer` `additionalContext["mopilot.computer-history"]`, `kind: "untrusted"`. Codex shows it as `<external_mopilot.computer-history>`, outside the user's text. | native |
| Claude Code | One `<sage-computer-history>` block ahead of the message | supported |
| ACP | The same block ahead of the prompt. ACP has no context channel, so the agent keeps it as part of the user's message. | degraded |

Memories are never written to Codex's memory store or Claude Code's memory files. Those are global, read by sessions outside MoPilot, and out of reach of Delete all.

The block is:

- quoted data with a preamble that says it is not instructions;
- sent only when well-formed;
- hidden from the message as shown and from a handoff record, so a harness switch does not carry it;
- redacted by `shared/scrub.cjs` from bug reports, diagnostics and shared prompts.

What was shared stays in that harness's chat history. The explainer, the Memories group and both deletes say so.

## Not yet

- The in-app browser is not a capture source. The policy knows its id (`mopilot:built-in-browser`), but the picker does not offer it.
- Private browser windows of an allowed browser are not told apart. The site allow list bounds them, and Pause covers them.

## Checking it

- Unit tests: `tests/computerHistory*.test.ts` and `tests/composerHistoryMenu.test.ts`. `computerHistoryNeverStored.test.ts` runs every built-in exclusion and a secure field through the real gate, recorder and encrypted store with settings forced to allow them.
- **UI and delivery on a Mac**: run a scratch dev instance (`SAGE_USER_DATA`, its own dev and CDP ports, `SAGE_E2E_BACKGROUND=1`, `--use-mock-keychain`).
  - To get memories without recording the host, add `--inspect=<port>` to Electron's arguments, then append entries through `process.mainModule.require('<abs>/electron/computerHistory/service.cjs').appComputerHistory().store.append(...)`.
- **Capture**: run in the VM (lock `~/bench/runner/vmlock.sh`), with the helper built from the branch (`node scripts/build-helper.mjs`; its ad-hoc signature keeps the Accessibility grant of the same bundle id).
  - Allow two apps and a site, use them, and check the store has those entries and nothing excluded.
  - Share with a chat on each harness, then Pause and Delete all.
  - Synthetic input (cliclick) does not count as the person's once the helper watches input, so a long run reads as idle unless the check stubs the idle reading.
