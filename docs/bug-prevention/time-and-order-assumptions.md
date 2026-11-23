# Time and order assumptions

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/time-and-order-assumptions/` (one note per file), not below; the bullets below are the earlier notes.

A throttle, debounce or cached answer decides by the clock what only the order of operations can decide: its window
is taken by an attempt that did nothing (it was refused, failed or read nothing), its early return also skips work
that was never meant to be throttled (reading the state again), a failed read replaces the last answer that was
decided, or it assumes that a timer of N ms firing means the clock moved N ms. Timers run on the event loop's
monotonic clock and `Date.now()` (or an injected `now()`) on another, each floored to whole milliseconds, so a timer
can fire just before the other clock reaches the end of the same window: the next attempt falls inside it, and only a
loaded or fast-waking runner shows it (CM-Z30, #1531).

## Search for and ask

- Search for: `now() - ` / `Date.now() - ` compared with a duration followed by an early `return`; a stamp
  (`this.lastAt = Date.now()`) taken before code that can still return without doing the throttled work; a TTL cache
  that stores the answer of a read whose failure handler returned a default (`() => false`); a window compared
  against a duration a `setTimeout` in the same class also waits (`plugin/timer-window`).
- Ask: *does the window count only an attempt that did the work, does its early return skip only that work, does a
  read that decided nothing leave the last decided answer in place, and would the next attempt behave the same if it
  arrived the moment the previous wait's timer fired?*

## Notes

- The Chrome extension's pairing page (`electron/capabilities/browser/chromeExtension.cjs`) was throttled to once per
  `connectMs` by `Date.now()`, the same duration each wait's timer waits. The stamp was taken before the profile was
  read, so a wait into a profile where the extension was missing or off used up the window without opening a page,
  and the early return skipped reading the profile again: the next wait (a retry, or another chat) reported the old
  "isn't installed" / "is turned off" and never opened the page for an extension the user had just turned on. Every
  offer now reads the profile, and only a wait that opened the page holds back the next ones, until it ends (ordered
  by the wait, not the clock). The same sweep found `WorkingInViews.screenGranted` keeping a failed helper read as
  "not granted" for 10 s, and `CodexBrowserUse.blockedReason` replacing the managed policy it had read with
  "unknown" for a minute when Codex timed out; both now keep a read that decided nothing out of their cache.
  `plugin/timer-window` flags a window compared against a timer's own duration; tests drive such windows with
  `mock.timers` and hold `Date` still while real timers fire to make the order certain.
- A reading is a measurement at its time, not now (#1582). `usedNow` treated a window past its reset as 0 % used, so a 44-hour-old reading (of another account, after failed reads) showed "100% left" on every window. A window whose reset passed since it was read is now not known (`usedNow` returns null): meters show "—" and "Reset since last read", and the row says so with its age.
- An automatic continuation after an account move joins the move with the original turn's actual controller completion, including delayed file-change capture. A timer cannot prove the old turn is over, and an idle chat cannot prove no newer turn ran and finished. Exercise both completion orders, queued user input, Stop and a completed replacement turn; delayed notices retain the failed turn's identity too.
- Update freshness is an app-wide contract, even when release channels use different feeds or authentication. A minute-polling change retained the legacy four-hour beta/dogfood interval and tests asserted that exception. Keep channel selection out of the shared schedule and test a release published after startup through each channel's real updater entrypoint, including both desktop platforms, rather than checking only startup or the default channel.
- A running step group showed only the step in progress, so it assumed each step lasts long enough to be seen (#1952). A Codex code-mode turn's desktop calls finish in a fraction of a second with seconds of model time between them, so the transcript read "Thinking" for minutes while the agent clicked, and the run appeared only when a message closed the group. Show what has finished as it finishes (the running group's control run grows live) rather than relying on the running step's duration, and test a run of fast steps with the turn still running, not only after it settles.
- The same assumption escaped #1952 on every other tool: the running group's row named a tool only while its status was in progress, so a turn of short tools with model time between them read "Thinking… 16m" on every harness. A running line names the last step it showed until the next one starts (Claude Desktop's held label, `heldStep` in StepGroups.tsx), and its tests run a finished tool followed by thinking with the turn still running, not only a tool in progress.
- A native-browser repro must wait for the precondition it tests (the exact tab being attached, a content script ready), then trigger the event. A fixed delay can fire before attachment under load and turn a correct ownership fix into a failing regression check. Exercise the fixture with arbitrarily late readiness; never manufacture the native event to make the check pass.
