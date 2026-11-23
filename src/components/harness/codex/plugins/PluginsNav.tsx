// Customize sidebar navigation: the store's plugins (every harness), then those Codex installed itself, newest first.
import { useEffect, useMemo } from 'react';
import { navigate } from '../../../../store/panes';
import { AtSign, Sparkles } from '../../../ui/icons';
import { usePluginStore } from '../../../plugins/usePluginStore';
import { openStorePlugin, PluginTile, pluginTitle, STORE_ROUTE } from '../../../plugins/pluginView';
import { BUNDLED, ensurePlugins, isMirrored, nameOf, openPlugin, usePlugins } from './catalog';
import { PluginLogo } from './PluginLogo';

export function PluginsNav({ tab = 'plugins', plugin }: { tab?: string; plugin?: string }) {
  const { plugins } = usePlugins();
  const store = usePluginStore();
  useEffect(ensurePlugins, []);
  // like the official sidebar: only plugins the user installed, not bundled or default ones
  const fromStore = useMemo(() => (store.plugins ?? []).filter((p) => p.spec && p.origin !== 'builtin'), [store.plugins]);
  const installed = useMemo(() => {
    const seen = new Set(fromStore.map((p) => p.spec!.name));
    return (plugins ?? [])
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
  }, [plugins, fromStore]);
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title static">Customize</span>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          {(
            [
              ['plugins', 'Plugins', <AtSign size={16} strokeWidth={1.7} />],
              ['skills', 'Skills', <Sparkles size={16} strokeWidth={1.7} />],
            ] as [string, string, React.ReactNode][]
          ).map(([id, label, icon]) => (
            <button
              key={id}
              className={`side-row ${tab === id && !plugin ? 'selected' : ''}`}
              onClick={() => navigate({ name: 'plugins', tab: id })}
            >
              <span className="side-row-icon">{icon}</span>
              <span className="side-row-label">{label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-section">
          <div className="side-label">Installed</div>
          {!plugins && <div className="side-row empty-note recents">Loading…</div>}
          {fromStore.map((p) => (
            <button
              key={p.id}
              className={`side-row ${plugin === `${STORE_ROUTE}${p.id}` ? 'selected' : ''}`}
              onClick={() => openStorePlugin(p.id)}
            >
              <span className="side-row-icon">
                <PluginTile spec={p.spec} size={16} />
              </span>
              <span className="side-row-label">{pluginTitle(p.spec!)}</span>
            </button>
          ))}
          {installed.map((p) => (
            <button key={p.id} className={`side-row ${plugin === p.id ? 'selected' : ''}`} onClick={() => openPlugin(p)}>
              <span className="side-row-icon">
                <PluginLogo p={p} size={16} />
              </span>
              <span className="side-row-label">{nameOf(p)}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
