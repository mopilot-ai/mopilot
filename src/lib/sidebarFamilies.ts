// Ordered sidebar families: stable roots at their best member's position, with depth-first descendants at one visual level.
import type { OrchestrationView } from '../../shared/orchestration';
import { chatFamilies } from '../../shared/chatFamilies.mjs';

/** `listed` already follows the list's comparator; malformed ancestry never hides or duplicates a listed chat. */
export function sidebarFamilies(view: OrchestrationView, listed: readonly string[]) {
  return chatFamilies(listed, (id) => {
    const link = view.children[id];
    return link && !link.detached ? link.parentId : null;
  });
}
