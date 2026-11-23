// Launch Google's standalone Antigravity ACP server with localharness_external beside it.
module.exports = {
  label: 'Antigravity',
  bins: ['agy_acp_server.par', 'agy_acp_server', 'agy_acp_server.exe'],
  // Linux's empty uid is part of Google's ACP Registry launch command. No client identity is impersonated.
  launch: ({ platform = process.platform }) => ({
    args: [...(platform === 'linux' ? ['--uid='] : []), '--nosyslog_on_start'],
  }),
  // The server's absl startup syslog flag is disabled; this does not change the account's data-sharing settings.
  privacyDefaults: ['syslog_on_start=false'],
  admission: { handshakeTimeoutMs: 10_000 },
  // Native modes, instruction discovery, isolation and session-scoped MCP are negotiated or left unclaimed.
};
