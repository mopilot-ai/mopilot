// Spike (#1320): Codex behind the upstream ACP adapter, @agentclientprotocol/codex-acp, which the developer installs
// into a scratch prefix; listed only while its developer flag is on (quirks/index.cjs SPIKE_IDS). The adapter starts
// `codex app-server` itself, and CODEX_PATH points it at a Codex on PATH, else the ChatGPT or Codex app's copy, instead
// of the @openai/codex it bundles. The first-class adapter runs the copy chosen in Settings, else the newest installed:
// for a like-for-like comparison, start MoPilot with CODEX_PATH set to it. Its modes are sandbox and approval presets;
// plan is the collaboration_mode config option, as on the first-class adapter. `codex resume` continues a session.
const { fs } = require('../../platform/ports/fs.cjs');
const { which } = require('../../platform/env.cjs');

// two of the copies electron/app/codexServer.cjs also looks in (its list lives inside its binary probe)
const APP_COPIES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
];

/** The `codex` the adapter runs: one the environment already names, else PATH's, else an app's copy, else its own. */
const codexPath = (env, find = which, exists = fs.existsSync) =>
  env.CODEX_PATH || find('codex', env.PATH ?? '') || APP_COPIES.find((p) => exists(p)) || null;

module.exports = {
  label: 'Codex (ACP)',
  // its sessions are Codex's own and show in MoPilot's Codex list: no hidden title session (#2150)
  titleSessions: false,
  bins: ['codex-acp'],
  launch: (ctx, find = codexPath) => {
    const codex = find(ctx.env);
    return { args: [], env: codex ? { CODEX_PATH: codex } : {} };
  },
  // the first-class adapter turns nothing off either: Codex's own config.toml decides
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  // the CLI under the adapter starts sage-mcp, which the tool socket accepts as a process the harness started
  // (capabilities/mcp/socket.cjs startedBy), so tools and plugins' local MCP servers go over stdio as for any basic harness
  // plan is a collaboration_mode value over these modes, and reads only (quirks/index.cjs validate)
  anchors: { 'read-only': 'readOnly', 'workspace-write': 'ask', agent: 'auto', 'agent-full-access': 'full', plan: 'readOnly' },
  permissionModes: { 'read-only': 'read-only', 'workspace-write': 'default', agent: 'auto-review', 'agent-full-access': 'full-access' },
  plan: { configOption: 'collaboration_mode', value: 'plan' },
  resumeCommand: (id) => `codex resume ${id}`,
  instructionsFiles: ['AGENTS.md', '~/.codex/AGENTS.md'],
  codexPath,
};
