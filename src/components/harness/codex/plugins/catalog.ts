// Shared plugin catalog cache, naming, installation and chat-launch actions.
import { create } from 'zustand';
import { navigate } from '../../../../store/panes';
import { toast } from '../../../../store/core';
import { codexRequest } from '../../../../harness/adapters/codex';
import { userError } from '../../../../lib/ignored';
import type { PluginInterface } from '../../../../protocol/v2/PluginInterface';
import type { PluginInstallPolicy } from '../../../../protocol/v2/PluginInstallPolicy';
import type { PluginListResponse } from '../../../../protocol/v2/PluginListResponse';

export interface Plugin {
  id: string;
  name: string;
  installed: boolean;
  enabled?: boolean;
  availability?: string;
  marketplace: string;
  marketplacePath?: string | null;
  interface?: PluginInterface | null;
  installPolicy?: PluginInstallPolicy;
  installedAt?: number | null;
  version?: string | null;
}

export { BUNDLED, isMirrored } from './marketplaceKinds';

/* catalog cache shared by the sidebar and the page; `error` says why the last load failed (the list is then empty) */
export const usePlugins = create<{ plugins: Plugin[] | null; featured: string[]; loading: boolean; error?: string | null }>(() => ({
  plugins: null,
  featured: [],
  loading: false,
}));

export async function loadPlugins(force = false) {
  const st = usePlugins.getState();
  // a catalog that failed to load is asked again, not taken as loaded
  if ((st.plugins && !st.error && !force) || st.loading) return;
  usePlugins.setState({ loading: true });
  try {
    const r = await codexRequest<PluginListResponse>('plugin/list', {});
    const plugins: Plugin[] = (r.marketplaces ?? []).flatMap((m) =>
      (m.plugins ?? []).map((p) => ({ ...p, marketplace: m.name, marketplacePath: m.path })),
    );
    usePlugins.setState({ plugins, featured: r.featuredPluginIds ?? [], loading: false, error: null });
  } catch (e) {
    // the pages say why the list is empty, and Refresh (or the next visit) asks again
    usePlugins.setState({ plugins: [], loading: false, error: userError(e) });
  }
}

/** loadPlugins for a page that opens: it cannot reject, since a failed list is kept as the catalog's error. */
export function ensurePlugins(): void {
  void loadPlugins();
}

export const isPublic = (p: Plugin) => /^openai-/.test(p.marketplace);
// Plugins without a display name read as title case ("frontend-design" → "Frontend Design"), like the official list.
export const nameOf = (p: Plugin) => p.interface?.displayName ?? p.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** Install or remove a plugin, then refresh the shared catalog. */
export async function toggleInstalled(p: Plugin) {
  if (p.installed) await codexRequest('plugin/uninstall', { pluginId: p.id });
  else
    await codexRequest('plugin/install', {
      marketplacePath: p.marketplacePath ?? undefined,
      remoteMarketplaceName: p.marketplacePath ? undefined : p.marketplace,
      pluginName: p.name,
      installAttemptId: crypto.randomUUID(),
    });
  await loadPlugins(true);
  toast(p.installed ? `Removed ${nameOf(p)}` : `Installed ${nameOf(p)}`);
}

/** "Add → Create plugin": install the Plugin Creator plugin if needed, then start a chat with it. */
export async function createPlugin() {
  await loadPlugins();
  const { plugins, error } = usePlugins.getState();
  const p = plugins?.find((x) => x.name === 'plugin-creator' && isPublic(x));
  if (!p) return toast(error ? `Couldn't load plugins: ${userError(error)}` : 'Plugin Creator isn’t available for this account', 'error');
  try {
    if (!p.installed) await toggleInstalled(p);
    tryPlugin(p, 'help me create a plugin');
  } catch (e) {
    toast(userError(e), 'error');
  }
}
/** Start a new chat with the plugin attached, optionally with a prompt filled in. */
export function tryPlugin(p: Plugin, prompt?: string) {
  navigate({ name: 'home' });
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('insert-mention', { detail: { name: nameOf(p), path: `plugin://${p.id}` } }));
    if (prompt) window.dispatchEvent(new CustomEvent('composer-insert', { detail: prompt }));
  }, 80);
}

export const openPlugin = (p: Plugin) => navigate({ name: 'plugins', plugin: p.id });
