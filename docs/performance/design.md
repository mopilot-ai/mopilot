# Streaming performance design

Status: implemented, 2026-10-16. Proposed 2026-10-15 in #1208; what landed and how it measured is under [Outcome](#outcome). The measurement plan and acceptance targets are in [measurement.md](measurement.md).

MoPilot stutters while chats stream, most of all when several chats stream at once. This document explains how a streamed token travels through MoPilot today, what Claude Desktop and the ChatGPT desktop client do differently at the same layers, and proposes a harness-independent streaming pipeline with a phased plan. Every phase applies to Codex, Claude Code and the ACP harnesses alike.

## Summary

The stutter hypotheses in #1208 share one shape: work that arrives per token is done per token at every layer, and blocking work shares the Electron main loop with every window's IPC. Claude Desktop and the ChatGPT client avoid this with two habits: blocking work runs away from the UI and main threads (worker hosts, a separate `app-server` process, `worker_threads`), and process boundaries carry bounded queues (chunked IPC with acknowledgements, background throttling). Neither client's shipped code proves that token deltas are frame-batched; the habit they share is isolation and bounded rate at boundaries.

MoPilot needs the same two habits, plus one it already half has: a frame coalescer that today serves only the Claude path and only consecutive deltas of one message. The proposal is five shared pieces: performance probes and a repeatable benchmark (D1), an asynchronous transcript writer (D2), one keyed delta batcher in main for every harness (D3), narrowed renderer subscriptions and windowed history (D4), and a per-item grapheme cache (D5). Each piece is a shared main-process or renderer service with a typed contract; adapters only translate.

## Outcome

Every phase landed. The final before/after measurement, on production builds in the isolated VM with the old and new build alternated so that one environmental episode hits both, is on #1208.

| Phase | Pieces | Pull requests |
| --- | --- | --- |
| 0 | Renderer coalescer joins by key | #1211 |
| 1 | D1 probes and benchmark (`scripts/perf-bench/`) | #1219, #1227, #1231, #1222 (transcript write timing) |
| 2 | D2 transcript writer, also used by the tool operation log | #1216 |
| 3 | D3 keyed batcher in main | #1213 |
| 4 | D4 renderer subscriptions; windowed history | #1215, #1230 |
| 5 | D5 grapheme cache; D6 background windows | #1212 |
| Found while measuring | Each finished reply parsed once for the pull request badge and the Sources list | #1228 |

What changed from the proposal:

