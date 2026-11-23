// Spike (#1320): Claude Code behind the upstream ACP adapter, @agentclientprotocol/claude-agent-acp (the renamed Zed
// claude-code-acp), which the developer installs into a scratch prefix; listed only while its developer flag is on
// (quirks/index.cjs SPIKE_IDS). The adapter wraps the Agent SDK, and CLAUDE_CODE_EXECUTABLE points it at a `claude` on
// the login shell's PATH (without one, the SDK's bundled copy). The first-class adapter runs the CLI chosen in Settings,
// else the newest installed: for a like-for-like comparison, start MoPilot with CLAUDE_CODE_EXECUTABLE set to it.
// Its modes are Claude Code's permission modes, and plan is one of them. Its sessions are Claude Code's own
// (~/.claude/projects), so `claude --resume` continues one.
const { which, AUTH_IDENTITY_ENV } = require('../../platform/env.cjs');

/** The `claude` the adapter runs: one the environment already names, else the first on its PATH. */
const claudePath = (env, find = which) => env.CLAUDE_CODE_EXECUTABLE || find('claude', env.PATH ?? '') || null;

module.exports = {
  label: 'Claude Code (ACP)',
  // its sessions are Claude Code's own and show in MoPilot's Claude Code list: no hidden title session (#2150)
  titleSessions: false,
  bins: ['claude-agent-acp'],
  launch: (ctx) => {
    const claude = claudePath(ctx.env);
    // as the first-class adapter's cleanEnv: the CLI runs on its own login, not on an API key, token or nested-session
    // marker MoPilot's own environment carries (an undefined value leaves the variable out of the child's)
    const scrub = Object.fromEntries(
      Object.keys(ctx.env)
        .filter((k) => AUTH_IDENTITY_ENV.test(k))
        .map((k) => [k, undefined]),
    );
    return { args: [], env: { ...scrub, ...(claude ? { CLAUDE_CODE_EXECUTABLE: claude } : {}) } };
  },
  // the first-class adapter turns nothing off either: Claude Code's own settings decide
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  // the CLI under the adapter starts sage-mcp, which the tool socket accepts as a process the harness started
  // (capabilities/mcp/socket.cjs startedBy), so tools and plugins' local MCP servers go over stdio as for any basic harness
  anchors: { plan: 'readOnly', default: 'ask', acceptEdits: 'auto', auto: 'auto', bypassPermissions: 'full' },
  // acceptEdits keeps its own name: no composer row only accepts edits
  permissionModes: { plan: 'read-only', default: 'default', auto: 'auto-review', bypassPermissions: 'full-access' },
  plan: { mode: 'plan' },
  resumeCommand: (id) => `claude --resume ${id}`,
  instructionsFiles: ['CLAUDE.md', '~/.claude/CLAUDE.md'],
  claudePath,
};
