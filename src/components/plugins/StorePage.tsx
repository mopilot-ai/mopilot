// The shared Plugins page: MoPilot's own plugin store, installed once for every harness. Installed plugins (and
// those one harness installed itself), plugins to discover in the added marketplaces, and the marketplaces themselves.
import { useMemo, useState } from 'react';
import { native } from '../../lib/native';
import type { InstalledPlugin, MarketplaceListing, PluginPreview } from '../../lib/native/plugins';
import { toast } from '../../store/core';
import { pluralize } from '../../lib/format';
import { Group, Row, Segmented } from '../pages/Settings';
import { usePluginStore } from './usePluginStore';
import { useFlag } from '../../lib/flags';
import { FAMILY_LABEL } from './ReachStrip';
import { TrustDialog } from './TrustDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { AddMarketplaceDialog } from './AddMarketplaceDialog';
import { InstallCard, InstalledCard } from './PluginCards';
import { attempt, pluginTitle, titleOfName } from './pluginView';

/** How many plugins Discover lists before asking for a search. */
export const DISCOVER_LIMIT = 50;

type View = 'installed' | 'discover' | 'marketplaces';
const VIEWS: { value: View; label: string }[] = [
  { value: 'installed', label: 'Installed' },
  { value: 'discover', label: 'Discover' },
  { value: 'marketplaces', label: 'Marketplaces' },
];

type Ready = Extract<PluginPreview, { ok: true }>;
/** An install waiting on its review: what it brings, and how to install it once accepted. */
type Review = { preview: Ready; install: (trust: string) => Promise<unknown> };
/** A step that asks first: what it says, and what it does. */
type Confirm = { title: string; detail: string; action: string; run: () => Promise<unknown> };

const sourceText = (m: MarketplaceListing) =>
  m.source.kind === 'local' ? m.source.path : `${m.source.url}${m.source.ref ? `#${m.source.ref}` : ''}`;

