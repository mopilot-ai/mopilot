// Plugin settings catalog hooks and MCP configuration reloads.
import { useMemo, useState } from 'react';
import { useEffectOn } from '../../../../lib/effects';
import { createLatestLoader } from '../../../../lib/latestLoader';
import { toast } from '../../../../store/core';
import { codexRequest } from '../../../../harness/adapters/codex';
import { errorText } from '../../../../lib/ignored';
import { usePlugins, BUNDLED } from '../Plugins';
import { isMirrored, isUserMarketplace } from '../plugins/marketplaceKinds';
import type { AppInfo } from '../../../../protocol/v2/AppInfo';
import type { AppsListResponse } from '../../../../protocol/v2/AppsListResponse';
import type { ConfigReadResponse } from '../../../../protocol/v2/ConfigReadResponse';
import type { ListMcpServerStatusResponse } from '../../../../protocol/v2/ListMcpServerStatusResponse';
import type { McpServerStatus } from '../../../../protocol/v2/McpServerStatus';
import type { PluginListResponse } from '../../../../protocol/v2/PluginListResponse';
import type { PluginMarketplaceEntry } from '../../../../protocol/v2/PluginMarketplaceEntry';
import type { SkillMetadata } from '../../../../protocol/v2/SkillMetadata';
import type { SkillsListResponse } from '../../../../protocol/v2/SkillsListResponse';

/** An `[mcp_servers.<name>]` table of config.toml, as the list and editor read it. */
export type McpServerToml = {
  enabled?: boolean;
  command?: string;
  args?: unknown[];
  env?: Record<string, string>;
  env_vars?: unknown[];
  cwd?: string;
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
};

/** Plugins the user installed themselves (not bundled or installed by default), like the Customize sidebar. */
export function useInstalledPlugins() {
  const { plugins } = usePlugins();
  return useMemo(() => {
    if (!plugins) return null;
    const seen = new Set<string>();
    return plugins
      .filter(
        (p) =>
          p.installed &&
          !BUNDLED.has(p.marketplace) &&
          !isMirrored(p.marketplace, p.marketplacePath) &&
          p.installPolicy !== 'INSTALLED_BY_DEFAULT' &&
          !seen.has(p.name) &&
          seen.add(p.name),
      )
      .sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));
  }, [plugins]);
}

/* Data sources for the tab counts and lists */

/**
 * A tab's list, read when the page opens and on `reload`: null while the first read runs. A read that fails
 * leaves the list empty with `error` saying why, rather than looking like there is nothing to show. When reads
 * overlap (two toggles in a row), only the newest one is shown.
 */
function useCodexList<T>(read: () => Promise<T[]>) {
  const [list, setList] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // overlapping reads (two toggles in a row): only the newest is shown, and a reload settles once it is
  const [loader] = useState(() =>
    createLatestLoader(
      () => read(),
      (xs: T[]) => {
        setList(xs);
        setError(null);
      },
      (e) => {
        setList([]);
        setError(errorText(e));
      },
    ),
  );
  const reload = () => {
    void loader.load();
    return loader.settled();
  };
  // read once when the page opens; each hook passes a module-level reader, so it never changes
  useEffectOn([read], () => {
    void reload();
  });
  return { list, error, reload };
}
const readApps = () => codexRequest<AppsListResponse>('app/list', {}).then((r) => (r.data ?? []).filter((a) => a.isAccessible));
const readSkills = () =>
  codexRequest<SkillsListResponse>('skills/list', { forceReload: true }).then((r) =>
    r.data.flatMap((d) => d.skills).filter((s) => s.scope !== 'system' && !s.pluginId && !s.name.includes(':')),
  );
const readMarketplaces = () =>
  codexRequest<PluginListResponse>('plugin/list', {}).then((r) =>
    (r.marketplaces ?? []).filter(isUserMarketplace).sort((a, b) => a.name.localeCompare(b.name)),
  );
export function useApps() {
  const { list, error, reload } = useCodexList<AppInfo>(readApps);
  return { apps: list, error, reload };
}
export function useMcp() {
  const [status, setStatus] = useState<McpServerStatus[] | null>(null);
  const [servers, setServers] = useState<Record<string, McpServerToml>>({});
  const [error, setError] = useState<string | null>(null);
  // overlapping reads: only the newest is shown, and a reload settles once it is
  const [loader] = useState(() =>
    createLatestLoader(
      // cannot reject: allSettled answers both reads, and a failed one is shown as the list's error
      () =>
        Promise.allSettled([
          codexRequest<ListMcpServerStatusResponse>('mcpServerStatus/list', {}),
          codexRequest<ConfigReadResponse>('config/read', { includeLayers: false }),
        ]),
      ([st, cfg]) => {
        // either read failing is said above the list; what the other one read is still shown
        const failed = [st, cfg].find((r) => r.status === 'rejected');
        setError(failed ? errorText(failed.reason) : null);
        // Servers that ship inside bundled plugins aren't user-manageable, so the official tab hides them.
        const data = st.status === 'fulfilled' ? (st.value.data ?? []) : [];
        setStatus(data.filter((x) => !x.pluginId || !BUNDLED.has(String(x.pluginId).split('@')[1])));
        const config =
          cfg.status === 'fulfilled' ? (cfg.value as { config?: { mcp_servers?: Record<string, McpServerToml> } }).config : null;
        setServers(config?.mcp_servers ?? {});
      },
    ),
  );
  const reload = () => {
    void loader.load();
    return loader.settled();
  };
  // read once when the page opens
  useEffectOn([], () => {
    void reload();
  });
  return { status, servers, error, reload };
}
export function useSkills() {
  const { list, error, reload } = useCodexList<SkillMetadata>(readSkills);
  return { skills: list, error, reload };
}
export function useMarketplaces() {
  return useCodexList<PluginMarketplaceEntry>(readMarketplaces);
}

/**
 * After config.toml's MCP servers changed: ask Codex to reload them. The change is written either way, so a failed
 * reload is said (false) rather than thrown, and not reported as a plain success.
 */
export async function reloadMcpServers(done = 'Saved'): Promise<boolean> {
  try {
    await codexRequest('config/mcpServer/reload', undefined);
    return true;
  } catch (e) {
    toast(`${done}, but Codex couldn't reload its MCP servers: ${errorText(e)}`, 'error');
    return false;
  }
}
