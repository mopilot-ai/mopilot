// Which browser pane tabs are loading a page now, for the tab strip's spinner: kept apart from the pane tabs, which are
// saved, so a quit mid-load never leaves a tab spinning when the app opens again.
import { useEffect } from 'react';
import { create } from 'zustand';

export const usePaneLoading = create<Record<string, boolean>>(() => ({}));

/** The pane's page started or stopped loading; a closed tab is forgotten. */
export function setPaneLoading(tabId: string, loading: boolean) {
  usePaneLoading.setState((s) => {
    if (!!s[tabId] === loading) return s;
    const next = { ...s };
    if (loading) next[tabId] = true;
    else delete next[tabId];
    return next;
  }, true);
}

/** A browser pane reports its page's loading for its tab, and nothing once it goes. */
export function useReportPaneLoading(tabId: string, loading: boolean) {
  useEffect(() => {
    setPaneLoading(tabId, loading);
    return () => setPaneLoading(tabId, false);
  }, [tabId, loading]);
}