- D4's first step, `content-visibility: auto` on finished turns, was removed (#1232). It kept a just-finished reply unrendered in a window that paints no frames, and it skipped layout but not the Markdown parse and render that dominate a long thread. Windowed history (#1230) unmounts far turns instead.
- Streamed Markdown is split into runs before it renders, not one render later (#1226), so blocks that arrive in one delta never remount.
- A profile of a 2 MB thread found most of its per-update cost outside the streaming path: the pull request badge and the Sources list re-parsed every reply on each refresh (#1228).

What the benchmark shows against [measurement.md](measurement.md)'s targets:

| Scenario | Before | After |
| --- | --- | --- |
| One chat streaming (Codex, ACP), 120 tok/s × 4 characters: frame p95 | 135–149 ms | 21–34 ms |
| Two chats streaming, 120 tok/s × 4: frame p95 | about 117 ms | 20 ms |
| Four ACP chats with tool calls (S7), 120 × 4: main loop p95 | 207 ms | 5 ms |
| First visible token | baseline | a half to a third of baseline |
| 300 history turns of 20 kB replies (S5) | the window stops answering near turn 100 | builds to 300 turns on every harness |

Store commits per thread no longer follow token rate for Codex and ACP (about 39/s at 120 tok/s). Claude Code with two chats settles at about 45/s, within the frame-rate target but above the other families.

## The pipeline as it was (2026-10-15)

Line numbers are as of `2a7a15f5`.

| Stage | Codex | Claude Code | ACP harnesses |
| --- | --- | --- | --- |
| Child process | `codex app-server` over stdio JSON-RPC | Claude Code CLI through the Agent SDK | the agent over stdio JSON-RPC |
| Main: parse | `CodexProcess` splits stdout by line and parses each record (`electron/harness/codexProcess.cjs`) | the SDK yields messages | `RpcPeer` splits and parses each line (`electron/harness/acp/rpc.cjs`) |
| Main: per-message work | `codexEvents.mapped`, lifecycle bookkeeping | `harness/claude/index.cjs` observes every event once | `record`: `ItemsLog.append` with `fs.appendFileSync`, then `emitEvent` (`electron/harness/acp.cjs`, `electron/platform/chats.cjs`) |
| Main → windows | `codexEmit`: one `codex:item` per window, every window (`electron/app/windows.cjs`) | `emitToWindows('claude:event')`, every window | `emitToWindows`, every window |
| Renderer: translate | none; already normalized | `ClaudeTranslator` → `display.emit` | `AcpTranslator.chunk` → one `item/agentMessage/delta` per chunk (`core/crates/translate`) |
| Renderer: coalesce | none | `createStreamNotifications`: text and thinking deltas held until the next frame, joined only with the last pending delta (`src/lib/streamNotifications.ts`) | none |
| Renderer: store | `applyNotification` → `ensureItem` (a store read, sometimes a second update) → `patchItem → patchTurn → patchRuntime`: maps every turn and item of the thread, clones the runtime map, one Zustand `set`, then `codexAgentTurnsChanged` (`src/store/notifications.ts`, `src/store/core.ts`) | same | same |
| Renderer: view | `ThreadView` recomputes navigation, async answers and narration priors from `turns`, renders every loaded turn; `TurnView` is not memoized; `Markdown` re-parses the streaming item's full text; the Priority section subscribes to the whole `runtime` map | same | same |
| Renderer: paint | `arrival.tsx` reveals text per animation frame through `revealedPrefix`, whose grapheme cache is one process-wide slot (`src/lib/textPacer.ts`) | same | same |

Two consequences follow. With one chat streaming, the Claude path does one store update per frame and the other two do one per token. With two chats streaming, all three paths do one update per token, because the coalescer compares only the last pending delta and A/B/A/B interleaving never matches. And every window, visible or not, repeats the renderer stages for every chat.

Finished turns already keep their object identity across updates (`patchTurn` returns other turns unchanged), so memoization will take effect once it is added.

## Principles

1. Nothing blocks the main loop per message. Disk writes, large reads and anything that can take more than a millisecond go through an asynchronous, bounded queue or a worker.
2. Rate at a boundary is bounded by frames, not tokens. Main sends a window at most one message per stream key per tick; the renderer commits at most one store update per thread per frame.
3. One shared service per concern, with a typed contract. Adapters supply a key and a join function for their delta kinds; the batcher, the writer and the view know no harness name.
4. Order within a chat never changes. A non-delta event (approval, tool start or end, turn end, stop, error) flushes that chat's pending deltas first. Order across chats is not promised.
5. The renderer re-renders what changed. A background chat's delta commits nothing in another chat's turns or in the sidebar beyond its own row.
6. Measure before and after. Every phase's PR carries the benchmark's numbers for its scenario, from the shared runner in `scripts/perf-bench/`.

## Design

### D1. Probes and benchmark

Main gets a probe module (`electron/perf/probe.cjs`) that samples `perf_hooks.monitorEventLoopDelay`, times every transcript write and counts IPC sends per channel. The renderer gets a counterpart (`src/session/perf.ts`) that counts store commits per thread, observes `longtask` entries and measures React commit time through the profiler hook in development builds. Both are off unless the flag `shared.perf.probe` is on; the renderer shows a small HUD when it is. Samples are written as JSON lines to the user data directory for the benchmark to read, never uploaded.

The benchmark (`scripts/perf-bench/`) follows `scripts/chrome-compare/`: a runner starts a scratch instance over its debugging port, drives 1, 2 and 4 chats, and records the probes. The chats talk to synthetic harnesses so a run is deterministic and free: a fake `app-server`, a fake ACP agent and a fake Claude CLI that each replay a recorded transcript at a chosen token rate. The runner needs the release gate like the other suites, so agents run it only inside a virtual machine through `scripts/vm-exec.sh`; the aggregation and the fake harnesses have unit tests. What it reports and the acceptance targets are in [measurement.md](measurement.md).

### D2. Asynchronous transcript writer

`ItemsLog.append` stops writing. It hands records to a `TranscriptWriter` (`electron/platform/transcriptWriter.cjs`) that keeps one queue per chat key and one in-flight `fs.promises.appendFile` per file. A flush timer of 250 ms drains a queue; a flush point drains it now and awaits it: a permission request, a turn's end, a session's close, a chat's deletion, and `before-quit` (with a bounded wait of 2 s). `ItemsLog.readAsync` (the only transcript read; there is no synchronous one) reads the file without blocking and adds the chat's queued records after it, so a window that opens a chat during a stream sees every record emitted so far. The queue is bounded at 2,000 records or 4 MiB per chat; past the bound the writer falls back to a synchronous append for that batch, so a runaway agent slows itself down instead of growing memory. A write error is reported once per chat through the existing `noteIgnored` path and surfaces as the chat's error banner; it never stops the stream.

Change contract. Invariant: a chat's transcript file holds its records in emission order, and every record emitted before a flush point is on disk when the flush point's promise resolves. Owner: the chat key's queue in `TranscriptWriter`. Invalidators: the chat is deleted or its directory moves. Overlapping work serializes per file; two chats never share a queue. Failure scenarios: a flush racing a delete (the delete awaits the flush, then removes the file); a crash between flushes loses at most 250 ms of records, which `readAsync` already tolerates because it skips a half-written last line; an agent emitting faster than the disk writes hits the bound and degrades to synchronous writes.

### D3. Keyed delta batcher in main

Since Stage 4.3 of the Rust core the batcher's queues, keys, joins, sizes and waits are the core's (`core/crates/batcher`, [rust-core.md](../architecture/rust-core.md) §6 step 9), and `electron/harness/coreBatcher.cjs` keeps the timers, the sends and each family's chat; the contract below is what the core's per-family code implements. As proposed:

A shared `StreamBatcher` sits between every adapter and `emitToWindows`. An adapter registers a small contract:

```ts
type StreamContract<E> = {
  /** The chat an event belongs to; null for events outside any chat (status, catalog). */
  chatOf(event: E): string | null;
  /** For a joinable delta, its key (chat, turn, item, kind); null for every other event. */
  keyOf(event: E): string | null;
  /** Two deltas with the same key become one. */
  join(first: E, next: E): E;
};
```

Codex's key is `(threadId, turnId, itemId, method)` on the normalized notification. ACP's is `(key, turnId, sessionUpdate, toolCallId?)` on the `update` event, joining `agent_message_chunk` and `agent_thought_chunk` content. Claude's is `(key, content block index, delta type)` on the SDK's `stream_event`, the same fields `shared/streamDelta.mjs` already validates. Everything else has no key and flushes the chat's pending deltas before it is sent, so a window never sees a tool result before the text that preceded it.

The batcher ticks every 16 ms while any app window is visible and focused, and every 50 ms otherwise, matching the renderer's background timer. On a tick it sends each pending key once, per window, through the adapter's existing channel. The window broadcast rule in `windows.cjs` does not change; it just runs per tick instead of per token. A pending delta is also flushed when its chat's window closes, when the adapter stops, and before `before-quit`.

The renderer keeps `createStreamNotifications` as a safety net against React's update-depth error, but its join rule changes from "the last pending delta" to "any pending delta with the same key", which fixes the interleaving case for Claude on its own and is the first, smallest PR of the plan.

Change contract. Invariant: for one chat, windows receive events in the order the adapter produced them, with runs of same-key deltas merged into one event whose delta is their concatenation; the final text of every item equals today's. Owner: the batcher's per-chat queue. Invalidators: the chat's adapter stops, the chat switches harness (the old adapter's queue flushes before the new segment's first event), the chat is deleted. Overlapping work: two adapters for one chat during a switch are serialized by the flush-on-switch. Failure scenarios: a stale `turnId` on a late delta goes through unchanged, as today; an event with a malformed key is treated as keyless and flushes; a window that is destroyed between tick and send is skipped, as `emitToWindows` already does.

### D4. Renderer subscriptions and windowed history

Store writes. `applyNotification` gains a batch entry, `applyDeltaBatch(threadId, deltas)`, that folds `ensureItem` and the patches of one frame into a single `set` per thread. `patchRuntime` keeps its shape; its per-frame cost is one map over the thread's turns, which is acceptable once per frame.

Thread view. `TurnView` becomes `memo`, and `ThreadView` stops passing it props that change on every delta: `questionAnswers` is split per turn, `narration` is looked up by turn id, `isLast` stays. The derived lists (`navigationItems`, `submittedAsyncAnswers`, `turnNarrationPriors`) are computed per turn and cached by turn reference, so a delta in the active turn recomputes one turn's share. History is windowed. `content-visibility: auto` alone skipped paint and layout but not the parse and render of every reply (a 300-turn chat of 20 kB replies took over 5 s to open), so `ThreadView` renders a full `TurnView` only for the turns an IntersectionObserver reports within two screens of the viewport (`src/components/thread/view/turnWindow.tsx`), plus the running and last turns, the turn a jump goes to, the turn holding the focus, and every rendered turn while text is selected in the transcript. Every other turn is a slot of its last measured height, or of an estimate from its text before it ever rendered (`src/lib/turnWindow.ts`); an estimate never changes once given, so placeholders do not move as other turns are measured. Before the transcript first reports what is on screen, a chat opens on the last turns that fill three screens. When the window changes, `KeepAnchor` keeps the first turn that starts on screen where it was, the same element the browser's scroll anchoring picks, so the two agree and a smooth scroll is not stopped by a correction. While the view follows its bottom, the browser's scroll anchoring is off (the transcript's `following` class), since following is the anchor; while a page of older history goes in, it is off too, and `loadHistoryPage` alone restores the place. A jump to a message whose turn is a placeholder renders the turn first and then scrolls there at once (`src/components/thread/view/messageJumps.ts`); a smooth jump, and the scroll back to the bottom, finish where the content ended up once the scroll ends. The navigation rail observes the rendered prompts with an IntersectionObserver whose edges are the transcript's top line and bottom, and reads only the prompts it needs (a binary search) when one crosses them, so a streamed reply that grows reads nothing. "Copy last code block" reads a placeholder turn's code from its replies.

Streaming Markdown. The streaming item's text is split at the last block boundary that the parser has already closed; the prefix renders through the memoized `Markdown` with a stable string, the tail re-parses at most once per frame. A finished item re-parses once when its text stops changing.

Sidebar. `PrioritySection` stops subscribing to `runtime`. Each `PriorityCard` subscribes to its own chat's `runtime[id]` and derives the snippet from the last agent message, so a delta re-renders only its own card; the rest of the list sees nothing. `ThreadIndicators` already subscribes per chat.

Change contract. Invariant: a store update that changes only thread A's active turn re-renders only components subscribed to that turn or to thread A's summary. Owner: each component's selector. Invalidators: a turn ends (its `TurnView` gets a new reference once), history loads older turns. Failure scenarios: a stale `threadId` in a late render reads an empty runtime and renders nothing, as today; windowed turns that resize after a placeholder is measured correct their height when they next render; a turn's local UI state other than its "Worked for" fold (kept for the visit of the chat, not when it opens again) resets once it leaves the window; reduced-motion users get the same windowing, with jumps that are always instant.

### D5. Per-item grapheme cache

`revealedPrefix(text, n)` becomes `revealedPrefix(key, text, n)`. The cache is a bounded map from item key to `{ text, boundaries }` (at most 8 streaming items, least recently used evicted). When the new text extends the cached text, only the suffix from the last cached boundary is segmented and appended, so a 20 kB reply costs the new characters per frame instead of its whole length. Two streaming replies no longer evict each other.

### D6. Background windows

A hidden or minimized app window gets the batcher's 50 ms tick and already runs the renderer's 50 ms fallback timer. It also skips the reveal animation: `arrival.tsx` shows a hidden window's text at once, and resumes pacing when the window is shown again, so a background window never spends frames on animation nobody sees. A visible window without focus is not in the background: someone may be watching it while typing in another app, so it keeps the 16 ms tick and the paced reveal (an earlier version treated a blurred window as hidden, and its text arrived in 20 Hz clumps). Browser `WebContentsView`s keep `backgroundThrottling: false`, which they need for control.

### Paced reveal

The reveal follows Claude Desktop's streaming text (its claude.ai renderer, read from the shipped bundle). `TextPacer` (`textPacer.ts`) shows a reply in steps of about 22 characters, spaced so the text that has arrived shows over about 550 ms: the step interval is `clamp(25, 550 × 22 / backlog, 150)` ms, and a backlog beyond what the fastest steps show in that time is caught up within 75 ms. A steady 550 ms lag turns bursty deltas into an even flow; draining each burst at once, as the earlier pacer did, made the reveal stop and go. A finished reply shows the rest within about 600 ms, a step every 25 ms, so it neither trails on nor jumps in large blocks. Each step ends where its Markdown is complete (`streamCut.ts`): never inside emphasis, a code span, a link, `$$` math, a directive, a table header without its delimiter line, a line of block markers alone, or a word that may still grow into a link, so nothing shown changes form, remounts and fades in again (the flicker). At most 600 characters wait for a construct to close, and a reply that pauses for a second (a slow model, a turn kept open) shows what it held back as if it had finished. Each word of a step fades in over 400 ms, 2.5 ms per character after the step began, at most 150 ms later (`rehypeWords.ts`); the long overlapping fades hide where the steps meet. The fade is a Web Animation started at the word's moment on the document timeline (`stepFade.ts`, as Claude Desktop's delta-fade is), not a CSS animation: Markdown that only a later line decides (a list turned loose by an indented code block, a setext underline) mounts the word again, and the new element carries on the fade where it was instead of starting it over.

### Not in this round

Moving the adapters' parsing into `utilityProcess` workers, as Claude Desktop does for its heavy work, is a candidate for a later round only if D1 shows line parsing and forwarding dominating the main loop after D2 and D3. The ChatGPT client's chunked, acknowledged IPC solves large payloads, not token rate; MoPilot's large payloads (history pages, diffs) are rarer and are measured by D1 before anything is built for them.

## Harness coverage

| Piece | Codex | Claude Code | ACP harnesses | Mixed chats |
| --- | --- | --- | --- | --- |
| D1 probes and benchmark | supported (fake `app-server`) | supported (fake CLI) | supported (fake agent) | supported (the runner mixes families) |
| D2 transcript writer | not applicable: history lives in the app-server | not applicable: history lives in the CLI's files | supported | a chat that switched to an ACP segment gets a writer for that segment |
| D3 batcher | supported | supported | supported | supported: the old adapter's queue flushes before the new segment's first event |
| D4 renderer | supported | supported | supported | supported: the view is harness-free |
| D5 grapheme cache | supported | supported | supported | supported |
| D6 background windows | supported | supported | supported | supported |

No piece is blocked for any family. The only degraded case is a harness that emits non-delta events faster than the tick (a tool-heavy ACP agent): its events flush the batcher on every one, so it gains nothing from D3 and relies on D2 and D4.

## Phases

Each phase is one PR stack with focused unit tests and the benchmark numbers for its scenario in the PR description. Phases 1 and 2 can land in either order; the rest depend on phase 1 for their numbers.

| Phase | Pieces | Exit criterion |
| --- | --- | --- |
| 0 | Renderer coalescer joins by key | Interleaved A/B/A/B deltas of two Claude chats deliver once per key per frame (unit test); no behavior change for one chat |
| 1 | D1 | A benchmark run on the current build produces the baseline table in measurement.md |
| 2 | D2 | Main p95 event-loop delay during four ACP chats streaming within target; transcript replay identical (unit test with a fake clock and fake fs) |
| 3 | D3 and the store's batch entry | Store commits per second grow with frame rate, not token rate, for every family and for mixed chats; event order unit tests pass for every adapter |
| 4 | D4 and D6 | A background chat's deltas cause no commit in the active thread's unrelated `TurnView`s or in other Priority cards (React profiler assertion in a unit test); frame interval target met with 4 chats |
| 5 | D5 | CPU profile shows segmentation cost proportional to appended text; two streaming replies share the cache |

## Guards

- A lint rule (`lint/rules/no-sync-fs-in-hot-paths`) forbids `fs.*Sync` writes in `electron/harness/**` and `electron/platform/chats.cjs` outside startup and shutdown functions; the existing call sites move to the writer in phase 2.
- An invariant test checks that every adapter's text-delta emit in `electron/harness/**` goes through the batcher, by requiring every harness family to have a chat and a contract in the core (`tests/streamContracts.test.ts`).
- Interleaving unit tests for the renderer coalescer and the main batcher: A/B/A/B across two chats, a non-delta event between deltas, a switch mid-stream, a window closing mid-tick.
- Bug-prevention classes touched: `overlapping-operations` (writer and batcher queues), `stale-async-results` (a flush after a delete, a late delta after a switch), `lost-user-input` (records never dropped, only delayed), `wrong-scope` (per-chat keys; no process-wide cache), `swallowed-errors` (write failures reach the chat's banner).

## Risks and open questions

- The user's stutter is not yet classified: typing latency, scroll frame drops, slow window switches or IPC stalls. Phase 1 answers this before phases 3 to 5 are sized.
- The shipped 0.3.23 renderer bundle has not been matched to the current source; the `electron/shared` files have. Phase 1's baseline runs on a build from `main`.
- Windowed history changes layout timing for navigation anchors and "load older" scrolling. Phase 4 kept `content-visibility: auto` as the first step; the windowed list followed on the evidence above. Selecting all of a transcript (Cmd+A) selects only the rendered turns.
- The batcher adds up to one tick of latency (16 ms) to the first token of a reply. The arrival animation already paces text, so this should be invisible; the benchmark records time to first visible token to confirm.
- ACP agents that need the transcript on disk immediately (none known) would see a 250 ms window; the flush points cover every path where MoPilot itself reads the file.
