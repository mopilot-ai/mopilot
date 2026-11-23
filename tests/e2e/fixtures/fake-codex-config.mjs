// The effective config the scripted Codex fixture reports from config/read: Codex's own defaults, with the `[features]` of
// the config.toml in the fixture's CODEX_HOME laid over them, as the real app-server reads its home. MoMo's own app-server
// runs on MoMo's home (electron/harness/codexMomoHome.cjs), whose `[features]` turn Codex's shell, exec and image tools
// off, which the app confirms before each MoMo run (CodexIsolation.shellOff); the user's home turns none off.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

/** What Codex has on with no config: the switches an isolated chat's config and MoMo's home turn off, among others. */
export const DEFAULT_FEATURES = Object.freeze({
  shell_tool: true,
  unified_exec: true,
  view_image: true,
  multi_agent: true,
  memories: true,
  external_agent_memory_import: true,
  hooks: true,
  skill_search: true,
  code_mode_host: true,
});

/**
 * The features Codex reports for a home: the defaults, then the home's own `[features]` that name a boolean. A home with
 * no config.toml, or one that can't be read, has the defaults.
 * @param {string} codexHome
 * @returns {Record<string, boolean>}
 */
export function effectiveFeatures(codexHome) {
  let own = {};
  try {
    const doc = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    own = Object.fromEntries(Object.entries(doc.features ?? {}).filter(([, v]) => typeof v === 'boolean'));
  } catch {
    /* no config of its own: Codex's defaults */
  }
  return { ...DEFAULT_FEATURES, ...own };
}

/** A saved model can lag behind model/list's recommendation, as in an existing Codex installation. */
function configuredModel(codexHome, fallback) {
  try {
    const model = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).model;
    return typeof model === 'string' ? model : fallback;
  } catch {
    return fallback;
  }
}

/**
 * config/read's `config`: the model and the user's MCP servers, and the home's features (a MoMo chat's app-server reports
 * its shell off).
 * @param {string} codexHome @param {string} model @param {Record<string, unknown>} mcpServers
 */
export const configOf = (codexHome, model, mcpServers) => ({
  model: configuredModel(codexHome, model),
  model_reasoning_effort: 'medium',
  mcp_servers: mcpServers,
  features: effectiveFeatures(codexHome),
});

/** The feature list's answer (experimentalFeature/list) as codex-cli 0.166 gives it: MCP tools deferred behind Codex's own tool search, so MoPilot lists them all (G2 tiers). */
export const configHandlers = {
  'experimentalFeature/list': () => ({
    data: [{ name: 'tool_search_always_defer_mcp_tools', stage: 'removed', enabled: true, defaultEnabled: true }],
    nextCursor: null,
  }),
};
