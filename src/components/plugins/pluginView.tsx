// How a store plugin reads on the shared Plugins page: its title, what it includes, its icon tile and its route.
import type { ReactNode } from 'react';
import { componentsOf } from '../../../shared/plugins/reach.mjs';
import type { PluginSpec } from '../../../shared/plugins/manifest.mjs';
import { navigate } from '../../store/panes';
import { toast } from '../../store/core';
import { errorText } from '../../lib/ignored';
import { pluralize } from '../../lib/format';
import { Blocks, Server, Sparkles } from '../ui/icons';

/** A store plugin's detail page is the Plugins route with this before its id; a bare id is a harness's own catalog. */
export const STORE_ROUTE = 'store:';
export const openStorePlugin = (id: string) => navigate({ name: 'plugins', plugin: `${STORE_ROUTE}${id}` });

const BRANDS: Record<string, string> = { mopilot: 'MoPilot' };
/** A plugin without a display name reads as title case ("frontend-design" → "Frontend Design"). */
export const titleOfName = (name: string) => BRANDS[name] ?? name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const pluginTitle = (spec: Pick<PluginSpec, 'name' | 'displayName'>) =>
  spec.displayName && spec.displayName !== spec.name ? spec.displayName : titleOfName(spec.name);

/** What a plugin brings, counted: "2 skills", "1 MCP server". */
export function includedCounts(spec: PluginSpec): string[] {
  const components = componentsOf(spec);
  const rows: [number, string][] = [
    [spec.skills.length, 'skill'],
    [spec.commands.length, 'command'],
    [spec.agents.length, 'agent'],
    [components.filter((c) => c.kind === 'mcpServers').length, 'MCP server'],
    [Object.keys(spec.lspServers ?? {}).length, 'LSP server'],
    [components.filter((c) => c.kind === 'hooks').length, spec.execution ? 'hook event' : 'hook'],
    [spec.apps.length, 'app connector'],
  ];
  return rows.filter(([n]) => n).map(([n, what]) => pluralize(n, what));
}

/** The icon tile of a plugin or catalog entry: servers for a plugin of MCP servers alone, sparkles for skills alone. */
export function PluginTile({ spec, size = 40 }: { spec?: PluginSpec | null; size?: number }) {
  const icon = size * 0.5;
  const kinds = new Set(spec ? componentsOf(spec).map((c) => c.kind) : []);
  const only = kinds.size === 1 ? [...kinds][0] : null;
  const glyph: ReactNode =
    only === 'mcpServers' ? (
      <Server size={icon} strokeWidth={1.6} />
    ) : only === 'skills' ? (
      <Sparkles size={icon} strokeWidth={1.6} />
    ) : (
      <Blocks size={icon} strokeWidth={1.6} />
    );
  return (
    <span className="plugin-tile" style={{ width: size, height: size }}>
      {glyph}
    </span>
  );
}

/** Run a store call, saying why it failed. */
export async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    toast(errorText(e), 'error');
    return undefined;
  }
}
