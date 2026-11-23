# Change contract and failure scenarios

Write a short contract before implementing behavior. Carry it into the PR and use it to choose focused
unit tests and challenge the change during review. This applies to fixes and new behavior; documentation-only
changes may omit runtime sections. Expand the applicable risks rather than repeating inapplicable boilerplate.
Keep validation results in the PR, never here.

## Contract

- **Invariant:** the user-visible outcome that must stay true, including failure/recovery.
- **Owner and invalidators:** the complete identity (for example chat, native session, account, permission
  and effect generation) and what retires it. Say whether work intentionally outlives a window. Name the
  fields the result depends on, not the identity of a whole stored object: a store that commits a new object on
  every write (the chat record) would retire the work on unrelated writes, such as a held goal saved just before a send.
- **Overlap policy:** latest read wins, coalesce equivalent reads, serialize ordered effects, or combine
  independent edits atomically at the state owner. State which competing writers exist. Independent user
  writes must not be dropped by a latest-read guard.
- **Pending/input/failure:** what ends a pending state, what remains retryable, where input is retained,
  and how the current failure reaches the user. Name the production entrypoint and affected harnesses.
- **Permission source:** what lets the agent take the action, and how the reference product (Claude Code, Codex)
  decides it. A permission that parses the user's wording (a verb list, a phrase match) refuses whatever the list
  missed; use a structural signal instead: the permission mode, an explicit UI action, the receiving side's gate.
  `send_message_to_chat` refused "协作 @chat" twice before its word list was removed (#3364).

Use existing shared primitives where they implement this contract. Extend them rather than copying a
guard. A one-shot effect guarded by cleanup may be sufficient; a reader that can overlap needs request
ownership too. A status read and an imperative action can have different owners and failure behavior.

## Failure scenarios

Evaluate all four categories. For each applicable ID, map a test file and test title to the invariant it
asserts. Give a concrete reason for each inapplicable ID, or one reason covering an entire inapplicable
category. Tests execute the real changed operation through mocked external boundaries. Coverage remains
100% of changed behavior; this matrix measures assumptions and orderings that coverage alone cannot.

### A: asynchronous work

- **A1:** start two operations, settle in both orders, and check the declared overlap policy.
- **A2:** after a newer result, settle an older success and an older rejection; neither may corrupt the
  new result, error, busy state or retry state.
- **A3:** retire the owner by each material context change, cancellation and disposal; settle each
  meaningful await with success/rejection and prove it starts no retired continuation or publication.
- **A4:** keep a replacement operation pending while the old one finishes, including catch/finally and
  queued callbacks after cleanup. The old one cannot clear the replacement or start a disposed read.
  For sign-in/cache invalidation, include a read already in flight and one still queued: retire the
  scheduler's cooldown, the producer's cache/error publication and every caller's coalescing ownership together.
  A cleared cooldown alone is insufficient if an old completion reinstates it or a renderer reuses the old promise.
  Invalidate at credential installation, before an await; a token caller must also recheck ownership before dispatch,
  even when its promise already succeeded. Retirement must not be mistaken for a current authentication failure.
- **A5:** successful retry/replacement still works after retirement and failure. For effect-owned work,
  cover setup-cleanup-setup (React Strict Mode where applicable). Exercise operation without a window
  when main-process work is supposed to continue.
- **A6:** for a throttle, debounce or cached answer, run the next attempt on a mocked clock inside the window, at
  its end, and the moment the previous wait's timer fires with `Date` held still. An attempt that was refused,
  failed or read nothing must not take the window or replace the last decided answer, and the early return skips
  only the throttled work (docs/bug-prevention/time-and-order-assumptions.md).

### W: shared writes and persistence

- **W1:** issue two independent edits before any displayed snapshot refreshes, including mixed add/remove
  where relevant. Assert both survive in authoritative state; include multiple windows if they can write.
- **W2:** settle acknowledgments in reverse order and fail one write. Accepted writes remain; rejected
  writes retain user input and a usable retry, and never report success.
- **W-registry:** a registry several pull requests append to (a list of tests, owners, exceptions or entry points) is a
  merge conflict between them, and when the gate treats its file as shared, a retest of every other pull request;
  use discovery by name or one file per feature instead (the classified list is docs/shared-files.md; a whole-repository invariant test is
  `tests/<name>.invariant.test.ts`, found by `INVARIANT_TESTS`, with no list entry).
- **W3:** fail persistence or load unreadable/corrupt state. Preserve prior authoritative data, report the
  failure and avoid false change notifications or silently treating unreadable data as empty.
- **W4:** a change that gives each process, test or window its own folder, home, port or environment variable.
  List what was keyed on the old shared value and which of it was a rendezvous between processes (a lock, a
  slot, a build cache, a socket path). Test that two processes under different values still agree on it
  (`tests/sageMcpBuildLock.test.ts` runs two `ensureBuilt` calls under different `TMPDIR`s, #2374).

### B: external responses

- **B1:** missing/null values, arrays where records are required, wrong field types and absent required
  fields. Invalid data must not become a successful status, empty result or destructive update. A card that
  went away unanswered (null: the turn ended, a sweep) is no answer: never store it as the user's refusal or consent.
- **B2:** malformed/truncated serialized data and rejection/timeout/transport failure. Cover the failure
  propagation and retry paths, not only the parser. A fake of an external call settles when the real one does
  (its documentation says when): also run the operation with that promise still pending and settled late, so its
  own completion does not wait on an unrelated event (a page load). When the change sends a request automatically (a
  release, a retry, a follow-up), list the refusals the protocol defines for it (error enums such as
  Codex's `CodexErrorInfo`, and the race where the native operation ended first) and test what each leaves
  the user with.
- **B3:** valid optional fields absent, extra fields, and equivalent accepted formatting/encoding. A guard
  must not reject valid responses or invent stricter requirements than the actual contract.
  Code that reads a chat's turns (a handoff record, a summary, a voice context) takes every turn shape each
  harness's history builder produces, including turns with no prompt or no reply (a Codex compaction turn, a
  `/compact` command), and turns carrying an image's bytes (a screenshot the user attached, a tool's image result):
  budget, clip or show those by their text, never by their raw size; test them through that builder (`buildTurns`,
  `buildAcpTurns`, `turnFromServer`).
- **B4:** current and obsolete failures have the right destination. Validate before publishing to any
  renderer/main copy; retain shared adapter behavior across Codex, Claude Code and admitted ACP harnesses.
- **B5:** the external side neither answers nor fails: a harness that retries a failing provider forever, a
  stream that goes quiet. A state waiting on it needs a no-progress exit or notice the user sees, and the
  failure the tool reports elsewhere (its stderr, its log, a side notification) read into it; test with a
  fake that goes silent, not only one that errors. "Progress" means getting further, not only events arriving:
  a harness that compacts its context after every step keeps sending items and never gets anywhere (#1575), so
  also test a fake that repeats the same kind of event without finishing.
- **B6:** the external side reads our state once and keeps it: a harness lists a session's tools when it connects
  and never asks again (opencode caches each MCP server's tools, whatever `list_changed` sage-mcp passes on later). Anything it is
  shown (a tool's `visibleTo`, a note) is decided by facts fixed before that read (the chat's tag), not by a later
  step of the same operation; gate the action at call time instead. Test the list on every channel at the moment
  its session starts, before the operation begins and after it ends (#2299, `tests/momoToolListTiming.test.ts`).
- **B7:** the same open sent again while the external side may still hold the first (a Codex `thread/resume` in the
  minute between `thread/unsubscribe` and `thread/closed`). The second request carries everything the first did: the
  vendor may rebuild from it. Test a re-open before the release lands, with a fake that rebuilds from each request
  (#2500, `tests/controlMatrixResumeLoaded.test.ts`).

- **B8:** a value in what we send a model that differs per process, session or run: a tool or MCP server name, a tool's
  description or order, an instruction's text. Providers cache the prompt by its exact prefix (tools, then system, then
  messages), so one differing byte re-writes the whole prefix at the cache-write price on every new or resumed process
  (#2579: a random `sage_<nonce>` server name). Test that two sessions started with the same options present
  byte-identical servers (`tests/claudeToolPrefixStable.test.ts`); a per-process value belongs in the token or the call
  path, never in a name the model sees. When the value is also a key for allow rules or ownership, list what else
  reads it and what a stable one lets a repository or the model declare before making it stable.
- **B9:** a subscription that answers with a catch-up (a snapshot, the text so far) and then streams live: the reply and
  the live frames around it can arrive in one read, and a promise's continuation runs only after every message of that
  read was handled. A window that collects the catch-up must hold what comes after it, never drop it, and hand it over
  after the catch-up is applied; a later whole record (a durable message) replaces what the live frames drew, not only
  extends it. Test a live frame in the same read as the reply, one between the catch-up and the reply, and a lost one
  repaired by the record; work that needs the subscription (a queued send) waits for its answer (#3525,
  `tests/hostRemoteSubscribeLive.test.ts`, `tests/hostRemoteChatsReplace.test.ts`).

### I: identity and scope

- **I1:** opaque identifiers containing delimiters, quotes and escapes; tuples with different boundaries
  must remain distinct. Prefer the shared structured identity encoder over concatenated keys.
- **I2:** missing/default identity, switched account/harness/native session and reused local IDs. Cache,
  cleanup and routing keys include every owner dimension the operation depends on.
  A stored name for the account behind a credential (a config's account, a cached email) is checked against
  what the credential itself answers, after the credential changes without the name changing (a refresh,
  a sign-in as someone else).
- **I3:** numeric boundaries used for identity/order: safe-integer edges and larger decimal sequences,
  empty/first entry and terminal extension parsing where relevant. Preserve exact identity rather than
  relying on lossy conversion. A saved position (a turn index) names an item only in the list it was taken
  from: after paging, compaction or a reload the list differs, so anchor to a stable id or time, and test where
  the item goes when its anchor is not shown.
- **I4:** one fact shown on several surfaces (a page header and its settings row, a picker and a page). Every
  surface decides it with the same function from the same inputs; a shared word table alone still lets their
  inputs differ. A snapshot kept per kind that describes one instance (main's update check of one binary) is
  used only while that instance is the one shown. Run every surface over one shared case matrix, rendering the
  shared decider itself: a surface test that stubs it (an avatar stub) cannot see the surface deciding otherwise.
  A new record of the fact (a chat's PR monitor binding, beside its attachments, branch and replies) reaches every
  surface that shows it: the sidebar badge never read the binding the Changes card showed, so a bound chat had no
  badge.
  For account choices, test the current chat, a new chat and a switch back to a previously pinned harness; an
  explicit automatic selection must clear the old pin before the first turn rather than merely change its label.
- **I6:** when an action depends on more than one session, test the visible availability against the executor's
  actual owners independently: one session can finish while the other is still running, and the state can change
  between rendering and execution. Unknown state must not be presented as permission to act.
- **I5:** an id one module makes and another checks (the segment a tool session names and the owner check that
  compares it with the chat's records): a test passes each harness's real producer output to the real checker,
  not a fixture value written to suit the checker. Both sides take the id's form from one shared helper.

## Sibling sweep and prevention

Record each relevant file/symbol as **fixed** (test), **safe** (specific ownership/contract reason), or
**deferred** (linked follow-up and a distinct invariant). Fix siblings violating this change's invariant
in the same PR. A deferred label is not a way to split identical failures into repeated small fixes.
Search adapters, main/renderer copies and start/send/stop/retry paths. Prefer one shared guard, a precise
lint rule or a registered behavioral invariant. A rule needs positive and safe negative fixtures; avoid
blanket bans on async callbacks or type assertions whose safety depends on surrounding validation.

## Adversarial review

The fresh reviewer reads every question in [the checklist](README.md#review-checklist), then tries
a concrete counterexample to the declared invariant using the highest-risk scenario above. Record the
candidate, affected entrypoint, result (prevented or confirmed), and test file/title or an explicit
validation limitation. Confirmed findings and siblings get a failing-before test and a fix, then review
again. A generic checklist approval is insufficient evidence. Keep the reviewer independent; unavailable
review is not a passing review and must not be bypassed.

## Recurrence record

Every bug-fix PR fills the template's canonical `Bug class` slug and `Recurs after` (earlier prevention PR
numbers, `none known`, or `unknown` when not established). Slugs come from the class document filenames in
[the index](README.md#bug-classes), for example `stale-async-results` or `overlapping-operations`.
Non-bug changes use `Bug class: none`. Do not infer recurrence just from sharing a broad class: identify
which earlier guard or invariant should have prevented this bug and why it did not.

Before a recurrence fix is handed off, strengthen that guard or scenario matrix and record the gap.
After each group of 20 merged bug fixes, inspect these PR records for class counts, confirmed recurrences
and missing/unknown records, and prioritize the protection that keeps escaping. Report the inspected
scope and unknowns; a lower bug count alone does not establish prevention effectiveness. This is a
retrospective during normal work, not a scheduled poll or permission to run release suites.

### Reporting a merged PR sample

Export reviewed metadata and run the local reporter (it makes no network requests):

    gh pr list --state merged --limit 100 --json number,body,mergedAt > /tmp/mopilot-merged-prs.json
    node scripts/prevention-report.mjs /tmp/mopilot-merged-prs.json

The JSON report names the input scope/time range, per-class counts, explicit non-bug records, unclassified
PRs, classified bugs with unknown recurrence, and declared recurrence references. Only plain paragraphs under
one visible level-two `Prevention record` heading count, ending at the next heading. Markdown is parsed
with the already-locked CommonMark parser (declared as a direct tooling dependency); code blocks, HTML
comments and examples never become metadata. Repeated/unsupported fields and marked-up values stay
unknown. Valid records surrounding examples remain readable. Old PRs without
these records stay unclassified. `Recurs after: none known` is an explicit assertion; missing or malformed
references are unknown, never evidence of no recurrence. References reflect the reviewed PR record, not
automatic verification of its causal claim. The reporter rejects open, duplicate and malformed PR records
rather than counting a partial sample. Report sample limits and unknowns when interpreting the result.

### Registered behavioral guards

`scripts/related-tests.mjs` always includes the structural merge-attribute check in
`tests/mergeAttributes.test.ts`, including documentation and tooling changes with no import edge.
For app changes, it also always includes the permission-card ownership cases in
`tests/desktopCardsUI.test.ts` and the structured-identity/authentication-boundary guards in
`tests/preventionContracts.test.ts`. They execute production behavior with mocked boundaries. Selector
UT prove that even an unrelated new app module keeps these guards; unrelated web/docs/tooling changes
retain their existing narrower selection. The guards protect these shared contracts and are examples
for extending the matrix, not proof that every new call site uses the right helper. Diff-specific scenario
UT and review remain required. Add precise lint rules only where a demonstrated mechanical pattern has
both unsafe and safe fixtures; a blanket ban on async callbacks would reject valid one-shot reads.
