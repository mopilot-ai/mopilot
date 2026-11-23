# Native ACP harnesses

MoPilot hosts additional coding agents through the same main-owned ACP adapter. The static contract for each is
one JSON descriptor in `shared/harnesses/`. `scripts/harness-catalog.mjs` discovers and validates these files and
atomically generates the ignored catalog used by the app, server flags, install UI and version checks. Build,
test and typecheck preparation regenerate it, including pre-commit's isolated index checkout.

## Added integrations

- Auggie, Autohand, Cline, CodeBuddy and Qoder use their native `--acp` mode.
- Kilo, MiMo Code, oh-my-pi, Command Code, Devin, Hermes and Kiro use their native `acp` subcommand.
- Mistral Vibe ships the native `vibe-acp` executable. The interactive `vibe` executable is not mistaken for it.
- Droid uses `exec --output-format acp-daemon`; Grok uses `agent stdio`; TRAE uses `acp serve`.
- Muse uses `muse acp`, with `MUSE_EXPERIMENTAL_ACP=on` in that child only. The vendor marks this interface experimental.
- Prime Agent uses `--mode acp`. Version 0.10.0 is blocked because of its shared-setting behavior; versions without
  native load/resume are also unsupported.
- Qoder CN has a separate executable/account identity and its own descriptor. OpenCode's `opencode2` installer
  alias uses the existing OpenCode identity, adapter and history.

These entries ship on once each has an admission record from a real install (`tests/conformance/results/admission/`):
an entry with none ships off, as TRAE does while its installer serves only mainland China. Shipping on does not bypass
runtime admission. Missing executables, sign-in failures, incompatible protocols, absent native recovery and a failed
MoPilot tool handshake keep their own visible states, so an entry whose current version cannot be admitted (Prime Agent
without native resume, Hermes without the tool handshake, Kiro while signed out,
MiMo Code when it quits at startup) says why on its tile instead of opening a chat. A version is
listed as tested only when its record admitted it; a fake test or a documented entrypoint never adds one. A
development build can still opt into an entry that ships off with `MOPILOT_FLAGS=harness.acp.<id>.enabled=1`.

Every entry that ships on, or has a tested version, needs its vendor mark; the rest keep the named initial tile.

Kilo is an OpenCode fork and gets OpenCode's treatment: MoPilot adds `mopilot-ask` (asks before edits, commands
and web fetches) and `mopilot-full` (runs them without asking) to its own Kilo process through `KILO_CONFIG_CONTENT`,
never writing the user's settings, and a new Kilo chat starts in `mopilot-ask`. Kilo's own code and debug modes edit
and run its allowlist of commands without asking, so they are anchored at auto, not ask; its plan and ask modes are
read-only.

Unknown modes retain the existing ask permission anchor. Native plan/permission mappings are claimed only when
verified. Each chat holds its own process and tool channel unless session-scoped MCP isolation is proven. Model
catalog discovery uses the same process/account as the chat, does not authenticate interactively and never invents
a session default. Optional discovery failure does not block the session's own catalog.

## Deferred and excluded

OpenClaw's native ACP bridge rejects session-supplied MCP servers. Jcode currently ignores them and does not provide
the required host permission contract. Their current versions are deferred until upstream meets MoPilot's existing
tool-injection and permission requirements; no maintained fork or separate bridge is introduced here.

Aider, Amp, Pi, ZCode, Crush, Continue, OpenClaude, Codebuff, Freebuff, Ante and Rovo Dev are excluded from these
additions because a suitable native ACP entrypoint was not established. Community bridges and custom protocols
are outside this integration. Existing Codex, Claude Code and Antigravity integrations retain their own paths.

## Sources and borrowing

