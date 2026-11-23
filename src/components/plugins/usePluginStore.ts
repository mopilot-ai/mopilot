// What the shared Plugins page shows, from MoPilot's plugin store in main (window.native.plugins): installed
// plugins, marketplaces, plugins the harnesses installed themselves and the Codex mirror's states, read again when
// the store says it changed.
import { useCallback, useEffect, useState } from 'react';
import { createLatestLoader } from '../../lib/latestLoader';
import { native } from '../../lib/native';
import type { CodexMirrorState, InstalledPlugin, MarketplaceListing, NativePlugin } from '../../lib/native/plugins';
import { errorText } from '../../lib/ignored';

export interface PluginStoreView {
  plugins: InstalledPlugin[] | null;
  marketplaces: MarketplaceListing[] | null;
  native: NativePlugin[];
  codex: Record<string, CodexMirrorState>;
  /** why the store, or a part of it, couldn't be read: said on the page, never shown as "none" */
  error: string | null;
  /** reads the store again; settles once the newest read is shown */
  reload: () => Promise<void>;
}

export function usePluginStore(): PluginStoreView {
  const [view, setView] = useState<Omit<PluginStoreView, 'reload'>>({
    plugins: null,
    marketplaces: null,
    native: [],
    codex: {},
    error: null,
  });
  // overlapping reads: only the latest one's answer is shown, none once the page is gone, and a reload settles once
  // the latest has
  const [loader] = useState(() =>
    createLatestLoader(
      // each part on its own: one that can't be read (a harness's own plugin folder) leaves the others shown.
      // allSettled cannot reject: every failure is a part's error, shown on the page
      () => Promise.allSettled([native.plugins.list(), native.plugins.catalog(), native.plugins.native(), native.plugins.codexStates()]),
      ([list, catalog, nativeList, codex]) => {
        const value = <T>(r: PromiseSettledResult<T>, fallback: T) => (r.status === 'fulfilled' ? r.value : fallback);
        const why = (r: PromiseSettledResult<unknown>, what: string) =>
          r.status === 'rejected' ? `${what}: ${errorText(r.reason)}` : null;
        const l = value(list, { plugins: [], error: null });
        const c = value(catalog, { marketplaces: [], error: null });
        const error =
          [
            why(list, 'Installed plugins'),
            l.error,
            why(catalog, 'Marketplaces'),
            c.error,
            why(nativeList, 'Plugins your harnesses installed'),
            why(codex, 'Codex installs'),
          ]
            .filter(Boolean)
            .join(' ') || null;
        setView({ plugins: l.plugins, marketplaces: c.marketplaces, native: value(nativeList, []), codex: value(codex, {}), error });
      },
    ),
  );
  const reload = useCallback(() => {
    void loader.load();
    return loader.settled();
  }, [loader]);
  useEffect(() => {
    void reload();
    const off = native.plugins.onChanged(() => void reload());
    return () => {
      loader.cancel();
      off();
    };
  }, [reload, loader]);
  return { ...view, reload };
}
