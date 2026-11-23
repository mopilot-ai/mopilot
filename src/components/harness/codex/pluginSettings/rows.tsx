// Installed plugin, app, skill and marketplace rows and their shared list frame.
import { ownTable } from '../../../../../shared/ownTable.mjs';
import { useState, type ReactNode } from 'react';
import { toast } from '../../../../store/core';
import { codexRequest } from '../../../../harness/adapters/codex';
import { errorText } from '../../../../lib/ignored';
import { onActivate } from '../../../../lib/focus';
import { Toggle } from '../../../pages/settings/Controls';
import { loadPlugins, PluginLogo, nameOf, openPlugin, toggleInstalled, type Plugin } from '../Plugins';
import { Menu, MenuItem, useAnchor } from '../../../ui/Popover';
import type { AppInfo } from '../../../../protocol/v2/AppInfo';
import type { MarketplaceUpgradeResponse } from '../../../../protocol/v2/MarketplaceUpgradeResponse';
import type { PluginMarketplaceEntry } from '../../../../protocol/v2/PluginMarketplaceEntry';
import type { SkillMetadata } from '../../../../protocol/v2/SkillMetadata';
import { Ellipsis, Spinner, Package, Trash2, SquareDashedMousePointer, Workflow } from '../../../ui/icons';

export function List({
  loading,
  empty,
  error,
  children,
}: {
  loading: boolean;
  empty: string;
  error?: string | null;
  children?: ReactNode[];
}) {
  if (loading)
    return (
      <div className="ps-loading">
        <Spinner size={16} />
      </div>
    );
  // a list that couldn't be read says why, rather than that there is nothing
  if (error) return <div className="ps-empty">Couldn't load the list: {error}</div>;
  if (!children?.length) return <div className="ps-empty">{empty}</div>;
  return <div className="ps-list">{children}</div>;
}

function Item({
  icon,
  iconStyle,
  title,
  desc,
  meta,
  children,
  onClick,
  more,
}: {
  icon: ReactNode;
  iconStyle?: 'filled' | 'round';
  title: ReactNode;
  desc?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  more?: boolean;
}) {
  // a row, not a <button>: its controls are buttons of their own
  const press = onClick && { role: 'button', tabIndex: 0, onClick, onKeyDown: onActivate(onClick) };
  return (
    <div className={`ps-item ${onClick ? 'clickable' : ''} ${more ? 'has-more' : ''}`} {...press}>
      <span className={`ps-icon ${iconStyle ?? ''}`}>{icon}</span>
      <span className="ps-text">
        <span className="ps-title">{title}</span>
        {desc && <span className="ps-desc">{typeof desc === 'string' ? <span>{desc}</span> : desc}</span>}
      </span>
      {meta && <span className="ps-meta">{meta}</span>}
      {/* not a control: it keeps its controls' clicks off the row (onActivate ignores their keys) */}
      <span className="ps-controls" role="presentation" onClick={(e) => e.stopPropagation()}>
        {children}
      </span>
    </div>
  );
}

export function PluginItem({ p }: { p: Plugin }) {
  const menu = useAnchor();
  const enabled = p.enabled !== false;
  return (
    <Item
      icon={<PluginLogo p={p} size={38} />}
      title={nameOf(p)}
      desc={p.interface?.shortDescription}
      meta={p.interface?.developerName}
      onClick={() => openPlugin(p)}
      more
    >
      <button ref={menu.ref} className={`ps-more ${menu.open ? 'open' : ''}`} onClick={menu.toggle} aria-label="Plugin actions">
        <Ellipsis size={16} />
      </button>
      <Toggle
        on={enabled}
        onChange={async (v) => {
          try {
            await codexRequest('config/value/write', {
              keyPath: `plugins.${JSON.stringify(p.id)}.enabled`,
              value: v,
              mergeStrategy: 'replace',
            });
            await loadPlugins(true);
          } catch (e) {
            toast(errorText(e), 'error');
          }
        }}
      />
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={160}>
        <MenuItem onSelect={() => openPlugin(p)}>Details</MenuItem>
        <MenuItem
          danger
          onSelect={() =>
            toggleInstalled(p).catch((e) => {
              toast(errorText(e), 'error');
            })
          }
        >
          Uninstall
        </MenuItem>
      </Menu>
    </Item>
  );
}

