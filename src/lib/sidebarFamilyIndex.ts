// One shared, identity-memoized sidebar family index, so a row's selector costs a lookup instead of a rebuild per store write.
import type { OrchestrationView } from '../../shared/orchestration';
import { byActivity, withChatRewinds } from './chatActivity';
import { isMomoChat } from './momoChats';
import { sidebarFamilies } from './sidebarFamilies';

type Families = ReturnType<typeof sidebarFamilies>;
type Entry = {
  view: OrchestrationView;
  order: readonly string[];
  threads: Record<string, Parameters<typeof byActivity>[0]>;
  momo: unknown;
  rewoundAt?: Record<string, number>;
  value: Families;
};

const cache: { sorted?: Entry; listed?: Entry; withRewinds?: Entry } = {};
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
  rewoundAt?: Record<string, number>,
): Families {
  const activity = sorted ? rewoundAt : undefined;
  const key = activity ? 'withRewinds' : sorted ? 'sorted' : 'listed';
  const hit = cache[key];
  if (hit && hit.view === view && hit.order === order && hit.threads === threads && hit.momo === momoChats && hit.rewoundAt === activity)
    return hit.value;
  const ids = order.filter((id) => !!threads[id] && !isMomoChat(momoChats, id));
  if (sorted) {
    const rows = withChatRewinds(threads, activity);
    ids.sort((a, b) => byActivity(rows[a], rows[b]));
  }
  familyBuilds.count += 1;
  const value = sidebarFamilies(view, ids);
  cache[key] = { view, order, threads, momo: momoChats, rewoundAt: activity, value };
  return value;
}
