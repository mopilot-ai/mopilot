// Dev-server previews for the in-app browser (IAB-02): an agent starts the project's dev server, or
// attaches to one already serving, and the chat's browser tab opens it once the port answers.
// Harness-neutral: the preview_* tools live in the capability Registry as browser_preview_*, so Claude
// Code sees them on mopilot_browser as preview_start / preview_stop / preview_list / preview_logs and
// Codex and ACP harnesses see them through sage-mcp, like the other browser_* tools.
//
// - Configurations come from the chat's project: .mopilot/launch.json, then .claude/launch.json (the
//   format Claude's desktop app reads): {configurations: [{name, runtimeExecutable, runtimeArgs, port,
//   url?, cwd?, env?}]}. The first file that names a configuration wins.
// - Servers are child processes owned by the chat that started them (its own process group, so a
//   `npm run dev` stops with the server it launched). They outlive turns, and stop when the chat is
//   archived or the app quits. Approved local launch recipes survive quit and restore on reopening the page;
//   stop/archive forgets them. Output is kept per server (the last MAX_LINES lines) for preview_logs.
// - Starting a process asks the user (one card per command and folder per chat) unless the chat has
//   Full access; a read-only chat can't start one. Opening the page goes through the browser's site
//   permission like browser_navigate.
// - Readiness: the configured port (or the one in `url`, or the first local URL the server prints)
//   accepts a TCP connection. preview_start waits for it a while; a server that comes up later opens
//   by itself when the chat already allows its origin.
const { DevPreviews } = require('./devPreview/servers.cjs');
const { createPreviewTools, registerPreviewTools, paneOpener, SPECS } = require('./devPreview/tools.cjs');
const { readLaunchConfigs, findLocalUrl, portOf, probePort, stripAnsi, LAUNCH_FILES } = require('./devPreview/launch.cjs');

module.exports = {
  DevPreviews,
  createPreviewTools,
  registerPreviewTools,
  paneOpener,
  readLaunchConfigs,
  findLocalUrl,
  portOf,
  probePort,
  stripAnsi,
  PREVIEW_TOOL_NAMES: Object.keys(SPECS),
  LAUNCH_FILES,
};