export function AppItem({ app, onChange }: { app: AppInfo; onChange: () => unknown }) {
  // App icons are site-relative paths on chatgpt.com (the official list uses the light variant on both themes).
  const src = app.logoUrl ? new URL(app.logoUrl, 'https://chatgpt.com').href : null;
  const [err, setErr] = useState(false);
  return (
    <Item
      iconStyle="filled"
      icon={src && !err ? <img src={src} className="ps-app-img" onError={() => setErr(true)} /> : <Workflow size={20} strokeWidth={1.5} />}
      title={app.name}
      desc={app.description}
    >
      <Toggle
        on={app.isEnabled !== false}
        onChange={async (v) => {
          try {
            await codexRequest('config/value/write', {
              keyPath: `apps.${JSON.stringify(app.id)}.enabled`,
              value: v,
              mergeStrategy: 'replace',
            });
            await onChange();
          } catch (e) {
            toast(errorText(e), 'error');
          }
        }}
      />
    </Item>
  );
}

const SCOPE: Record<string, string> = ownTable({
  user: 'Personal',
  repo: 'Project',
  system: 'System',
  admin: 'Managed',
});
export function SkillItem({ s, onChange }: { s: SkillMetadata; onChange: () => unknown }) {
  return (
    <Item
      iconStyle="round"
      icon={<Package size={18} strokeWidth={1.5} />}
      title={s.interface?.displayName ?? titleCase(s.name)}
      desc={s.interface?.shortDescription ?? s.shortDescription ?? s.description}
      meta={SCOPE[s.scope] ?? s.scope}
    >
      <Toggle
        on={s.enabled}
        onChange={async (v) => {
          try {
            await codexRequest('skills/config/write', {
              path: s.path,
              enabled: v,
            });
            await onChange();
          } catch (e) {
            toast(`Couldn't change ${s.name}: ${errorText(e)}`, 'error');
          }
        }}
      />
    </Item>
  );
}
const titleCase = (n: string) => n.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function MarketplaceItem({ m, onChange }: { m: PluginMarketplaceEntry; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  // Only git-backed marketplaces (cloned under .tmp/marketplaces) can be upgraded. Listed ones always have a path.
  const upgradable = /\/\.tmp\/marketplaces\//.test(m.path!);
  return (
    <Item
      iconStyle="filled"
      icon={<SquareDashedMousePointer size={18} strokeWidth={1.5} />}
      title={m.interface?.displayName ?? m.name}
      desc={
        <>
          <span>
            {m.plugins.length} {m.plugins.length === 1 ? 'plugin' : 'plugins'}
          </span>
          <span className="ps-path">{m.path}</span>
        </>
      }
    >
      <button
        className="ps-btn sm"
        disabled={!upgradable || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await codexRequest<MarketplaceUpgradeResponse>('marketplace/upgrade', {
              marketplaceName: m.name,
            });
            if (r.errors?.length) toast(r.errors.map((failure) => errorText(failure)).join('\n'), 'error');
            else toast(r.upgradedRoots?.length ? `Upgraded ${m.name}` : `${m.name} is up to date`);
            await loadPlugins(true);
            onChange();
          } catch (e) {
            toast(errorText(e), 'error');
          }
          setBusy(false);
        }}
      >
        Upgrade
      </button>
      <button
        className="ps-icon-btn"
        aria-label="Remove marketplace"
        onClick={async () => {
          if (!window.confirm(`Remove the ${m.name} marketplace?`)) return;
          try {
            await codexRequest('marketplace/remove', {
              marketplaceName: m.name,
            });
            await loadPlugins(true);
            onChange();
          } catch (e) {
            toast(errorText(e), 'error');
          }
        }}
      >
        <Trash2 size={16} strokeWidth={1.6} />
      </button>
    </Item>
  );
}
