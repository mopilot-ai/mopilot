// Where each harness's own config can send its requests somewhere else (a gateway such as magpie, another vendor's endpoint): its files, keys and variables, its vendor's hosts and model names. Data only; shared/route.mjs reads it.
//
// A reference is '<source>:<dotted.path>'. The source is a file's id below or 'env' (the environment the
// harness gets). A path segment in braces is another reference whose value is that one segment, so
// 'config:model_providers.{config:model_provider}.base_url' follows the provider the config names. A
// file path may start with '{env:NAME|fallback}' and '~'. In each list the first reference with a value wins.
// A nested reference list is one variable's precedence group: its first defined scalar wins, even if empty.
//
// The keys are the ones the harnesses document and the ones magpie (github.com/yetone/magpie,
// internal/agent/<harness>.go) writes when it connects a harness; a key that is missing reads as unset.

/**
 * @typedef {{ id: string, path: string, format: 'toml' | 'json' | 'yaml' | 'dotenv', os?: string[], overlay?: string }} RouteFile
 *   overlay: a table whose keys override the top level (Codex's active profile)
 * @typedef {string | string[]} RouteRef a key, or high-to-low copies of the same variable
 * @typedef {{
 *   files: RouteFile[],
 *   endpoint?: RouteRef[],
 *   provider?: RouteRef[],
 *   model?: RouteRef[],
 *   models?: RouteRef[],
 *   catalog?: RouteRef[],
 *   cloud?: { ref: RouteRef, label: string }[],
 *   vendorHosts?: string[],
 *   vendorModel?: string,
 *   multiProvider?: boolean,
 *   appliesLive?: boolean,
 * }} HarnessRouteInfo
 *   models: further model settings (Claude's per-tier models) that also count when they name another vendor's model;
 *   catalog: a model list the config points at (shown, never a route on its own);
 *   cloud: switches that send the harness to a cloud account;
 *   multiProvider: picking a provider is the harness's ordinary setup, so only a known router counts as a route;
 *   appliesLive: a running process picks a change up by itself, so it never needs Restart to apply.
 */

/** @type {Record<string, HarnessRouteInfo>} keyed by harness kind ('codex', 'claude', 'acp:<id>') */
export const HARNESS_ROUTES = {
  codex: {
    files: [{ id: 'config', path: '{env:CODEX_HOME|~/.codex}/config.toml', format: 'toml', overlay: 'config:profiles.{config:profile}' }],
    // a provider's table names its endpoint; openai_base_url moves the built-in OpenAI provider
    endpoint: ['config:model_providers.{config:model_provider}.base_url', 'config:openai_base_url'],
    provider: ['config:model_provider'],
    model: ['config:model'],
    catalog: ['config:model_catalog_json'],
    vendorHosts: ['api.openai.com', 'chatgpt.com'],
    vendorModel: '^(gpt-|o\\d|codex-)[^/]*$',
  },
  claude: {
    files: [
      // managed settings outrank the user's own
      { id: 'managed', path: '/Library/Application Support/ClaudeCode/managed-settings.json', format: 'json', os: ['darwin'] },
      { id: 'managed', path: '/etc/claude-code/managed-settings.json', format: 'json', os: ['linux'] },
      { id: 'settings', path: '{env:CLAUDE_CONFIG_DIR|~/.claude}/settings.json', format: 'json' },
    ],
    // the CLI applies settings.json's env block itself; MoPilot drops the login shell's endpoint variables
    endpoint: [['managed:env.ANTHROPIC_BASE_URL', 'settings:env.ANTHROPIC_BASE_URL']],
    // ANTHROPIC_MODEL outranks settings.json's model
    model: [['managed:env.ANTHROPIC_MODEL', 'settings:env.ANTHROPIC_MODEL', 'env:ANTHROPIC_MODEL'], 'managed:model', 'settings:model'],
    models: ['OPUS', 'SONNET', 'HAIKU', 'FABLE'].map((t) => [
      `managed:env.ANTHROPIC_DEFAULT_${t}_MODEL`,
      `settings:env.ANTHROPIC_DEFAULT_${t}_MODEL`,
    ]),
    cloud: [
      ['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'],
      ['CLAUDE_CODE_USE_VERTEX', 'Google Vertex AI'],
      ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry'],
    ].map(([v, label]) => ({ ref: [`managed:env.${v}`, `settings:env.${v}`], label })),
    vendorHosts: ['api.anthropic.com'],
    // the CLI watches its settings files: a running process sent its next request to the new ANTHROPIC_BASE_URL
    // (observed in a dev instance on 2026-10-17, issue #1314)
    appliesLive: true,
    // full ids, cloud ids (us.anthropic.claude-…) and the CLI's aliases, with an optional [1m]
    vendorModel: '(^|[./])claude|^(opus|sonnet|haiku|fable|default|best|opusplan)(\\[1m\\])?$',
  },
  'acp:gemini': {
    files: [
      { id: 'dotenv', path: '~/.gemini/.env', format: 'dotenv' },
      { id: 'settings', path: '~/.gemini/settings.json', format: 'json' },
    ],
    endpoint: ['env:GOOGLE_GEMINI_BASE_URL', 'dotenv:GOOGLE_GEMINI_BASE_URL'],
    model: ['env:GEMINI_MODEL', 'settings:model.name'],
    vendorHosts: ['googleapis.com'],
    vendorModel: '^(models/)?gemini-',
  },
  'acp:qwen': {
    files: [{ id: 'settings', path: '{env:QWEN_HOME|~/.qwen}/settings.json', format: 'json' }],
    endpoint: ['settings:model.baseUrl', 'env:OPENAI_BASE_URL'],
    model: ['settings:model.name', 'env:OPENAI_MODEL'],
    vendorHosts: ['qwen.ai', 'aliyuncs.com'],
    vendorModel: '^(qwen|coder-model|vision-model)',
  },
  'acp:kimi': {
    files: [{ id: 'config', path: '{env:KIMI_SHARE_DIR|~/.kimi}/config.toml', format: 'toml' }],
    // default_model names a [models."<key>"] table, which names its [providers.<name>] table
    endpoint: ['config:providers.{config:models.{config:default_model}.provider}.base_url'],
    provider: ['config:models.{config:default_model}.provider'],
    model: ['config:default_model'],
    vendorHosts: ['moonshot.cn', 'moonshot.ai', 'kimi.com'],
    vendorModel: '^(kimi|moonshot)',
  },
  'acp:goose': {
    files: [{ id: 'config', path: '~/.config/goose/config.yaml', format: 'yaml' }],
    provider: ['env:GOOSE_PROVIDER', 'config:GOOSE_PROVIDER', 'config:active_provider'],
    model: ['env:GOOSE_MODEL', 'config:GOOSE_MODEL'],
    multiProvider: true,
  },
  'acp:dsh': {
    // the home layer's pick; a profile's own patch list is not read
    files: [{ id: 'settings', path: '{env:DSH_HOME|~/.dsh}/settings.yaml', format: 'yaml' }],
    provider: ['settings:agent-default-model.provider'],
    model: ['settings:agent-default-model.model'],
    multiProvider: true,
  },
  'acp:opencode': {
    files: [{ id: 'config', path: '~/.config/opencode/opencode.json', format: 'json' }],
    model: ['config:model'],
    multiProvider: true,
  },
};
