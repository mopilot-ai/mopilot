# MoMo "Gets it done" (pure core)

Design: Function 4 of 5, stage row 6 of section 4. Plain TypeScript, no I/O: the machines, the brain, the chat, the clock, the storage and the readers are injected. Nothing is wired to a Host, a flag or the UI yet; everything stays behind the existing MoMo flags and the invite gate.

An item is a normal MoPilot session on the machine the user chose, wrapped in a small record (`types.ts` `Item`): id, title, `doneMeans`, `state` (`working | needs_you | watching | done | failed | stopped`), `where` (`machineId`, `harness`, `sessionId` = the MoPilot chat id), `origin`, `stableKey`, `attempts / attemptCap`, `lastError` (code, message, fixes), `result`, `nextCheck`.

```
manager.ts   createTaskManager(ports): create / start / retry / onEvent / stop / recover / createWatch / tick / resume / flushCards / reset, groupTasks
runs.ts      session tasks: preflight, start, typed events, read-only check, stop, restart recovery
watching.ts  watching items: claim, read, compare, notify, pause on failure
watch.ts     model-free change watch (ported from rakazo, THIRD_PARTY.md)
failure.ts   the real cause and fixes, from shared/host/refusalWords and turnErrorCode (same words as a Remote Run chat)
brief.ts     the brief, the report form, the read-only check prompt and its strict answer
store.ts     the durable ledger over a `DocSeam`; validated on read; `reset()`
core.ts      shared parts: ports, TaskRefusal, owed cards
```

## What the home lane must implement (`types.ts`, `core.ts`)

