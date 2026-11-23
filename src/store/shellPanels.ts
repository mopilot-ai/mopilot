// The sidebar and summary island at the window's CSS width (src/lib/shellFit.ts): which fit, kept for every control
// that shows them, and the user's own show and hide.
import { useLayoutEffect, useRef } from 'react';
import { forcedAfter, panelChange, panelShown, shellFit, type ShellPanel } from '../lib/shellFit';
import { get as getState, set as setState, useStore } from './core';

export function showPanel(panel: ShellPanel, show: boolean) {
  setState((s) => panelChange(s, panel, show));
}

export function togglePanel(panel: ShellPanel) {
  setState((s) => panelChange(s, panel, !panelShown(s, panel)));
}

/**
 * Which side panels fit a window `viewport` CSS pixels wide, beside `splits` of split view, kept in the store. What the
 * user opened anyway is forgotten once it fits, and the summary once `summaryChat` changes.
 */
export function useShellFit(viewport: number, splits: number, summaryChat: string | null) {
  const sidebarChosen = useStore((s) => s.sidebarOpen);
  const sidebarForced = useStore((s) => !!s.shellForced.sidebar);
  const lastChat = useRef(summaryChat);
  useLayoutEffect(() => {
    const fit = shellFit(viewport, (fits) => sidebarChosen && (fits || sidebarForced), splits);
    const { shellFit: now, shellForced } = getState();
    const forced = forcedAfter(shellForced, fit, lastChat.current !== summaryChat);
    lastChat.current = summaryChat;
    if (now.sidebar !== fit.sidebar || now.summary !== fit.summary || forced !== shellForced)
      setState({ shellFit: fit, shellForced: forced });
  }, [viewport, splits, summaryChat, sidebarChosen, sidebarForced]);
}
