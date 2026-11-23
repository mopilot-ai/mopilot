// opencode confined for MoMo's chats (#2278): its tools run inside its own process, so the client can't refuse them one
// by one; the process MoMo's chats run on starts with every tool but MoPilot's own (sage_*) denied, which opencode
// also takes off the model's tool list (permission `"*": "deny"` on every agent, its built-in ones turned off and the
// session pinned to MoMo's), no project or Claude Code instructions or settings (OPENCODE_DISABLE_PROJECT_CONFIG,
// OPENCODE_DISABLE_CLAUDE_CODE), and a config folder of its own (XDG_CONFIG_HOME), so ~/.config/opencode's AGENTS.md,
// plugins, agents, MCP servers and skills don't load; only its providers and models are carried over. Its logins
// (~/.local/share/opencode) stay. ~/.opencode always loads (opencode reads it from the home folder), so a process
// isn't started while it holds settings of its own. Checked against opencode 1.18.35's config, agent, permission and
// instruction code.
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { mkdirPrivate } = require('../../platform/privateFiles.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { settingsFiles, jsoncText } = require('./opencodeMcp.cjs');

/** Every tool denied but MoPilot's own server's (opencode names an MCP tool `<server>_<tool>`). */
const MOMO_ONLY = Object.freeze({ '*': 'deny', 'sage_*': 'allow' });
/** The agent MoMo's chats run as: the only primary one this process has. */
const MOMO_AGENT = 'momo';
/** The process's own config: nothing of the user's but the providers and models below. */
const ISOLATED_CONFIG = Object.freeze({
  share: 'disabled',
  permission: MOMO_ONLY,
  default_agent: MOMO_AGENT,
  agent: {
    [MOMO_AGENT]: { mode: 'primary', description: "MoMo's own tools only", permission: MOMO_ONLY },
    build: { disable: true },
    plan: { disable: true },
    general: { disable: true },
    explore: { disable: true },
  },
});

/** The user's global settings carried over: which providers and models there are (none of them adds a tool). */
const MODEL_KEYS = Object.freeze(['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers']);
/** What opencode loads from ~/.opencode, besides its own binaries (bin/). */
const HOME_SETTINGS = Object.freeze([
  'opencode.json',
  'opencode.jsonc',
  'AGENTS.md',
  'plugin',
  'plugins',
  'agent',
  'agents',
  'mode',
  'modes',
  'command',
  'commands',
  'tool',
  'tools',
  'skill',
  'skills',
]);

/** Why MoMo can't run on opencode's free models: its free tier refuses any agent but its own (#2357). */
const NEEDS_PROVIDER = "MoMo needs an opencode provider (free models can't run MoMo)";
/** Provider keys opencode takes from the environment (models.dev's env names for the common providers). */
const KEY_VARS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'OPENCODE_API_KEY',
]);

/** Switches the user's shell may set that would bring their own settings back: cleared. */
const CLEARED = Object.freeze({ OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', OPENCODE_PERMISSION: '', OPENCODE_TUI_CONFIG: '' });

/**
 * The providers and models the user's global settings define, later files winning (a provider by its id).
 * @param {Record<string, string | undefined>} env @param {(file: string) => string} read
 */
function modelSettings(env, read) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const file of settingsFiles(env)) {
    let config;
    try {
      config = JSON.parse(jsoncText(read(file)));
    } catch (error) {
      // a missing file has nothing to carry over; one that doesn't parse is opencode's own to report
      noteIgnored("read opencode's settings for MoMo", error, ['ENOENT', 'ENOTDIR']);
      continue;
    }
    for (const key of MODEL_KEYS) {
      if (config?.[key] == null) continue;
      out[key] = key === 'provider' ? { ...out.provider, ...config.provider } : config[key];
    }
  }
  return out;
}

/**
 * Whether opencode has a provider MoMo can run on: a login or key it keeps (auth.json, from `opencode auth login`), a
 * provider in the user's settings (carried over to MoMo's process), or a provider key in the environment.
 * @param {Record<string, string | undefined>} env @param {(file: string) => string} read
 */
function hasProvider(env, read) {
  if (KEY_VARS.some((k) => !!env[k])) return true;
  if (Object.keys(modelSettings(env, read).provider ?? {}).length) return true;
  const data = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share');
  try {
    const auth = JSON.parse(read(path.join(data, 'opencode', 'auth.json')));
    return !!auth && typeof auth === 'object' && Object.keys(auth).length > 0;
  } catch (error) {
    noteIgnored("read opencode's logins for MoMo", error, ['ENOENT', 'ENOTDIR']);
    return false;
  }
}

const opencodeIsolation = Object.freeze({
  /**
   * Why MoMo can't run on opencode now, or null: with free models only, every MoMo message would fail (#2357).
   * @param {{ env: Record<string, string | undefined> }} ctx
   * @param {{ read?: (file: string) => string }} [io] tests
   */
  blocked(ctx, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
    return hasProvider(ctx.env, read) ? null : NEEDS_PROVIDER;
  },
  /**
   * The env MoMo's opencode process starts with, last over everything else; fails closed without a data folder or
   * while ~/.opencode holds settings of its own.
   * @param {{ dataDir: string | null, env: Record<string, string | undefined> }} ctx
   * @param {{ exists?: (p: string) => boolean, read?: (file: string) => string }} [io] tests
   */
  env(ctx, { exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
    if (!ctx.dataDir) throw new Error("opencode has no folder of its own for MoMo's chats");
    const home = path.join(ctx.env.HOME || os.homedir(), '.opencode');
    const found = HOME_SETTINGS.filter((f) => exists(path.join(home, f)));
    if (found.length) throw new Error(`opencode can't run MoMo's chats while ${home} has settings of its own (${found.join(', ')})`);
    const config = path.join(ctx.dataDir, 'isolated', 'opencode', 'config');
    mkdirPrivate(config);
    return {
      ...CLEARED,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...modelSettings(ctx.env, read), ...ISOLATED_CONFIG }),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      XDG_CONFIG_HOME: config,
    };
  },
  /** opencode's modes are its primary agents, the values of its `mode` config option. */
  mode: Object.freeze({ configOption: 'mode', value: MOMO_AGENT }),
});

module.exports = { opencodeIsolation, ISOLATED_CONFIG, MOMO_ONLY, HOME_SETTINGS, NEEDS_PROVIDER };
