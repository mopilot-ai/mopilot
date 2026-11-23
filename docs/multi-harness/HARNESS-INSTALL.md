# Installing the eight basic-tier harnesses for admission probes

How the real harnesses were installed and probed on 2026-10-10 (macOS arm64, Node 24.21), so a person or another agent can repeat it. Everything goes under `~/.sage-harnesses/<name>/`: no sudo, no shell-profile edits, no global npm/pip config, no system install. Results: `tests/conformance/results/acp-admission.json`.

For the subsequently added Antigravity ACP server, see [Antigravity setup](../antigravity.md). New admission evidence lives in `tests/conformance/results/admission/<id>.json`; the matrix combines these records with the historical snapshot above.

## Rules used

- Install only from the vendor's own npm package, GitHub release or install script on the vendor's domain. Confirm the publisher first (`npm view <pkg> repository.url maintainers`, `gh api repos/<org>/<repo>`).
- npm installs use `--prefix`, a private `--cache` and `--ignore-scripts`. Install scripts (curl style) are downloaded to a file and read first; none is run if it edits shell profiles or other tools' files.
- Pin exact versions. Never sign in and never put a credential anywhere: the admission probe only needs `initialize` and `session/new` (no prompt is sent).
- Do not touch `~/.codex` or `~/.claude` (note: opencode and Goose read `~/.claude/skills`, see Observations).

```sh
H=~/.sage-harnesses
mkdir -p $H/_npm-cache
npm_i() { mkdir -p $H/$1 && npm install --prefix $H/$1 --cache $H/_npm-cache --ignore-scripts --no-audit --no-fund --no-update-notifier "$2"; }
```

## Per harness

| Harness | Version tested | Binary (under `~/.sage-harnesses`) | Admission with the quirks fixes |
|---|---|---|---|
| dsh | 0.2.0-rc.2 | `dsh/node_modules/.bin/dsh` | admitted |
| opencode | 1.18.35 | `opencode/node_modules/opencode-darwin-arm64/bin/opencode` | admitted |
| Kimi Code | 2.1.1 | `kimi/node_modules/.bin/kimi` | sign in first |
| Qwen Code | 0.25.0 | `qwen/node_modules/.bin/qwen` | sign in first |
| Copilot CLI | 1.0.95 | `copilot/node_modules/.bin/copilot` | sign in first: rejects stdio MCP servers, so its tools come over http (checked with 1.0.98) |
| Cursor CLI | 2026.10.01-e373342 | `cursor/2026.10.01-e373342/cursor-agent` | sign in first |
| Gemini CLI | 0.63.0 | `gemini/node_modules/.bin/gemini` | sign in first |
| Goose | 1.54.0 | `goose/bin/goose` | needs a provider and sign in |

Point the probe at them with a JSON map (`~/.sage-harnesses/bins.json`, with `~` expanded):

```sh
SAGE_ACP_BINS="$(cat ~/.sage-harnesses/bins.json)" node tests/conformance/acp/probe.mjs
```

Build `sage-mcp` first if `native/sage-mcp/build/sage-mcp` is missing: `node scripts/build-sage-mcp.mjs`. On Windows it is the Rust one (`core/crates/sage-mcp`, the same protocol over `127.0.0.1`): `cargo build --release -p sage-mcp` in `core/` gives `core/target/release/sage-mcp.exe`, and a Windows package ships it in `resources/core`. A Linux package ships the same Rust one, `resources/core/sage-mcp`, over MoPilot's Unix socket; a Linux checkout runs `host/bin/sage-mcp.mjs` under the login `PATH`'s Node. Without it no harness can say hello and every probe fails. Without the quirks fixes (the "Fix ACP quirks found by real-binary probes" PR), dsh is refused by its privacy gate. "Admission" above is with those fixes.

### dsh (DeepSeek Harness)

- Official: repo `deepseek-ai/deepseek-harness` (org site deepseek.com, repo homepage deepseek.com/harness), npm `@deepseek-ai/dsh` (maintainers include a deepseek.com address, repository field points at that repo). README install is `npx @deepseek-ai/dsh web`; the bin is `dsh`. All releases are previews; `latest` was 0.2.0-rc.2 (an alpha 0.2.1-alpha.2 exists).
- Install: `npm_i dsh @deepseek-ai/dsh@0.2.0-rc.2`
- Check: `dsh --version` prints `0.2.0-rc.2`. Over ACP its `agentInfo.version` is `0.0.1` (the bridge), so use `--version` for the release.
- Start for ACP: `dsh --profile acp --patch <patch.yml>`; the quirks write the patch (`electron/harness/quirks/dsh.patch.yml`). `--dump-config` with the same arguments must show `session-log-deepseek` `enabled: false` and `session-telemetry-otel` `mode: DISABLED`.
- Sign in: set `DEEPSEEK_API_KEY` in the environment dsh runs in, or use the account login from its own `dsh web` / `dsh tui`. Not done here. Without a credential `initialize` and `session/new` still work (`authMethods` is empty; `session/new` returns no config options and `image` is false).
- Admission: privacy gate passes with the patch, `initialize` ACP v1, `session/new` with a stdio sage-mcp server returns, hello in about 0.3 s.

