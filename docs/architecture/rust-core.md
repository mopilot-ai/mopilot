# Rust core: making startup and idle cheaper

Status: every domain of main's hot paths in this plan runs in the core, with no JS copy and no fallback: `proc`, `store` (reads and a chat record's commit), `framing` (every harness and tool stream), `caps-socket`, `session`, `transcript`, `rank`, `rollout`, `translate` (ACP and Claude Code), the stream batcher (`core/crates/batcher`, §6 step 9) and delivery as bytes. An app or Host whose core does not load stops with why (the app before main loads: `electron/boot.cjs`, `electron/app/withoutCore.cjs`), and `coreCall` has no null branch. Steps 2 to 5 of §6 were measured at their gates and, at the user's choice (2026-10-28), ported anyway; the release baseline was not run (the user chose to skip it, 2026-10-27), so the gates were applied to numbers from GitHub's macOS runners instead, the streaming benchmark's S3 and S7 among them, and to a Node timing of the framer ([Phase 0 results](#phase-0-results)). Each domain's numbers are in [§11](#11-final-numbers). The window stays JS. The modularization it depends on is in [modularization.md](modularization.md).

## 1. Goal, and what Rust can and cannot change

The goal is faster **cold startup** and lower **idle memory and CPU**. The approach is a strangler migration. Electron stays as a thin shell, and main-process domains move one at a time into a Rust core. Each move has to show a measured gain before the next one starts.

Earlier performance work bounds what Rust can buy. The streaming jank fixed in [docs/performance/design.md](../performance/design.md) came from architecture, not from JS speed:

- per-token work;
- blocking I/O on main;
- broad re-renders;
- unbounded IPC payloads.

Each fix was an algorithmic or isolation change made in JS, and it brought the measured scenarios within budget.

Where the cost sits:

| Cost | Where it lives | Can Rust help? |
| --- | --- | --- |
| Main-process heap and CPU (stores, adapters, session state, polling) | Electron main (Node) | **Yes.** This is the target |
| Frame drops, React renders, Markdown and Shiki highlighting, large diff DOM | Renderer (Chromium) | No. A Tauri webview runs the same React code |
| First token and turn time | Codex app-server, Claude Code CLI, ACP agents (child processes) | No |
| git, ripgrep | Already native child processes | No |
| Built-in browser page memory (IndexedDB, DOM storage) | Chromium's browser process | No |

One spot sample of an installed build, taken 9 minutes after launch, is the only memory number we have:

| Process | Approximate size |
| --- | --- |
| Main | 137 MB |
| Renderer | 128 MB |
| GPU | 34 MB |
| Network utility | 29 MB |
| **Total** | **about 330 MB** |

An empty Electron main is estimated at 60–80 MB. That puts the part of main that Rust could reach at roughly 50–70 MB, or 15–20% of the total. Both figures are estimates. Phase 0 replaces them with measurements.

## 2. Phase 0: measure, then take the cheap wins

No startup or idle budget exists today, and no number has been recorded for either. Measure before porting anything.

### Probes

Extend `electron/perf/probe.cjs` and the `scripts/perf-bench` runner with two probes.

- **Cold start.** Record each mark from the process start:
  - first window shown;
  - first paint;
  - `app:ready` resolved (`electron/app/startup.cjs`);
  - the first chat interactive.

  Report the median and p95 over 10 cold launches, with a scratch user-data folder and a seeded fixture of 200 chats.
- **Idle.** After 10 minutes with no chat running, sample every process the app owns (main, renderers, GPU, utility processes, the future core):
  - RSS;
  - CPU time;
  - wakeups per minute;
  - child processes spawned per minute.

Add the budgets to [docs/performance/measurement.md](../performance/measurement.md) once the baseline exists. Like every app check, these probes run on the GitHub macOS runners or in a `mopilot-*` VM, never on a developer's own Mac (see AGENTS.md).

### Cheap wins, measured against that baseline

Startup today is serial JS work. In `startup.cjs`, once `app.whenReady` fires:

1. the window is created;
2. then `await shellEnv.ready()`: a `$SHELL -ilc` child process with a 5 s cap;
3. then `await signIns.openAccounts()`;
4. then `await agentTools.openTools()`.

The renderer imports its full app only after `app:ready`. `main.cjs` requires about 51 modules eagerly, with no compile cache and no bundle.

Idle CPU today comes from polling:

- `electron/platform/processTree.cjs` runs `ps -A` every `WATCH_MS` (2 s) while a harness is active, backing off to `IDLE_WATCH_MS` (30 s) once nothing has happened for a few ticks (a harness event brings it back);
- `electron/platform/memoryPressure.cjs` spawns `sysctl`;
- `electron/` has about 42 `setInterval` sites, among them the harness-updates check, Codex idle release, the updater tick and Computer History sampling.

Candidates, each one PR measured by the probes above:

- Start the renderer's chunk loading in parallel with main's setup, and gate only the IPC that needs `app:ready`.
- Run shellEnv, sign-ins and the tool registry concurrently where they don't depend on each other. Defer what the first paint doesn't need.
- Bundle main with rolldown, which is already a dependency.
- Not Node's compile cache (`module.enableCompileCache()`). It would save about 30 ms of the 330–620 ms main's modules take to load (boot to `mainLoaded`), but the packaged app would run V8 bytecode read from a folder any process of the user can write, or that `NODE_COMPILE_CACHE` names. That bypasses the asar integrity the release fuses enforce (`scripts/check-fuses.mjs`). Loading is mostly running the modules, not compiling them, so fewer modules at startup is the win.
- Not preloading the renderer's full app (a `modulepreload` link per chunk of `src/main.tsx` in `index.html`). On the runners it made `appReady` to the first paint slower (about 330 ms against 205 ms) and the chat interactive about 260 ms later: compiling ~3 MB of chunks up front competes with the launch screen and main's own setup instead of filling a gap.
- Make the heavy `main.cjs` requires lazy.
- Replace intervals with events, or stretch them while nothing is running.

The numbers after these wins are the baseline a Rust port must beat. If the wins meet the budgets, the Rust work moves on to the typed-boundary and memory goals alone.

### Phase 0 results

The release baseline (10 launches and 10 minutes idle on a developer's Mac, the streaming benchmark's S1 to S7) was not run: it needs a `mopilot-*` VM that this setup does not have, and the user chose to go on without it. The numbers here come from the perf-startup spec on GitHub's macOS runners, with fake harnesses and 200 chats: the cold-start and idle probes, and the streaming benchmark's interaction spec for S3 and S7 (under `framing` below). Wall-clock times vary about 40% between runners; module counts, per-file load times and spawn counts do not.

**These runs had no core.** The perf-startup spec and the streaming benchmark launch a checkout unpackaged, where the loader looks in `core/target/release`, and until 2026-11-05 no E2E or CUJ workflow built the addon there. Every runner number in this section, S3 and S7 included, is the JS fallbacks'; only what it names as a packaged app's had the core (`scripts/package.mjs` builds it into the app). Since then `tests/e2e/global-setup.ts` builds or restores the addon for every run, and each probe sample carries `coreLoaded`, so old-against-new comparisons start from runs that say which they measured.

**Startup**, medians over warm launches (`perf-startup.spec.ts`, the marks of `electron/app/startup.cjs`):

| Step | Median |
|---|---|
| `boot` to `mainLoaded`: main's ~930 modules | ~310 ms |
| `mainLoaded` to `whenReady` | ~80 ms |
| `whenReady` to the window shown (`setupGuests`, `createWindow`) | ~165 ms |
| shell environment, accounts and tool registry (fake harnesses) | ~8 ms |
| IPC registered, then `appReady` | ~155 ms |
| `appReady` to the first paint | ~280 ms |
| first paint to the first chat interactive | ~1.3 s |

- Main's own files take ~310 ms to load in all; the heaviest were the legacy Office readers, `js-yaml` and `tldts`, now loaded on first use (#2761). The rest is a long tail: `./shared` (with the ES modules it imports) and `./electron/capabilities` lead.
- The renderer dominates. A warm reload to the chat interactive is ~730 ms: ~270 ms idle waiting on main, ~190 ms V8's own work, ~170 ms the app's chunks. While the chat loads, the window waits on Claude Code CLI checks (`claude:catalog`, `claude:detect`, `claude:probe`, `claude:refreshAccounts`, each starting the CLI) and `claude:turns` (`timedIpc`, #2768).

**Idle**, the probe's spawn samples by call site (#2763): 39 child processes in the first idle minute, then a steady ~9 a minute on a runner, and ~3 (`git`) in a packaged app, which reads the process table and memory pressure through the core. The first minute's Claude Code CLI starts are startup's tail, not a poller. The sidebar's PR badges and the Changes pane no longer spawn `git` every few seconds (#2764).

**What the gates decided:**

1. `proc` (§6 step 1): done. `proc.table` and `proc.pressure` replace `ps` and `sysctl` in the packaged app (#2738, #2750, #2752), and `proc.commands` replaces Claude's presence scan with `ps -axww`, every 4 s in front (#2765), and the native scheduler's check for an open app, which reads the row's executable (macOS's `KERN_PROCARGS2` path), never the arguments. `proc.started` dates one process for the MoMo locks, the Host's lock, children and npm pid file (`processStart`, `electron/platform/processIdentity.cjs`), which store the same milliseconds or file times as when `ps` did this, so no record changes format. A MoPilot records its own start as the kernel has it (the estimate from the clock only when the core can't say), so a clock stepped since launch can't make a live owner look like a reused pid. It answers for any user's process, as `ps` did: `KERN_PROC_PID` on macOS (the full record `proc.identities` reads stops at this user's), `btime` plus the start tick on Linux, and on Windows `GetProcessTimes`, or null for a process this user can't open. A process that is gone is null; one that can't be read (Linux's `hidepid=1`) is a route error, so null with a note. The browser memory guard's worker asks `proc.table` for a page's parent, loading the core in that thread so a flood that starves main can't stop it. It has no fallback, so the worker reports on starting whether it reached the core, and a release's smoke launch (`scripts/smoke-launch.mjs`) fails if it did not. On Windows the table comes from Toolhelp32 and `proc.kill` ends a process tree, children first, in place of `taskkill /T /F` (#2772); the Windows package ships the core signed and checked by hash (#2773). A harness that `spawnGroup` starts is held in a Job Object (`proc.contain`), the Windows counterpart of its POSIX process group: a stop ends the job with the tree, and after a harness exits on its own `endGroup` ends what its job still holds (`proc.endContained`), commands whose parent exited included, as #1486 does on POSIX.
2. `store` (§6 step 2): the chat store's startup read is ported; the user chose to port each remaining domain whatever its gate said (2026-10-28). `store.readRecords` lists `threads/` and reads every `<id>.v2` in parallel on native threads, checks each as JSON and hands back one reply, which `ChatsStore.load` parses once (`electron/platform/recordFiles.cjs`). A file it can't validate goes back as text and is parsed as before, so the entries match the JS loop's byte for byte, in Node's order The JS loop is gone (a folder that can't be listed starts the store empty, and it won't write over a chat file it could not see). On 723 chat files (this Mac's count, ~1 KB each, synthetic), warm: 12.4 ms in JS, 8.2 ms through the core. The startup-path reads were ~70 ms of the ~1.4 s to the first chat interactive, so this does not move that metric. Since Stage 4.5 a chat record's commit is written by the core too, synchronously (`store.writeRecord` through `dispatchSync`, `writeRecordFile` in `recordFiles.cjs`), so the record is on the disk before `ChatsStore.commit` returns, as before. JS still makes the bytes (`JSON.stringify`, compact), names the file and its temporary sibling (`.mopilot-<pid>-<uuid>.tmp`, `temporarySibling`) and says whether it is under the data folder (`isPrivatePath`); the core does what `writeAtomic` did, step for step (`core/crates/store/src/write.rs`): the file's mode read through a link (none for a missing entry or a path through a file), the folder made (0700 when private), the temporary file written with that mode (0600 for a new private file, else 0666 less the umask) and closed, with a failed close a failure (a network or over-quota disk may report a lost write only there, and std's drop would ignore it), the mode put back past the umask, then renamed over the file; any failure from the temporary file on removes it, and the failure is the step's. The close and, on Windows, the rename are libuv's own calls (`sys.rs`): an interrupted close is done, and a rename is one `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on the namespaced paths Node hands libuv, not std's POSIX-semantics rename. Like `writeAtomic` it syncs nothing to the disk: a crash between the write and the rename leaves the old file whole and a stray `.tmp` that nothing reads. A failure throws Node's error for the step (`EACCES: permission denied, open '<temp>'`, `ENOSPC: no space left on device, write`), with `code`, `syscall`, `path` and `dest`, libuv 1.52.1's names (`uv_table.rs`: every errno of `UV_ERRNO_MAP`, and on Windows every case of `uv_translate_sys_error`; an errno libuv has no name for reads `Unknown system error -<n>`, as Node's did). `store.errorNames` serves the table, and `tests/recordFiles.test.ts` holds it to `util.getSystemErrorMap()` on each platform it runs on, both ways on POSIX, so a switch still says "The chat could not save its new session (…)" word for word; a temporary file that could not be removed is noted. `this.fallback` (a migration not finished, when only the legacy files are written) stays: it is no fallback for a missing core. The legacy mirror and `ui-state.json` stay JS's: they are written behind (`WriteBehind`, asynchronously, cancelled and fenced by a newer write), a different operation, and every other state file keeps `writeAtomic`. Measured in plain Node on Apple silicon (`scripts/perf-bench/commit.mjs`, Node 24, five rounds alternating, median, two runs), a commit's `JSON.stringify` and write together, `writeAtomic` then the core: a 0.9 KB record 114–117 → 114–115 µs, a 1 MB record 651–699 → 662–703 µs. No gain, as expected: the time is the disk's and the encoding's, and a commit stays far under the 50 ms that labels a stall. The payload is encoded once into one buffer; joining the strings first cost a 1 MB commit ~50 µs more than `writeAtomic`. The other formats and the locks stay JS's.
3. `framing` (§6 step 3): ported at the user's choice (2026-10-28), and since Stage 4.2 all of it: the core frames every harness and tool stream, and JS only parses (`electron/transport/jsonReader.cjs`). A harness child's stdout is framed on the core's reader thread and reaches main as whole lines; any other stream (an MCP or helper socket, a child Node started, Your Chrome's output) through the `framing.*` routes on main. So does the portable sage-mcp (`host/src/sageMcpShim.mjs`), on both its streams, where it still runs: on a Host, whose version carries the core, and in a Linux checkout; the Linux package ships the Rust bridge (`core/crates/sage-mcp`) instead, as Windows does. The JSON input worker and JS's framer are gone, with no fallback: no core, no reader. Measured in plain Node on Apple silicon (`scripts/perf-bench/stdio.mjs`, Node 24, the median of five runs, two alternating rounds), before and after 4.2: at Codex's rate a line costs main about the same (19.7–19.8 µs before, 19.9–20.9 µs after, mostly the loop's own wake-up), its latency under 0.03 ms at p95 either way; a burst of 20,000 lines costs main 1.2–1.3 µs a line instead of 12.6–12.9 µs, and lands at p95 in 0.8–1.2 ms instead of 104–108 ms; a 32 MiB record arrives in 40–41 ms instead of 78 ms, holding main for 14.4–15.0 ms instead of 16.5–17.6 ms: the record's parse moved to main, and its copies into a worker and back went. The text below is the state before 4.2, kept for its numbers. Then, a raw UTF-8 connection's records past 4 KB were framed by the core's `framing.*` routes in a JSON input worker: the core cut the bytes into complete lines within the transport's limit, and the worker decoded and parsed each and handed them to main one at a time; a UTF-16 connection, or no core, framed in JS. The gate below said it would not move its metric, and it does not: main's part is unchanged. Its metric is main's event-loop delay while harnesses stream. The streaming benchmark's interaction spec (`tests/e2e/performance-input.spec.mts`) measured it on a GitHub macOS runner on 2026-10-28: S3 and S7, three repetitions each, with four chats streaming while a continuous load of 32 MiB JSON records goes through the real Codex reader in main:

   | | S3, median (range) | S7, median (range) | Target |
   |---|---|---|---|
   | main event-loop delay p95 | 9.3 ms (6.2–23.9) | 10.9 ms (10.6–35.1) | ≤ 20 ms |
   | a 32 MiB record delivered | 331 ms | 208 ms | ≤ 100 ms |

   The loop delay meets its target at the median; one repetition of each went over, during typing, scrolling and chat switches, which it does not separate from framing. Framing's own share of main is small:
   - A streamed delta line costs main ~0.5 µs to frame and parse. That is under 0.1 ms a second at S3's rate (the JSON input reader of the time timed alone in plain Node on Apple silicon).
   - A record past 4 KB is framed and parsed in a worker thread. Receiving a 32 MiB record's value holds main for ~3 ms as one string, or ~11 ms as half a million small objects.

   The 32 MiB delivery target is missed on the runner, where four chats share three vCPUs. On Apple silicon with nothing else running, the same record arrives in ~37 ms: ~15 ms feeding 32 KiB reads, then the worker's parse and the hand-back. A Rust framer reading the pipe itself could remove the feeding. The parse's result still has to become V8 values on main, which costs as much through Node-API as through the worker's clone, so the event-loop delay would not move. Process-group lifetime already has its native piece in `proc` (#2772 and the Job Objects above). If the release baseline on a developer's Mac misses the 32 MiB target, that gap is the case to reopen.
4. `session` (§6 step 4): under way at the user's choice (2026-10-28), precondition first: harness translation lives only in main, the precondition for the controller moving to Rust; the windows' copies and their flags are gone. ACP (`electron/harness/items/acp.cjs`): main translates each basic chat's events once for every window, after the stream batcher, and sends the Codex-shaped notifications on `acp:items`; history comes as main's turns (`acp:turns`), and the windows keep only what reads their own store (notes, provider errors, toasts). Codex needs no move (main already sends its notifications finished). Claude Code (`electron/harness/items/claude.cjs`): one translator per native session for every window, fed each event right after the window gets it (the window that sent a message shows it before main's `turn/started` names its turn), its items on `claude:items`; a transcript page carries the running turn under its live id (`claude:turns`), so a window opening mid-turn adopts nothing. The controller follows.
5. `caps-socket` (§6 step 5): the peer checks are ported at the user's choice (2026-10-28). Each sage-mcp connection ran up to eight `ps` (its ancestry, one level at a time) and one or two `lsof` (that the claimed process holds the socket); the core's `caps.ancestry` reads the ancestry from one process table, and `caps.peerPid` asks the kernel which process connected (`LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux). The rules stay in `electron/capabilities/mcp/socket.cjs` and `httpMcp.cjs`, and these routes are their only source for unix sockets: a peer the kernel names as the claimed process is accepted, and any other answer, a failing core or none is refused. `LOCAL_PEERPID` names the last process to use the far end and `SO_PEERCRED` the process that connected, and either can have exited with its number taken by another. So `caps.peerPid` answers only while that process holds the far end: on macOS one of its descriptors must be the socket joined to ours (`PROC_PIDFDSOCKETINFO`, both handles compared), on Linux `/proc/<pid>/fd` against sock_diag's peer inode. `caps.ready` runs that check on a socket pair of its own, so tools are reported only where it works, and an addon without the holder proof is not ready. `caps.ancestry` has no depth of its own, since a descendant can sit any depth down; a check that has one cuts the chain. `caps.executable` reads the file a process runs (`proc_pidpath`, `/proc/<pid>/exe`). TCP peers on the http channel still take their pid from lsof or netstat. The server, its token and the Swift helper stay as they are; the computer-access frames' X25519 and AEAD already run in Node's native OpenSSL, and a second implementation of them would only be a second place for a security bug, so they are not moved.

The startup budget the design asked for stays unset for the same reason: a budget belongs on the release machine's numbers, not a shared runner's.

## 3. Core architecture

### Workspace

A Cargo workspace lives at `core/`:

```
core/
  Cargo.toml            # members = ["crates/*"], a glob, never a hand-kept list
  rust-toolchain.toml   # pinned stable; the coverage job pins a nightly
  crates/
    proto/              # message types; generates checked-in TS types (ts-rs or specta)
    proc/               # process table, process tree, tree kill (first slice)
    framing/            # NDJSON / JSON-RPC framing with backpressure
    batcher/            # main's stream batcher: each chat's queue, the deltas' keys and joins, the ticks' decisions
    rank/               # fuzzy ranking of a folder's paths, held by id between keystrokes
    rollout/            # a Codex thread's history from its rollout file, held by id and read a page at a time
    translate/          # ACP updates as a thread's turns and items: one translator per native session, held by id
    jsvalue/            # JS values in Rust, for the ports that do what the JS did: JSON.parse, UTF-16 strings, coercions
    llmroute/           # a model request translated between an SDK's wire and a provider's (Anthropic Messages to OpenAI Chat), whole or streamed; ported from Nasiko's llm-router (Apache-2.0)
    store/              # byte-compatible readers and writers for the app's files
    transcript/         # JSON-lines logs written off the JS thread, read back with what is still queued
    harness-codex/      # app-server connection, later
    harness-acp/        # ACP client, later
    session/            # chat controller state machine, later
    caps-socket/        # the sage-mcp and helper sockets, later
    sage-mcp/           # a binary, not the addon: the harnesses' tool bridge on Windows and in the Linux package, where no Swift helper ships
    node/               # the Node-API binding: dispatch, cancel and routes, nothing else
```

Rules:

- Each crate has one owner and a `//!` header comment, which feeds the module map.
- Each crate registers its own dispatch routes with `inventory` or `linkme`. No central `match` exists that every crate appends to (see docs/shared-files.md).
- Crate dependencies follow the layers in [modularization.md](modularization.md). Cargo enforces them, because a crate can only use what it declares.

### Hosting: in-process first

The core is a native addon (`core/crates/node`, on Node-API directly) that Electron main and its workers load. It runs routes on its own threads (see [Calls, threads and handles](#calls-threads-and-handles)) and settles each call's promise on the JS thread that made it.

| | In-process addon (chosen) | Separate daemon |
| --- | --- | --- |
| Startup cost | dlopen plus init, about 2–10 ms (estimate) | Spawn plus handshake, about 10–30 ms; can overlap startup |
| Memory | The Rust heap replaces the JS heap it takes over | Adds a process (about 10–20 MB); main still holds its shims |
| Synchronous calls | Possible if a route ever needs one (today's sync IPC stays in JS, §4) | Only by blocking main on a socket |
| Keychain / safeStorage | Same code signature as the app | Its own signature: Keychain ACL prompts |
| macOS TCC grants | The app's grants | A launchd-started daemon is its own "responsible process" and loses the app's Desktop, Documents, microphone and screen grants |

The API is message-based from the start:

```
dispatch(route, payload: Buffer) -> Promise<Buffer>
dispatchCancellable(route, payload: Buffer) -> { id: number, reply: Promise<Buffer> }
cancel(id: number) -> boolean
dispatchSync(route, payload: Buffer) -> Buffer
subscribe(callback: (event: Buffer) => void)
routes() -> string[]
```

Because of this, moving the core out of process later is a change of transport, not a redesign. A daemon only pays off if MoPilot ever quits Electron while automations, MoMo and the scheduler keep running. That is a product decision, not part of this plan.

### Calls, threads and handles

**Threads.** `dispatch` runs a route on the core's own pool (`core/crates/dispatch/src/pool.rs`), never on libuv's, which `fs.promises` shares. The pool is plain threads, with no async runtime: no route awaits anything, and each only needs a thread to run on.

- It has four threads, as libuv's default pool has, so nothing runs less concurrently than it did. They start as work arrives and stay parked afterwards.
- Calls past the cap wait in order, in an unbounded queue. Long and short routes share it, so four long routes hold up a short one until a thread comes free. A later port that makes this matter splits the queue then.
- A reply comes back on the environment's ordered stream (§4). It settles the promise on the JS thread, and a running call holds the loop open, as `napi_async_work` did.
- `dispatchSync` does not use the pool: it blocks its JS thread, for the callers that must answer at once, such as ACP translation (§6 step 7).
- Node closes an addon when the environment that loaded it ends. The pool's threads park in its code, so it must stay loaded. On Windows the addon pins itself (`core/crates/node/src/pin.rs`). Linux and macOS keep it loaded anyway: `napi-build` links a glibc build `NODELETE` (`core/crates/node/build.rs`), musl never unloads, and macOS won't unload a library with thread-locals.

**Routes.** A `Route` is `fn(&[u8]) -> Reply`. A `CallRoute` also takes its `Call`, for a route that stops when cancelled or opens handles. Both are found the same way, by `inventory`.

**Cancellation.** `dispatchCancellable` returns the call's id, and `cancel(id)` asks that call to stop. Cancelling only asks; the reply says what happened:

| When `cancel` arrives | The call | `cancel` returns |
| --- | --- | --- |
| Waiting for a thread | Never runs; rejects with `CORE_CANCELLED` | `true` |
| Running, on a route that checks its token | The route stops at its next `call.cancel.check()?`; rejects with `CORE_CANCELLED` | `true` |
| Running, on a route that doesn't check, or one that finishes anyway | Keeps its reply: the work was done, and a rejection would hide it | `true` |
| After the route finished | Keeps its reply | `false` |

When a JS environment ends, its `CallRoute` calls are cancelled the same way. Plain routes are not: one can't be told to stop and may be one the app relies on, such as `proc.kill` during quit, so the environment's end waits for them.

A cancelled call rejects with an `Error` whose `code` is `CORE_CANCELLED`; no other failure has a code. A long route checks its token between steps, and clones it for threads of its own. Nothing interrupts a route that doesn't check, so a route that may run for long has to.

**Handles.** State a route keeps between calls is a `static Handles<T>` (`core/crates/dispatch/src/handles.rs`), used by `framing`, the `rank` listings, `rollout` and the `translate` translators and histories:

- `open` returns an id, `with(id, f)` uses it, and `close(id)` lets it go. Dropping the value is the cleanup. A family made with `Handles::big` (a read held for a window, a translator, a rollout, a listing) drops on the pool, since `close` may be on the JS thread and a chat's worth of small allocations costs that thread what parsing them would; one whose drop is a cleanup something waits on, as a transcript writer's is, stays on the caller's thread.
- Each family has an upper bound. An open past it is refused and nothing open is taken away, because a live handle that vanished would fail far from the cause.
- Uses of one handle run one at a time; different handles never wait on each other.
- `close` never waits for a use in progress. The value goes when that use ends, and no use starts after, so a synchronous close can't stall the JS thread on a long route.
- A use that panics leaves its handle broken, since its state can't be trusted. The next use closes it and says so.
- A handle belongs to the JS environment that opened it. When that environment ends, its handles close, so a terminated worker leaves nothing behind. A call cancelled that way can't open a handle afterwards.

`session.*` keeps its own stores for now: their ids come from JS, and the chat store lives as long as main.

### Staying reachable with no window

Mobile Remote (the phone app) makes the product decision above real: the Mac must stay reachable while no window is open. Decision: **a menu-bar background agent now, no daemon.** With the user's opt-in (`remote.enabled` plus the Settings switch) closing the last window leaves MoPilot running as a menu-bar item, with the remote runtime, turns, approval cards, scheduled tasks and MoMo routines alive; an optional login item starts it that way (`electron/app/alwaysOn.cjs`). The same Electron process keeps every Keychain and TCC grant in the table above, which a launchd daemon would lose.

What a daemon would add is surviving a quit or a crash of the whole app. That stays behind the `dispatch`/`subscribe` transport boundary: moving the core out of process is a change of transport (a launchd job speaking the same messages over a socket), not a redesign. It is revisited only if users need the Mac reachable after quitting MoPilot, with the grants and signing cost above accepted. No daemon code exists.

### Failure and crossing rules

- **Panics.** Every dispatch is wrapped in `catch_unwind`, on the pool as on the JS thread. A panic becomes an error reply, and a core bug never takes down the window.
- **No core, no fallback.** Every process needs the core, and no domain it owns has a JS copy. `coreCall`, `coreSyncCall` and `coreEvents` (`electron/platform/core.cjs`) throw without one, with `coreProblem`'s reason, and a failing route throws its error: neither is ever a null reply. A caller that degrades for a reason of its own (a process gone while it was read, a transcript deleted since it was listed) catches the error, notes it and says what it does instead; the peer checks refuse. `MOPILOT_CORE` points a checkout at another build, and no value turns the core off. `tests/coreNoFallback.invariant.test.ts` fails on a reply compared with null or undefined, or a check for a missing core.
- **What crosses the boundary.** Payloads cross as strings or Buffers. Building JS objects from serde values through napi is usually slower than V8's `JSON.parse` of the same bytes, so large data either stays in Rust or crosses once as bytes.
- **Backpressure.** A stream's reader (`electron/transport/jsonReader.cjs`) pauses it past 2 MB of lines waiting to be parsed and resumes it below 512 KB; a child's framed stdout then stops acknowledging, and the core's window holds the child (§4, Harness children).

## 4. Renderer ↔ core wiring

The renderer keeps one bridge: `window.native`, built from `electron/bridge/<ns>.cjs` by `electron/bridge/spec.cjs`. A namespace whose domain moved to the core declares `owner: 'core'`. Main then forwards its channels to `dispatch` without parsing them, and the TS types for it are generated from `core/crates/proto`. Today `tests/ipcRegistry.test.ts` requires each declared channel to be named in main's sources, and a generic forwarder names none. So the same PR that adds `owner: 'core'` extends the test: a core-owned namespace's channels are checked against the routes `proto` exports, and a channel with neither a main literal nor a core route still fails.

Three ordering contracts must survive:

1. **Replies follow their stream events.** `electron/main.cjs` wraps ipcMain with `orderedReplies` (`electron/harness/coreBatcher.cjs`; the queues are `core/crates/batcher`'s, §6 step 9), so a reply on a `codex:`, `claude:` or `acp:` channel reaches the window after the deltas it caused. So every call's reply reaches JS down the **same ordered stream** as the events a route emits (`core/crates/dispatch/src/stream.rs`, `core/crates/node/src/stream.rs`), one threadsafe function per environment. By the time `coreCall` resolves, every listener of `coreEvents` (`electron/platform/core.cjs`) has had the call's events; under `orderedReplies` the batcher then flushes them, and the window's answer goes last. A `dispatchSync` reply is the exception: it returns at once, ahead of anything still queued, and what such a call emits holds nothing open, so a process with nothing else to do may end before hearing it. A call's own events keep their order; events of calls running at once interleave. An environment with no call running doesn't hold its process open, and a listener that throws costs the others nothing. Sending never blocks, and the queue has no limit of its own: what emits at a harness's rate limits itself (`core/crates/proc/src/spawn.rs`, the one route family that does so far, charges each output against a window that JS's acknowledgements refill). One function, not one per call: Node before 24.14 frees a function as its environment ends, whatever thread count it holds, and only the stream's lock and finalizer can keep a core thread from calling a freed one. The `rust` job runs the binding's teardown tests on such a Node, which the app itself doesn't use: Electron 44.7 has Node 24.21, and a Host may run on 22.
2. **`session:patch` revisions stay monotonic**, per chat, across both stores until the session controller moves.
3. **Synchronous IPC stays in main JS:**
   - `flags:getSync` (`electron/preload.cjs:16`, served by `electron/platform/flags.cjs`), which runs before main is ready;
   - page dialogs that set `event.returnValue` (`electron/capabilities/browser/pageDialogs.cjs`).

### Harness children

Codex, its account sidecar and every ACP harness run as children of the core (Stage 4.1): `proc.spawn` starts them, and threads of the core own their stdio (`core/crates/proc/src/spawn.rs`). `electron/platform/coreChild.cjs` gives JS the same child in a ChildProcess's shape, so `spawnGroup`, `killTree`, `endGroup` and the JSON readers don't know the difference, and there is no other path: without the core a child fails as one that couldn't be spawned, with the core's problem as its error. Output reaches JS on the ordered stream: stderr as bytes, and stdout, for a spawn that asks for `lines` (every harness does), as the complete lines each read ended, framed on the reader thread by `core/crates/framing` (Stage 4.2), so JS only parses them (`electron/transport/jsonReader.cjs`). A stream the core doesn't own (a socket, a child Node started) is framed through the `framing.*` routes on the JS thread instead. No harness or tool stream is framed in JS, and `tests/rustOnly.invariant.test.ts` keeps it so; the Host's own control socket (`host/src/server.mjs`) and the Host wire's codec (`shared/host/frames.mjs`, binary frames among the lines) still frame in JS, for their own port.

- **What a child sees is what Node gave it**: spawnArgs' command, arguments and options; its whole environment, nothing inherited; on POSIX socket pairs for stdio with libuv's 64 KiB buffers, a session of its own, every signal at its default and an empty signal mask; on Windows anonymous pipes and a Job Object from the spawn on, which ends the child and all it started when this process goes, as libuv's job does for a child Node started, though libuv's lets a child's own children leave (`core/crates/proc/src/windows.rs` `hold`). `proc.contain`, for children Node started, sets no such limit.
- **How it starts follows libuv on each platform.** On macOS, `posix_spawn` (`spawn/macos.rs`): a fork of a process with many MAP_JIT pages degrades badly, libuv's source says, and names Electron. The kernel closes every other descriptor (`POSIX_SPAWN_CLOEXEC_DEFAULT`), the search of the child's PATH is libuv's, and a spawn holds main about 0.2 ms at any size of process, as Node's does. On Linux, `Command` with `pre_exec` (`spawn/forked.rs`), with signals blocked across the fork. There, the descriptors above stdio are marked close-on-exec from a listing taken just before the fork: one another thread opens in those microseconds, without close-on-exec, still reaches the child. libuv does no sweep on Linux at all.
- **Exit** comes behind the last byte of stdout and stderr, except that it stops waiting after 100 ms with no byte read, and after 1 s whatever is read: a process that outlived the child and holds the pipe is ended only once JS hears of the exit, however much it keeps writing, and a JS reader that stopped taking bytes must not hold it either. `JsonReader.finishInput` seals on stdout's end, which still comes last. The core says the child has exited before it reaps it (`WNOWAIT`), so no signal can reach a pid that was handed on.
- **Backpressure**: an output has a 1 MiB window, refilled as JS takes bytes. A framed stdout's line still arriving counts against the window too, so nothing listening still costs a window; once that line fills it the core asks (an ask has a number), and JS, if it reads the stream, says it wants that ask's line (`proc.want`), which then comes whole however much longer than the window it is; a want of an earlier ask is none. A stdout JS destroyed tells the core (`proc.drop`), which then reads and drops what comes and keeps no line. A line is at most the spawn's limit, by default the longest string JS can hold, which is what reading one ever allowed (the JSON input worker before Stage 4.2 held a line as it grew until it failed there). Its stream holds one read before it stops acknowledging, since one read can be a whole record. A full one stops the core's reader, so the child blocks in its write, as under a paused Node stream, and output nobody reads costs a window. Stdin is queued off main; past 1 MiB queued a write stays in JS's stream, as on a full socket, until 256 KiB remain. Destroying stdin ends the child's read at once, with what is queued dropped, and fails a write held back. Destroying an output doesn't close it: what comes is taken and dropped, so the child goes on and nothing stalls, where a Node child's next write would fail.
- **Lifetime**: four threads per child, gone with it. The handle goes once the exit is told and both outputs ended. A child whose JS environment ends keeps running with its stdin closed, and is reaped when it ends; a process that outlives the child and keeps its stdout keeps one thread and that pipe.

## 5. What stays where

### Electron main (permanently)

- Windows and webContents, menus, tray, global shortcuts, powerMonitor, systemPreferences, dialogs, downloads and sessions.
- The built-in browser (`electron/capabilities/browser`, about 30k lines). It is built on `WebContentsView`, `webContents.debugger` (CDP) and page-agent injection.
- `utilityProcess` children, including Playwright MCP. `ELECTRON_RUN_AS_NODE` is fused off, so these must stay utility processes.
- `node-pty` terminals.
- The updater.

### Secrets

Secrets stay behind a JS `SecretsPort` built on Electron `safeStorage` (`electron/platform/secretFile.cjs`, `electron/platform/encryptedStore.cjs`):

- When the core needs a secret, or the data key of a sealed file (`electron/platform/sealedFile.cjs`, `MPS1`), main decrypts it and hands it over.
- `readSecret`'s rule is kept: it throws when a secret can't be decrypted rather than returning null, so no caller overwrites a secret it couldn't read.
- The core never reimplements Chromium's OSCrypt (on macOS a Keychain item with PBKDF2 and AES-CBC "v10"; on Windows a DPAPI-wrapped key).

### Claude Code

The Claude adapter stays on `@anthropic-ai/claude-agent-sdk`. Its control surface is private and wide:

- about 20 `Query` methods (`setPermissionMode`, `rewindFiles`, `selectChromeBrowser`, background tasks, …);
- `canUseTool`, `onElicitation`, PreToolUse hooks;
- in-process SDK MCP servers (`electron/capabilities/mcp/sdkMcp.cjs`).

Reimplementing all of that in Rust would mean following every SDK release. An optional later step moves the SDK into a `utilityProcess`, so its heap leaves main. Every harness still gets the same user-facing outcome. The Codex and ACP pieces that move to Rust sit behind the same session contract the Claude adapter uses.

### `shared/*.mjs`

About 90 shared modules are imported by both main and the renderer. Each one gets exactly one owner:

- **UI-pure logic** (formatting, keys, text helpers) stays JS.
- **Wire and translation logic** moves to Rust as one piece, since the renderer receives finished thread items and only main translates: ACP's and Claude Code's have (`core/crates/translate`; `tests/windowNoTranslator.invariant.test.ts` holds the window to it). Item helpers other code also uses stay in JS in `shared/acpItems/` and `shared/claudeItems/`; the ones translation calls then exist on both sides, and both answer one fixture (`tests/fixtures/core/translate/helpers/`, read by the crate's `parity` and by `tests/translateHelpers.parity.test.ts`), so a change to one alone fails.
- **During a migration**, a parity test runs both implementations over the same JSON fixtures (`tests/fixtures/core/<domain>/`). Both suites read the same files.

## 6. Port order

Each step is one or more PRs. Each is gated on its metric moving and is stopped or reverted if it doesn't.

1. **`proc`: process table and tree. This is the first slice.**
   - Implementation: libproc on macOS, Toolhelp32 plus Job Objects on Windows, `/proc` on Linux.
   - It replaces the `ps -A` polling in `electron/platform/processTree.cjs` and the `sysctl` spawns in `electron/platform/memoryPressure.cjs` with native calls, and gives Windows a real tree kill.
   - Metrics: child processes spawned per idle minute, wakeups, and CPU while a harness runs.
   - It is small, it is easy to measure, and it proves the whole pipeline: four targets, signing, Linux unit shards, macOS-only coverage, event callbacks into JS, and `.rs` in related-tests.
2. **`store`: startup-path reads,** only if Phase 0 shows them on the critical path. The formats stay byte-compatible:
   - `threads/<id>.v2` and `items.jsonl`;
   - `projects.json` and `ui-state.json`;
   - the ledger JSONL and `MPS1` sealed files.

   So do `writeAtomic` with 0600 permissions (a chat record's commit, `store.writeRecord`, keeps them step for step) and the cross-process lock semantics. An older build must still read what a newer one writes, because the app supports downgrade ([the downgrade test](../../tests/downgrade.md)).
3. **`framing` plus process supervision for Codex and ACP.** NDJSON JSON-RPC framing, the `framing` backpressure and process-group lifetime move to Rust. The adapters (`electron/harness/codex*.cjs`, `electron/harness/acp/*`) stay JS at first.
4. **`session`: the chat controller** (`electron/session/controller.cjs`, `state.cjs`). This happens only after harness translation lives in one place, either main or core, not the renderer. The first part has moved: `core/crates/session` decides every patch of a chat's session state (`state.cjs` keeps the mirror its readers use), with the turn's rules, the approvals that make a running turn wait on the user and run again among them, the queue's drain: whether the next message goes, asked of main's holds (a folder change, a voice conversation, a compaction) only when the session allows it, a turn's own steps (`session.step`: it starts, ends, or its harness quits), which every send, harness event and crash path now takes, the queue's order when a message goes back (`session.putBack`: behind the ones put back first in line before it, or ahead of all), and how "Send now" admits and routes a queued message (`session.sendNow`: refused, started, steered, or first in the queue). The controller's decisions about a chat's turn and queue are the core's; what it does with them, calling the harness adapters, stays in JS, as §5 keeps the adapters. The harness adapters and the controller's orchestration stay in JS behind that store.
5. **`caps-socket`:**
   - the sage-mcp socket server (`electron/capabilities/mcp/socket.cjs`, `electron/platform/privateSocket.cjs`), with its token and peer checks;
   - the Swift helper client;
   - the `computerAccess` crypto (X25519, encrypted frames).
6. **`rollout`: a Codex thread's history from disk (Stage 2.4).** `core/crates/rollout` reads the rollout, plain or compressed, on a core thread and holds its turns behind a handle, so paging parses nothing again and the JS heap has only the page it asked for. There is one parser and no JS fallback: `shared/codexRollout.mjs` is gone, and a failed read rejects. `electron/harness/codexRollout.cjs` keeps finding the file, the CODEX_HOME rules (failing closed), `missing`, the 60-second keep and the cursor. It closes a handle only once no read is paging it.
   - What is held is each item's JSON, written as it completes, not a tree of values: a page is bytes joined up, and JS parses only that page.
   - The crate has its own JSON reader (`json.rs`), because `serde_json` refuses a lone surrogate and a number past a double's range, both of which `JSON.parse` took, and because the JS's output depended on its key order and spelling of numbers. Strings are WTF-8 (`value.rs`).
   - A shape the JS threw on still fails the whole read, as it did; only a line that doesn't parse is skipped. The parity fixtures, `tests/fixtures/core/rollout/`, were made by the JS parser, and the Rust test compares its output byte for byte.
   - Zstd is `ruzstd`, pure Rust, so no build needs a C toolchain. `src/zstd.rs` adds what Node's decoder did and ruzstd doesn't: the checksum, the content size, the reserved bit, the magic number of a file too short to hold one, its window limit, reading only the first frame, and a frame cut short ending where the file does. File URLs are `src/file_url.rs`, by the WHATWG steps: the `url` crate departs from them on `file:////a` and `file:///C|/`, and brings about 30 crates of Unicode tables.
   - Left different on purpose: `readline` also split lines at U+2028 and U+2029, which Codex writes raw in a JSON string, and so lost that line's event, so here they are ordinary characters. A kind named after a member of every JS object (`constructor`) is left out where the JS found that member and made nonsense or threw. A line nested past 1000 levels is a bad line, since the JS's limit was its stack's. An ill-formed international host in a file URL is taken as valid, as checking it needs Unicode's tables. A cut frame ending in a raw block loses that block, which libzstd streamed. Two decoders notice different corruption, so a damaged body in a frame with no checksum can read or fail where libzstd did the opposite. Node went on to a second frame when the first ended exactly on its 16K output or 64K read boundary, an accident of its buffers; this always stops at the first.
   - Measured on a 200 MB generated rollout, this Mac, one process per run, median of three, JS then Rust. Every line an event, as a long chat's items are: 950 → 620 ms to read, 320 → 6 MB of JS heap held, 441 → 271 MB of RSS. Mostly the model's own records, which neither parses: 490 → 135 ms, 54 → 4 MB, 183 → 92 MB. A page of 50 turns costs about 2 ms, where a slice cost nothing. A read with no limit still puts every turn on the JS heap for its caller.

7. **`translate`: ACP translation and history (Stages 3.3 and 3.4).** `core/crates/translate` is the one implementation: `electron/harness/items/acpTranslator.cjs` holds a translator's id and mirrors its turn. `shared/acpTranslate.mjs`, which kept only a re-export of `permissionChoices`, went with the Claude Code stage below.
   - **One stateful handle per native session.** It goes with the session (`closed`, or a new owner) and with its owner's environment; a paired phone's goes when its session closes or its chat is deleted, and an archived chat keeps one, since a turn it runs goes on to its end. A chat closed for good says nothing to `AcpItems`, so past 256 sessions the oldest idle translator goes too. A translator is opened by its first event.
   - **An event is synchronous** (`dispatchSync`, `translate.event`). `acpSender` hands a window a translated event's items before the `acp:event` they came from, the event's reply carries what it said, and JS sends those in order before returning, so nothing the batcher's `flushNamed` or `orderedReplies` promise moves. The route reads no disk and waits on nothing: a translator's lock is only ever held by these calls, on the JS thread that makes them.
   - **An event can fail without the session.** What the JS threw on, for an input the language couldn't read, is a `thrown` in the reply beside whatever the event said first; that is noted and the session goes on. A panic is the same: the guard is inside the handle's use, so it never breaks the handle. Past what the JS did, a turn always ends: a call or a stop reason that can't be read is left out, where the JS threw out of `endTurn`, left the chat's turn running for good and threw again at every later end; a prompt that can't be read still starts its turn; and a transcript's record that can't be replayed is left out and counted, where it failed the chat's whole read.
   - **A chat's history is read off the JS thread and settled on it.** The window asks `acp:turns` for a page with `limit`/`before`, as for Claude and Codex, and replaces its turns with it, so the page has to be the session as of now however long the read took. `AcpItems.history` starts hearing the session before anything is read, and has main write what is queued. `translate.read` reads the file and replays it on a core thread, with main's audio records passed in. `translate.settle` then runs on the JS thread, in one step: it lays what the session said since over what was read, decides what is still running, puts in the open message's text from the live translator, and gives the page. What it was told says each item whole, so one the file also held changes nothing, and it heard the stream batcher's queue too (`flush`), which it sends on first. Keeping the fold here is what keeps this from being quadratic: a sub-agent's every update says its whole transcript so far. Each item's JSON is written on the core thread and kept, so a page is a copy, and it reaches the window as bytes, parsed there. Saved diffs are looked up in main for that page's turn ids, in that same step, and go beside the bytes for the window to lay on, not through the core: a chat's diffs have no size limit, and only a page's are wanted. The read is held 60 seconds for older pages, for at most 8 sessions. Past 8 MB a page stops early, at a whole turn. A cursor is how many turns come before its page, so it always goes back, and turns being added after keeps it good across reads, but for a turn id said twice, whose empty second turn a read that heard it lacks: a cursor used past its read can be one off there. A composite chat's commit is the one reader that replaces turns from more than one page: `readAllAcpTurns` takes the active segment's newest page again after the older ones, lays it over them by that cursor and commits in the tick of its reply, so nothing the stream did since page one is lost.
   - **Main's own readers** (a chat switch, a peer's history) take the same read: `readChatTurns` has `translate.read` replay the file on a core thread, so its records never reach main's heap, and `translate.turns` gives every turn a slice of at most 4 MB at a time, each parsed in a tick of its own. A slice ends at an item, so one item is the bound: about 1 ms a megabyte. When the transcript's own `session` record is to name the folder (`find`), the core takes it from the file before it replays. Measured on 50 MB transcripts, this Mac, longest hold of a read: 23–49 ms before, 3.6–5 ms after, 7 ms the worst of 25 reads, and it no longer grows with the chat. So every production read of a transcript leaves out and counts a record that can't be replayed, and a chat a window can read hands over the same; `translate.replay`, which fails whole as the JS did, is left to the parity fixtures and the benchmark, through `buildAcpTurns`.
   - **A turn followed from a transcript** (`partway`) is a remote chat's mirror found with a turn still running: not the turn but the whole transcript behind it, and session logs here reach 120 MB (Claude) and 470 MB (Codex). It goes the same way: main writes what is queued and passes the file, `translate.read` replays it on a core thread up to where it ended then, since what the machine says next comes as events, and `translate.keep` hands the read's translator over in one step. Until then `AcpItems.following` holds that session's events and any window's read of it, and `acpSender` sends them on in order after it; other sessions' go on. Longest hold at 50 MB: 288 ms when this was `dispatchSync`, 0.1 ms now, 2.5 ms the worst of five.
   - **A turn id said twice** folds into the turn that first had it, which goes back to running, as the JS did. A replay of a transcript also leaves an empty second turn after it, and a read that heard the second start from the session has none until the next read. Ids are `at-<clientId>` and a client id can be stable (a peer message's, an authored item's), so this isn't ruled out.
   - **Open text under an empty turn id** is lost to a read that races its session: such a turn isn't running, so its message isn't closed and what the file lacks isn't filled in. Main never mints one.
   - **`auto-` turn ids** come from a seed and a count: `auto-<seed>-<n>`. A live translator's seed is a UUID; a read's is the session's key, so a turn with no prompt reads under one id every time. The time comes with each event. Neither is read in Rust, so the fixtures are exact.
   - **Parity:** `tests/fixtures/core/translate/` was made by the JS: `scenarios/` (115 sessions and transcripts the app's tests fed it), `edges/` (each trap, by hand) and `fuzz/`, each a folder of parts under the linter's 1 MiB. The JS was first changed as above for a turn's end and a prompt that can't be read.
   - Left different on purpose, with what reaches each. A `__proto__` key with an object value in a tool update changed the object's prototype in JS, so its fields read through; it is an unknown key here, ignored. A number past a double's range and `-0` reach Rust as `JSON.stringify` writes them, null and 0, as every transcript read always had them, so a live title of `1e999` now reads as a transcript's did, 'Tool'. An update nested past 1000 levels is refused whole with a note, and the turn goes on; a transcript's line is left out and counted, since JS's limit was its stack's and a release build needs under 512 KB of stack there. An object or an array as a turn id, which only main mints, is told apart by its spelling and not its identity. A kept translator says nothing until `continueLive`, where the JS's went on folding into turns it had returned, which only a test read. A burst with no prompt running during a read shows under its live `auto-` turn and the read's own for that read, as the two have different ids. A file that cannot be read rejects `acp:turns`, where it read as empty, and a line still unwritten because the disk is failing is not in the read. An older page's cursor that is there twice means its last, where `turnPage`'s means its first and loses turns.
   - Measured on this Mac, Node 24, plain process. Per event on a realistic stream (2,186 events: reply chunks and tool updates), JS then through the binding: mean 0.2 → 5.8 µs, p95 0.5 → 20 µs, p99 0.8 → 28 µs, max ~60 µs; with a sub-agent re-sending its transcript, 1.2 → 61 µs, p95 4 → 204 µs, max ~500 µs, about what its IPC clone already costs. At S3's rate of four chats on a 60 Hz tick that is about 1.4 ms of main a second, against a 20 ms p95. A read with a session emitting throughout (100 tool calls), against replaying blocking as the first version of this did: at 10 MB 49–69 → 0.2 ms held on main, at 50 MB 240–342 → 0.3 ms, and the reply's IPC copy 4–33 → under 0.1 ms; a page of 30 turns is 0.15–0.41 MB. The worst case is one running turn that is the whole transcript: 2 ms at 10 MB and 9 ms at 50 MB, about 0.18 ms a MB, so that step passes 20 ms at about 110 MB of one turn: a turn is the unit a page cuts. A read's own time is 31–253 ms, where the JS's replay took 1–16 ms; none of it is on main.

8. **`translate`: Claude Code translation and history (Stages 3.5 and 3.6).** `core/crates/translate/src/claude/` is the one implementation of the translator, the replay of a transcript into turns and a sub-agent's stored transcript, and no JS copy is left: `shared/claudeTranslate*`, `shared/acpTranslate.mjs`, `shared/replayIndex.mjs` and the translating part of `shared/claudeItems/` are gone. `electron/harness/items/claudeTranslator.cjs` holds a translator's id, mirrors its turn and whether it was interrupted, and hands on what it says. `electron/platform/claudeHistory.cjs` is the read side, below the harness because the turns worker that opens a read lives in `platform`. Claude Code stays on its SDK, `getSessionMessages` included (§5), so its messages reach Rust as `JSON.stringify` of the SDK's objects. What JS and Rust both still read lives on both sides, held to one answer by `claude-helpers`: how a `result` ended, goals, findings and token usage, for the controller, the adapter and the window. `ClaudeFailures` moved whole; what stays in `shared/claudeItems/` is what no translator owns: `isSyntheticAssistant`, `tokenUsage` and `LIVE_WINDOW_MS`.
   - **One stateful handle per native session, as ACP's.** `ClaudeItems` closes it on `closed` and on a new owner, and past 256 sessions the oldest idle one goes. A phone's feed closes it on `closed`, on the chat's deletion (`phones.forget`, through `chatDeletion`) and, at the next live event, once remote control has gone off, since then no session's end reaches it. A translator's and a read's value drop on the pool (`Handles::big`): a long chat's history takes tens of milliseconds to drop.
   - **An event is synchronous** (`dispatchSync`, `translate.claudeEvent`), for the reasons ACP's is. A message goes as a line of its own after the event's fields and is parsed apart from them, so that no envelope takes from the 1000 levels a message may have and a message reads live as it reads from its file. Its reply is a line of JSON, which main parses, and after it the transcript of any sub-agent the message moved, which main does not: `agent/items` is that sub-agent's whole transcript for each of its messages, as it always was, so a transcript of screenshots would otherwise be parsed on main per message. It goes to the window as bytes and is parsed there. A translator that shows no such transcript (a phone's feed, a read) opens with `children: false` and doesn't write it. What JS threw on is a `thrown` in the reply, noted, with what the message said first still going out; a panic is the same.
   - **A read goes off main and stays there.** The turns worker (`claudeTurnsWorkerMain.cjs`) loads the addon too: it runs `getSessionMessages` and the merges in `claudeTranscriptRead.cjs` as it did, then writes the messages out as lines and has the core replay them (`translate.claudeRead`), on a core thread, and answers with the read's id. The read keeps each item's JSON and drops its translator, the items themselves and their places, so that the 200 MB the cache allows counts one copy. `translate.claudeSettle` cuts a page on a core thread too, where the JS's page crossed from the worker by structured clone and went on to the window by another: main has only the reply's copy to make, and the window parses the bytes. A thread that can't load the addon says so, and the read goes on in main, as for a worker that is gone. The reads kept (`createReadCache`) are the same eight sessions and 200 MB, by file size, of what the core holds, which is about the file's size again for the items' JSON; each that leaves is released. A read can go before its page is cut (it left the cache, or the worker holding it died), so a failed cut reads again outside the cache, up to twice, and the last failure says the chat could not be read.
   - **What a page asks is decided at the page, not the read:** whether the last turn stays open (`open`, or a live tail with `lastAt`), `closedTail`, and the live turn's id. A read's translator ends the turn it was left in once, into a copy of that turn, so one read answers every way of asking. Saved diffs are looked up in main for the page's turn ids and go beside the bytes, as ACP's.
   - **Main's own readers** (a harness switch, a peer's history, and in the worker the prose reader) take `allTurns`, which walks the read by place, a few hundred kilobytes a step, each parsed in its own tick, cutting even a single long turn between items. A walk's read is its own and never in the cache: another reader of the chat would push it out part way, which the old cache of messages could not do to a page being built. It used to parse the SDK's messages and replay them on main.
   - **A sub-agent's stored transcript** was the last thing a window translated: main now reads it and has the core fold it on a core thread (`translate.claudeAgentItems`), and `claude:subagentItems` replaces `claude:subagentMessages`, with the bytes parsed in the window, its model read in Rust, and what couldn't be read counted.
   - **The race.** A window merges a page with its live turns (`mergeClaudeTurns`, `withEarlyItems`), so a session emitting during a read changes nothing here: the read has its own translator and shares no lock with the session's. The window still reads a whole chat with one `claude:turns` call and commits once, so nothing it streamed in between is overwritten by an older answer.
   - **A cursor always goes back.** It is a turn's id, as the window has always had it, unless that id repeats: then it says which of them, as `<id>\0<n>`. `before` reads the id's first turn, as `turnPage` did, so a window's old cursors hold.
   - **`auto-` turn ids and what stood for `crypto.randomUUID()`** come from a seed and one count, `<seed>-<n>`: a live translator's seed is a UUID and a read's is the session's id, so a turn with nothing to name it reads under one id every time. The time comes with each event. Neither is read in Rust, so the fixtures are exact.
   - **Parity:** folders of parts in `tests/fixtures/core/translate/`, made by the JS before it went: `claude-scenarios` (125 live sessions, 209 transcripts and 11 sub-agent transcripts the app's tests fed it), `claude-edges` (each trap, by hand), `claude-fuzz` and `claude-helpers`. A differential, deleted with the JS, ran both over 7.4M operations of recorded and fuzzed streams, 200 of this Mac's real transcripts (359 MB, 124,756 messages, three ways of asking each) and 370,742 live events made from them, with no difference but those below; the regular expressions are hand ported in `patterns.rs`, since the `regex` crate has neither `\k` nor JS's `\s`, and the fuzz is built from what each of them looks for. The tests that called a helper now gone moved to the crate (`parse_cases.rs`) or go through the core (`tests/support/claude-translate.ts`).
   - Left different on purpose, with what reaches each.
     - `Date.parse` is ECMAScript's own format, in all its forms; V8's legacy guessing at anything else (`2026-01-01 00:00:00Z`, `Jan 1 2026`, a number) and a date-time with no zone (local time in JS, which nothing here knows) read as no time, so a live message takes the clock and a read's turn no stamp. Claude Code writes `toISOString()`.
     - An object or an array as an id is told apart by its spelling, not its identity. The CLI writes strings.
     - A status named after a member of every object (`constructor`, `__proto__`) in a task list reads as no status, where JS put a function or a prototype in the item, which no window could be sent.
     - A message nested past 1000 levels is refused whole: a note live, and the turn goes on; a transcript's line is left out and counted, since JS's limit was its stack's.
     - A transcript line that can't be replayed is left out and counted, where it failed the chat's whole read; what it said before failing stays. An item for a turn that never began is the same.
     - A cursor at a repeated id goes on back, where `turnPage` lost the turns before it.
     - A page stops early past 8 MB, at a whole turn, as ACP's does; `olderCursor` goes on from there.
     - A number past a double's range and `-0` reach Rust as `JSON.stringify` writes them, null and 0.
   - Measured on this Mac, Node 24, plain process.
     - **Live, per event**, 61,921 events sized by a real 114 MB transcript with its text streamed in 48-character ticks, JS then through the binding: mean 0.3 → 6.9 µs, p95 1.0 → 20 µs, p99 1.7 → 42 µs, max 104 → 394 µs. `JSON.stringify` alone is 1.2 µs mean, 3.9 µs p95. A delta: 0.1 → 3.0 µs, p95 3.5 µs. An assistant message: 0.5 → 12.8 µs, p95 22.5 µs. A user message: 1.1 → 21 µs, p95 47 µs. **Per flush** at S3's four chats on a 60 Hz tick: mean 1.1 → 27.6 µs, p95 2.7 → 63 µs, max 105 → 418 µs, about 1.7 ms of main a second, against a 20 ms flush budget and S3/S7's 10 ms p95.
     - **Heavy events**: a sub-agent at 400 messages (each says its whole transcript) 0.5 ms, p95 0.57 ms; a 1 MB tool result 1.9 ms; 5 MB 10.5 ms, 12 ms at worst, once. JS's own cost for those is on the IPC clone, which goes on.
     - **Main held by a read**, with a session emitting at 250 events a second throughout, the longest step, three runs, JS then Rust. Generated transcript of many turns, first page of 30: 10 MB 0.8–1.0 → 0.5–0.6 ms, 50 MB 0.7–0.8 → 0.6–0.8 ms. Every turn: 10 MB 3.8–4.1 → 0.8–2.1 ms, 50 MB 20–24 → 12–14 ms. One running turn the size of the file: 50 MB 16–18 → 8–14 ms either way. A harness switch's read, which JS ran on main: 10 MB 8–11 → 0.3–1.3 ms, 50 MB 45–51 → 2.4–5.2 ms; one running turn, 45–50 → 0.8–3.6 ms. A read's own time, off main, is 70–400 ms, where JS's was 30–200 ms: JS held the objects and Rust is handed text.

9. **`batcher`: main's stream batcher (Stage 4.3).** `core/crates/batcher` keeps each chat's queue, both lanes, the keys, the joins, the sizes, which events wait, and what each tick and push decides (docs/performance/design.md D3), for every family: Codex, Claude Code, ACP and the remote item feed. `electron/harness/coreBatcher.cjs` keeps what is JS's: each family's chat (the controller's map), the windows' lookups (`hasBackground`, `watched`, `hostOf`, `resolve`), the timers, the sends, and the request plumbing (`ordered`, `orderedReplies`, `namedChats`). `electron/harness/streamBatcher.cjs`, `streamContracts.cjs` and `shared/acpItems/agentItems.mjs` are gone, with no fallback (`tests/rustOnly.invariant.test.ts`); the key's `parentOf` is the translator's own (`translate::parent_of`).
   - **Every route is synchronous** (`dispatchSync`), so a flush still sends before the call that asked for it returns: a broadcast, a reply under `orderedReplies` and `acpSender`'s `flush` keep their order. No route waits on JS, and the handle's lock is held only while the queues change: the event is parsed before, and what a flush sends is written after.
   - **What crosses.** Each family's gates come from the core once (`batcher.families`), and JS reads them as `e?.a?.b` would: an event no delta gate admits is no delta, so it is never serialized, and only small events pass one (a Codex text-delta notification, a Claude `content_block_delta`, an ACP message or thought chunk, a feed `items.delta`). One a wait gate admits (an ACP tool update) crosses with no JSON at all. The events stay JS objects in JS, held by the number they were pushed with until their entry flushes or the chat is dropped, so a window gets the adapter's own object back; only a joined delta comes back as JSON, inside the reply, and is parsed with it.
   - **The timers stay in JS.** A tick's end is a JS `setTimeout` that calls `batcher.tick` (or `batcher.backgroundTick`), and the core answers which ticks to start. A core timer would fire on a core thread, so its flush would have to reach JS down the ordered stream and run there anyway, behind whatever was queued; and the tick's length is read at each start from whether a window is on screen, which only JS knows, and tests and the remote feed set their own timers. The core re-arms a tick that sent something before JS sends it, so a delta an adapter emits during those sends waits for the next tick rather than leading out ahead of the rest of that tick's sends, which the JS batcher let happen.
   - **Failure.** An event whose chat or gate can't be read, or whose JSON is nothing, is noted, every chat flushes and it goes out alone, as before; so is one whose key the JS's `keyOf` threw on (`String()` of an object whose own `toString` is no function). A send that throws costs only its own entry. A core call that fails (a core bug: nothing given to it can fail it) is noted, the event goes out at once, and the batcher starts over in a new handle: what the old one held is lost, though what a reply had already handed out, before a send called back in and failed, still goes out. A new handle the core refuses (too many open, an environment going) leaves events going out unbatched, each push trying to open one again. A chat id that `String()` throws on is an event whose chat can't be read. A handle goes with its JS environment; main's two batchers live as long as main.
   - Left different on purpose: a key is read from the event's JSON, so a part `JSON.stringify` changes reads as it wrote it (a NaN index is null, so `??` goes on to the next index, where JS keyed it `NaN`; an object account or login is `String()` of its JSON, `[object Object]` as in JS, but an object whose `toString` was a function, which JSON leaves out, is `[object Object]` here where JS keyed it by what that function returned), and an event with a BigInt or a cycle anywhere, which JS only failed to read where its key was, goes out alone. A joined delta reaches windows as `JSON.parse` of its JSON, without its `undefined` fields. A feed delta whose `text` is no string goes out alone, where JS would have thrown out of its `push`. Chat ids are strings in the core (`String(chat)`).
   - Measured with `scripts/perf-bench/batcher.mjs` (plain Node 24, Apple silicon, on a simulated clock, the median of five runs alternating the old tree and this one), JS then the core. Per delta at S3 (four chats at 120 a second): Codex mean 0.35 → 2.3 µs, p95 0.42 → 2.5 µs, p99 0.54 → 3.7 µs; Claude Code 0.32 → 2.6 µs, p95 0.46 → 2.7 µs; ACP 0.27 → 1.9 µs, p95 0.29 → 2.0 µs; the worst push 13–69 → 42–49 µs. A tick's flush: mean 0.3–0.5 → 4.3–5.9 µs, p95 0.3–0.7 → 4.6–6.5 µs, the worst 1.3–32 → 10–16 µs. In all, main spends 0.14–0.20 → 1.2–1.6 ms a second on S3, against a 20 ms p95 budget. A burst of 20,000 deltas of one chat: 0.2–0.3 → 1.9–2.5 µs a delta, and the bound's flush of its 256 Ki units 1.4–2.6 → 70–74 µs. A request's flush of the chat it names, with four pending: 0.06–0.21 → 2.1–2.6 µs, and an event that passes unbatched (flushing its chat first) 0.09–0.20 → 2.1–2.4 µs. Each step costs a crossing (about 1 µs) and, for a delta, its `JSON.stringify` and the core's parse; no target moves: it is the port the user chose to finish regardless (2026-11-05). One large delta is the exception: a Codex command-output delta of 1 MB, pushed while a tick runs, holds main 0.01 → 2.5 ms (past the bound, it goes out at once), and 5.5 ms when it joins a pending delta of its key; one of 8 MB 25 ms, and 50 ms joined, since it is stringified, parsed in the core and, joined, written back and parsed again, where JS only concatenated (measured with the machine under other load, five runs). S3's streaming is not touched, but such a delta is a long task on main.
   - **Since Stage 4.4** a joined delta's JSON comes after the reply's list, as bytes (each entry gives its length), and JS keeps it as text for the windows' stream batch (step 10) beside the object it parses for the senders, as it keeps a delta's own JSON from its push.

10. **Delivery as bytes (Stage 4.4).** A flush that sends a window more than one event sends one `stream:batch` of JSON bytes (`electron/app/streamBatch.cjs`), and the preload parses it (`electron/bridge/spec.cjs` `streamItems`) and hands each event to its channel's listeners at once, before anything sent after the batch is handled: a `session:patch`, which `broadcastAll` sends only once the batcher has flushed its chat, still comes after the chat's text (`tests/windowsStreamBatch.test.ts`, `tests/streamBatch.test.ts`). What goes in as text is what main already has as text, unparsed and never stringified again: a delta's JSON, made when it crossed to the core, and a joined delta's, as the core wrote it (`electron/harness/eventJson.cjs` keeps each by its event; an adapter's event is new each time, so the text is the event's). A Codex event's `mine`, which differs per window, is written into that text, as `{ ...event, mine }` had it. Every other event of the batch (an ACP tool update, a translator's items, an event with bytes in it such as `agent/items`) goes by structured clone beside the bytes, in the same message: one `JSON.stringify` of an event main holds only as an object costs more than its clone, so none is made. A flush of one event sends it as it always did. The bytes are an array of their own, of the batch's size (`TextEncoder`): a small `Buffer` is a view into a pool other writes share, which a serializer copying the whole store would send with them. An extra JSON cannot write as the spread has it (`mine: undefined`, a BigInt) sends that event by clone; the preload takes a view from any realm (`ArrayBuffer.isView`); and a core from before this stage, whose replies have no line after their list, fails the batcher where it is made, once, naming the mismatch.
   - **What a window gets of a delta in a batch** is `JSON.parse` of its JSON, as a joined delta always was since Stage 4.3: a key whose value is undefined is left out, a Date is its string, -0 is 0, and NaN and the infinities are null (`tests/windowsStreamBatch.test.ts`). A delta sent alone is cloned and keeps them. The text is the event's as it was when it crossed to the core, so a change to it after that would not be sent: no adapter changes an event it emitted, and every unit test checks that the kept text is still the event's when a batch reads it (`tests/support/kept-json-check.ts`, installed by `tests/support/register.ts`).
   - Measured on this Mac, Node 24, plain process, the median of five runs; a message is timed as Electron's IPC writes it, `v8.serialize` in main and `v8.deserialize` in the window (`scripts/perf-bench/delivery.mjs`), event objects then bytes. A frame tick at S3 (four chats' joined deltas and a tool update): main 2.3 → 2.9 µs, the window 2.7 → 2.8 µs; a background tick: main 2.0 → 2.2 µs, the window 1.9 → 2.3 µs. A flush with a 256 Ki-unit delta: main 14 → 86 µs, the window 21 → 106 µs, since V8 clones a long one-byte string as a copy, and bytes are encoded to UTF-8 and parsed. So delivery as bytes gains nothing at the sizes a tick has and costs under 0.1 ms on each side at the bound (figures with the bytes in an array of their own, after the review), which a runaway stream reaches at most once per 256 Ki units. What one serialization costs by `JSON.stringify` against the clone: a Claude Code tool call 0.8 against 1.0 µs, a 100 KB tool result 32 against 2.8 µs, a 1 MB command output 1.6 ms against 14 µs, a 50 KB ACP diff 16 against 2.0 µs. The batcher with the text kept (`scripts/perf-bench/batcher.mjs`, Stage 4.3 then 4.4, alternating): per delta 3.2–3.7 → 3.2–3.9 µs, a tick 5.5–8.7 → 8.3–9.8 µs, main 1.5–2.3 → 2.1–2.5 ms a second at S3 (this machine was busier than for step 9's figures).

## 7. Shell decision gate

Once step 5 lands, Electron main holds only the items in §5. A move to Tauri is considered only if the built-in browser gets a non-Chromium plan; the system webview on macOS has no CDP. Without one, Electron stays as the thin shell.

## 8. Packaging

- **Targets:**
  - darwin-arm64 (`macos-15` runners);
  - darwin-x64 (`macos-15-intel`);
  - win32-x64 (MSVC);
  - linux-x64, for the unit-test shards;
  - for the Host, on its own (job `core-host`): darwin-arm64 and darwin-x64 for macOS 13.5, and linux x64 and arm64, glibc (2.17 floor, `manylinux2014` containers) and musl (`crt-static` off, Alpine containers). See [docs/host.md](../host.md#the-rust-core-on-a-host).
- **macOS.** asar already unpacks `**/*.node`, and osx-sign signs the Mach-O files there, so the addon gets the app's signature.
- **Windows.** The `.node` file needs Authenticode signing alongside the executables.
- **sage-mcp.** Windows and Linux ship the Rust tool bridge (`core/crates/sage-mcp`) beside the addon in `resources/core`, built with it (`scripts/build-core.mjs`), and the package stops when it is missing (`checkWindowsCore`, `checkLinuxCore`); macOS has the Swift one in `Contents/Helpers`. A Linux package takes its addon from the release's `linux-<arch>-gnu` Host build, held to glibc 2.17, and builds sage-mcp in that build's `manylinux2014` container, to the same floor; a Linux machine with no Host build builds both itself. The Linux package carries no Node and no JS bridge: the portable sage-mcp runs only where a core is beside it, on a Host and in a Linux checkout.
- **Integrity.** Unpacked files sit outside the asar integrity check that the `OnlyLoadAppFromAsar` fuse relies on.
  - **macOS:** the addon ships in `Contents/Resources/core` (`scripts/build-core.mjs`), and osx-sign signs it with the app. The release entitlements keep library validation on, so macOS loads it only with the app's own team signature: the OS is the integrity check. A hash recorded inside `app.asar` could not match anyway, since signing changes the file after the asar is sealed.
  - **Windows:** no load-time check exists there. The release builds the core on a Windows runner (job `core-win`), signs it before packaging, and the packager records the signed file's SHA-256 in `app.asar` (`electron/platform/core-hash.json`, which the asar integrity fuse covers); the loader checks it before `dlopen`, and a packaged Windows app with no recorded hash loads no core.
  - **Everywhere:** a packaged app (one whose code sits in `app.asar`) loads only its own `resources/core` copy. `MOPILOT_CORE` and a checkout's build are for developers' runs; in the signed app they would load code the release did not sign.
  - **Host:** the app never loads `resources/host-core`; it sends one build to each machine, after checking it against the hashes recorded in `app.asar` (`electron/host/host-core-hashes.json`). The update manifest's signature covers the archive's hash, so it covers the addon; the Host's loader requires the hash its version records, and an installed Host ignores `MOPILOT_CORE`. The macOS builds are Developer ID signed before their hashes are taken, as notarization requires of any Mach-O in the app, and osx-sign leaves the folder alone.
- **CI.** The core is built once per CI run, cached on `Cargo.lock` + `core/**`, and downloaded by every unit shard.

## 9. Fitting the repository's workflow

Rust code follows the same rules as JS code. Today there is no precedent: Swift coverage runs only at release. The Rust gate lives inside the PR's `unit-tests` status.

- **Coverage.**
  - `cargo llvm-cov` exports lcov, and `scripts/diff-coverage.mjs` reads it next to the V8 coverage.
  - Line and function coverage work on stable. Branch coverage needs `-Zcoverage-options=branch`, so the coverage job alone pins a nightly.
  - The same 100% changed-line line, branch and function threshold applies.
  - `#[coverage(off)]` is an ignore directive and is not allowed.
  - Coverage from macOS-only `cfg` code and from Linux shards is merged the way `scripts/raw-coverage.mjs` merges V8 runs.
- **The binding layer is thin and tested from JS.**
  - `core/crates/node` does `dispatch` and `subscribe` only.
  - A few `tests/core*.test.ts` tests load an instrumented `.node` (`LLVM_PROFILE_FILE=%p`).
  - Every other JS test of a core-backed domain injects a fake core, so it never loads the addon.
- **Related tests.** A changed `.rs` file maps to its crate. `cargo metadata` gives the crates that depend on it, and `cargo test -p` runs that set. If the crate is reachable from `node`, the binding tests run too.
- **Checks:**
  - `scripts/file-size.mjs` adds `rs` to its extensions, under the same 500-line rule;
  - `scripts/module-map.mjs` reads `//!` headers;
  - a clippy JSON baseline joins the lint ratchet, under the same never-raise-by-hand rule;
  - the pre-commit hook runs rustfmt and clippy only when `.rs` files are staged;
  - a `tests/coreTypes.invariant.test.ts` fails when the checked-in generated TS types drift from `proto`.
- **Shared files.** When they land, `core/Cargo.toml`, `core/Cargo.lock` and `core/rust-toolchain.toml` are classified in docs/shared-files.md.
- **Harnesses.** A core-backed domain serves Codex, Claude Code and admitted ACP harnesses alike, with UT for each adapter and for mixed pairs, as AGENTS.md requires.

## 10. Risks and stop conditions

| Risk | Mitigation |
| --- | --- |
| Phase 0 cheap wins meet the budgets | Rust work narrows to `proc` and the typed boundaries. It does not continue just because it was planned |
| A port doesn't move its metric | Stop. Revert it if it adds maintenance with no gain |
| Ordering regressions between core replies and stream events | One ordered stream (§4), with UT for reply-after-delta per harness |
| A file-format drift breaks downgrade | Byte-compatibility fixtures shared by the JS and Rust suites, plus the downgrade check at release |
| Two implementations of shared logic drift | One owner per module, with parity fixtures only during a migration (§5) |
| Native addon crash or load failure | `catch_unwind` per dispatch. An app whose core does not load reports why, tells the person to reinstall and exits before main loads (`coreProblem` in `electron/platform/core.cjs`, checked by `electron/boot.cjs`); a checkout prints the reason. The Windows core links its C runtime statically, since a stock Windows has no VC++ runtime; no JS copy answers a call that fails, which throws (§3) |
| Toolchain cost for contributors | A pinned toolchain, prebuilt artifacts in CI, and JS tests that never need the addon |

The memory and timing figures in this document are spot samples or estimates. §2 replaces them with measurements before any port is judged.

## 11. Final numbers

Every domain of main's hot paths in this plan now has one implementation, in the core, with no JS copy or fallback (`tests/rustOnly.invariant.test.ts`, `tests/coreNoFallback.invariant.test.ts`). The user chose to port each domain whatever its gate said, to merge one that gained nothing, and to fix first only one that pushed a met target out of budget. None did.

Each row compares JS with the core on this Mac (Apple silicon, plain Node, not Electron, synthetic inputs). The source is the port's pull request, or `scripts/perf-bench/readpaths.mjs` run on main at 793119b13 (Node 24, median of 5) against Stage 0.1's baseline (#3798, Node 26). "Off main" means the time moved to a core thread, so main's hold is the smaller figure beside it.

The targets are:
- a live flush at 20 ms p95;
- 50 ms, the stall that is labelled;
- a 32 MiB record in 100 ms or less.

| Domain (stage, PR) | Measure | JS | Core | Verdict |
|---|---|---|---|---|
| `proc` (1, #2738–#2773, #3868, #3961) | process spawns to read the process table, memory pressure and presence | `ps`, `sysctl`, `taskkill` | none | fewer processes; no timing recorded |
| `store` read (2, #3875) | 723 chat files at startup, warm | 12.4 ms | 8.2 ms | gain, not on the critical path |
| `store` commit (4.5, #4404) | `JSON.stringify` and write: 0.9 KB / 1 MB | 114–117 µs / 651–699 µs | 114–115 µs / 662–703 µs | no gain, as expected (disk-bound) |
| `framing` (4.2, #4388) | burst of 20,000 lines: main per line / p95 latency | 12.6–12.8 µs / 103–107 ms | 1.16–1.17 µs / 0.77–0.79 ms | gain |
| | 32 MiB record: latency / main time | 79–80 ms / 18.2–19.5 ms | 48–49 ms / 15.9–16.0 ms | gain, within its 100 ms target |
| | steady stream, main per line | 23.0–23.7 µs | 21.7–22.6 µs | no change |
| harness children (4.1, #4005) | steady stream, main per event (macOS / Linux) | 19.4 / 8.1 µs | 29.4 / 9.8 µs | slightly worse, far within 20 ms |
| | spawn hold, p50 (macOS / Linux) | 0.17 / 0.55 ms | 0.22 / 0.83 ms | slower, within budget |
| `session` (§6 step 4, #3880) | a chat's state decisions | — | — | not timed: decisions per event, no hot loop |
| `caps-socket` (§6 step 5, #3953) | processes spawned per sage-mcp connection | up to 8 `ps` and 1–2 `lsof` | none on macOS and Linux; Windows still runs `netstat` per TCP connection | fewer processes |
| `transcript` writer (2.1, #3886) | appends | — | — | not timed: the file format and batching are unchanged |
| `transcript` scan (2.2, #3888, #3923) | ACP list, 300 chats / a search that misses | 56 / 78 ms | 36 / 39 ms | gain |
| `rank` (2.3, #3874) | 100,000 paths, short / long query (readpaths on main at 793119b13; #3874's own 9–28 ms came from another fixture) | 139 / 281 ms on main | 50 / 61 ms off main | gain; main no longer blocked |
| `rollout` (2.4, #3930) | 200 MB rollout: read / JS heap held / RSS | 950 ms / 320 MB / 441 MB | 620 ms / 6 MB / 271 MB | gain, mostly memory |
| | 50 MB parse, total | 56 ms on main | 68 ms off main | main no longer blocked |
| ACP translate (3.3–3.4, #3967) | live per event, mean | 0.2 µs | 5.8 µs | worse, within budget: about 1.4 ms of main a second at S3 |
| | main's own readers at 50 MB, longest hold | 8–35 ms | 3.6–5 ms | gain |
| Claude translate (3.5–3.6, #3980) | live per event, mean / p95 | 0.3 / 1.0 µs | 6.9 / 20 µs | worse, as the plan expected; within budget |
| | flush at S3, p95 (§6 step 8) | 2.7 µs | 63 µs | about 1.7 ms of main a second, against 20 ms |
| | a harness switch's read at 50 MB, main's hold | 45–51 ms | 2.4–5.2 ms | gain |
| batcher (4.3, #4406) | per delta, mean | 0.35 µs | 2.3 µs | worse, within budget |
| | main time per second at S3 | 0.14–0.20 ms | 1.2–1.6 ms | within the 20 ms budget |
| | one 8 MB delta, alone / joined | — | 25 / 50 ms | within the 500 ms stall target; Codex and ACP deltas are small |
| delivery (4.4, #4407) | frame tick, main / window | 2.3 / 2.7 µs | 2.9 / 2.8 µs | no change |
| | one 256 Ki-unit delta, main / window | 14 / 21 µs | 86 / 106 µs | worse by 0.1 ms, within budget |

What this does not change: the window stays JS, so first paint to interactive (about 1.3 s, §2) is mostly where it was. The gains are in reads, search, ranking and the Codex rollout's memory. The live path costs main about 1–2 ms more a second at S3, against its 20 ms budget.

Not measured:
- in Electron;
- on Windows or Linux, beyond the rows that say so;
- the S3/S7 interaction spec, on the core-built app, for the whole of Stage 4.

Validated at the end of Stage 4:
- **Full E2E:** every macOS and Linux shard of `main-e2e.yml` passed on e6a9b9bbc, with Stages 4.2 to 4.5 in ([run 43560981810](https://github.com/mopilot-ai/mopilot-code-release/actions/runs/43560981810)). After the cleanup, main's own validation passed at 738cd1865.
- **Windows:**
  - **Rust tests:** the core's Rust tests run on `windows-latest`, in main's validation and in every pull request's check.
  - **E2E:** the fake-based E2E specs also run on a Windows runner (`win-e2e.yml`, [Windows E2E](../unit-coverage.md#windows-e2e)).
    - The first full run found 23 failures, among them product bugs, each fixed on main: a Codex path that is not a program, a `.com` beside a folder, Your Chrome's stdio, ConPTY's 3 s DA1 wait, `!cmd` through PowerShell, and a missing Downloads folder (#4477, #4484, #4486, #4488, #4493).
    - The full run on main at 0d6837bfb: 437 passed, 1 failed, 16 skipped ([run 43623736343](https://github.com/mopilot-ai/mopilot-code-release/actions/runs/43623736343), shard 1 rerun after the runner failed to start processes). The one failure, `browser-blank-tab-recovery`, was a product bug, seen intermittently: the side pane's hairline border made its held children 1 px wider than its content box, and focusing a pane button scrolled the pane 1 px. #4501 clips it (`overflow: clip`); the spec passed 12 of 12 on Windows with the fix ([run 43628306889](https://github.com/mopilot-ai/mopilot-code-release/actions/runs/43628306889)).
    - The first full run with no failures, on main at b1b8a5214: 439 passed, 0 failed, 20 skipped ([run 43787862275](https://github.com/mopilot-ai/mopilot-code-release/actions/runs/43787862275), attempt 3). Shards 6 and 8 were rerun after runner faults: the runner failed to start processes (0xC0000142, also reported by Playwright as a worker exiting with code 3221225794), or lost contact with GitHub. #4664 skips the fake SSH machine page on Windows, where it has no Host.
    - Skipped on Windows: the POSIX fake Host's specs, the fake SSH machine page, computer use, the SIGTERM deadline and the opt-in downgrade.
  - **Packaged app:** the packaged Windows app's containment check (`win-containment.yml`) runs against a release.
