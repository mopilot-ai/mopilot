# Streaming performance measurement

How the streaming pipeline in [design.md](design.md) is measured, what the benchmark reports, and the acceptance targets each phase is judged by. Tracks #1208. The benchmark is phase 1 of the design and lives in `scripts/perf-bench/`; this page is its specification, and the measured before/after is on #1208.

## Why measure first

The hypotheses in #1208 come from reading the source and the installed 0.3.23 bundle. None of them has been timed on a user's machine, and the stutter the user sees has not been classified: it may be typing latency in the composer, dropped frames while a reply scrolls, a slow switch between windows or chats, or a stall of the main process that every window feels at once. Each of those points at a different layer of the pipeline. The benchmark exists to say which it is before the larger phases are sized, and to give every later PR a number for its scenario.

## Probes

The probes are off unless the flag `shared.perf.probe` is on (`MOPILOT_FLAGS=shared.perf.probe=1`, or the Settings switch in development builds). They write JSON lines to `<userData>/perf/<run id>.jsonl` and never upload anything. Every line also carries `coreLoaded`, whether that process has the Rust core ([rust-core.md](../architecture/rust-core.md)): `false` is a run from before the core was required, whose numbers are the JS fallbacks' that are gone now, and a file without the field predates it, so its run is unknown.

