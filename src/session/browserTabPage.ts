// What a pane tab's menu asks of one browser tab's live page (Reload, Mute tab), whether or not that tab is in front.
import { useEffect, useRef } from 'react';
import { native } from '../lib/native';
import { set as setState } from '../store/core';

export interface BrowserTabPage {
  reload(): void;
  /** Mutes or unmutes the page; the tab records what main answers. Rejects when the tab has no page yet. */
  setMuted(muted: boolean): Promise<void>;
}

const pages = new Map<string, BrowserTabPage>();

/** The mounted page of pane tab `paneId`, or null while it has none. */
export const browserTabPage = (paneId: string): BrowserTabPage | null => pages.get(paneId) ?? null;

const recordMuted = (paneId: string, muted: boolean) =>
  setState((s) => ({ paneTabs: s.paneTabs.map((t) => (t.id === paneId ? { ...t, muted } : t)) }));

/**
 * Offers a BrowserPanel's page to its tab's menu for the panel's life. `bound(id)` is for each page that binds to the
 * tab (a new one after a crash restart): a muted tab mutes it too, or shows as unmuted if that fails.
 */
export function useBrowserTabPage(paneId: string, options: { reload(): void; pageId(): number | null; muted: boolean }) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const page: BrowserTabPage = {
      reload: () => latest.current.reload(),
      setMuted: async (muted) => {
        const id = latest.current.pageId();
        if (id == null) throw new Error('This browser page is not ready yet. Try again in a moment.');
        recordMuted(paneId, await native.browser.setAudioMuted(id, muted));
      },
    };
    pages.set(paneId, page);
    return () => {
      if (pages.get(paneId) === page) pages.delete(paneId);
    };
  }, [paneId]);
  return {
    bound(id: number) {
      if (!latest.current.muted) return;
      native.browser.setAudioMuted(id, true).then(
        (muted) => recordMuted(paneId, muted),
        () => recordMuted(paneId, false),
      );
    },
  };
}
