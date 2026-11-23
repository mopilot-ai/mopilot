// The app's right-pane lifetime: animate visibility while keeping live browser pages and terminal shells mounted.

import { useLayoutEffect } from 'react';
import { set as setState, useStore } from '../../store/core';
import { usePresence } from '../ui/Presence';
import { paneExitMs, prefersReducedMotion } from '../../lib/paneMotion';
import { SidePane } from './SidePane';

export function SidePaneSlot({ cwd, threadId }: { cwd: string; threadId: string | null }) {
  const open = useStore((s) => s.diffPanel.open);
  const full = useStore((s) => s.paneFull);
  const route = useStore((s) => s.route.name);
  const resources = useStore((s) => s.paneTabs.some((tab) => tab.kind === 'browser' || tab.kind === 'terminal'));
  const pane = usePresence(open && (route === 'thread' || route === 'home'), paneExitMs(full, prefersReducedMotion()));
  useLayoutEffect(() => {
    if (!pane.mounted && full) setState({ paneFull: false });
  }, [pane.mounted, full]);
  return pane.mounted || resources ? <SidePane cwd={cwd} threadId={threadId} leaving={pane.leaving} hidden={!pane.mounted} /> : null;
}
