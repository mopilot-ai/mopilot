// Which chat the thread view shows while the route switches from one chat to another: the new chat renders in the background.

import { useDeferredValue } from 'react';

/**
 * The chat the thread view renders for the routed chat `routeId` (null on any other page). A switch from one chat
 * to another renders the new chat through a deferred value: the switch itself (the sidebar's selection, the title)
 * paints at once, the new chat's view renders in a background render React can interrupt, and a switch that comes
 * before it finishes replaces it, so a chat clicked past never renders. Until then the old chat stays on screen,
 * `stale`, for the caller to make inert. Arriving from another page or leaving for one is not deferred.
 */
export function useShownThread(routeId: string | null): { id: string | null; stale: boolean } {
  const deferred = useDeferredValue(routeId);
  const id = routeId !== null && deferred !== null ? deferred : routeId;
  return { id, stale: id !== routeId };
}
