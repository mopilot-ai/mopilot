// One shared, identity-memoized sidebar family index, so a row's selector costs a lookup instead of a rebuild per store write.
import type { OrchestrationView } from '../../shared/orchestration';
import { byActivity } from './chatActivity';
import { isMomoChat } from './momoChats';
import { sidebarFamilies } from './sidebarFamilies';

type Families = ReturnType<typeof sidebarFamilies>;
type Entry = {
  view: OrchestrationView;
  order: readonly string[];
  threads: Record<string, Parameters<typeof byActivity>[0]>;
  momo: unknown;
  value: Families;
};

const cache: { sorted?: Entry; listed?: Entry } = {};
/** How many times the index was rebuilt; tests assert it does not grow with unrelated store writes. */
export const familyBuilds = { count: 0 };

/**
 * Families of the listed, non-Momo chats. Recomputed only when one of the four inputs changes identity;
 * `sorted` follows the by-activity comparator, otherwise the stored order. Every row shares the result.
 */
export function familiesOf(
  view: OrchestrationView,
  order: readonly string[],
  threads: Record<string, Parameters<typeof byActivity>[0]>,
  momoChats: Parameters<typeof isMomoChat>[0],
  sorted: boolean,
): Families {
  const key = sorted ? 'sorted' : 'listed';
  const hit = cache[key];
  if (hit && hit.view === view && hit.order === order && hit.threads === threads && hit.momo === momoChats) return hit.value;
  const ids = order.filter((id) => !!threads[id] && !isMomoChat(momoChats, id));
  if (sorted) ids.sort((a, b) => byActivity(threads[a], threads[b]));
  familyBuilds.count += 1;
  const value = sidebarFamilies(view, ids);
  cache[key] = { view, order, threads, momo: momoChats, value };
  return value;
}
