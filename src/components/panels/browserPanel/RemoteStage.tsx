// What the browser pane draws for an agent's tab on a Host: a page by its frames, or the Host's whole desktop (G8 #3903).
import type { MutableRefObject } from 'react';
import { agentTabFor } from '../../../lib/agentTabs';
import { hostOfTabKey, isDesktopTabKey } from '../../../lib/hostTabKey';
import { useStore } from '../../../store/core';
import { HostDesktopSurface } from './HostDesktopSurface';
import { RemoteViewSurface } from './RemoteViewSurface';
import type { WebviewElement } from './ViewSurface';

export function RemoteStage({
  handleRef,
  paneId,
  chatId,
  tabKey,
  shown,
  takenOver,
}: {
  handleRef: MutableRefObject<WebviewElement | null>;
  paneId: string;
  chatId: string;
  /** the pane key, which names the Host */
  tabKey: string;
  shown: boolean;
  takenOver: boolean;
}) {
  // the machine of a desktop tab, from main's agent-tab view
  const machine = useStore((s) => agentTabFor(s.agentTabs, chatId, tabKey)?.desktop?.machine);
  if (isDesktopTabKey(tabKey))
    return (
      <HostDesktopSurface
        paneId={paneId}
        chatId={chatId}
        hostId={String(hostOfTabKey(tabKey))}
        machine={machine ?? 'the other machine'}
        shown={shown}
        takenOver={takenOver}
      />
    );
  return <RemoteViewSurface handleRef={handleRef} paneId={paneId} chatId={chatId} tabKey={tabKey} shown={shown} takenOver={takenOver} />;
}
