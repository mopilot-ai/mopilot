// GitHub Copilot CLI over ACP: `copilot --acp`. Modes agent, plan and autopilot, whose ids are the ACP
// session-mode URLs; autopilot is passed through as a mode (Copilot's own goal loop). /fleet, /agent,
// /compact come through its command list. As of 1.0.95 it rejects stdio MCP servers from the client
// ("Rejecting non-http/sse MCP server") and accepts only http and sse (1.0.98 still advertises only
// those), so it gets MoPilot's tools from main's http endpoint (capabilities/httpMcp.cjs) rather
// than from sage-mcp.
const MODE = 'https://agentclientprotocol.com/protocol/session-modes#';

module.exports = {
  label: 'Copilot',
  bins: ['copilot'],
  args: ['--acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  // tools over http (harness/acpSessionTools.cjs toolsOverHttp); plugins' local MCP servers aren't offered to it
  // (electron/plugins/delivery.cjs)
  mcpStdio: false,
  anchors: { [`${MODE}plan`]: 'readOnly', [`${MODE}agent`]: 'ask', [`${MODE}autopilot`]: 'full' },
  plan: { mode: `${MODE}plan` },
};
