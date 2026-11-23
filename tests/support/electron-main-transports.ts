// Main's transport collaborators use one per-load fake bridge; real native/portable selection is covered by mcpRuntime.test.ts.
import fs from 'node:fs';
import path from 'node:path';

export function mainTransports(tmp: string, { cls, fn, resolved }: { cls: any; fn: any; resolved: any }) {
  const command = path.join(tmp, 'sage-mcp');
  return {
    'electron/capabilities/mcp/socket.cjs': {
      ToolSocket: cls('ToolSocket', () => ({ listen: resolved('/tmp/sage.sock') })),
      sageMcpPath: fn(() => command),
      preloadedFor: fn(() => () => []),
    },
    'electron/capabilities/mcp/runtime.cjs': {
      mcpRuntime: fn(() => ({ command, args: [], available: fs.existsSync(command) })),
    },
  };
}
