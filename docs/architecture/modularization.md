# Modularization: domains, layers and focused tests

Status: steps 1 to 6 of §7 are implemented: `node scripts/module-boundaries.mjs` counts no violation in any domain, so the ratchet (§4) now holds every domain at zero. `session/` and `harness/` reach the disk and child processes only through the `fs` and `proc` ports; the other files that require `node:fs` or `child_process` directly are L1 (`platform/`, `perf/`), the composition root that makes the platform objects (`main.cjs`, `app/`, `bridge/`), and the memory guard's worker source, which runs in a thread of its own. This is stage 1 of [rust-core.md](rust-core.md): a domain can move to the Rust core only once it sits behind a port. The same change also makes unit tests focused.

## 1. Problem

A change to a small module selects hundreds of unit tests. These counts come from `node scripts/related-tests.mjs <file>`, transitive and `--direct`, on main as of October 2026:

| Changed file | Related tests | `--direct` |
| --- | --- | --- |
| `src/store/send.ts` | 508 | 5 |
| `src/lib/native.ts` | 887 | 299 |
| `electron/session/queueItem.cjs` | 275 | 6 |
| `electron/harness/codexParams.cjs` | 197 | 7 |

A leaf module with five to seven tests of its own inherits the whole closure of the hub above it. Five causes:

