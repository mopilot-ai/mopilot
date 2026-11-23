// Which side panels fit beside the chat at the window's CSS width: a zoomed or narrow window hides the summary island,
// then the sidebar, instead of squeezing the chat under them. The saved open/closed choice stays as the user left it.
import type { AppState } from '../../shared/model/window';
import { SIDEBAR_MIN_WIDTH } from './sidebarSizing';
import { CHAT_MIN_WIDTH, SUMMARY_SLOT_WIDTH } from './splitClamp';

export type ShellPanel = 'sidebar' | 'summary';
export type ShellFit = Record<ShellPanel, boolean>;
type PanelState = Pick<AppState, 'sidebarOpen' | 'summaryOpen' | 'shellFit' | 'shellForced'>;

/**
 * Room for each panel in a window `viewport` CSS pixels wide (zoom divides them), the summary island giving way first:
 * it counts the sidebar at its narrowest only while the sidebar shows. `splits` is what split view panes beside the
 * chat need at their narrowest. An unmeasured window fits both.
 */
export function shellFit(viewport: number, sidebarShown: (fits: boolean) => boolean, splits = 0): ShellFit {
  if (!(viewport > 0)) return { sidebar: true, summary: true };
  const chat = CHAT_MIN_WIDTH + splits;
  const sidebar = viewport >= SIDEBAR_MIN_WIDTH + chat;
  const beside = sidebarShown(sidebar) ? SIDEBAR_MIN_WIDTH : 0;
  return { sidebar, summary: viewport >= beside + SUMMARY_SLOT_WIDTH + chat };
}

/**
 * What the user opened anyway once it fits again, or once the summary belongs to another chat: forgotten, so the
 * next time the room runs out the panel gives way again.
 */
export function forcedAfter(forced: AppState['shellForced'], fit: ShellFit, chatChanged = false): AppState['shellForced'] {
  const next = { sidebar: !!forced.sidebar && !fit.sidebar, summary: !!forced.summary && !fit.summary && !chatChanged };
  return next.sidebar === !!forced.sidebar && next.summary === !!forced.summary ? forced : next;
}

const OPEN = { sidebar: 'sidebarOpen', summary: 'summaryOpen' } as const;

/** The panel is on screen: the user has it open, and it fits or the user opened it at this width anyway. */
export const panelShown = (s: PanelState, panel: ShellPanel) => s[OPEN[panel]] && (s.shellFit[panel] || !!s.shellForced[panel]);

/**
 * The change that shows or hides `panel` as the user asked. Showing one that does not fit shows it anyway, so a
 * button never looks dead; hiding one sets the saved choice.
 */
export function panelChange(s: PanelState, panel: ShellPanel, show: boolean): Partial<AppState> {
  return { [OPEN[panel]]: show, shellForced: { ...s.shellForced, [panel]: show && !s.shellFit[panel] } };
}