| Process | Probe | Sample |
| --- | --- | --- |
| Main | `perf_hooks.monitorEventLoopDelay` (10 ms resolution), read every second | `{ t, kind: 'loop', p50, p95, p99, max }` |
| Main | Transcript writes: queue length, batch size, write time, flush reason | `{ t, kind: 'write', chat, records, bytes, ms, reason }` |
| Main | IPC sends per channel and per window, counted per second | `{ t, kind: 'ipc', channel, window, count }` |
| Main | The windows' invokes main answered per channel, each second: how many, their total and longest time to answer (`timedIpc`) | `{ t, kind: 'invoke', channel, count, ms, max }` |
| Main | Raw notifications per adapter per second, before batching | `{ t, kind: 'raw', harness, chat, count }` |
| Renderer | Store commits per thread per second, from a `useStore.subscribe` counter | `{ t, kind: 'commit', thread, count }` |
| Renderer | `PerformanceObserver` `longtask` entries | `{ t, kind: 'longtask', ms }` |
| Renderer | Frame intervals, from a `requestAnimationFrame` loop while the probe is on | `{ t, kind: 'frame', ms }` |
| Renderer | React commit time, through the profiler hook in development builds only | `{ t, kind: 'react', ms, components }` |
| Renderer | Time from the first delta of a reply to its first painted character | `{ t, kind: 'firstToken', chat, ms }` |
| Renderer | Each reveal step of a streaming reply, with how many characters it showed (`arrival.tsx`) | `{ t, kind: 'reveal', chars }` |
| Renderer | Long Animation Frame entries with the longest script in the frame (`src/session/perf.ts`) | `{ t, kind: 'loaf', ms, blocking, script: { url, fn, invoker, ms } \| null }` |
| Renderer | Event Timing entries of 100 ms or more for `keydown`, `input` and `pointer*` events; the loaded turns are in the common fields | `{ t, kind: 'event', name, ms, delay, processing }` |
| Renderer | Stalls of 200 ms or more counted since the window started (the counter below), sent when it moved | `{ t, kind: 'stalls', count, maxMs }` |
| Main | The startup timeline (`electron/perf/startup.cjs`): `boot` and `mainLoaded` (`electron/boot.cjs`, before and after main's modules load), then `whenReady`, `windowCreated`, `windowShown` and `appReady`, each the time since the process started with the modules main had loaded by then, kept from launch and written when the probe starts | `{ t, kind: 'mark', name, ms, modules }` |
| Main | At `whenReady`, main's loaded modules by where they come from: each `node_modules` package by name, the app's own files by folder two levels deep (`./electron/capabilities`), heaviest first: what a lazy require would move out of startup | `{ t, kind: 'modules', name, packages }` |
| Main | With `MOPILOT_REQUIRE_TIMES=1`, each CommonJS file's own load time from boot (its compile and top-level run, the files it requires left out; `electron/perf/requireTimes.cjs`): the count, the total, the 30 slowest, and the 30 slowest packages and app folders by their files' summed time | `{ t, kind: 'requires', files, ms, slowest: [{ file, ms }], packages: [{ name, ms }] }` |
| Renderer | The window's first contentful paint (`firstPaint`) and the first chat on screen with its history loaded (`chatInteractive`), sent as wall-clock time and written on main's timeline | `{ t, kind: 'mark', name, ms, window }` |
| Main | Every 10 s, each process the app owns from Electron's `app.getAppMetrics()` (RSS, CPU, idle wakeups per second) | `{ t, kind: 'proc', type, pid, rssKb, cpuPct, wakeups }` |
| Main | Every 10 s, main's own CPU time so far, and the child processes started since the last sample with how many of each program and its first plain word (`git status`, `node <script>`) (Node's `child_process` diagnostics channel: asynchronous spawns, not synchronous ones; one that fails to start is counted, not named) | `{ t, kind: 'cpu', userMs, systemMs }`, `{ t, kind: 'spawns', count, commands, sites }` (`sites`: each spawn's name with the app frames that started it) |

The startup marks and the idle samples are Phase 0 of the Rust core plan (docs/architecture/rust-core.md §2): cold start reads the marks over 10 launches, idle reads the process samples after 10 minutes with no chat running.

Every sample carries the window id, whether that window was visible and focused, the number of loaded turns in the active thread and the current text length of the streaming item, so a run can be sliced by what the user would have been looking at.

### Always-on stall evidence

Two cheap checks run in every build, whether or not `shared.perf.probe` is on, and never leave the machine:

- Main (`electron/perf/stalls.cjs`): a 200 ms timer measures how late it fires. A timer more than 500 ms late is a stall: one line goes to the app log and one JSON line to `<userData>/perf/stalls.jsonl`, `{ t, kind: 'stall', ms, focused, visible, rss, rssDelta, ipc, tasks, spawns, label, labelMs }`. The file rotates to `stalls.1.jsonl` at 256 kB, so it holds at most about 512 kB. `label` names the last long (50 ms or more) synchronous task that ended inside the stall, set by wrapping the spot in `labeled(label, fn)` (nested labels read `outer>inner`; the innermost long one wins). Wrapped so far: the chat-meta commit (`chats.commit`), the turn-diff store write (`turnDiffs.write`), the Claude transcript merge (`claude.messages.merge`, `claude.messages.endTurns`), an ACP transcript's parse (`items.parse`) and turn build (`acp.buildTurns`) and the audio reference walk (`audio.collect`). A stall also names what main did inside it: `ipc` (the channels of IPC calls that started in the window, with counts, at most 8; a ring of the last 32 calls, written by `timedIpc` on every call), `tasks` (the long labeled tasks that ended in it, newest first, at most 8), `rssDelta` (rss growth since the previous 200 ms tick) and `spawns` (child processes started since it, counted from Node's `child_process` channel). The always-on cost is two array writes per IPC call, one rss read per tick and a counter. A system sleep or wake is not a stall: the tick that spans it is skipped.
- Renderer (`src/session/perf.ts`): `rendererStalls` counts `longtask` entries of 200 ms or more (`count`, `maxMs`) from the window's start; the probe sends it as a `stalls` sample when it moved.

### CPU profile of the main window (production builds)

A production build has no DevTools or debugging port, so the probes above cannot say which JavaScript burns CPU in the renderer. **Help > Capture Performance Profile…** (`electron/perf/cpuProfile.cjs`) attaches `webContents.debugger` to the focused app window, runs the `Profiler` domain at a 1 ms sampling interval for 10 s, writes `<userData>/perf/profile-<run id>.cpuprofile`, detaches and reveals the file. A notification says when recording starts; reproduce the lag during those 10 s. It needs no flag and never uploads anything.

It refuses (with a short message) when a debugger is already attached, for example DevTools open on that window, when a capture is already running, or when there is no window. The debugger is always detached on an error, a write failure or a closing window. Open the file in Chrome DevTools (Performance or JavaScript Profiler > Load profile) or `speedscope`.

