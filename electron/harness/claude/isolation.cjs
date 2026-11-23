// A Claude Code session kept apart from the coding side (MoMo's chat, #2139): no CLAUDE.md (the user-level
// ~/.claude/CLAUDE.md included), no auto memory, and default deny for tools (#2305): none of Claude Code's own tools, no MCP
// server but MoPilot's own (whose tools the registry's chat scope already keeps to MoMo's), no claude.ai connectors
// and no skills, and a call to any other tool refused in every permission mode. Still applied (degraded, #2139): the
// user's hooks and output style (settingSources is kept, so logins and permissions keep working).

/**
 * The CLI's own switches: no memory files, no auto memory, and none of the account's claude.ai connectors (Gmail, Drive…),
 * which would send data outside MoMo's sources and trust rules.
 */
const ISOLATED_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
});

/**
 * Turn a session's options into an isolated session's, in place. Tools are an allowlist, never a list of what to take
 * away: the CLI gets an empty built-in tool set (`--tools ""`: no Bash, Read, Agent, Workflow, Monitor, WebFetch, WebSearch,
 * Cron… nor any tool a later CLI adds), loads only the MCP servers in `mcpServers` (`--strict-mcp-config`: MoPilot's
 * own, added after this; not the user's, a project's or a plugin's) and no claude.ai connectors, and lists no skills (the
 * prompt's skill listing; with no Skill tool none could run). A permission mode's auto-allowed built-ins go too: only
 * MoPilot's read-only tools are added to that list afterwards (injectSdkMcpServers).
 * @param {{ env?: Record<string, string | undefined>, settings?: any, tools?: unknown, strictMcpConfig?: boolean,
 *   skills?: unknown, allowedTools?: string[] }} options the SDK query options
 */
function isolateOptions(options) {
  options.env = { ...options.env, ...ISOLATED_ENV };
  options.settings = { ...(options.settings ?? {}), autoMemoryEnabled: false };
  options.tools = [];
  options.strictMcpConfig = true;
  options.skills = [];
  if (Array.isArray(options.allowedTools)) options.allowedTools = [];
}

const DENIED = "MoMo's chats use only MoMo's own tools.";
/** canUseTool's answer, in an isolated session, for a tool that isn't one of MoPilot's own it was given. */
const ISOLATED_DENIAL = Object.freeze({ behavior: /** @type {const} */ ('deny'), message: DENIED });
/** The same refusal from a PreToolUse hook, which the CLI runs in every permission mode (canUseTool isn't asked under Full access). */
const HOOK_DENIAL = Object.freeze({
  hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENIED }),
});

/**
 * Default deny for an isolated session's tool calls, past what `--tools ""` and `--strict-mcp-config` already keep out (a
 * tool an older or newer CLI still offers): a PreToolUse hook refuses any tool `given` doesn't name, in every permission
 * mode, and the permission check refuses it without a card; a given tool goes on to the session's own check.
 * @param {{ canUseTool?: (toolName: string, input: any, o: any) => any, hooks?: Record<string, any[]> }} options the SDK
 *   query options, changed in place
 * @param {(toolName: string) => boolean} given
 */
function confineTools(options, given) {
  const ask = options.canUseTool;
  options.canUseTool = (toolName, input, o) => (given(toolName) && ask ? ask(toolName, input, o) : Promise.resolve({ ...ISOLATED_DENIAL }));
  const gate = async (/** @type {{ tool_name?: unknown }} */ input) =>
    typeof input?.tool_name === 'string' && given(input.tool_name) ? {} : HOOK_DENIAL;
  const hooks = options.hooks ?? {};
  options.hooks = { ...hooks, PreToolUse: [{ hooks: [gate] }, ...(hooks.PreToolUse ?? [])] };
}

module.exports = { isolateOptions, confineTools, ISOLATED_ENV, ISOLATED_DENIAL, HOOK_DENIAL };
