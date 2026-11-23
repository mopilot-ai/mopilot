# Load-dependent tests

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/load-dependent-tests/` (one note per file), not below; the bullets below are the earlier notes.

A unit test passed alone and failed in a full run with many files at once: a short real timer in the code under test
(an idle stop, a 50 ms recheck) fired before the step the test meant to come first, or the whole file failed with
only "test failed" (a crash in Node, or async work that outlived its test).

## Search for and ask

- Search for: options ending in `Ms`, `delay` or `idle` below 200 in tests; `setTimeout(` with a short literal delay
  in components and services whose tests assert the state right after an action; `process.exit` inside a
  `setTimeout` in a script a test spawns.
- Ask: *does this test assert anything between arming a real timer and its firing?*

## Notes

- Run a timer the test depends on on a mocked clock (`mock.timers.enable({ apis: ['setTimeout'] })`, then
  `mock.timers.tick(ms)`), and let fakes answer on `setImmediate`, which the mocked clock leaves alone. A test that
  does not exercise the expiry passes a long timeout instead of a short one. Waiting for a real timer to have fired
  is safe only with a poll that allows seconds (`until` in `tests/support/pages-kit.ts`).
- A fixed delay in the code that only guesses at an order (`setTimeout(recheck, 50)` after saving a setting) is the
  same race in the app: rely on the order that holds (main applies `prefs:patch` before a later request from the
  same window) or await the step, and drop the delay.
- A whole-file failure is explained at the end of the run (`scripts/test-file-failures.mjs`): killed by a signal
  is a crash in Node or V8, and an exit after the tests passed comes with the diagnostic naming the rejection that
  outlived a test. Await or cancel work a test starts before it ends.
- Reproduce it deterministically by blocking the test's event loop for longer than the window, right after the
  step that arms the timer (`const end = Date.now() + 600; while (Date.now() < end) {}`): that is what a loaded runner
  does, and it fails on any machine. Running many copies at once (links to the file in a scratch folder,
  `node --test --test-concurrency=48` with the loader flags from `package.json`) often passes on a fast laptop: the
  `devPreview` flake behind #842 passed 32 copies under load locally and failed on the first blocked run.
- A child process a test starts must not quit on a timer the test races (`listen(port, () => setTimeout(exit, 300))`);
  let it quit on the event the test waits for, such as the probe's connection closing.
- A test that scans the tree raced the lint-rule tests, which write a fixture folder (`src/.lint-fixture-*`) for
  Biome to read: in a full run the module map listed the fixture and `tests/moduleMap.test.ts` failed. The map skips
  hidden folders (`sourceFiles` in `scripts/module-map.mjs`); a tree scan reads only what a run cannot be writing.
- The same race came back in `scripts/related-tests.mjs`, whose own tree walk still entered hidden folders:
  `tests/relatedTests.test.ts` failed with ENOENT when it read a fixture folder as a lint-rule test deleted it. Every
  scan of the repository's folders, in scripts and tests alike, now lists files with `treeFiles` from
  `scripts/source-tree.mjs`, which never enters hidden folders or node_modules; a new scan uses it rather than another
  hand-written `readdirSync` walk. Scans of a test's own temporary folder or of a built app are not affected. The
  changed-file lists (`changedPaths` and `scripts/diff-coverage.mjs`) also leave out untracked files in such a folder
  (`inHiddenFolder`), which a fixture is while a test runs.
- A test can also depend on the machine rather than its load: `tests/controlMatrixSky.test.ts` reached the real
  `ComputerHelper`, which `open`s the computer-use helper whenever `native/helper/build` has one. Where it was not
  built (CI) the launch failed at once; in the benchmark VM's built checkout four helpers stayed connected and the file
  never exited. Every unit test now refuses any real app (`tests/support/no-real-apps.ts`): a browser, any program in a
  `.app` bundle, the openers (macOS `open`, `xdg-open` and the like, Windows `start` and `explorer`) and `osascript`,
  also inside a shell command line (`exec`, `execSync`, `shell: true`, `sh -c`). Ask of a fixture that wires a real
  service: does it launch anything when the binary it looks for happens to exist?
- A download test's byte-count or error assertion must not race its stall watchdog while the file stream closes or
  its size is read. Give the downloader tests a mocked clock, advance it only at the intended blocked read or
  back-off, and check the production threshold, renewal on progress and timer cleanup explicitly. Keep loopback
  serving tests on their own real clock so their socket-cleanup deadlines still work.
- The machine's files leak in the same way: `tests/support/electron-main-harness.ts` hid `/opt`, `/usr`,
  `/Applications` and `/System` from `fs.existsSync` only, so on a Mac with Homebrew's `codex` cask
  `electron/harness/installMethod.cjs` resolved the listed `/opt/homebrew/bin/codex` with `realpathSync` to the real
  Caskroom and three `tests/codexBinaryLookup.test.ts` tests failed; CI runners have no cask. `userTools` (realpath)
  and `toolVersion` (stat, and reading the real ChatGPT.app binary) read the same folders. The harness now hides every
  path-first fs call there in each form (`tests/support/hermetic-system-fs.ts`), and `tests/hermeticSystemFs.test.ts`
  fails when main starts calling an fs function the helper does not cover. Ask of a fixture that fakes a path for one
  fs call: what do the other calls on that path read from the machine?
- An E2E step that waits on a fake's request log before the next click waits for the request, not for what the user
  sees: the next click can land before the UI took in the answer, and only a loaded runner shows it. Wait on the
  control's own state (`aria-checked`, enabled) before acting on it again; when that wait is not enough, the app has
  the same race (#1461: the Codex MCP switch).

- Does an assertion observe a transient terminal, progress indicator, or pending state after IPC? Even synchronous successful completion can beat the observer. Hold the fake behind an explicit release until the transient is observed, release it in `finally`, then assert the stable result. A watchdog must fail closed, not release the fake.
- A lint-rule test's own filename does not bound Biome's project scan: while one test linted a row, another
  deleted its fixture and Biome failed on that unrelated folder. Rule fixtures now use `lintFixtures` in
  `scripts/biome-fixtures.mjs`, which copies the unchanged configuration, ignore file and rules into a private
  temporary project and preserves production-relative paths. Review external scanners' whole discovery scope,
  including configuration and cleanup, rather than assuming our `treeFiles` hidden-folder guard protects them.
  Test one owner's cleanup while another remains live, failed setup/process cleanup, and exact-path overrides;
  do not restore fixtures inside the checkout, serialize the suite, ignore scanner errors or add retries.
- When shutdown closes a channel before a delayed force-kill, observe the channel and registry retirement in
  lifecycle tests. A poll whose deadline equals the grace period can expire before an overdue kill timer runs.
  Assert the force-kill boundary separately on a mocked clock, immediately before and at the deadline.
- An E2E spec took the last user message in the fake Claude log (`harness.claudeLog()`), which every process the app
  starts writes to, and on the CI runner the app's scheduled `/usage` probe came after the chat's Auto-fix message
  (`cuj-pr-and-ci`, #1728); it passed in the VM, whose timing put the probe first. Read what a chat received with
  `claudeChatMessages` (`tests/e2e/fixtures/claudeChat.ts`), and whether something never reached Claude with
  `claudeAllUserTexts`. Search for: `.at(-1)` or `[0]` over `claudeLog()` or `codexLog()` without a chat-process or title filter.
- An E2E spec clicked a Settings select while the page was still filling in rows above it (Settings → Browser's
  harness status, which a Codex chat's setup updates again): the row moved between Playwright's checks and its
  click, the click landed beside the button, and the menu never opened (`cuj-use-my-chrome` on Codex, #1822; the Claude
  Code run of the same journey passed). Open a Settings select with `openSettingsSelect`, or pick with
  `chooseSetting` (`tests/e2e/fixtures/settings.ts`), which opens it again until its option shows. The
  `plugin/settings-select` rule warns on `.select-btn` in a spec. Ask of an E2E click on a page that loads what it
  shows: can anything above the target still appear or change size?
- A fake stamped a "fresh" time before the code under test read its own clock: `readAs(m, profile(..., Date.now() + 1))`
  built the profile before `LoginIdentity.read` took `since`, which counts only a profile fetched at or after it, so
  a runner that stalled for 2 ms saw it as stale (`tests/claudeLoginIdentity.test.ts`). #1629 had fixed the same race in
  `tests/claudeAddedLoginIdentity.test.ts` with a thunk and left this sibling eager. Both now write through
  `fetchedNow` (`tests/support/claudeFetchedProfile.ts`), which builds the profile when the fake writes it and refuses
  one built before. Search for: `Date.now()` in an argument to a helper whose fake writes later; ask of a fake's
  timestamp: is it taken after the moment the code compares it with?
- A test runner's own load can take the whole machine down. `UNIT_TEST_CONCURRENCY` once skipped the shared slot
  lease (`scripts/test-slots.mjs`), and the bench's control-matrix run started `node --test` with the full budget, so
  ten agents' runs stacked their workers to a load average of 777 on 12 cores and froze MoPilot; fixtures that
  never removed their `mkdtemp` folders had also left 860k entries in the OS temp folder. Now an override only caps a
  run's share, `tests/testSlotsInvariant.test.ts` refuses any script that starts `node --test` without
  `test-slots.mjs`, and every test process gets its own `TMPDIR` removed on exit (`tests/support/test-tmpdir.ts`).
  Search for: `--test` in a spawn's arguments, an environment variable that returns before a shared lease, an
  `os.tmpdir()` folder a fixture makes per call; ask of every knob that tunes a shared budget: can it add capacity
  outside the budget?

- A native-browser repro that needs a native event the product tries to prevent is a race against the product (cuj-chrome-foreign-frame: the page guard emptied the injected frame before Chrome noticed it, so the expected detach came only on some runs; the same spec also lost on a loaded runner). Make the fixture one the product cannot prevent (the frame in a closed shadow root, as password managers keep theirs) instead of retrying until the event shows, and check the outcome after both orders.
- A budget that guards only the obvious phase still leaks. After test runs were leased, the coverage command freed
  its slots before the c8 report and chose its related files before leasing, and the pre-commit hook ran Biome and
  two tsc processes unleased; a dozen agents reporting and committing at once kept the load average near 40 and
  MoPilot stuttering. Ask of every heavy local step (report, typecheck, lint, selection): is it inside the lease?
- Giving each test process its own `TMPDIR` (#2340) moved every path built from `os.tmpdir()` out from under the other processes, including a build lock that was meant to be shared, so three test files built `native/sage-mcp` at once (#2374). When a change isolates a per-process resource (temp folder, home, cwd, port, environment), list what else was keyed on it and whether any of it was a cross-process rendezvous (W4 in change-contract.md); `tests/crossProcessLockInvariant.test.ts` covers the temp folder.
