// The names MoMo's chats see for a coding-side MCP server's tools (#2999 C0): the gateway's names (gateway/names.cjs) under MoMo's prefix, momo_mcp_<server>_<tag>_<tool>, so every proxied tool is told apart from MoMo's own tools by its name; a tool's identity for the allowlist is the gateway's toolKey (its name and a hash of its input schema).
const { proxiedNames: namesUnder, toolKey } = require('../../gateway/names.cjs');

const PREFIX = 'momo_mcp_';
/** Every proxied tool's name (toolTrust.cjs classes them by it). */
const PROXIED = /^momo_mcp_[a-z0-9_]+$/;

/**
 * The names of one server's tools in MoMo: momo_mcp_<server>_<tag>_<tool> (gateway/names.cjs).
 * @param {{ key: string, name: string }} server @param {string[]} tools
 * @returns {Map<string, string>} tool name → its name in MoMo
 */
const proxiedNames = (server, tools) => namesUnder(server, tools, PREFIX);

module.exports = { proxiedNames, toolKey, PROXIED, PREFIX };
