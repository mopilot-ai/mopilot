// Selects each platform's authenticated MCP bridge and readiness without coupling agent tools to desktop control.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { sageMcpPath } = require('./socket.cjs');
const { sageMcpReady } = require('./sageMcpReady.cjs');

/**
 * A packaged app starts its own native bridge (socket.cjs sageMcpPath: the Swift helper on macOS, the Rust one beside the
 * core on Windows and Linux), as a checkout does on macOS and Windows. A Linux checkout runs the portable one,
 * host/bin/sage-mcp.mjs, under the login PATH's Node, which frames its streams with the checkout's core.
 * @param {{ platform?: NodeJS.Platform, packaged?: boolean, resourcesPath?: string, root?: string, which?: (name: string) => string | null,
 *           exists?: (file: string) => boolean, addon?: ReturnType<typeof import('../../platform/core.cjs').core> | null }} [o]
 * @returns {{ command: string, args: string[], available: boolean }}
 */
function mcpRuntime({
  platform = process.platform,
  packaged = false,
  resourcesPath = process.resourcesPath,
  root = path.join(__dirname, '../../..'),
  which,
  exists = fs.existsSync,
  addon,
} = {}) {
  if (platform !== 'linux' || packaged) {
    const command = sageMcpPath({ packaged, resourcesPath, repoRoot: root, platform });
    return { command, args: [], available: sageMcpReady(command, { exists, addon }) };
  }
  const command = which?.('node') ?? '';
  const script = path.join(root, 'host/bin/sage-mcp.mjs');
  return { command, args: [script], available: !!command && exists(command) && sageMcpReady(script, { exists, addon }) };
}

module.exports = { mcpRuntime };