1. **Barrels.** `src/store/store.ts` re-exports every store module (`core`, `send`, `panes`, …), and 306 files in `src/` import it. [docs/code-quality.md](../code-quality.md#module-boundaries) currently says to import from the barrel.
2. **A global port read at load time.** `src/lib/native.ts:130` does `export const native: NativeApi = window.native`. Every UI test either mocks it by specifier, which 104 `mock.module` calls do, or assigns `window.native` before importing, which 148 tests do.
3. **Module-level singletons.** For example, `electron/platform/transcriptWriter.cjs:495` does `const shared = new TranscriptWriter()`. Other module-level state lives in `electron/harness/claude/index.cjs`, `electron/platform/flags.cjs` and `electron/ledger/index.cjs`, and in about 50 `src/` files with top-level `let`. No reset hooks exist, so tests share state through the module cache.
4. **Platform reached directly.** About 170 files in `electron/` require `fs` and 43 require `child_process`. Within `session/`, `harness/` and `capabilities/`, 54 require `fs` and 21 require `child_process`. Their tests need temporary folders or `mock.module('node:child_process')`.
5. **Test selection over-counts.** `scripts/related-tests.mjs`:
   - counts a `mock.module('<path>')` string as a reference, so `tests/appShell.test.ts`, which only stubs the store, is selected for `src/store/store.ts`;
   - lets reach pass through every helper under `tests/support/`;
   - adds the invariant bundle (196 tests) to every app change.

   [docs/unit-coverage.md](../unit-coverage.md) already says stubs don't count.

The good patterns to extend:

- the `electron/app/<area>.cjs` factories over a deps object built in `main.cjs`;
- `electron/app/ipc/<feature>.cjs` `register(ipcMain, deps)`;
- the declarative bridge in `electron/bridge/`;
- the harness contract in `src/harness/adapter.ts`;
- the pure `shared/*.mjs` modules.

## 2. Layers

A module may import only from its own layer or from the layers below it. Within a layer, it imports another domain only through that domain's public entry (`index.cjs` / `index.ts`).

### `electron/` (main process)

| Layer | Domains | May touch the platform? |
| --- | --- | --- |
| L0 kernel | `shared/*.mjs`, `electron/ignored.cjs`, pure helpers (`textPrefix`, `jsonRecord`, `gitParse`); `shared/model/` (the types main and the windows share: the harness contract, requests, a window's store state, the session copy and caps, main's native records); `src/protocol/` (the generated app-server types) | No, except read-only `node:os` / `node:path` lookups (`ignored.cjs` reads the home folder to scrub paths) |
| L1 ports and platform | `electron/platform/` (env, git, pty, search, scheduler, notify), `electron/perf/` (startup and idle probes), `fsutil`, `processTree`, `winbin`, secrets (`secretFile`, `encryptedStore`, `sealedFile`) | **Yes. Below the composition layer (L6), this is the only layer that requires `fs`, `child_process` or `electron`** |
| L2 stores | chats, items log, projects, ui-state, ledger, context store, migrations, checked/sealed stores, `gateway/` (the MCP client, catalog, tool names and description/schema sanitizers, the connector token vault and OAuth, and the sealed JSON file, durable write and folder lock they keep data with; MoMo uses them from above) | Through L1 ports |
| L3 harnesses | `harness/codex`, `harness/acp`, `harness/claude` (absorbing the ~50 top-level `claude*.cjs` files), `transport/` | Through L1 ports |
| L4 session | `session/` (controller, state, switch, caps, orchestration) | Through ports |
| L5 features | `capabilities/` (browser with its own internal layers, tools, channels, vision), `momo`, `plugins`, `identity`, `context`, `computerAccess`, `computerHistory`, `design`, `updates`, `remote`, `chrome-extension`, `support` (bug reports, diagnostics, notices, telemetry, install ping) | Through ports. Reaches session only through its port |
| L6 composition | `app/` (with its IPC handlers in `app/ipc/`), `bridge/`, `main.cjs`, `preload.cjs`, `boot.cjs` | Yes: it makes the platform objects. It wires everything, so it may import any lower domain's files, not only their public entries; another L6 domain only through its public entry. Nothing imports it |

A feature's pieces that a lower layer needs, and that need only L0 and L1 themselves, live in its `contract/` folder: a nested L2 domain (`electron/capabilities/contract/`, `identity/contract/`, `session/contract/`, `momo/contract/`) whose `boundary.json` lists what the other domains import. The tool registry and session names, the model notes, the server requests, the input guard and route, the account switch policy and MoMo's context are there, so the harness adapters (L3) and the chat controller (L4) import them downward while their feature still owns them.

Exceptions are named in the domain's `boundary.json` (§4) with a reason. Two expected ones:

- the built-in browser, which is Electron by nature;
- `electron/platform/flags.cjs`'s sync IPC.

### `src/` (renderer)

| Layer | Contents |
| --- | --- |
| R0 protocol | shared modules the renderer uses, generated core types, `src/styles/` (CSS, which imports no code). The generated `src/protocol/` types are L0: `shared/model/` and main name them too |
| R1 lib | `src/lib/native/<ns>.ts` types (types only), pure `src/lib/*` |
| R2 harness translators | `src/harness/`. Its boundary.json lists as public the modules that stay here (translators, types, family, registry); the runtime that drives the store moves up to R4 |
| R3 store slices | `src/store/<slice>.ts`, reading the native port when called. No barrel. A slice says `@store-slice` in its header, and tests' store stub replaces those; the store's other public modules (split view, live actions) stay real there. `src/store/session/` holds the window's own copies of each chat's session state and caps, stores of their own |
| R4 session | `src/session/`, including the modules that drive the store for components (opening links and chats, voice, app shortcuts), moved up from `src/lib` and `src/harness`, and later the harness runtime the store reaches through a registry |
| R5 features | `src/components/<feature>/`. No imports of another feature's internals |
| R5 shared UI | `src/components/ui/`, a new folder that `Popover`, `Modal`, `MenuList`, … move into |
| R6 composition | `src/App.tsx`, `src/main.tsx`, `src/launch.ts`, held by `src/components/boundary.json` (`files`) and judged by its R5 rules, since nothing imports them |

`native` becomes a port the composition root installs:

- `src/lib/nativeInstall.ts`, the entry's first import, reads `window.native` once and installs it (`installNative`). No other module reads `window.native`.
- Modules import the port (`native` from `src/lib/native.ts`) and read whatever is installed each time they use it, so nothing holds a bridge from load time. A use before anything is installed throws; a module that must work without a bridge (error reporting, the platform name) asks `installedNative()`, which is null then.
- A test installs the one shared fake (`tests/support/ports/native.ts`). It doesn't need `mock.module` or a global.
- Store slices are modules over the installed port, not factories: one store per window needs no second instance (decided in step 3; a slice that ever needs two instances becomes a factory then).

## 3. Ports

Ports are small interfaces created in the composition root and passed down:

| Port | Replaces | Implemented by |
| --- | --- | --- |
| `fs` | direct `node:fs` in L2–L5 | `electron/platform/ports/fs.cjs`, later the core's `store` |
| `proc` | `child_process`, `processTree.cjs` | `platform/ports/proc.cjs`, later the core's `proc` |
| `clock` | `Date.now`, `setTimeout`/`setInterval` in state machines | `platform/ports/clock.cjs` |
| `secrets` | `secretFile.cjs` reads in features | `platform/ports/secrets.cjs` (safeStorage stays here; see rust-core.md §5) |
| `session` | features requiring `session/*` | `session/index.cjs` |
| `native` (renderer) | `window.native` reads | `src/lib/native.ts`, installed by `src/lib/nativeInstall.ts` |

Rules:

- **Singletons.** `main.cjs` or the `app/` factories create them and pass them in. A module exports a factory or a class, never an instance. For example, `transcriptWriter.cjs` exports `TranscriptWriter`, and `app/sessions.cjs` creates the one shared writer. The ports are the exception: `electron/platform/ports/fs.cjs`, `proc.cjs` and `clock.cjs` (and the renderer's `native`) are installable, so a module requires the port and reads it when called, and a test installs a fake instead of having it passed in.
- **Fakes.** Each port gets one shared fake in `tests/support/ports/`, used by every test of the layers above it, so per-test `mock.module` lists disappear. The clock's fake (`useFakeClock`) stands still until the test moves it; the global clock reads `Date` and the timers when called, so `node:test`'s `mock.timers` still reaches a module on the port.
- **The core.** These are the seams where a Rust implementation plugs in (rust-core.md §6). The same contract tests run against the JS port and the core-backed port.

## 4. Enforcement

There is no central registry. Each rule is found by folder or file name (docs/shared-files.md).

- **`boundary.json` in each domain folder.** For example `electron/session/boundary.json`:

  ```json
  { "layer": "L4", "public": ["index.cjs"], "mayImport": ["L0", "L1", "L2", "L3"], "allow": [] }
  ```

  `allow` lists named exceptions, each `{ "path", "to", "reason" }`. `files` names the files at a tree's top that belong to the domain, since a folder can't hold them: `shared/boundary.json` holds `electron/ignored.cjs` (L0) and `electron/app/boundary.json` holds `main.cjs`, `boot.cjs` and `preload.cjs` (L6).
- **`tests/moduleBoundaries.invariant.test.ts`** walks every `boundary.json` and reuses `reverseGraph()` from `scripts/related-tests.mjs`. It fails on:
  - an upward import;
  - an import of another domain's internals, except from the composition layer (L6) into a lower layer, since it builds every domain;
  - a platform require outside L1 and L6;
  - an import cycle between domains.

  It starts as a ratchet, with no hand-kept list of violations. The test computes each domain's violations on the merge base with origin/main and fails when a change adds one. Parallel PRs that each fix violations in a domain therefore never edit the same file. A file a change moves (a git rename) carries its merge-base violations to the domain it moves to, so moving a module up a layer is not counted as new violations; an import the moved file gains still counts.
- **A GritQL rule in `lint/rules/`** (`module-singleton.grit`) warns on module-level mutable state (`let`, or an exported instance) outside L6, through the lint ratchet.
- **[docs/code-quality.md](../code-quality.md#module-boundaries).** Its "import from `store.ts`" sentence is replaced in the PR that removes the barrel. That document keeps owning the rule.

## 5. Test selection

Three changes to `scripts/related-tests.mjs`, each with UT in `tests/relatedTests*.test.ts`:

1. **Stubs don't count as reach.** A path that appears only as the first argument of `mock.module(...)` is no longer an edge, which matches docs/unit-coverage.md.
2. **Helpers pass reach on only through what they load.** A test reaches a source file through a kit only if the kit loads that file; a module the kit only stubs through `mock.module(…)` or `autoMock(…)` is not reached. A path the kit loads by `createRequire`, `require.resolve` or by name stays an edge, because that loads the file. So does a path-keyed table the kit later stubs in a loop (`tests/support/electron-main-harness.ts`), which the selector cannot tell from a table of files it reads; such a kit moves to `autoMock` per module, or is split. A kit that loads many modules is split per domain: `tests/support/<domain>-kit.ts`.
3. **The invariant bundle is scoped by area.** Each `tests/<name>.invariant.test.ts` declares the folders it guards (an exported `GUARDS` array read by `invariantTestsFor()`), so a session-only change no longer runs the browser or Settings invariants. A test that guards the whole repository says `GUARDS = ['*']`.

When a domain moves to the core, its JS tests inject a fake core. The Rust tests are selected by crate (rust-core.md §9).

## 6. Targets

Measured by replaying `related-tests.mjs` over the files changed in the last 200 merged PRs, before and after each step:

| Metric | Today | Target |
| --- | --- | --- |
| Related tests per changed file, p50 / p90 | to be measured (200–900 for the files in §1) | ≤ 50 / ≤ 150 |
| Invariant tests per single-domain change | 196 | ≤ 40 |
| Importers of `src/store/store.ts` | 306 | 0 (file removed) |
| Modules reading `window.native` | many, through `native.ts` | 1 (`src/lib/nativeInstall.ts`) |
| `electron/` files requiring `fs` | ~170 | ≤ 30 (L1 only) |
| `electron/` files requiring `child_process` | 43 | ≤ 5 |
| `mock.module` calls on `store.ts` / `native.ts` | 122 / 104 | 0 |
| Boundary violations, domain cycles | unknown | 0 (the computed count falls to zero) |

A `scripts/related-replay.mjs` produces the first row, so each step's PR can quote its before and after numbers in its description.

## 7. Migration order

Each step is one PR or more, keeps behavior the same, and carries focused UT at 100% changed-line coverage under docs/unit-coverage.md.

1. **Test-selection fixes (§5) and the replay script.** This gives the baseline and the first, cheap reduction. It doesn't touch app code.
2. **The boundaries test in ratchet mode (§4).** `boundary.json` files land for every domain, and the test records today's violation count per domain in its output.
3. **Inject `native` and remove the store barrel (R3).**
   - The port is installed, not injected per slice: modules read it when called, and tests install one shared fake.
   - Importers move to the slice they use, by a codemod, in reviewable batches.
   - docs/code-quality.md is updated in the same PR.
4. **Ports in L3 and L4.** `fs`, `proc` and `clock` are passed into `session/` and `harness/`, and the singletons move into `app/`. The shared fakes land in `tests/support/ports/`.
5. **Move the Claude harness under `electron/harness/claude/`.** The ~50 top-level `claude*.cjs` files go there behind an `index.cjs`, and `electron/harness/claude/index.cjs` keeps re-exporting until its importers move.
6. **The remaining domains** (L5 features, then the renderer's features). Done: the composition layer wires any lower domain (§2), the pieces a lower layer needs moved to `contract/` and `mcp/` domains, the IPC handlers joined `app/`, Electron reaches features through its port, the store-driving renderer modules moved up to `src/session`, the window's session copies to `src/store/session`, and the types that crossed layers to `shared/model/`. A module a change adds keeps to its layer from the start.

A file move changes only the paths that count from the file itself: `require`, `import`, `__dirname` and `import.meta.dirname`. A path that counts from where the app runs (`process.execPath`, `process.resourcesPath`, `app.getAppPath()`, the working directory) keeps its count. Step 6 rewrote the updater's `'../..'` from the executable to `'../../..'`, and from then on codesign read `/Applications` and every release turned its updates off. `[exec-path-depth]` flags a path counted with `..` from the executable.

Every harness keeps its behavior through each step. The ports are shared, and the harness specifics stay inside `harness/<name>/` (AGENTS.md, multi-harness).

## 8. How this enables the Rust core

Once a domain is behind a port, with its own contract tests:

1. A core-backed implementation of the port is added next to the JS one.
2. The contract tests run against both, over the same fixtures (`tests/fixtures/core/<domain>/`).
3. The composition root picks the implementation. The JS one stays as a fallback until the core-backed one has shipped a release.
4. The JS implementation is deleted. Its tests become the core's contract tests.

Without this stage, every Rust port would have to untangle the same barrels, globals and singletons first, inside a risky change.
