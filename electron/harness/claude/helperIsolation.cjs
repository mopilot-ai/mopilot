// The Claude Code helper runs written for a MoMo chat (a harness switch's handoff note, a title; #2364) held as tight as the
// chat itself (harness/claude/isolation.cjs): no CLAUDE.md or AGENTS.md of the user's or the project's, no memory, no built-in
// tools and no MCP server or connector, so the user's coding-side instructions never shape what MoMo carries over.
const { isolateOptions } = require('./isolation.cjs');

/**
 * Turn a helper query's options into a confined one, in place: the chat session's own isolation (CLAUDE.md and memory off by
 * the CLI's switches; the settings sources stay, as in the chat, so the login and permissions the note needs keep working),
 * and no built-in tools, MCP servers or connectors.
 * @param {Record<string, any>} options the SDK query options of a helper run for an isolated chat
 */
function confineHelperOptions(options) {
  isolateOptions(options);
  options.tools = [];
  options.strictMcpConfig = true;
  options.env = { ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
}

module.exports = { confineHelperOptions };
