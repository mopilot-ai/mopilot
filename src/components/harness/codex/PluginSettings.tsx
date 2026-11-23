// Plugin settings page: tab routing, counts, search and the add/edit flow around focused catalog views.
import { useEffect, useState } from 'react';
import { navigate } from '../../../store/panes';
import { useStore } from '../../../store/core';
import { resolveSection, splitTab } from '../../../lib/settingsNav';
import { usePlugins, ensurePlugins, nameOf, createPlugin, MarketplaceDialog } from './Plugins';
import { Menu, MenuItem, useAnchor } from '../../ui/Popover';
import { Search, ChevronDown, Blocks, Store, Server } from '../../ui/icons';

import { useInstalledPlugins, useApps, useMcp, useSkills, useMarketplaces } from './pluginSettings/data';
import { List, PluginItem, AppItem, SkillItem, MarketplaceItem } from './pluginSettings/rows';
import { McpList } from './pluginSettings/McpServers';
import { McpEditor } from './pluginSettings/McpEditor';

type Tab = 'plugins' | 'apps' | 'mcps' | 'skills' | 'marketplace';
const TABS: { id: Tab; label: string; search: string }[] = [
  { id: 'plugins', label: 'Plugins', search: 'Search plugins' },
  { id: 'apps', label: 'Apps', search: 'Search apps' },
  { id: 'mcps', label: 'MCPs', search: 'Search MCP servers' },
  { id: 'skills', label: 'Skills', search: 'Search skills' },
  { id: 'marketplace', label: 'Marketplace', search: 'Search marketplaces' },
];

export function PluginSettings() {
  const route = useStore((s) => s.route);
  const sub = route.name === 'settings' ? splitTab(resolveSection(route.section, route.tab).tab).sub : undefined;
  const tab: Tab = (TABS.some((x) => x.id === sub) ? sub : 'plugins') as Tab;
  const setTab = (t: Tab) => navigate({ name: 'settings', section: 'codex', tab: `extensions:${t}` });
  const [q, setQ] = useState('');
  const [mcpEdit, setMcpEdit] = useState<string | null | undefined>(undefined); // undefined = list, null = new server
  const [addingMarketplace, setAddingMarketplace] = useState(false);
  const add = useAnchor();
  const installed = useInstalledPlugins();
  const apps = useApps();
  const mcp = useMcp();
  const skills = useSkills();
  const markets = useMarketplaces();
  const pluginsError = usePlugins((s) => s.error);
  useEffect(ensurePlugins, []);
  // another tab starts with no search and its list: reset while rendering, so its first frame shows neither
  const [shownTab, setShownTab] = useState(tab);
  if (shownTab !== tab) {
    setShownTab(tab);
    setQ('');
    setMcpEdit(undefined);
  }
  const counts: Record<Tab, number | null> = {
    plugins: installed?.length ?? null,
    apps: apps.apps?.length ?? null,
    mcps: mcp.status ? Object.keys(mcp.servers).length + mcp.status.filter((x) => x.pluginId && !mcp.servers[x.name]).length : null,
    skills: skills.skills?.length ?? null,
    marketplace: markets.list?.length ?? null,
  };
  const needle = q.trim().toLowerCase();
  const match = (...xs: (string | null | undefined)[]) => !needle || xs.some((x) => x?.toLowerCase().includes(needle));

  return (
    <div className="ps">
      <div className="ps-head">
        <div>
          <h1 className="settings-title">Plugins</h1>
          <p className="settings-sub ps-sub">Manage plugins, skills, and MCPs</p>
        </div>
        <div className="ps-head-actions">
          <button className="ps-btn" onClick={() => navigate({ name: 'plugins' })}>
            Browse directory
          </button>
          <button ref={add.ref} className="ps-btn primary" onClick={add.toggle}>
            Add <ChevronDown size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="ps-tabbar">
        <div className="ps-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`ps-tab ${tab === t.id ? 'on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {counts[t.id] != null && <span className="ps-count">{counts[t.id]}</span>}
            </button>
          ))}
        </div>
        <label className="ps-search">
          <Search size={16} strokeWidth={1.7} />
          <input placeholder={TABS.find((t) => t.id === tab)!.search} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      {tab === 'plugins' && (
        <List loading={!installed} empty="No plugins installed" error={pluginsError}>
          {installed
            ?.filter((p) => match(nameOf(p), p.interface?.shortDescription, p.interface?.developerName))
            .map((p) => (
              <PluginItem key={p.id} p={p} />
            ))}
        </List>
      )}
      {tab === 'apps' && (
        <List loading={!apps.apps} empty="No apps available" error={apps.error}>
          {apps.apps
            ?.filter((a) => match(a.name, a.description))
            .map((a) => (
              <AppItem key={a.id} app={a} onChange={apps.reload} />
            ))}
        </List>
      )}
      {tab === 'mcps' &&
        (mcpEdit !== undefined ? (
          <McpEditor
            name={mcpEdit}
            config={mcpEdit ? mcp.servers[mcpEdit] : null}
            onDone={() => {
              setMcpEdit(undefined);
              // cannot reject: a failed read is shown as the list's error
              void mcp.reload();
            }}
          />
        ) : (
          <McpList
            status={mcp.status}
            servers={mcp.servers}
            error={mcp.error}
            match={match}
            onEdit={(n) => setMcpEdit(n)}
            onChange={mcp.reload}
          />
        ))}
      {tab === 'skills' && (
        <List loading={!skills.skills} empty="No skills found" error={skills.error}>
          {skills.skills
            ?.filter((s) => match(s.interface?.displayName ?? s.name, s.description))
            .map((s) => (
              <SkillItem key={s.path} s={s} onChange={skills.reload} />
            ))}
        </List>
      )}
      {tab === 'marketplace' && (
        <List loading={!markets.list} empty="No marketplaces added" error={markets.error}>
          {markets.list
            ?.filter((m) => match(m.name, m.interface?.displayName, m.path))
            .map((m) => (
              <MarketplaceItem key={m.name} m={m} onChange={markets.reload} />
            ))}
        </List>
      )}

      <Menu anchor={add.anchor} open={add.open} onClose={add.close} placement="bottom-end" width={178}>
        <MenuItem icon={<Blocks size={15} strokeWidth={1.7} />} onSelect={createPlugin}>
          Create plugin
        </MenuItem>
        <MenuItem icon={<Store size={15} strokeWidth={1.7} />} onSelect={() => setAddingMarketplace(true)}>
          Add a marketplace
        </MenuItem>
        <MenuItem
          icon={<Server size={15} strokeWidth={1.7} />}
          onSelect={() => {
            setTab('mcps');
            setTimeout(() => setMcpEdit(null), 0);
          }}
        >
          Add MCP server
        </MenuItem>
      </Menu>
      {addingMarketplace && (
        <MarketplaceDialog
          onClose={() => {
            setAddingMarketplace(false);
            // cannot reject: a failed read is shown as the list's error
            void markets.reload();
          }}
        />
      )}
    </div>
  );
}
