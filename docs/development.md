# Development guide

How to build and run MoPilot from source, keep a development instance apart from your everyday app, run the checks
CI runs, and package the desktop app. [CONTRIBUTING](../.github/CONTRIBUTING.md) covers the pull request side, and
[AGENTS.md](../AGENTS.md) the repository's working rules.

## Toolchains

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24 | npm comes with it. The `engines` field in `package.json` records the version CI uses. |
| Git | any recent | The repository's hooks live in `.githooks/`. |
| Rust | pinned in [`core/rust-toolchain.toml`](../core/rust-toolchain.toml) | `rustup` installs the pinned version on first build. |

For each operating system:

- **macOS** (the main development platform): Xcode Command Line Tools (`xcode-select --install`). The native
  helpers and the computer-use helper build with Swift from them.
- **Linux**: a native x64 or ARM64 machine. The [Linux guide](linux.md) lists the system packages, the keyring
  requirement and what the Linux build leaves out.
- **Windows**: the Windows app and installer are built with `npm run package:win`; see [Packaging](#packaging).

## First run

```bash
npm ci
npm --prefix mobile ci
npm run dev
```

- `npm ci` installs the root dependencies, generates the agent catalog and points Git at the repository's hooks.
- `npm --prefix mobile ci` installs the phone client's dependencies. `npm run typecheck` checks the phone client too,
  so install them even if you only work on the desktop.
- `npm run dev` builds the Rust core and the native bridge when they are missing or stale, then starts Vite and
  Electron.

Source edits do not reload an open chat by default. For live interface reload, run `MOPILOT_DEV_HMR=1 npm run dev`.

## A separate development instance

A development instance uses its own ports and user data, so it can run next to the MoPilot app you use every day
without touching its chats, sign-ins or settings:

```bash
SAGE_DEV_PORT=5174 SAGE_DEBUG_PORT=9333 SAGE_USER_DATA="$HOME/.mopilot-dev-2" npm run dev
```

The variables keep their historical `SAGE_` names. Give each checkout or Git worktree its own values when you run
several at once.

Settings lets you choose each agent's executable. `CODEX_BIN` and `CLAUDE_BIN` override the Codex and Claude Code
executables for one run.

## Checks

| Command | What it does |
| --- | --- |
| `npm run format` | Formats with Biome. Pass files to format only those. |
| `npm run lint` | Biome's error rules and the lint ratchet, which fails on new bug-class warnings. |
| `npm run typecheck` | The root, Node and phone TypeScript projects. |
| `npm run module-map -- --check` | Every source file starts with a one-line ownership comment. |
| `npm run i18n:check` | Interface text is ready for translation ([interface languages](i18n.md)). |
| `npm run test:related -- --direct <files>` | Lists the unit tests that reach the files you changed. |
| `npm run test:coverage -- --changed --related` | Runs those tests and enforces 100% coverage of the changed code ([unit coverage](unit-coverage.md)). |
| `npm test` | The whole unit suite. CI runs the tests a change reaches on every pull request. |

The pre-commit hook runs formatting, lint, the file-size check and, when types can change, the type checks on what
you stage. Skip it once with `git commit --no-verify` only when you will fix the result before pushing. The pre-push
hook refuses a push to `main`: changes reach it through a pull request.

Unit tests are Node's built-in test runner with TypeScript loaded by `tests/support/register.ts`. They use fakes
for the agents, the network and the file system, so they run without accounts. Some suites start real app windows
or real agents; they are not part of `npm test` and are run separately before a release.

## Phone client and Chrome extension

The phone client is an Expo app with native modules; it does not run in Expo Go. Its [README](../mobile/README.md)
covers development builds, simulators and pairing with a development desktop. The Chrome extension that connects
**Your Chrome** builds with `npm run build:chrome-extension` ([browser](browser.md)).

## Packaging

```bash
npm run package        # macOS app
npm run package:win    # Windows x64 app and installer
npm run package:linux  # Linux .deb and .tar.gz; run it on Linux
```

Source packages display as **MoPilot Source** and use the separate `MoPilot Source` data directory.
Builds have independent bundle and installer IDs. See `TRADEMARKS.md` before distributing a fork.

Packaging, signing and publishing are separate steps. A local build is unsigned unless a signing identity is
configured, so macOS Gatekeeper and Windows SmartScreen warn when you open it. Official releases are built, signed
and notarized by the maintainers.

Official releases install from [mopilot.ai/download](https://mopilot.ai/download), or on macOS from the Homebrew tap
`mopilot-ai/tap` (`brew install --cask mopilot-ai/tap/mopilot`). The release repository's `homebrew-tap.yml` workflow
updates the tap's cask to each stable version once it reaches 100% rollout ([Homebrew cask](updates.md#homebrew-cask)).

## Troubleshooting

- **Hundreds of type or lint errors after switching branches or creating a worktree.** The dependencies are stale or
  missing: run `npm ci` and `npm --prefix mobile ci` again in that checkout.
- **The hooks do not run.** `node scripts/hook-check.mjs` explains why and repairs the usual cause, a
  `core.hooksPath` that points somewhere else.
- **The Rust core fails to build.** Run `rustup toolchain install` in `core/` to install the pinned toolchain, then
  `npm run dev` again.
- **A development instance shows your everyday chats.** It is sharing user data: set `SAGE_USER_DATA` to a folder of
  its own.
- **Tests behave differently on another Node version.** CI uses Node 24; use the same version locally.
