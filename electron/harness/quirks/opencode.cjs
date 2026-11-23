// opencode over ACP: `opencode acp`. Its modes are its primary agents, sent as the values of its `mode` config option
// (no modes list): build (its own permission settings) and plan (no edits), plus the two MoPilot adds through
// OPENCODE_CONFIG_CONTENT so the composer can choose how much it may do: mopilot-ask (asks before edits, commands and
// web fetches) and mopilot-full (runs them without asking). The config is only this process's, merged over the user's
// own and never written to it. /init, /review, /compact come through its command list. Sessions load, resume and
// fork. Sharing a session (a public link on opncd.ai) is turned off the same way. Provider logins happen in its own
// terminal UI (`opencode auth login`). A failing provider (a rate limit, a header timeout) is retried in silence, with
// no update and no prompt result, so opencode prints its errors to stderr (--print-logs at ERROR) and providerError
// reads its stream errors from there for the running prompt (acp/providerErrors.cjs, #1534).
const { opencodeStreamError } = require('../acp/providerErrors.cjs');
const { opencodeServers, opencodeLayer } = require('./opencodeMcp.cjs');
const { opencodeIsolation } = require('./opencodeIsolation.cjs');

const ASK = { edit: 'ask', bash: 'ask', webfetch: 'ask' };
const FULL = { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' };
const CONFIG = {
  share: 'disabled',
  agent: {
    'mopilot-ask': { mode: 'primary', description: 'Asks before edits, commands and web fetches', permission: ASK },
    'mopilot-full': { mode: 'primary', description: 'Edits, runs commands and fetches without asking', permission: FULL },
  },
};
module.exports = {
  label: 'opencode',
  bins: ['opencode'],
  args: ['acp', '--print-logs', '--log-level', 'ERROR'],
  providerError: opencodeStreamError,
  env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG) },
  privacyDefaults: ['session sharing (share: disabled)'],
  admission: { handshakeTimeoutMs: 10_000 },
  anchors: { plan: 'readOnly', build: 'ask', 'mopilot-ask': 'ask', 'mopilot-full': 'full' },
  // build follows the user's own opencode permissions: it is opencode's own agent, in the mode menu (#1875)
  permissionModes: { plan: 'read-only', 'mopilot-ask': 'default', 'mopilot-full': 'full-access' },
  agentModes: ['build'],
  plan: { configOption: 'mode', value: 'plan' },
  loginCommand: ['opencode', 'auth', 'login'],
  // `opencode --session <id>` continues a session (checked against `opencode --help`, 1.18.35)
  resumeCommand: (id) => `opencode --session ${id}`,
  // AGENTS.md, with CLAUDE.md as the project fallback; the user-level file is ~/.config/opencode/AGENTS.md
  instructionsFiles: ['AGENTS.md', '~/.config/opencode/AGENTS.md'],
  // the MCP servers in the user's own opencode settings, and the layer over them that turns some off for MoPilot's process only (#1575; electron/harness/acp/ownMcp.cjs)
  mcp: { servers: (env) => opencodeServers(env), off: (names) => opencodeLayer(CONFIG, names) },
  // MoMo's chats: a process of their own with opencode's own tools, instructions and settings off (#2278)
  isolation: opencodeIsolation,
};
