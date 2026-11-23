# Plugins across harnesses

Status (2026-10-14): implemented and unit tested across work packages WP1–WP6 (#1088, #1093, #1096, #1098, #1099, #1103). Real-harness checks are listed under [Verification](#verification) and run with a release.

## What the user gets

A plugin is installed once, in MoPilot's own store, and every harness gets what it can run of it, in its own form. The Plugins page opens on **All harnesses**:

- **Installed**: a card per plugin with one switch. A harness that doesn't get all of it (off there, partly, nothing, or a failed install) is the only harness named. A plugin's page has what reaches each family, a switch per family, what it includes, and Uninstall; MoPilot's own plugins can't be uninstalled, since a removed one isn't seeded again. Plugins Claude Code or Codex installed themselves are under **On this Mac**; installing one copies it into the store, after the same review.
- **Discover**: plugins from the marketplaces the user added. Installing first shows a review: what the plugin includes, every command and remote MCP server it will run on this Mac, and any harness that won't get all of it. Main refuses an install whose commands changed since the review.
- **Marketplaces**: one of the official sources, a folder, `owner/repo` on GitHub, or a git URL (`#ref` for a branch or tag), in Claude Code's (`.claude-plugin/marketplace.json`) or Codex's (`.agents/plugins/marketplace.json`) layout. Removing one leaves the plugins installed from it.

The sidebar lists the store's plugins, then those Codex installed itself. Codex's copies of store plugins (`mopilot-*` marketplaces) are shown only by the store.

The tabs per first-class harness keep that harness's own catalog (Codex's marketplace and app connectors, Claude Code's installed plugins). Skills pages stay per harness.

## Store

`~/.mopilot/plugins/` (`electron/plugins/store.cjs`, `marketplaces.cjs`):

| Path | What |
|---|---|
| `installed.json` | `{version, plugins: {"<name>@<marketplace>": {path, version, enabled, harnesses, trusted, origin, installedAt, updatedAt}}}`; serialized, atomic writes; a file saved by a newer MoPilot is never rewritten |
| `cache/<marketplace>/<plugin>/<version>-<id>/` | one folder per install, never changed afterwards; links are copied as what they point at and refused if they leave the plugin; old folders go once no session holds them |
| `marketplaces/<name>/`, `known.json` | git marketplaces (staged checkouts swapped into place) and the list of sources |
| `cache/<marketplace>/.agents/plugins/marketplace.json` | the Codex marketplace the mirror generates (`mopilot-<marketplace>`) |
| `codex-mirror.json` | what the Codex mirror did with each plugin |

A plugin's manifest is read in either layout into one `PluginSpec` (`shared/plugins/manifest.mjs`): skills, commands, agents, hooks, MCP servers and app connectors. **Trust** is the SHA-256 of `whatRuns(spec)` — every local MCP command, remote MCP URL and hook command, with the plugin's folder written as `${PLUGIN_ROOT}` — so a plugin that changes what it runs is withheld from every harness until reviewed again.

## Delivery per harness

| | Claude Code | Codex | Basic tier (ACP) |
|---|---|---|---|
| How | each plugin folder in the Agent SDK's per-session `plugins` option (`--plugin-dir`) | installed with Codex's `plugin/install` from MoPilot's local marketplaces; switched per thread | MCP servers in `session/new`/`session/load` `mcpServers`; skills and commands from MoPilot |
| Skills, commands | native | native (commands become skills) | `/` menu and `plugin_skills` / `plugin_skill_read` |
| MCP servers | native | native | stdio unless quirks `mcpStdio: false`; http/sse when `initialize` advertises them |
| Hooks | native | installed (Codex's own hook trust applies) | not run |
| Agents | native (subagents) | as skills: the mirror installs a copy of the plugin with a `skills/agent-<name>/SKILL.md` per agent | as skills over `plugin_skills` / `plugin_skill_read` (entries named `<plugin>:agent:<name>`) |
| App connectors | not delivered (Codex only) | native | not run |
| Already installed natively | left to Claude Code (by name, from user, project, local or managed settings) | left to Codex (by name, from its own marketplaces) | — |
| Old CLI / failed install | a CLI without `--plugin-dir` starts without plugins; `plugin_skills` serves their skills | a failed install is recorded; `plugin_skills` serves its skills | — |
| Code | `electron/plugins/delivery.cjs` `forClaude`, `electron/harness/claude/sessions.cjs` | `electron/plugins/codexMirror.cjs`, `CodexToolInjection.pluginConfig` | `delivery.cjs` `forAcp`, `electron/harness/acp.cjs`, `electron/harness/acpTurns.cjs` |

What reaches each family is one table, `shared/plugins/reach.mjs`; delivery and every line on the Plugins page read it, so they never disagree. Delivery runs in main at session start, so scheduled runs, mid-chat harness switches (the new segment's adapter delivers) and chats with no window open get plugins the same way. A delivery that fails never stops a session from starting; what was withheld is recorded with its reason.

**Agents off Claude Code** run as skills in the chat, not as separate subagents; the Plugins page says so (`REACH_NOTE`). `shared/plugins/agentSkill.mjs` is the one conversion: the agent's description and instructions, its `tools`/`model` front matter dropped. For Codex the mirror installs from a derived copy, `cache/<marketplace>/.codex-agents/<plugin>/<install folder>/` (the store's own folders never change), pruned on upgrade, uninstall, `plugins.codex` off and when a marketplace goes. A skill or command of the plugin named `agent-<name>` wins and that agent is reported as left out (`plugin.agentNameTaken`). A plugin whose manifest points `skills` away from `skills/` would not load the generated skills (not handled). The trust digest is unchanged: agents run no commands.

Codex's install is global: the standalone Codex app and CLI see the plugins too. The mirror syncs on every store change, when Codex first starts and after it restarts, and only while Codex is up; a store that can't be read leaves Codex as it is, and only `mopilot-*` marketplaces inside the store's folder are the mirror's.

## Capability and switches

`plugins` is a semantic (`shared/caps.mjs`): Codex and Claude Code bind it as `config('plugins')` — Claude Code's behind the `claude.pluginDirs` probe, which a session reports once its CLI loaded the plugin folders — and the basic tier as `polyfill('plugins')`. Remote switches `plugins.codex`, `plugins.claude` and `plugins.acp` (`electron/platform/flags.cjs`, `web/lib/flags.ts`) turn delivery off per family and set `sage.plugins` false for that family's chats; with `plugins.codex` off, chat threads switch the mirrored plugins off at once and the next sync takes them out of Codex. MoPilot's helper threads never get them.

## Verification

Unit tests: `npm run test:coverage -- --changed --related` reaches `tests/plugin*.test.ts`, `tests/codexPluginMirror.test.ts`, `tests/acpPlugins.test.ts`, `tests/killSwitch.test.ts` and the composer and Plugins page suites.

With a release (real harnesses, not run by agents on a user's computer):

1. Install a plugin with a skill, a command, a stdio MCP server and a hook from a local marketplace; open a chat on each of Codex, Claude Code and an admitted ACP harness.
2. Claude Code: the skill is listed as `/<plugin>:<skill>`, the MCP server's tools are callable, the hook runs; with a CLI without `--plugin-dir`, the session starts and `plugin_skills` lists the skill.
3. Codex: `skills/list` shows `<plugin>:<skill>`; the hook runs (or Codex asks to trust it); `plugins.codex` off removes the plugin from Codex after the next sync.
4. ACP (opencode or dsh): the MCP server is in `session/new`; `/` lists the skill; picking it makes the model call `plugin_skill_read`.
5. Edit an installed plugin's `.mcp.json`: every harness withholds it until it is reviewed again.
