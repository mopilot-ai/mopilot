// Plugin detail loading, information, capabilities and launch actions.
import { useEffect, useState } from 'react';
import { navigate } from '../../../../store/panes';
import { toast } from '../../../../store/core';
import { codexRequest } from '../../../../harness/adapters/codex';
import { errorText, noteIgnored } from '../../../../lib/ignored';
import { copyText } from '../../../../session/clipboard';
import { openLink } from '../../../../session/open';
import { Menu, MenuItem, Tooltip, useAnchor } from '../../../ui/Popover';
import {
  Spinner,
  Plus,
  Ellipsis,
  ChevronRight,
  Sparkles,
  ExternalLink,
  Server,
  ArrowRight,
  Copy,
  Info,
  UserLock,
  MessagesSquare,
} from '../../../ui/icons';
import type { PluginDetail } from '../../../../protocol/v2/PluginDetail';
import type { PluginInterface } from '../../../../protocol/v2/PluginInterface';
import type { PluginReadResponse } from '../../../../protocol/v2/PluginReadResponse';
import { ensurePlugins, nameOf, toggleInstalled, tryPlugin, usePlugins } from './catalog';
import { PluginLogo } from './PluginLogo';

/** Full-page plugin detail (official layout: header, prompt preview, apps, information). */
export function PluginPage({ id }: { id: string }) {
  const { plugins, error } = usePlugins();
  const p = plugins?.find((x) => x.id === id) ?? null;
  const [detail, setDetail] = useState<Partial<PluginDetail> | null>(null);
  // another plugin's page shows none of the last one's details: reset while rendering, so no frame does
  const [detailFor, setDetailFor] = useState(id);
  if (detailFor !== id) {
    setDetailFor(id);
    setDetail(null);
  }
  const [busy, setBusy] = useState(false);
  const menu = useAnchor();
  useEffect(ensurePlugins, []);
  // the plugin's details, read again for another plugin; a catalog refresh that keeps it changes nothing
  const found = !!p;
  const marketplacePath = p?.marketplacePath;
  const marketplace = p?.marketplace;
  const pluginName = p?.name;
  useEffect(() => {
    if (!found) return;
    let live = true;
    setDetail(null);
    codexRequest<PluginReadResponse>('plugin/read', {
      marketplacePath: marketplacePath ?? undefined,
      remoteMarketplaceName: marketplacePath ? undefined : marketplace,
      pluginName,
    }).then(
      (r: PluginReadResponse) => live && setDetail(r.plugin),
      (e) => {
        // the page shows what the catalog knows about it
        noteIgnored("read a plugin's details", e);
        if (live) setDetail({});
      },
    );
    // another plugin's page: an answer for this one no longer lands
    return () => {
      live = false;
    };
  }, [found, marketplacePath, marketplace, pluginName]);
  if (!p)
    return (
      <div className="center-fill">
        {/* a catalog that couldn't load never lists it: say why instead of waiting */}
        {error ? <span className="settings-row-desc">Couldn't load plugins: {error}</span> : <Spinner size={18} />}
      </div>
    );
  const i: Partial<PluginInterface> = { ...(p.interface ?? {}), ...(detail?.summary?.interface ?? {}) };
  const prompts: string[] = i.defaultPrompt ?? [];
  const apps: { name: string; description?: string | null; template?: boolean; logoUrl?: string | null }[] = [
    ...(detail?.apps ?? []),
    ...(detail?.appTemplates ?? []).map((a) => ({ ...a, template: true })),
  ];
  const version = detail?.summary?.version ?? p.version;
  const info: [string, React.ReactNode][] = [
    ['Capabilities', i.capabilities?.length ? i.capabilities.join(', ') : null] as [string, React.ReactNode],
    ['Developer', i.developerName] as [string, React.ReactNode],
    ['Category', i.category] as [string, React.ReactNode],
    ['Version', version] as [string, React.ReactNode],
    ...(
      [
        ['Website', i.websiteUrl],
        ['Privacy Policy', i.privacyPolicyUrl],
        ['Terms of Service', i.termsOfServiceUrl],
      ] as [string, string | null][]
    ).map(
      ([k, url]) =>
        [
          k,
          url ? (
            <button className="pd-link" onClick={() => openLink(url)} aria-label={k}>
              <ExternalLink size={15} strokeWidth={1.7} />
            </button>
          ) : null,
        ] as [string, React.ReactNode],
    ),
  ].filter(([, v]) => v);
  const run = async () => {
    setBusy(true);
    try {
      await toggleInstalled(p);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  return (
    <div className="pd">
      <div className="pd-crumbs">
        <button className="pd-crumb" onClick={() => navigate({ name: 'plugins' })}>
          Plugins
        </button>
        <ChevronRight size={14} className="pd-crumb-sep" />
        <span className="pd-crumb current">{nameOf(p)}</span>
      </div>
      <div className="pd-scroll">
        <div className="pd-col">
          <PluginLogo p={p} size={60} />
          <div className="pd-head">
            <div>
              <h1 className="pd-title">{nameOf(p)}</h1>
              {i.shortDescription && <div className="pd-sub">{i.shortDescription}</div>}
            </div>
            <div className="pd-actions">
              <button ref={menu.ref} className="pd-more" onClick={menu.toggle} aria-label="Plugin actions">
                <Ellipsis size={16} />
              </button>
              {detail?.shareUrl && (
                <button className="pd-btn" onClick={() => copyText(detail.shareUrl!, 'Copied link')}>
                  <Copy size={14} strokeWidth={1.7} /> Copy link
                </button>
              )}
              {p.installed ? (
                <button className="pd-btn primary" onClick={() => tryPlugin(p)}>
                  <MessagesSquare size={14} strokeWidth={1.7} /> Try now
                </button>
              ) : (
                <button className="pd-btn primary" disabled={busy || p.availability === 'UNAVAILABLE'} onClick={run}>
                  {busy ? <Spinner size={12} /> : <Plus size={14} strokeWidth={1.8} />} Install
                </button>
              )}
            </div>
          </div>
          {prompts.length > 0 && (
            <div className="pd-preview">
              <div className="pd-preview-bg" />
              <div className="pd-prompts">
                {prompts.map((t) => (
                  <button key={t} className="pd-prompt" onClick={() => (p.installed ? tryPlugin(p, t) : run())}>
                    <span className="pd-prompt-text">
                      <span className="pd-mention">
                        {i.composerIconUrl ? <img className="pd-mention-icon" src={i.composerIconUrl} /> : <PluginLogo p={p} size={16} />}
                        {nameOf(p)}
                      </span>
                      <span className="pd-prompt-body">{t}</span>
                    </span>
                    <span className="pd-arrow">
                      <ArrowRight size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {(i.longDescription || detail?.description) && <div className="pd-long">{i.longDescription ?? detail!.description}</div>}
          {apps.length > 0 && (
            <section className="pd-section">
              <div className="pd-section-head">
                <h2>Apps</h2>
                <span className="pd-count">{apps.length}</span>
              </div>
              <div className="pd-apps">
                {apps.map((a) => (
                  <div key={a.name} className={`pd-app ${a.template ? 'template' : ''}`}>
                    <span className="pd-app-icon">{a.logoUrl ? <img src={a.logoUrl} /> : <PluginLogo p={p} size={24} />}</span>
                    <span className="pd-app-text">
                      <span className="pd-app-name">
                        {a.name}
                        {!a.template && <Info size={13} strokeWidth={1.7} className="pd-app-info" />}
                      </span>
                      {a.description && <span className="pd-app-desc">{a.description}</span>}
                    </span>
                    {a.template && (
                      <Tooltip label="Your workspace admin sets this up">
                        <span className="pd-app-lock">
                          <UserLock size={15} strokeWidth={1.6} />
                        </span>
                      </Tooltip>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          {(detail?.skills?.length ?? 0) > 0 && (
            <section className="pd-section">
              <div className="pd-section-head">
                <h2>Skills</h2>
                <span className="pd-count">{detail!.skills!.length}</span>
              </div>
              <div className="pd-apps">
                {detail!.skills!.map((sk) => (
                  <div key={sk.name} className="pd-app">
                    <span className="pd-app-icon">
                      <Sparkles size={18} strokeWidth={1.6} />
                    </span>
                    <span className="pd-app-text">
                      <span className="pd-app-name">{sk.interface?.displayName ?? sk.name}</span>
                      {sk.description && <span className="pd-app-desc">{sk.interface?.shortDescription ?? sk.description}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {(detail?.mcpServers?.length ?? 0) > 0 && (
            <section className="pd-section">
              <div className="pd-section-head">
                <h2>MCP servers</h2>
                <span className="pd-count">{detail!.mcpServers!.length}</span>
              </div>
              <div className="pd-apps">
                {detail!.mcpServers!.map((m: string) => (
                  <div key={m} className="pd-app">
                    <span className="pd-app-icon">
                      <Server size={18} strokeWidth={1.6} />
                    </span>
                    <span className="pd-app-text">
                      <span className="pd-app-name">{m}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {info.length > 0 && (
            <section className="pd-section">
              <div className="pd-section-head">
                <h2>Information</h2>
              </div>
              <dl className="pd-info">
                {info.map(([k, v]) => (
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
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={180}>
        {p.installed ? (
          <MenuItem danger onSelect={run}>
            Uninstall
          </MenuItem>
        ) : (
          <MenuItem onSelect={run}>Install</MenuItem>
        )}
      </Menu>
    </div>
  );
}
