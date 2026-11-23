# Conformance probes

These probes check what the real Claude Code CLI and the real Codex app-server actually do, using the
CLIs installed on your machine. The design relies on these facts. The probes are not part of `npm test`
or CI, because they send real model turns on your login and cost tokens. They are release-only (`AGENTS.md`): the runner
refuses to start unless `MOPILOT_RELEASE=1` is set.

## Running

```sh
MOPILOT_RELEASE=1 npm run conformance -- --harness claude              # C1–C26
MOPILOT_RELEASE=1 npm run conformance -- --harness codex               # X1–X18
MOPILOT_RELEASE=1 npm run conformance -- --harness codex --only X1,X8  # some checks
```

Options:

- `--only C4,C9` runs only these check ids.
- `--model <id>` and `--effort <level>` override the defaults. The defaults are the cheapest model at the lowest effort: `haiku`/`low` for Claude and `gpt-6-luna`/`low` for Codex.
- `--bin <path>` picks a CLI. Without it, the newest of the usual install locations is used (`CLAUDE_BIN` and `CODEX_BIN` are honoured).
- `--out <dir>` writes the results file somewhere else, for example to try a run without touching the committed results.
- `--keep` keeps the temp working directories.
- `--record-protected` (inside the benchmark VM only) records a check during which a protected file changed as a `fail`, with `wrote <file>` in its mismatches, and goes on with the next check. Without it the run stops there. The harness version contract (bench/README.md) uses it, since the VM's files are nobody's.

Each run:

- writes `conformance/results/<kind>@<version>.json`. Checks are merged by id, so `--only` updates just those checks and keeps the rest.
- records every message to `conformance/logs/<kind>@<version>/<run>/<ID>-*.jsonl`, which is git-ignored. Secrets, emails and home paths are scrubbed.
- prints a summary table and exits non-zero if any check did not pass.

Each probe module (`claude/C*.mjs`, `codex/X*.mjs`) returns `{id, title, verdict, observed, evidence}`.
The verdict is `pass` when every fact recorded in the baseline still holds and `fail` when one changed;
`observed.mismatches` names the facts that changed. `error` means the probe crashed or timed out, and
`skip` means the check does not apply on this machine.

The committed `claude@2.1.295.json` and `codex@0.162.0-alpha.17.2.json` are the first, hand-written
baseline. Their verdicts were judged against the design (so `partial` means the design was partly wrong)
and their evidence paths point at the original scratch logs.

## What it costs

Every probe uses its own temp working directory and the cheapest model. Most checks take one to a few
short turns. The full baseline runs cost about $0.33 in API-equivalent usage for Claude (on a Claude
subscription) and about 30 short Codex turns (≈1.1M tokens, mostly cached input). Expensive checks are
the goal loops (C4, X2), background tasks (C8), `/code-review` (C13), plan mode (C7, X3) and tool
injection (X7). These checks send no model turns: C3 (local commands only), C15, X6, X9, X11, X12 and X13.

## When to run it

- Before raising `versions.min` for a harness: run the full suite against the new version and review every `fail`.
- Before each release ring: run both harnesses against the versions the ring ships with.
- When a CLI update changes behaviour Sage depends on: run the affected checks with `--only`.

Commit the updated results file with the change it justifies.

## Results, versions and the matrices

- `conformance/results/<kind>@<version>.json` holds one run per first-class CLI version (Codex and Claude Code).
  `tests/conformance/results/acp-admission.json` holds the initialize and session/new probe of each basic harness
  (no prompt is sent, so a basic harness stays "unverified").
- `StaticInfo.versions` in `src/harness/registry.ts` (and its copy in `electron/harness/versions.cjs`) follows the
  results: `tested` is every version whose run has no `fail` or `error` check, and `min` is the oldest of them.
  `knownBad` is a manual list: add a version when a run (or a bug report) shows it breaks something MoPilot
  depends on, and keep it out of `tested`. A CLI above `min` and not in `knownBad` works as usual and is shown as
  "unverified"; only a failed runtime probe greys out a single capability.
  `tests/harnessMatrix.test.ts` fails when the registry and the results disagree.
- After a new run or a registry or bindings change, run `npm run harness-matrix`. It rewrites
  `docs/harness-matrix.md` and `src/harness/matrix.generated.json` (the data Settings renders); the same test
  fails while either file is stale. To raise `min`, run the full suite on the new version, commit its results
  file, then update the registry and `versions.cjs`.

## Safety

- Codex overrides are per-process `-c` flags or per-thread `config`. The client rejects any other
  app-server argument and blocks `config/value/write`, `config/batchWrite`, logins, feature-enablement
  writes, installs and real `feedback/upload` calls.
- Claude settings are passed as SDK options (the in-memory flag layer). `Query.updateSettings` is blocked.
- The runner stats (never reads) `~/.codex/config.toml` and `~/.claude/settings*.json` before and after
  each probe, and stops if one changed (in the VM, `--record-protected` fails that check instead and goes on).
- X14, X15, X16, X17 and X18 run against a throwaway `CODEX_HOME` (the developer's config.toml, plugins and login cloned with `cp -c`, so nothing is written back). X16 sends SIGKILL to the probe's own app-server and removes the shell command it orphans. C20 and C21 SIGKILL the probe's own CLI (started through `spawnClaudeCodeProcess`, so its pid is known); C21 also removes the shell command the CLI leaves behind.
- Auth files are never read or logged. Claude runs with the same scrubbed environment as Sage, so it uses
  its own login.
- Cleanup: Codex threads are archived when their client closes. Claude sessions use
  `persistSession: false` unless a check needs the transcript (C4, C5, C6, C11, C12, C14); those
  sessions are deleted afterwards. Background processes started by C8 and X10 are killed.