### opencode

- Official: repo `anomalyco/opencode` (formerly `sst/opencode`), npm `opencode-ai` (maintainer thdxr, MIT). Docs list `curl -fsSL https://opencode.ai/install | bash` and `npm install -g opencode-ai`.
- Install: `npm_i opencode opencode-ai@1.18.35`. The npm package's `postinstall` only copies the platform binary (read and checked); with `--ignore-scripts` the binary is used where npm put it, in the `opencode-darwin-arm64` optional package.
- Check: `opencode --version` prints `1.18.35`. ACP: `opencode acp`.
- Sign in: `opencode auth login` (a terminal flow; not done). It works without a login on its free `opencode/*` models.
- Admission: `initialize` ACP v1, `session/new` returns config options `model` and `mode` (build, plan; no `modes` list) and pushes its command list, hello in about 0.5 s.

### Kimi Code

- Official: repo `MoonshotAI/kimi-code` (org site moonshot.ai), docs at kimi.com/code/docs, npm `@moonshot-ai/kimi-code` (MIT). The vendor's script is `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`; it was downloaded and read. It adds a PATH line to the shell rc file and renames or deletes any existing `kimi` command on PATH, so it was not run. The script itself names the npm package as the alternative.
- Install: `npm_i kimi @moonshot-ai/kimi-code@2.1.1` (`--ignore-scripts` skips the package's postinstall, which does the same legacy-shim migration).
- Check: `kimi --version` prints `2.1.1`. ACP: `kimi acp`.
- Sign in: run `kimi`, then `/login` (device code in a browser), or `kimi login`. Not done.
- Admission: `initialize` ACP v1 (load, resume, list, fork, close; image and embedded context), `session/new` answers "Authentication required". The sage-mcp handshake is untested until someone signs in.

### Qwen Code

- Official: repo `QwenLM/qwen-code`, npm `@qwen-code/qwen-code` (README: `npm install -g @qwen-code/qwen-code@latest`, Node 22+). Binary `qwen`.
- Install: `npm_i qwen @qwen-code/qwen-code@0.25.0`
- Check: `qwen --version` prints `0.25.0`. ACP: `qwen --acp`.
- Sign in: inside `qwen` run `/auth` (API key providers such as OpenAI-compatible, Anthropic, Gemini or Qwen; its ACP auth method is the OpenAI API key variable). Not done.
- Admission: `initialize` ACP v1, `session/new` answers "Authentication required" (it logs that the sage MCP server failed to start before it refuses). Handshake untested until signed in.

### Copilot CLI

- Official: repo `github/copilot-cli`, npm `@github/copilot` (README: `npm install -g @github/copilot`). Binary `copilot`.
- Install: `npm_i copilot @github/copilot@1.0.95`
- Check: `copilot --version` prints `GitHub Copilot CLI 1.0.95.` ACP: `copilot --acp`.
- Sign in: `/login` inside `copilot`, or `copilot login`. This Mac already had a Copilot sign-in in `~/.copilot` from before, which the probe used (the real home was not redirected); no new login was made.
- Admission: `initialize` ACP v1 (modes agent, plan, autopilot as ACP session-mode URLs, config options `mode` and `allow_all`), `session/new` accepts the call but sage-mcp never says hello (checked for 25 s). Its log says `Rejecting non-http/sse MCP server "sage_..." from client`: 1.0.95 takes only http and sse MCP servers. MoPilot now serves its tools to it over http (`capabilities/httpMcp.cjs`), so admission goes on to sign-in.

### Cursor CLI

- Official: `curl https://cursor.com/install -fsS | bash` (cursor.com/docs/cli/installation). The script was downloaded and read: it downloads `https://downloads.cursor.com/lab/<version>/<os>/<arch>/agent-cli-package.tar.gz`, unpacks under `~/.local/share/cursor-agent/versions/<version>` and symlinks `agent` and `cursor-agent` into `~/.local/bin`, replacing any existing ones. Because of the symlinks it was not run; the same download and unpack was done by hand.
- Install:
  ```sh
  mkdir -p $H/cursor/2026.10.01-e373342
  curl -fSL -o /tmp/cursor.tgz https://downloads.cursor.com/lab/2026.10.01-e373342/darwin/arm64/agent-cli-package.tar.gz
  shasum -a 256 /tmp/cursor.tgz   # 629e51de43a0b7fb3b86f5ebc7e579f7df7df941b39f29e82945cde750145afc (Cursor publishes no checksum)
  tar --strip-components=1 -xzf /tmp/cursor.tgz -C $H/cursor/2026.10.01-e373342
  ```
  The version in the URL is whatever `cursor.com/install` pins at the time; re-read the script for the current one.
- Check: `cursor-agent --version` prints `2026.10.01-e373342`. ACP: `cursor-agent acp` (same as `agent acp`).
- Sign in: `agent login`, then ACP `authenticate` with method `cursor_login`. Not done.
- Admission: `initialize` ACP v1 (no `agentInfo`, so the probe shows no version; load and list; image), `session/new` answers "Authentication required". Handshake untested.

### Gemini CLI

- Official: repo `google-gemini/gemini-cli`, npm `@google/gemini-cli` (Google's `google-wombot` publisher, Apache-2.0; README: `npm install -g @google/gemini-cli`). Binary `gemini`.
- Install: `npm_i gemini @google/gemini-cli@0.63.0`
- Check: `gemini --version` prints `0.63.0`. ACP: `gemini --acp`.
- Sign in: run `gemini` and pick "Sign in with Google", or set `GEMINI_API_KEY` (or Vertex variables). Not done.
- Admission: `initialize` ACP v1 (auth methods oauth-personal, gemini-api-key, vertex-ai, gateway), `session/new` answers "Gemini API key is missing or not configured". Handshake untested.

### Goose

- Official: repo `aaif-goose/goose` (Apache-2.0, docs at goose-docs.ai). Docs: `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash`. The script was downloaded and read: it downloads the release archive for the platform, moves the binary into `GOOSE_BIN_DIR` and, only if that directory isn't on PATH and configuring is allowed, offers to edit shell files.
- Install (pinned, nothing else touched):
  ```sh
  mkdir -p $H/goose/bin
  curl -fsSL -o /tmp/goose-install.sh https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh
  # read it, then:
  GOOSE_BIN_DIR=$H/goose/bin GOOSE_VERSION=v1.54.0 CONFIGURE=false bash /tmp/goose-install.sh </dev/null
  ```
- Check: `goose --version` prints `1.54.0`. ACP: `goose acp`.
- Sign in: `goose configure` (provider and API key), or set `GOOSE_PROVIDER` and `GOOSE_MODEL` plus that provider's key. Not done.
- Admission: `initialize` ACP v1 (load, list, close; image), `session/new` fails with "Configuration value not found: GOOSE_PROVIDER". With only `GOOSE_PROVIDER=ollama GOOSE_MODEL=llama3.2` set (a local provider, no credential) it succeeds, returns modes auto, approve, smart_approve, chat, and sage-mcp says hello in about 0.2 s. So MCP injection works once a provider exists.

## Observations while installing and probing

- The probe runs harnesses with the real home, so they created their own folders there (`~/.dsh`, `~/.gemini`, `~/.qwen`, `~/.kimi-code`, `~/.cursor`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.config/goose`, `~/.local/share/goose`, `~/.local/state/goose`). They hold no credentials and can be deleted.
- opencode on start runs `npm install` of its plugin packages in `~/.config/opencode`, creates a SQLite database, and fetches its model list; it also loaded 17 commands from the user's `~/.claude/skills` and reads `~/.claude/CLAUDE.md` as an instruction fallback. Goose also listed the user's Claude skills as commands.
- Copilot CLI contacted github.com (managed-policy fetch, update check) using the existing sign-in. Cursor wrote a `statsig-cache.json` (feature-flag service). dsh's default config uploads session logs to the DeepSeek API and OTel telemetry to `dsh-otel-collector.deepseeksvc.com`; the quirks turn both off. Gemini CLI (`privacy.usageStatisticsEnabled`) and Qwen Code usage statistics default to on.
- Cursor's helper processes can outlive the probe if the probe exits before they do; `pkill -f ~/.sage-harnesses/` cleans up.

## Remove everything

`rm -rf ~/.sage-harnesses`, plus the folders listed above if they didn't exist before.
