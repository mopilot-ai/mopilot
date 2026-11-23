# Overlapping operations

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/overlapping-operations/` (one note per file), not below; the bullets below are the earlier notes.

Two operations run at once where one was assumed: a double submit, two writes to the same file, a commit while
a discard runs, two deliveries of one message (#17, #422, #466, #493, #499, #514, #539, #541; whole-record
overwrites #98, #125, #139).

## Search for and ask

- Ask: *what happens if this is triggered twice before the first finishes, or while another writer runs?*

## Notes

- File-handle cleanup: preserve the original asynchronous read/write failure if closing also fails. Use `withAsyncCleanup` for awaited file-handle operations; a close failure after a successful operation must still reject. Durable private-file writes should use `writePrivate` rather than duplicate temporary-file cleanup that can mask a write or rename error.
- Scheduled-run ledgers: an empty or malformed claimed file still reserves its time, but cannot supersede the last known run or let pruning remove that run. Read JSON object records and select only defined run states; the same selection must drive overlap checks and retention.
- Post-commit retention: failure to remove old history must not reject a successfully written claim and prevent its primary operation from running. Record the cleanup failure for diagnostics, retain duplicate protection, and retry retention on a later claim; genuine claim writes still fail.
- Serialize per resource (a pending promise per key, or a queue), and disable the control while it runs.
  Update records by merging the fields you own, not by replacing the whole record.
- Write state files with `writeAtomic` or `writePrivate` from `electron/platform/fsutil.cjs` (`plugin/non-atomic-write`, on the
  app's sources: build scripts write reports that are regenerated, not state read back).
- Append logs that grow with every event (ACP chat transcripts, the tool operation log) through the shared transcript
  writer, `electron/platform/transcriptWriter.cjs`, never with `appendFileSync` per record (`plugin/sync-log-append`):
  a synchronous append stalls the main process for every window. The writer keeps one write per file at a time,
  reads include records not on disk yet, and the app drains it before quitting.
- An IPC handler reads files and runs processes asynchronously (`fs.promises`, a file handle for a tail, `execFile`),
  never with `readFileSync`, `readdirSync` or `execFileSync` (`plugin/sync-ipc-read`): main serves every window's IPC on
  one thread, so a chat switch that read a 100 MB transcript synchronously held up every streaming chat. What a lookup
  finds again on every switch is kept, keyed by everything it depends on and checked before use (where a Claude
  transcript was found; its checkpoints by file, size and time), and a caller's newer scan replaces its older one
  (`electron/platform/searchScans.cjs`, keyed by window and search box; a search reads at most 400 transcripts and starts none
  after 2.5 s). A transcript the writer appends to is read with `readText`, which returns what `text()` would at one
  moment: during a write, the file up to where that write began plus every line not written before it; otherwise the
  whole file while that file's next write waits for the read (a read that starts once a write waits, waits for it).
- In-app browser tabs: everything that acts on a tab (input, navigation, the viewport), from `browser_*`, scripts,
  credentials or a vendor backend such as the Codex plugin's iab backend, runs in the tab's queue
  (`BrowserTabs.run`) and re-checks the tab when its turn comes. A gate that may ask the user runs before the
  action takes its turn: the queue's timeout does not wait for a card, and work still running after it is outside
  the queue. Answers an action may wait on (dialogs, request interception) and reads stay outside it.
- A chat's turn end, crash and Stop are reported to main's one turn ledger (`turnLedger` in
  `electron/capabilities/turnEnd.cjs`), which lets go of the in-app browser and the desktop once per turn and
  aborts running tool calls on a crash and on a Codex or ACP Stop (Claude Code cancels each call through the SDK); calling `turnEnded` or `abortChat` beside it runs cleanup twice
  or misses a harness (`plugin/turn-end-path`, on main's wiring).
- A time limit on a queued operation does not stop it: in-app browser tab actions (`BrowserTabs.run`) run with
  the action as their context, so a timed-out action can no longer send anything to the page (`Tab.send`
  refuses it) while the queue has moved on. A browser_* tool that waits for the user's card inside an action
  does it through `tabs.awaitUser`, which stops the action's clock and checks the tab again after the answer
  (`plugin/card-wait`). What changes where input lands (explicit viewport emulation) changes only inside an action.

- #797: Snapshot attribution compares canonical physical directories, including aliases and parent/child scopes. Resolve identity before capture, and recheck it before publishing after asynchronous work. Unknown identity cannot prove concurrent attribution independent; retain native diffs rather than publishing mixed edits. A missing directory, failed identity lookup or failed first capture must reserve overlap until its turn finishes, aborts or clears, in either start order.
- User-directed text saves and adapter filesystem writes need the same atomic replacement as serialized state: inject a partial write followed by failure, preserve the previous contents and symlink destination, clean only owned temporary files, and verify successful retry.
- Scroll position: the browser's scroll anchoring (`overflow-anchor`) is a second writer of a transcript's `scrollTop`.
  A position the app sets itself must either be measured against the viewport, so it moves nothing the browser
  already moved (`KeepAnchor` in `src/components/thread/view/turnWindow.tsx`), or turn the browser's anchoring off
  while the app owns the position: `loadHistoryPage` while an older page goes in, and `markFollowing`
  (`src/lib/streamScroll.ts`) while a view follows its bottom. Otherwise both correct (a page loaded above scrolled
  a page too far), or the browser moves a following view off the bottom and its scroll handler stops following.
- Main's event loop is shared by every window and chat: a child process run synchronously there (`execFileSync`, `execSync`, `spawnSync`) stalls all of them until it exits (`plugin/sync-child-process`). Converting an attached HEIC, BMP or TIFF with sips did this on every send. Await `execFile` instead; when that adds an await to a send, keep the chat's sends in order (`ChatController.claudeSend` waits for the send before it) and recheck the turn after the await (`ChatController.turnCheck`), so a Stop meanwhile means the message is not sent and waits first in line. Asking a CLI about itself (`claude --version`, `--help`) is a child process too: callers waiting meanwhile share the one in flight, and a forced re-ask replaces it without an older answer overwriting the newer one (`electron/harness/claude/cli.cjs` `candidates`).
- Per-account reads of a rate-limited endpoint (plan usage) go through one main-process owner, `UsageRefresh` (`electron/identity/contract/usageRefresh.cjs`): a timer, a surface and the user each name a reason, and the owner decides per account whether a read is due (by how recently the account was used), shares a read in flight across windows, and backs a refused account off on its own. A renderer timer or a surface that reads every account directly multiplies the load by windows and accounts and hammers the endpoint into 429s (#1295); a cached answer that the source served instead of measuring afresh counts as a refusal.
- A ChatController hook (`onFinished`, `onStopped`, `onCrash`, `beforeDispatch`, `onDispatchResult`) has several owners: the turn-end ledger, the peer service, the PR monitor and linked sessions. Add to it with `addHook` or `addGuard` (`electron/session/hookChain.cjs`), never `controller.onX = fn`: `PeerRuntime` used to assign `onFinished` and so replaced the ledger's, which ran only because a second path (the session going idle) also reached it.
- A settings switch whose `on` comes from a re-read (config.toml, an IPC answer) returns its write *and* that re-read
  as one promise from `onChange`; `Toggle` (`src/components/pages/settings/Controls.tsx`) then shows the value being
  written and takes no click until it settles. A handler that fires the write and returns nothing, or resolves before
  the re-read lands, lets a quick second click flip the stale `on` and write the same value again (the Codex MCP
  switch wrote `enabled = false` twice, #1461).
- Main's thread is shared by every window, so periodic work there must cost what changed, not everything again. A newline-delimited pipe split by `buf += chunk; buf.indexOf('\n')` copied the whole buffer for every chunk (a 30 MB Codex answer cost seconds and gigabytes); read every JSON-lines pipe through `JsonReader` (`electron/transport/jsonReader.cjs`, framed by the Rust core; `plugin/quadratic-lines`, and `tests/rustOnly.invariant.test.ts` keeps line framing out of JS). The sidebar's PR badge read each chat's whole history from main every minute; a poll keeps a read while its source's version (the row's `updatedAt`) is unchanged (`savedReplies` in `src/lib/threadPullRequest.ts`). Together they made idle main grow by half a gigabyte a minute.
- A lazily allocated native resource needs concurrent tests with no resource yet and with the previous resource gone, including mixed entrypoints. An exact-Session FIFO owns Chrome tab-group lookup/allocation/join for explicit creates and popup adoption; earlier window-hint reads cannot clear its canonical group. Return each operation's acknowledged group receipt, and retire the exact tab membership on release/re-adoption. Test queued user moves and metadata waits separately from active native-mutation suppression (`tests/chromeGroupSerialization.test.ts`, `tests/chromeGroupLifecycle.test.ts`).
- Does the app show anything on screen (a system notification, a window, an overlay) while an agent clicks on the screen? It must be click-through and capture-excluded, so the helper's hit test looks through it (the pill, the glow, the phantom cursor), or wait until control ends (`Notifier.hold`): a banner over the click point makes the helper refuse the click as "Notification Center".