- `ItemStore`: `createItemStore(seam, clock)` over a `DocSeam { read, change }`. `change` must run `fn` on the current document and save its result in one transaction (sealed file or the Host's database). `createMemorySeam` is the reference. Register `TASKS_STORE_ID` (`'tasks'`) with Reset MoMo: add `{ id: 'tasks', label: 'tasks MoMo started' }` to `MOMO_STORES` in `electron/momo/stores.cjs`, a write for it in `tests/momoResetRecovery.test.ts`, and `registerMomoStore('tasks', () => manager.reset())` where the home is composed. **Not done here** because it changes Reset for every user before there is a store to reset.
- `MachinePort`: `list()` (name, online, outdated, installable, per-agent `ready | signin | missing`: `agentsOf` of the machine row), `start(StartRequest)` through the same Host session/start service a Remote Run chat uses (returns `{ ok, sessionId }` or the Host's refusal `{ code, message, details }`; a thrown error is read as offline), `stop`, and `probe` (`running | finished + report | gone | unreachable`). `StartRequest` carries `readOnly`, `gateOrigin` (`task` or `unprompted`, the approval gate's run origin), `forbidTools` and an idempotency `key` (`<itemId>:<attempt>`) the Host's ledger can answer twice.
- Per-harness adapters turn what the session does into `SessionEvent` (`progress`, `needs_you` with the gate's card id, `resumed`, `finished` with the closing reply, `failed` with the harness's own `signal` and text, `lost`) and call `manager.onEvent(machineId, sessionId, event)`. Native ids and wire shapes stay in the adapter. `failed.signal` takes Claude Code's assistant `error`, Codex's `codexErrorInfo` and an ACP agent's text; they land on the same `usage_limit`, `agent_signed_out` and `session_failed`.
- `CheckPort.ask(prompt, data?)`: MoMo's brain, read-only, **no tools** (the request is `prompt`; the report is `data`, which the brain fences apart from the request).
- `ChatSink.postResult(card)`: one card per `(itemId, settle)`; make it idempotent on that pair. The card is captured when the item settles and stored on it, so a later retry, stop or move never changes or breaks it. A card or watch notice the chat cannot take stays owed (and survives a restart); call `manager.flushCards()` on wake and after delivery failures. `postWatchChanged` is the notice for a watch (route it through the notice pipeline's limits).
- `WatchReader` (optional until Watching is wired): `toolIsReadOnly(tool)` and `read(watch)` returning a `Reading` built with `readItems`, `readFiles` or `readWhole`. A busy source throws `WatchRetryError`; anything else pauses the watch with the reason. `parseWatch` refuses localhost, private, link-local and metadata names and addresses as written, but a public name can still resolve or redirect to a private address: **the reader must resolve the name itself, check every address it connects to, and follow no redirects.** Call `manager.tick()` from the scheduler about once a minute.
- `home()`: MoMo's home machine and signed-in agent, the default `where`.
- Call `manager.recover()` once after the home starts, before scheduling anything.
- Pass `callerItemId` to `create` / `createWatch` from any tool a task's own session can reach: it refuses (`nested`). Do not give the session the `forbidTools` capabilities at all.

## What the UI lanes read

`manager.list()` and `groupTasks(items, dayStart)` give Needs you (waiting, and failed today), Working, Watching and Done today. Per item: `lastError.message` and `lastError.fixes` (`install`, `signIn`, `orgSignIn`, `update`, `retry`, `runElsewhere` with `machineId`/`harness` per named machine, `startAgain`, `openSession`, `review`), `progress`, `result`, `where`. The result card has `untrusted: true` and a stable `settle` key. Actions: `start(id, where?)` / `retry(id, where?)` (Run on another machine = `where`), `stop(id)`, `resume(id)` (Keep watching, or Retry a paused watch).

## What the Host must enforce (phase-2 test)

`StartRequest.readOnly` and `gateOrigin` are requests, not enforcement: this core only sets them. The Host must refuse a write or send from a `readOnly` / `unprompted` session in code, and route every write or send of a `task` session through the approval gate. Phase 2 needs a test that starts an unprompted task, has its session attempt a write and a send, and sees both refused with no card; and a `task` session whose write raises a card.

## Rules enforced in code

- Unprompted origins (`matter`, `routine`) start read-only (`readOnly`, `gateOrigin: 'unprompted'`); `asked` and `suggestion` need `userStarted`. Every write or send still goes through the gate.
- No scheduling from inside a task (`nested`, plus `forbidTools`).
- One run plus two retries; moving to another machine earns one more round, once; six runs is the ceiling. The same session failure twice stops offering Retry on that machine.
- A ledger written by a newer version, or one that is damaged, is left untouched and refused (`LedgerError`); only Reset MoMo clears it. Reset also stops the sessions of running tasks (`manager.reset()`).
- A failed, interrupted or stopped item is never started again by itself; a restart marks lost tasks `interrupted` and the user's Start again asks first.
- One stable key, one live item: a finished, failed or stopped one does not block asking again. At most five tasks working.
- The read-only check sets `done` only on a clear yes; "finished but not done", an unreadable check or a failed check is `needs_you`.
- A change watch never calls a model and never takes a tool that is not read-only.

## On a Host (phase 2: `host/src/momoServices/tasks.mjs`, `host/src/momoTasks/`)

The service plugs into the home by folder and offers `home.service('tasks')`:

- **Storage**: the ledger is `tasks.json` and the start keys `task-keys.json`, sealed under the home's storage folder; both move with the home and Reset deletes them. The ledger is written only while this Host is the running home.
- **Sessions**: a task is an ordinary chat of the chosen agent on this Host (`claude:<uuid>`, a bare Codex id, `acp:<agent>:<uuid>`), started with the brief in a folder of its own under the home's storage. Another machine is not reachable from a Host: a task for it fails as `machine_offline`, named.
- **Events**: the Host's turn events are read as `SessionEvent`s (reply text, a failure with the Host's typed code, a restart's interrupted end, a Stop that says nothing); a chat that waits on an approval is `needs_you` with the marker `approval:<chatId>` until the turn goes on.
- **Enforcement** (`host/src/momoTasks/modes.mjs`): a task's chat is an ordinary chat of its agent (never of MoMo's form, so it is never given MoMo's own tools: nothing in it can schedule, make a task or a rule). Before its first message it is set to the typed mode of its adapter: Claude Code and Codex take `default` ("Ask for approval", never the machine's looser mode) for a task the user asked for, and `read-only` for one nobody asked for. A basic agent's modes are its own: an asked task runs as the agent is, an unprompted one is refused with "can't be held read-only on this machine" (`refused`). A mode the agent refuses is told in the agent's own words and the start key is given back. Writes by a task are the agent's own tool calls, held by its permission mode and the Host's approvals (`needs_you` with `approval:<chat>`); `guardedRun(chatId, input, exec)` runs a MoMo action through `home.service('gate').run` with origin `task` or `unprompted` (the latter can only read), and refuses a chat that is not a task (`not_a_task`).
- **Start and end**: the start key is written before anything runs and given back when nothing started; a key finds its chat only if the Host still has it. A session that speaks before its start is recorded is replayed in order. How each session ended is kept sealed (`task-ends.json`) the moment it ends, so a home that was paused, moving or lost reads it when it runs again (`probe` says `ended`), instead of calling a finished task lost. A session started under a lease that is lost is stopped. Each task works in `<dataDir>/momo-tasks/<id>`, outside MoMo's storage: a move or Reset never carries or deletes what a task made.
- **Wiring**: `deps.harnesses` (momo-home adds it to `momoHomeFor`) gives the machine's agent readiness, read here through `agentsOf`. Left to momo-home (`bind`): the brain's tool-less `check.ask`, `chat.postResult` / `postWatchChanged` into the MoMo chat, and the watch reader. Until bound a task does not start (machine unknown), and cards and notices stay owed (visible in `view()`), never dropped.
- **Clients**: `view()` returns `MomoTaskView[]` (shared/momoView.ts); `act(taskId, fixId)` performs Retry, Start again and Run on a named machine, and returns `{ client: action }` for Install, Sign in, Update, Open the session and Review.