## Read-path benchmark

`node scripts/perf-bench/stdio.mjs [--engine core|node] [--reps <n>] [--out <file>]` times a harness's stdout on its way to main: a stand-in writes stamped JSON lines through the app's own spawn and Codex's JSON reader, at the S3 rate and as a burst, and one 32 MiB record. It reports each line's latency from write to value (p50, p95, max), main's busy time per event and how long a spawn holds main. `--engine node` runs the same path on `node:child_process`, for the difference.

`node scripts/perf-bench/batcher.mjs [--root <checkout>] [--reps <n>] [--seconds <n>] [--out <file>]` times main's stream batcher on a simulated clock: each family's deltas at the S3 rate (main's time per push, per tick and per second) and as a burst of 20,000, a request's flush of the chat it names, and an event that passes unbatched. `--root` runs another checkout's batcher (an older tree unpacked with `git archive`), so a change is timed before and after on one machine.

`node scripts/perf-bench/delivery.mjs [--reps <n>] [--rounds <n>] [--out <file>]` times a flush's `stream:batch` on the wire as Electron's IPC writes it (V8's serializer, through `node:v8`): main's write and the window's read of a frame tick, a background tick and a chat past the batcher's bound, as event objects and as the JSON bytes main sends (electron/app/streamBatch.cjs), and what one serialization of an event main holds only as an object costs by `JSON.stringify` and by the clone.

`node scripts/perf-bench/readpaths.mjs [--reps <n>] [--scale <factor>] [--out <file>]` times what main does with what is already on disk: an ACP transcript's read, parse and turn build, the list and search scans over many transcripts, file-search ranking and a Codex rollout's parse. It calls the app's own functions on generated files in a temporary folder, in plain Node, so it starts no app and needs no virtual machine; `--scale 0.01` makes a quick check, and `--out` writes the rows as JSON. Each row is the median of its repetitions.

Plain Node is not Electron's Node, there is no window, and a serialized copy stands in for IPC, and the files were just written, so `acp read` is a read from the system's cache. Compare rows of one machine with each other and do not read them as app timings. The stall labels above show the same slices in a running app.

## Benchmark runner

`scripts/perf-bench/` follows the shape of `scripts/chrome-compare/`: `run.mjs` starts a scratch MoPilot instance with its own user data directory, debugging port and `SAGE_E2E_BACKGROUND=1`, drives it over the debugging port, and reads the probe files when the run ends. It takes over the user's computer like the other suites, so it refuses to start without `MOPILOT_RELEASE=1`; agents run it only inside a virtual machine through `scripts/vm-exec.sh`. The aggregation (`aggregate.mjs`) and the fake harnesses have unit tests and run anywhere.

### Synthetic harnesses

Real harnesses cost tokens and vary between runs. The benchmark replays recorded transcripts through three fakes that speak each family's wire protocol:

| Fake | Speaks | Replays |
| --- | --- | --- |
| `fake-app-server.mjs` | Codex app-server JSON-RPC over stdio | `thread/start`, `turn/start`, then `item/*` notifications at the chosen rate |
| `fake-claude.mjs` | the Claude Code CLI's `stream-json` protocol | `stream_event` deltas, tool use and result messages |
| `fake-acp.mjs` | ACP v1 over stdio | `session/new`, `session/prompt`, `session/update` chunks and a `tool_call` pair |

Each fake takes a transcript file, a token rate (tokens per second), a chunk size (characters per delta) and an optional tool-call interval, and reports to the runner when its turn ends. The instance is pointed at the fakes through the existing binary overrides: `CODEX_BIN`, `CLAUDE_BIN` and `SAGE_ACP_BINS`.

### Scenarios

| Id | Chats streaming | Families | Window state | Turns loaded | Reply length |
| --- | --- | --- | --- | --- | --- |
| S1 | 1 | each family on its own | active, focused | 30 | 4 kB |
| S2 | 2 | same family, both | one active, one in the sidebar | 30 | 4 kB |
| S3 | 4 | one of each plus a second Codex | one active, three in the sidebar | 30 | 4 kB |
| S4 | 2 | mixed, in one chat that switched harness mid-run | active | 30 | 4 kB |
| S5 | 1 | each family | active | 300 (history loaded) | 20 kB |
| S6 | 2 | same family | second window, blurred | 30 | 4 kB |
| S7 | 4 | ACP only, tool call every 200 ms | one active | 30 | 4 kB |

Token rates: 40 and 120 tokens per second, chunk sizes 4 and 32 characters. Each cell runs three times; the table reports the median.

### Report

`aggregate.mjs` writes `runs.json` and a Markdown table per scenario:

Reports distinguish attempted cells, measured cells with usable samples in their own time window,
complete evidence, incomplete evidence, and runner failures. Missing/unreadable probe files, malformed
samples, skipped JSON lines, dropped samples and empty measurement windows never count as complete.
Drop markers record flush time rather than the lost samples' times, so any positive drop count makes
all cells using that probe file incomplete, even when the marker itself is outside a cell's window.
Usable partial measurements remain in the metric medians; each row in `runs.json` records `metricRuns`
with the number of numeric contributing cells per metric, and each incomplete cell records its reasons.
An absent optional metric (such as React timings in a production build) stays blank. A complete count
means no detected evidence loss, not that every metric was collected or any acceptance target passed.
The long-task rate counts recorded events only: zero means no recorded events, not a verified zero.
The probe emits no observer-availability or observed-span sentinel, so both remain unknown in each
run's `evidence.longTasks` metadata. Its `recordedEvents` count and `metricRuns` are not proof of an
installed observer or observation coverage. Establishing a measured zero requires a future producer
contract that records observer availability and the interval actually observed.
The offline reporting CLI returns success when it generated the report, including an incomplete report.

| Column | Source |
| --- | --- |
| raw/s | main `raw` samples |
| ipc/s per window | main `ipc` samples |
| commits/s per thread | renderer `commit` samples |
| frame p95 (ms), active window | renderer `frame` samples where visible and focused |
| long tasks per minute | renderer `longtask` samples |
| React commit p95 (ms) | renderer `react` samples (development builds) |
| main loop p95 (ms) | main `loop` samples |
| write p95 (ms), queue max | main `write` samples |
| first token (ms) | renderer `firstToken` samples |
| reveal gap p95 (ms), reveal stalls per minute | renderer `reveal` samples: the time between steps under 2 s (a longer one is a pause, such as a tool call), and how often it passed 300 ms |

## Acceptance targets

Starting targets, to be revised against the phase 1 baseline and the product's own requirements. A phase passes when its scenario meets its target on the benchmark machine and does not regress any other scenario.

| Metric | Target | Phase that owns it |
| --- | --- | --- |
| Active window frame interval p95 | ≤ 33 ms in S1 to S4 | 4 |
| Main event-loop delay p95 | ≤ 20 ms in S3 and S7 | 2 |
| Store commits per thread | ≤ frame rate (about 60/s), independent of token rate, in S2 to S4 | 3 |
| IPC sends per window per key | ≤ tick rate (about 60/s focused, 20/s blurred) | 3 |
| Commits caused in unrelated components | 0 in a background chat's turn: no `TurnView` of another chat, no other Priority card | 4 |
| First visible token | no worse than the baseline plus one tick (16 ms) | 3 |
| Reveal cadence | gap p95 ≤ 150 ms (the pacer's longest step) and no stalls while text keeps arriving, in S1 to S4 | pacing |
| Transcript order | byte-identical replay to today's writer in every scenario | 2 |
| Final text and event order | identical to today for every family (existing `streaming*.test.ts` and `streamDelta.test.ts`, plus the interleaving tests) | 0, 3 |

## What the benchmark does not show

- Real harness behavior: real agents vary their chunk sizes and pause for tool calls; the fakes replay fixed transcripts. A release run on real harnesses remains part of the release checklist.
- The user's machine: the targets are set on the benchmark machine; a slower machine needs its own baseline.
- The streaming runner does not drive user input; the separate interaction spec below measures it.

