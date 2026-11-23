// Keeps vendor skills that name Claude Desktop's tools away from MoPilot sessions. The account's claude.ai skills
// (anthropic-skills:built-in-browser, :computer-use, :chrome-browser) reach every Claude Code session the CLI starts
// for that account and tell the model to call mcp__Claude_Browser__*, mcp__computer-use__* and mcp__claude-in-chrome__*;
// MoPilot serves mcp__mopilot_browser__*, mcp__mopilot_computer__* and mcp__mopilot_chrome__* instead
// (capabilities/contract/hostServers.cjs). The CLI's `skillOverrides` setting ("off") hides a skill from the model and the
// Skill tool, and MoPilot's own plugin (plugins/builtin) supplies mopilot:built-in-browser, :computer-use and :chrome-browser.

/** The vendor skill names (as the CLI lists them) with the tool namespace each one is written for. */
const VENDOR_SKILLS = Object.freeze({
  'anthropic-skills:built-in-browser': 'mcp__Claude_Browser__',
  'anthropic-skills:computer-use': 'mcp__computer-use__',
  'anthropic-skills:chrome-browser': 'mcp__claude-in-chrome__',
});

/**
 * The `skillOverrides` setting for a session: every vendor skill off, except the Chrome one while the session has
 * Claude in Chrome itself. Each skill is keyed by its listed name and by its bare name, since the CLI matches a
 * synced skill by either.
 * @param {{ nativeChrome?: boolean }} [o]
 * @returns {Record<string, 'off'>}
 */
function vendorSkillOverrides({ nativeChrome = false } = {}) {
  const keep = (name) => nativeChrome && name.endsWith('chrome-browser');
  const names = Object.keys(VENDOR_SKILLS).flatMap((name) => [name, name.slice(name.indexOf(':') + 1)]);
  return Object.fromEntries(names.filter((name) => !keep(name)).map((name) => [name, /** @type {const} */ ('off')]));
}

/**
 * A note for the system prompt naming the tool namespaces this app serves, for text (a CLAUDE.md, a page, a skill)
 * that mentions Claude Desktop's. With Claude in Chrome on, the user's Chrome is its own tools.
 * @param {{ nativeChrome?: boolean }} [o]
 */
function toolNamespaceNote({ nativeChrome = false } = {}) {
  const chrome = nativeChrome
    ? "and the user's Chrome is mcp__claude-in-chrome__* (Claude in Chrome is on)"
    : "and the user's Chrome is mcp__mopilot_chrome__*";
  const gone = nativeChrome
    ? 'mcp__Claude_Browser__* and mcp__computer-use__*'
    : 'mcp__Claude_Browser__*, mcp__computer-use__* and mcp__claude-in-chrome__*';
  return [
    `Tool names in this app: the built-in browser is mcp__mopilot_browser__*, computer use is mcp__mopilot_computer__*, ${chrome}.`,
    `Names such as ${gone} do not exist here; use the matching tool above, and the mopilot:built-in-browser and mopilot:computer-use skills${nativeChrome ? '' : ' (and mopilot:chrome-browser)'}.`,
  ].join(' ');
}

module.exports = { VENDOR_SKILLS, vendorSkillOverrides, toolNamespaceNote };
