// Plugin marketplace browsing, search, categories and installation rows.
import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../../../../store/panes';
import { toast } from '../../../../store/core';
import { onActivate } from '../../../../lib/focus';
import { errorText } from '../../../../lib/ignored';
import { Menu, MenuItem, Tooltip, useAnchor } from '../../../ui/Popover';
import { Search, Blocks, Spinner, Plus, Ellipsis, RefreshCw, Settings as Gear, ChevronDown, ChevronRight, Store } from '../../../ui/icons';
import {
  createPlugin,
  ensurePlugins,
  isMirrored,
  isPublic,
  loadPlugins,
  nameOf,
  openPlugin,
  toggleInstalled,
  usePlugins,
  type Plugin,
} from './catalog';
import { PluginLogo } from './PluginLogo';
import { MarketplaceDialog } from './MarketplaceDialog';

export function PluginCatalog() {
  const { plugins, featured, loading, error } = usePlugins();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'public' | 'personal'>('public');
  const [category, setCategory] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const add = useAnchor();
  const [addingMarketplace, setAddingMarketplace] = useState(false);
  useEffect(ensurePlugins, []);

  const pool = useMemo(() => {
    const seen = new Set<string>();
    return (plugins ?? [])
      .filter((p) => !isMirrored(p.marketplace, p.marketplacePath))
      .filter((p) => (scope === 'public' ? isPublic(p) : !isPublic(p)))
      .filter((p) => !seen.has(p.name) && seen.add(p.name));
  }, [plugins, scope]);

  const sections = useMemo(() => {
    if (q.trim()) {
      const ql = q.toLowerCase();
      return [
        {
          title: 'Results',
          items: pool
            .filter((p) => nameOf(p).toLowerCase().includes(ql) || (p.interface?.shortDescription ?? '').toLowerCase().includes(ql))
            .slice(0, 60),
        },
      ];
    }
    if (category) return [{ title: category, items: pool.filter((p) => (p.interface?.category ?? 'Other') === category) }];
    const out: { title: string; items: Plugin[]; more?: string }[] = [];
    const feat = featured.map((id) => pool.find((p) => p.id === id)).filter(Boolean) as Plugin[];
    if (feat.length) out.push({ title: 'Featured', items: feat.slice(0, 6) });
    const installed = pool.filter((p) => p.installed);
    if (installed.length)
      out.push({ title: 'Installed', items: installed.slice(0, 6), more: installed.length > 6 ? '__installed' : undefined });
    const counts = new Map<string, number>();
    for (const p of pool) counts.set(p.interface?.category ?? 'Other', (counts.get(p.interface?.category ?? 'Other') ?? 0) + 1);
    for (const [cat] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
      out.push({ title: cat, items: pool.filter((p) => (p.interface?.category ?? 'Other') === cat).slice(0, 6), more: cat });
    return out;
  }, [pool, q, category, featured]);

  const toggleInstall = async (p: Plugin) => {
    setBusy(p.id);
    try {
      await toggleInstalled(p);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(null);
  };

  return (
    <div className="page plugins-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Plugins</h1>
          <p className="page-sub">Connect plugins to let Codex work across your tools</p>
        </div>
        <div className="plugins-tools">
          <div className="pill-search">
            <Search size={14} strokeWidth={1.7} />
            <input placeholder="Search plugins" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Tooltip label="Refresh">
            <button className="icon-btn" onClick={() => loadPlugins(true)}>
              {loading ? <Spinner size={14} /> : <RefreshCw size={15} strokeWidth={1.7} />}
            </button>
          </Tooltip>
          <Tooltip label="Plugin settings">
            <button className="icon-btn" onClick={() => navigate({ name: 'settings', section: 'plugins' })}>
              <Gear size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <button ref={add.ref} className="btn-white" onClick={add.toggle}>
            Add <ChevronDown size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="segmented tabs-seg">
        {(['public', 'personal'] as const).map((s) => (
          <button
            key={s}
            className={scope === s ? 'on' : ''}
            onClick={() => {
              setScope(s);
              setCategory(null);
            }}
          >
            {s === 'public' ? 'Public' : 'Personal'}
          </button>
        ))}
      </div>
      {!plugins && (
        <div className="center-pad">
          <Spinner size={16} />
        </div>
      )}
      {error && <div className="center-pad settings-row-desc">Couldn't load plugins: {error}</div>}
      {category && (
        <button className="crumb" onClick={() => setCategory(null)}>
          ← All plugins
        </button>
      )}
      {sections.map((sec) => (
        <section key={sec.title} className="plugin-section">
          <button className="plugin-section-title" onClick={() => sec.more && sec.more !== '__installed' && setCategory(sec.more)}>
            {sec.title} {sec.more && sec.more !== '__installed' && <ChevronRight size={14} />}
          </button>
          <div className="plugin-rows">
            {sec.items.map((p) => (
              <PluginRow key={p.id} p={p} busy={busy === p.id} onToggle={() => toggleInstall(p)} />
            ))}
            {sec.items.length === 0 && <div className="settings-row-desc">No plugins</div>}
          </div>
        </section>
      ))}
      <Menu anchor={add.anchor} open={add.open} onClose={add.close} placement="bottom-end" width={178}>
        <MenuItem icon={<Blocks size={15} strokeWidth={1.7} />} onSelect={createPlugin}>
          Create plugin
        </MenuItem>
        <MenuItem icon={<Store size={15} strokeWidth={1.7} />} onSelect={() => setAddingMarketplace(true)}>
          Add a marketplace
        </MenuItem>
      </Menu>
      {addingMarketplace && <MarketplaceDialog onClose={() => setAddingMarketplace(false)} />}
    </div>
  );
}

function PluginRow({ p, busy, onToggle }: { p: Plugin; busy: boolean; onToggle: () => void }) {
  const menu = useAnchor();
  const open = () => openPlugin(p);
  return (
    // a row, not a <button>: it holds buttons of its own (the menu, install)
    <div className="plugin-row" role="button" tabIndex={0} aria-label={nameOf(p)} onClick={open} onKeyDown={onActivate(open)}>
      <PluginLogo p={p} size={36} />
      <span className="plugin-row-text">
        <span className="plugin-name">{nameOf(p)}</span>
        <span className="plugin-desc">{p.interface?.shortDescription ?? p.marketplace}</span>
      </span>
      {busy ? (
        <Spinner size={14} />
      ) : p.installed ? (
        <button
          ref={menu.ref}
          className="icon-btn sm"
          onClick={(e) => {
            e.stopPropagation();
            menu.toggle();
          }}
          aria-label="Plugin actions"
        >
          <Ellipsis size={16} />
        </button>
      ) : (
        <Tooltip label="Install">
          <button
            className="icon-btn sm"
            disabled={p.availability === 'UNAVAILABLE'}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label="Install"
          >
            <Plus size={17} strokeWidth={1.7} />
          </button>
        </Tooltip>
      )}
      {/* not a control: a click in the menu (a portal) bubbles through React to its parent, so keep it off the row */}
      <span role="presentation" onClick={(e) => e.stopPropagation()}>
        <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={180}>
          <MenuItem onSelect={() => openPlugin(p)}>Details</MenuItem>
          <MenuItem danger onSelect={onToggle}>
            Uninstall
          </MenuItem>
        </Menu>
      </span>
    </div>
  );
}
