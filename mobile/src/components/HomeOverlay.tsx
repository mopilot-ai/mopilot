// Where the Chats home's sheets are drawn: over the whole screen, not at the end of the list. A sheet fills its parent, and the list's parent is the scroll content, so a sheet opened from a row at the top of a long list was drawn eight screens below it; the page gives the list a slot above its scroll view and the list puts its sheet there.
import { createContext, useContext, useEffect, type ReactNode } from 'react';

/** Sets what the page draws over its screen (null clears it); absent outside the page. */
export const HomeOverlayContext = createContext<((node: ReactNode) => void) | null>(null);

/** Puts `node` over the page's screen while it is given; where there is no page (a list drawn alone) it is returned to draw in place. */
export function useHomeOverlay(node: ReactNode): ReactNode {
  const set = useContext(HomeOverlayContext);
  useEffect(() => {
    if (!set) return;
    set(node);
    return () => set(null);
  }, [set, node]);
  return set ? null : node;
}
