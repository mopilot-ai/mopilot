// Whether a sidebar row has started chats nested under it, re-rendered only when the families change, not for every change of a linked session (#5398).
import { useStore } from '../../store/core';
import { familyLineageNow, useLineageStamp } from '../../session/harness/claude/desktopLineage';
import { familiesOf } from '../../lib/sidebarFamilyIndex';

/** Whether chat `id` has listed chats that its linked sessions started (the shared, identity-memoized family index decides). */
export function useSidebarNests(id: string, enabled: boolean): boolean {
  // the selector below reads the family view as it is when it runs: this renders the row when who-started-whom changed
  useLineageStamp();
  return useStore(
    (s) => enabled && !!familiesOf(familyLineageNow(), s.threadOrder, s.threads, s.momoChats, false).descendants.get(id)?.length,
  );
}