- [ACP Registry](https://github.com/agentclientprotocol/registry): vendor distributions and native launch arguments;
  its older external Autohand adapter is superseded by
  [Autohand's native interface](https://github.com/autohandai/code-cli/blob/main/docs/guides/ACP.md).
- [MiMo's native ACP implementation](https://github.com/XiaomiMiMo/MiMo-Code/tree/main/packages/cli/src/acp),
  [Command Code ACP](https://commandcode.ai/docs/acp), [Kiro ACP](https://kiro.dev/docs/acp/),
  [Hermes ACP](https://hermes-agent.nousresearch.com/docs/reference/cli-commands),
  [TRAE ACP](https://docs.trae.cn/cli_agent-client-protocol),
  [Muse native ACP](https://meta-models.github.io/muse-code-sdk/next/guides/editors-acp/).
- [Orca launch contracts at the inspected commit](https://github.com/stablyai/orca/blob/ccfe30a05f63516f837ff81c7c006088c744eeec/src/main/acp/acp-launch-specs.ts):
  executable aliases, separate model-discovery strategies, and native protocol differences. Grok extension
  envelopes and OMP structured command output are normalized at MoPilot's adapter boundary. Terminal keystroke
  injection, trust bypasses and UI emulation are not used. The upstream MIT notice is retained in the shipped
  third-party notices and `docs/licenses/orca-LICENSE.txt`.
- [OpenClaw ACP limitations](https://github.com/openclaw/openclaw/blob/main/docs/cli/acp.md),
  [Jcode ACP implementation](https://github.com/1jehuang/jcode/blob/main/src/cli/acp.rs),
  [Prime Agent continuation and shared-setting report](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3624).

## Verification

Focused UT run production detection, admission, process launch, permission handling, transcript publication and
restart routing with fake external processes. Coverage and concrete run results belong in the PR. A release must
verify real native behavior in CI or an isolated VM before stable enablement: create a chat, choose supported
controls, send text and supported attachments, allow/deny a tool, use MoPilot tools, Stop, reopen after restart,
and repeat with independent chats in the same folder. Broad suites and app launches remain governed by AGENTS.md.

### What release verification means for each entry

Each release checks every entry with these four steps on a real install, in a `mopilot-*` VM or on a GitHub runner,
never on a developer's desktop. Steps 1 and 2 need no account and gate shipping on; steps 3 and 4 need the vendor's
account and gate the claims a release makes about the entry (its mapped modes and its tested journey):

1. **Install.** The descriptor's install method puts the listed executable on PATH. An entry with no method shows only
   its docs link, so its vendor's documented installer is what the release installs.
2. **Admission without sign-in.** The production probe (`probeInstalled` in `tests/conformance/lib/acp.mjs`) runs
   `initialize` within the 10 s handshake; the agent advertises `loadSession` or `sessionCapabilities.resume`
   (`requireResume`); `session/new` either fails as a sign-in or returns a session in which sage-mcp says hello.
   The record goes in `tests/conformance/results/admission/<id>.json`.
3. **Admission signed in, and the anchors.** With the account the vendor requires, `session/new` succeeds and
   sage-mcp says hello (the tool handshake). The session's modes are recorded. Until each mode id is mapped to
   `readOnly`, `ask`, `auto` or `full` in `acp.anchors` and its plan mode in `acp.plan`, every mode keeps the `ask`
   anchor and no plan mode is claimed. Model discovery is checked here as well: the catalog comes from
   `session/new` (`models`, or the `model` config option), or for Grok from `initialize` `_meta.modelState` or
   `x.ai/models/list`, and it is never invented.
4. **The chat journey** in the list above: one chat with a turn, an allowed and a denied tool, a MoPilot tool, Stop,
   reopening after a restart through native load or resume, and a second chat in the same folder.

| Entry | Install (descriptor) | Launch | Sign-in the release needs (as the agent advertises it) |
| --- | --- | --- | --- |
| Auggie | npm `@augmentcode/auggie` | `auggie --acp` | Augment Code account (it advertises no sign-in method) |
| Autohand | npm `autohand-cli` | `autohand --acp` | Autohand account |
| Cline | npm `cline` | `cline --acp` | Cline account, ClinePass or a ChatGPT subscription, signed in from `cline` |
| CodeBuddy | npm `@tencent-ai/codebuddy-code` | `codebuddy --acp` | iOA, Google/GitHub, WeChat or an enterprise domain, signed in from `codebuddy` |
| Command Code | none (vendor: npm `command-code`) | `command-code acp` | Command Code account: `cmd login` |
| Devin | none (vendor archive) | `devin acp` | Devin account, browser sign-in from `devin` (`/login`) |
| Droid | npm `droid` | `droid exec --output-format acp-daemon` | Factory account by device pairing, or `FACTORY_API_KEY` |
| Grok | npm `@xai-official/grok` | `grok agent stdio` | grok.com account, signed in from `grok` |
| Hermes Agent | none (vendor `install.sh`) | `hermes acp` | a model provider: `hermes --setup` (or `hermes model`) |
| Kilo Code | npm `@kilocode/cli` | `kilo acp` | Kilo account: `kilo auth login` |
| Kiro | none (vendor archive) | `kiro-cli acp` | Kiro account: `kiro-cli login`, or `KIRO_API_KEY` |
| MiMo Code | npm `@mimo-ai/cli` | `mimo acp` | MiMo account (it advertises its OpenCode base's `opencode auth login`) |
| Mistral Vibe | none (vendor archive of `vibe-acp`) | `vibe-acp` | Mistral AI Studio account (browser), or `MISTRAL_API_KEY` |
| Muse | none (vendor `install.sh`) | `muse acp` (`MUSE_EXPERIMENTAL_ACP=on`) | Meta developer account: `muse login` (device code) |
| oh-my-pi | none (vendor: `bun install -g @oh-my-pi/pi-coding-agent`; needs Bun 1.4.4 or later) | `omp acp` | a model provider set up in `omp` |
| Prime Agent | none (vendor `install.sh`) | `prime-agent --mode acp` | Prime Intellect account: `/login` in `prime-agent` |
| Qoder | npm `@qoder-ai/qodercli` | `qodercli --acp` | Qoder account, signed in from `qodercli` (`/login`) |
| Qoder CN | none (vendor: npm `@qodercn-ai/qoderclicn`) | `qoderclicn --acp` | qoder.com.cn account, signed in from `qoderclicn` (`/login`) |
| TRAE | none (vendor `install_v2.sh` from trae.cn) | `traecli acp serve` | TRAE account: `traecli login` |
