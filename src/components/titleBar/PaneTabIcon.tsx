// The icon of a side pane tab in the title bar's strip: its kind's mark, and for a browser tab a spinner while its page
// loads (src/store/paneLoading.ts), the agent's mark while one drives it, else the globe.
import type { PaneTab } from '../../store/state';
import { usePaneLoading } from '../../store/paneLoading';
import {
  AppWindow,
  Box,
  Bot,
  Diamond,
  DiffSquare,
  FileText,
  Files,
  Gauge,
  FolderTree,
  Globe,
  Palette,
  SideChatIcon,
  Spinner,
  SquareTerminal,
} from '../ui/icons';

const KIND = {
  changes: DiffSquare,
  files: FolderTree,
  file: FileText,
  plan: FileText,
  outputs: Files,
  usage: Gauge,
  skill: Box,
  terminal: SquareTerminal,
  chat: SideChatIcon,
  tasks: Diamond,
  artifact: AppWindow,
};

/** `badge`: what the agent driving a browser tab is doing, as the tab's tooltip says it. */
export function PaneTabIcon({ tab, badge }: { tab: Pick<PaneTab, 'id' | 'kind' | 'artifactKind'>; badge?: string | null }) {
  const loading = usePaneLoading((s) => !!s[tab.id]);
  // a Claude Design project has the palette the thread's card has
  const Icon = tab.kind === 'browser' ? null : tab.artifactKind === 'design' ? Palette : KIND[tab.kind];
  if (Icon) return <Icon size={15} strokeWidth={1.6} />;
  if (loading) return <Spinner size={15} />;
  return badge ? <Bot size={15} strokeWidth={1.6} aria-label={badge} /> : <Globe size={15} strokeWidth={1.6} />;
}
