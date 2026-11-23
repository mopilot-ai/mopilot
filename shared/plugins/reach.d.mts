import type { PluginSpec } from './manifest.mjs';

export type ComponentKind = 'skills' | 'commands' | 'agents' | 'hooks' | 'mcpServers' | 'lspServers' | 'apps';
export type Reach = 'native' | 'mopilot' | 'unavailable';
export type ReachFamily = 'claude' | 'codex' | 'acp';
export type Component = { kind: ComponentKind; name: string; transport?: 'stdio' | 'http' | 'sse' | 'other' };
export type ComponentReach = Component & { reach: Reach; why?: string; note?: string };
/** What a basic-tier session accepts for MCP servers. */
export type McpAccepts = { stdio: boolean; http: boolean };

export const REACH_WHY: Record<string, string>;
export const REACH_NOTE: Record<string, string>;
export function componentsOf(
  spec: Pick<PluginSpec, 'skills' | 'commands' | 'agents' | 'hooks' | 'mcpServers' | 'lspServers' | 'apps' | 'execution'>,
): Component[];
export function componentReach(component: Component, family: string, mcp?: McpAccepts): { reach: Reach; why?: string; note?: string };
export function pluginReach(
  spec: Pick<PluginSpec, 'skills' | 'commands' | 'agents' | 'hooks' | 'mcpServers' | 'lspServers' | 'apps' | 'execution'>,
  family: string,
  mcp?: McpAccepts,
): { summary: 'full' | 'partial' | 'none'; components: ComponentReach[]; reasons?: string[] };
