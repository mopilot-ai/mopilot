// A store plugin's page: about it, a switch and what reaches each harness, what it includes, and Uninstall.
import { useState } from 'react';
import { native } from '../../lib/native';
import type { ReachFamily } from '../../../shared/plugins/reach.mjs';
import type { PluginSpec } from '../../../shared/plugins/manifest.mjs';
import { navigate } from '../../store/panes';
import { toast } from '../../store/core';
import { Toggle } from '../pages/Settings';
import { ChevronRight, Spinner } from '../ui/icons';
import { ConfirmDialog } from './ConfirmDialog';
import { FAMILIES, FAMILY_LABEL, reachLine, type Installs } from './ReachStrip';
import { usePluginStore } from './usePluginStore';
import { attempt, includedCounts, PluginTile, pluginTitle } from './pluginView';

const backToPlugins = () => navigate({ name: 'plugins' });

/** What a plugin brings, by name, per kind that it has. */
function contentsOf(spec: PluginSpec): [string, string][] {
  const names = (list: { name: string }[]) => list.map((x) => x.name).join(', ');
  const rows: [string, string][] = [
    ['Skills', names(spec.skills)],
    ['Commands', names(spec.commands)],
    ['Agents', names(spec.agents)],
    ['MCP servers', Object.keys(spec.mcpServers).join(', ')],
    ['App connectors', spec.apps.join(', ')],
  ];
  return rows.filter(([, v]) => v);
}

export function PluginDetail({ id }: { id: string }) {
  const store = usePluginStore();
  const [confirming, setConfirming] = useState(false);
  const plugin = store.plugins?.find((p) => p.id === id);
  const spec = plugin?.spec;
  if (!plugin || !spec)
    return (
      <div className="center-fill">
        {store.error ? (
          // a store that can't be read says why, not that the plugin is gone
          <button className="btn-pill soft" onClick={() => void store.reload()}>
            Couldn't read the plugin store. Retry
          </button>
        ) : store.plugins ? (
          <button className="btn-pill soft" onClick={backToPlugins}>
            This plugin isn't installed. Back to Plugins
          </button>
        ) : (
          <Spinner size={18} />
        )}
      </div>
    );
  const title = pluginTitle(spec);
  const installs: Installs = { codex: store.codex[id] };
  const setEnabled = (on: boolean, family?: ReachFamily) => attempt(() => native.plugins.setEnabled(id, on, family)).then(store.reload);
  const uninstall = async () => {
    setConfirming(false);
    if (!(await attempt(() => native.plugins.uninstall(id)))) return;
    toast(`Uninstalled ${title}`);
    backToPlugins();
  };
  const meta = [spec.author && `by ${spec.author}`, spec.version && `v${spec.version}`, ...includedCounts(spec)]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="pd">
      <div className="pd-crumbs">
        <button className="pd-crumb" onClick={backToPlugins}>
          Plugins
        </button>
        <ChevronRight size={14} className="pd-crumb-sep" />
        <span className="pd-crumb current">{title}</span>
      </div>
      <div className="pd-scroll">
        <div className="pd-col">
          <PluginTile spec={spec} size={60} />
          <div className="pd-head">
            <div>
              <h1 className="pd-title">{title}</h1>
              {meta && <div className="pd-sub">{meta}</div>}
            </div>
            <div className="pd-actions">
              {/* MoPilot's own plugins can be turned off; a removed one wouldn't come back */}
              {plugin.origin !== 'builtin' && (
                <button className="pd-btn" onClick={() => setConfirming(true)}>
                  Uninstall
                </button>
              )}
              <Toggle on={plugin.enabled} label={`${title} on or off`} onChange={(on) => setEnabled(on)} />
            </div>
          </div>
          {spec.description && <div className="pd-long">{spec.description}</div>}
          <section className="pd-section">
            <div className="pd-section-head">
              <h2>Harnesses</h2>
            </div>
            <div className="plugin-harnesses">
              {FAMILIES.map((f) => {
                const off = !plugin.enabled || plugin.harnesses[f] === false;
                const line = reachLine(spec, f, { off, install: installs[f] });
                return (
                  <div key={f} className={`plugin-harness ${line.state}`}>
                    <span className="plugin-harness-text">
                      <span className="plugin-harness-name">{FAMILY_LABEL[f]}</span>
                      <span className="plugin-harness-reach">{line.text}</span>
                    </span>
                    {plugin.enabled && (
                      <Toggle
                        on={plugin.harnesses[f] !== false}
                        label={`${title} on ${FAMILY_LABEL[f]}`}
                        onChange={(on) => setEnabled(on, f)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
          {contentsOf(spec).length > 0 && (
            <section className="pd-section">
              <div className="pd-section-head">
                <h2>Includes</h2>
              </div>
              <dl className="pd-info">
                {contentsOf(spec).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title={`Uninstall ${title}?`}
          detail="It's removed from every harness."
          action="Uninstall"
          onConfirm={() => void uninstall()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