export function StorePage() {
  const store = usePluginStore();
  const [view, setView] = useState<View>('installed');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [confirming, setConfirming] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  // with plugins.codex off, nothing goes to Codex (electron/plugins/codexMirror.cjs)
  const codexOn = useFlag('plugins.codex');

  const q = query.trim().toLowerCase();
  const matches = (...text: (string | undefined)[]) => !q || text.join(' ').toLowerCase().includes(q);
  const installedIds = useMemo(() => new Set((store.plugins ?? []).map((p) => p.id)), [store.plugins]);
  const allDiscover = useMemo(
    () =>
      (store.marketplaces ?? [])
        .flatMap((m) => (m.marketplace?.plugins ?? []).map((p) => ({ ...p, marketplace: m.name, id: `${p.name}@${m.name}` })))
        .filter((p) => !installedIds.has(p.id)),
    [store.marketplaces, installedIds],
  );
  const discover = allDiscover.filter((p) => matches(p.name, p.description));
  const installed = (store.plugins ?? []).filter((p) => matches(p.id, p.spec?.displayName, p.spec?.description));
  const elsewhere = store.native.filter((p) => !installedIds.has(p.id) && matches(p.name));

  /** Ask main what installing brings, then show the review; a plugin that can't be read says why. */
  const startReview = async (preview: () => Promise<PluginPreview>, install: Review['install']) => {
    const p = await attempt(preview);
    if (!p) return;
    if (!p.ok) toast(p.error, 'error');
    else setReview({ preview: p, install });
  };
  const confirmInstall = async (r: Review) => {
    setBusy(true);
    const done = await attempt(() => r.install(r.preview.trust));
    setBusy(false);
    if (done) {
      toast(`Installed ${pluginTitle(r.preview.spec)}`);
      setReview(null);
    }
  };
  const askUninstall = (plugin: InstalledPlugin, title: string) =>
    setConfirming({
      title: `Uninstall ${title}?`,
      detail: "It's removed from every harness.",
      action: 'Uninstall',
      run: async () => {
        if (await attempt(() => native.plugins.uninstall(plugin.id))) toast(`Uninstalled ${title}`);
      },
    });
  const askRemove = (m: MarketplaceListing) =>
    setConfirming({
      title: `Remove ${m.name}?`,
      detail: 'Plugins you installed from it stay installed.',
      action: 'Remove',
      run: async () => {
        if (await attempt(() => native.plugins.marketplaceRemove(m.name))) toast(`Removed ${m.name}`);
      },
    });
  const upgrade = async (m: MarketplaceListing) => {
    if (await attempt(() => native.plugins.marketplaceUpgrade(m.name))) toast(`Updated ${m.name}`);
  };

  return (
    <div className="page plugins-page">
      <div className="page-header">
        <h1 className="page-title">Plugins</h1>
      </div>
      <div className="plugin-store-bar">
        <Segmented value={view} onChange={setView} options={VIEWS} />
        {view !== 'marketplaces' && (
          <input
            className="plugin-store-search"
            aria-label="Search plugins"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <button className="btn-pill soft plugin-store-add" onClick={() => setAdding(true)}>
          Add marketplace
        </button>
      </div>

      {store.error && (
        <Group>
          <Row title="Couldn't read all of the plugin store" desc={store.error}>
            <button className="btn-pill soft" onClick={() => void store.reload()}>
              Retry
            </button>
          </Row>
        </Group>
      )}

      {view === 'installed' && (
        <>
          {!store.plugins ? (
            <Group>
              <Row title="Loading…" />
            </Group>
          ) : store.plugins.length === 0 && !store.error ? (
            <Group>
              <Row title="No plugins yet">
                <button className="btn-pill soft" onClick={() => setView('discover')}>
                  Discover plugins
                </button>
              </Row>
            </Group>
          ) : installed.length === 0 && q ? (
            <Group>
              <Row title="No plugins match your search" />
            </Group>
          ) : (
            <div className="plugin-grid">
              {installed.map((p) => (
                <InstalledCard
                  key={p.id}
                  plugin={p}
                  installs={{ codex: store.codex[p.id] }}
                  reload={store.reload}
                  onUninstall={askUninstall}
                />
              ))}
            </div>
          )}
          {elsewhere.length > 0 && (
            <section className="plugin-store-section">
              <h2 className="settings-group-title">On this Mac</h2>
              <div className="plugin-grid">
                {elsewhere.map((p) => (
                  <InstallCard
                    key={p.id}
                    title={titleOfName(p.name)}
                    meta={`Only on ${FAMILY_LABEL[p.harness]}`}
                    onInstall={() =>
                      void startReview(
                        () => native.plugins.previewNative(p.id),
                        (trust) => native.plugins.importNative(p.id, trust),
                      )
                    }
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {view === 'discover' &&
        (discover.length > 0 ? (
          <>
            <div className="plugin-grid">
              {discover.slice(0, DISCOVER_LIMIT).map((p) => (
                <InstallCard
                  key={p.id}
                  title={titleOfName(p.name)}
                  desc={p.description}
                  meta={p.author ? `by ${p.author}` : `from ${p.marketplace}`}
                  onInstall={() =>
                    void startReview(
                      () => native.plugins.preview(p.marketplace, p.name),
                      (trust) => native.plugins.install(p.marketplace, p.name, trust),
                    )
                  }
                />
              ))}
            </div>
            {discover.length > DISCOVER_LIMIT && (
              <p className="plugin-store-note">
                Showing {DISCOVER_LIMIT} of {discover.length}. Search to find the rest.
              </p>
            )}
          </>
        ) : (
          <Group>
            {!store.marketplaces?.length ? (
              <Row title="No marketplaces yet" />
            ) : allDiscover.length > 0 ? (
              <Row title="No plugins match your search" />
            ) : (
              <Row title="Nothing more to install" />
            )}
          </Group>
        ))}

      {view === 'marketplaces' && (
        <Group>
          {store.marketplaces?.length ? (
            store.marketplaces.map((m) => (
              <Row
                key={m.name}
                title={m.name}
                desc={m.error ?? `${pluralize(m.marketplace?.plugins.length ?? 0, 'plugin')} · ${sourceText(m)}`}
              >
                <div className="plugin-store-actions">
                  {m.source.kind === 'git' && (
                    <button className="btn-pill soft" onClick={() => void upgrade(m)}>
                      Update
                    </button>
                  )}
                  <button className="btn-pill soft" onClick={() => askRemove(m)}>
                    Remove
                  </button>
                </div>
              </Row>
            ))
          ) : (
            <Row title="No marketplaces yet" />
          )}
        </Group>
      )}

      {adding && <AddMarketplaceDialog added={store.marketplaces} onClose={() => setAdding(false)} />}
      {review && (
        <TrustDialog
          preview={review.preview}
          busy={busy}
          sharedInstall={codexOn ? "Also appears in Codex's own app and CLI." : undefined}
          onInstall={() => void confirmInstall(review)}
          onClose={() => setReview(null)}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={confirming.title}
          detail={confirming.detail}
          action={confirming.action}
          onConfirm={() => {
            setConfirming(null);
            void confirming.run();
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
