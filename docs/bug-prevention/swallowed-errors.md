# Swallowed errors

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/swallowed-errors/` (one note per file), not below; the bullets below are the earlier notes.

A failure becomes a success, an empty list, `null`, or a spinner that never stops (#282, #291, #317, #341,
#345, #460, #489, #513, #515, #540). A comment in an empty `catch` documents the choice but does not handle
the error, and an unawaited promise loses its rejection.

## Search for and ask

- Search for: `|| true` and `2>/dev/null` in `.github/` and `.githooks/`.
- Ask: *what does the user see when this fails, and can the caller tell the failure from an empty result?*

## Notes

- Deferred deletion intents must be persisted before a native attempt and acknowledged only after it succeeds. Preserve failed siblings and intents added while waiting; mutation readers must reject an unreadable intent journal rather than replace it with an empty list.
- Read-modify-write boundaries must distinguish absent files from unreadable existing records. A tolerant snapshot reader cannot become a mutation default: fail before replacing malformed or inaccessible data, preserving the file and propagating I/O errors. Three-way config merges must validate all inputs, including the baseline, before writing either side; skip and record a failed input rather than inventing an empty side. `readStoreFile` (electron/platform/fsutil.cjs) tells a missing file from one that couldn't be read and keeps a copy of the latter; a store that writes back refuses the write when it reports an error (saved logins, bookmarks, connection tokens).
- Return a typed failure (`{ ok: false, error }`) and show it; keep the "loading" state's exit on the failure
  path; await or explicitly handle every promise. Do not cache a failed lookup forever (#537).
- A failure to ask the user is not the user's answer: a card or dialog that could not be shown fails as
  `unavailable` and is asked again, never recorded as a refusal.
- When ignoring an error is the intended behavior (cleanup of something already gone, an optional probe, a
  cosmetic step), record it in main-process code with `noteIgnored('<what was being done>', error)` from
  `electron/ignored.cjs`: it logs with `console.debug` and keeps the last 50 (scrubbed, repeats counted) for "Copy diagnostics".
  Renderer code uses `noteIgnored` from `src/lib/ignored.ts`, which sends it to the same ring (as `renderer: …`)
  and falls back to `console.debug` where there is no bridge (tests, the web build).
  For a best-effort promise nobody awaits, `promise.catch(ignoring('<what was being done>'))` (exported by both
  modules) records its rejection the same way. `void promise` is not handling: use it only on a promise that
  cannot reject, with a comment saying why.
  Keep the reason as a comment. Where one error code is the normal answer (ENOENT for a file that may not exist
  yet), pass it as expected (`noteIgnored(context, error, ['ENOENT'])`) so only other failures are recorded. A
  queue that only keeps order waits with `Promise.allSettled([p])` while its caller gets the error from `p`.
- Code serialized into a page or a worker (`pageAgent.cjs`, `scriptRuntime.cjs`) cannot reach `noteIgnored`:
  catch only the error that is the normal answer there (a cross-origin `SecurityError`) and rethrow the rest, or
  return the failure in the result (`observeError`, `nameError`, `unreadable`) for main to record. A worker whose
  message to main fails closes its port, so main reports the exit.
- Lint: `plugin/swallowed-error` (`.catch(() => {})`, `.catch(() => null | [] | '' | false …)`, the same value
  handed to a setter or callback, `.catch(() => setChecks([]))` or `.then(set, () => set(null))`, and empty or
  comment-only `catch` blocks), `noFloatingPromises`, `noMisusedPromises`. A block body (`() => { set([]); }`)
  is not matched: Biome's GritQL does not match statements inside an arrow's block.
- The same holds for the safety net: a workflow step that ends in `|| true` turned an unreadable log into "no test
  names", so every main-red issue before #842 named no failing test. In a workflow or hook, warn
  (`echo "::warning::…"`) and let the reader tell an unreadable input from an empty one.

- Recording reads distinguish an absent store/clip (`ENOENT`) from inaccessible directories, metadata and audio. Share the missing-file guard across these paths and read clips directly instead of probing existence first. Skip malformed legacy JSON separately from I/O failures, so Settings can show a read error and engine initialization cannot persist a default chosen from an invented empty history.

- #768: Durable drafts and goals require recovery copies before defaults are saved. Publish cache changes only after the disk write succeeds. Non-record app state uses the malformed-JSON recovery path. If copying or verifying a regular-file copy fails, propagate the original read error; directories and symlinks do not establish recovery. Read-only stores can retain their read error and refuse writes.
- #1534: a failing provider under an ACP harness left the chat "running" for 15 minutes with no message: opencode retries a rate limit indefinitely and says so only in its own log, and the host ended a turn only on the prompt's answer. Each harness's retry signal reaches the shared retry banner and the request ledger together (CM-K36: Claude Code's `api_retry` had reached only the ledger), a quirk's `providerError` reads a harness's stderr (electron/harness/acp/providerErrors.cjs), and a minute with no progress shows "No response" on every harness (src/lib/turnStall.ts). Ask of a waiting state: *what does the user see if the other side never answers and never fails?* (change-contract B5).
- A CI job that fails without posting a status or opening an issue is invisible to every agent: the release
  repository's sweep crashed on every run for 7.5 hours (a package import reached a checkout-only job) while
  `main-status.mjs` said "Main is green", since it read only the runs on main. Every automation that merges, starts
  or copies things reports a lasting failure through the `main-red` path (`scripts/sweep-red-issue.mjs` for the
  sweep), and `tests/ciDependencies.test.ts` imports every script a workflow runs before installing packages with
  none resolvable. Ask of a new workflow: where does its failure show up for someone who is not watching Actions?
