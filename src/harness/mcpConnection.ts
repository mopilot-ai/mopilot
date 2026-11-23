// MCP connection presentation and source capabilities; adapters supply provenance, never infer it from a display name.
import type { ClaudeMcpServer } from '../../shared/model/native';
export type { ClaudeMcpServer } from '../../shared/model/native';

export const CLAUDE_CONNECTORS = 'https://claude.ai/customize/connectors';

export function mcpConnectionStatus(status: string): { label: string; tone: string } {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tone: 'ok' };
    case 'needs-auth':
      return { label: 'Sign-in required', tone: '' };
    case 'failed':
      return { label: 'Connection failed', tone: 'err' };
    case 'pending':
      return { label: 'Connecting…', tone: '' };
    case 'disabled':
      return { label: 'Disabled', tone: '' };
    default:
      return { label: 'Unknown status', tone: '' };
  }
}

/** An explicit source overrides scope. Older CLIs without provenance get safe, non-destructive controls. */
export function claudeMcpCapabilities(server: ClaudeMcpServer) {
  const source = server.source ?? server.scope;
  const connector = source === 'claudeai';
  const plugin = source === 'plugin';
  const removeScope = ['user', 'project', 'local'].includes(source ?? '') ? source : undefined;
  return {
    connector,
    plugin,
    removeScope,
    signIn: !connector && server.status === 'needs-auth',
    description: connector
      ? 'Connected through your Claude account. Manage access in Claude.'
      : plugin
        ? 'Provided by a plugin. Manage it with the plugin that installed it.'
        : removeScope
          ? `${removeScope === 'user' ? 'All projects' : 'This project'} · Configured server`
          : 'Managed by Claude Code. Open its MCP controls to manage this server.',
  };
}
