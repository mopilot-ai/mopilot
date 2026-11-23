// The windows' copy of linked sessions (main's electron/session/orchestration journal): read once, then kept current
// from main, and which thread items main delivered as a brief, a wake-up or a family message.
import { useSyncExternalStore } from 'react';
import type { OrchestrationView, SideSessionDelivery } from '../../shared/orchestration';
import { native } from './native';
import { ignoring } from './ignored';
import { windowReady } from './windowReady';
import { pluralize } from './format';

const EMPTY: OrchestrationView = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
let view: OrchestrationView = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function set(next: OrchestrationView | null | undefined) {
  view = next && typeof next === 'object' ? next : EMPTY;
  for (const fn of listeners) fn();
}

/**
 * Starts reading from main on first use; a snapshot that arrives after a change from main is older and dropped. A
 * bridge that fails (main gone) is only noted: the window then shows delivered items as ordinary messages.
 */
function start() {
  if (started) return;
  started = true;
  let changed = false;
  Promise.resolve()
    .then(() => {
      // read inside the chain: a window with no bridge is noted below, not thrown into the component that subscribed
      const bridge = native.orchestration;
      bridge.onChanged((next) => {
        changed = true;
        set(next);
      });
      // main answers only a window that told it it is ready: asked earlier, the read fails and nothing reads again
      // until the journal next changes, which may never happen
      return windowReady().then(() => bridge.snapshot());
    })
    .then((snap) => {
      if (!changed) set(snap);
    })
    .catch(ignoring('read the linked sessions'));
}

function subscribe(fn: () => void) {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The linked sessions, kept current. */
export function useOrchestration(): OrchestrationView {
  return useSyncExternalStore(
    subscribe,
    () => view,
    () => view,
  );
}

/** Only this chat's question: another session's plan or wrap-up does not re-render its row. */
export function useWrapUpAsk(chatId: string): boolean {
  const read = () => !!view.wrapUps?.[chatId]?.ask;
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * What main delivered a thread item as, with the key it is delivered under, matched by the client id main gave it, or
 * null for the user's own input. The id alone decides: a fork's copy of the parent's history keeps the parent's items,
 * which show as what they were.
 */
export function sideSessionEntryForItem(
  v: OrchestrationView,
  item: { id?: string; clientId?: string | null },
): { key: string; delivery: SideSessionDelivery } | null {
  for (const key of [item.clientId, item.id]) {
    const delivery = key ? v.deliveries[key] : undefined;
    if (key && delivery) return { key, delivery };
  }
  return null;
}

/** The same, as the delivery alone. */
export function sideSessionForItem(v: OrchestrationView, item: { id?: string; clientId?: string | null }): SideSessionDelivery | null {
  return sideSessionEntryForItem(v, item)?.delivery ?? null;
}

/** The chats `parentId` started, oldest first. */
export function linkedChildren(v: OrchestrationView, parentId: string): string[] {
  return Object.entries(v.children)
    .filter(([, c]) => c.parentId === parentId && !c.detached)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .map(([id]) => id);
}

/**
 * `roots` and every listed chat they started, theirs too, each once: what hiding the roots' rows hides. `above` (the
 * chats above the roots) and a damaged record's loop stop the walk.
 */
export function nestedFamily(v: OrchestrationView, roots: string[], listed: string[], above: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set(above);
  const shown = new Set(listed);
  const walk = (id: string) => {
    if (seen.has(id) || !shown.has(id)) return;
    seen.add(id);
    out.push(id);
    linkedChildren(v, id).forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/**
 * The chats from one `parentId` started down to `target`, `target` last ([] when it is not below `parentId`); a damaged
 * record's loop gives [].
 */
export function trailTo(v: OrchestrationView, parentId: string, target: string): string[] {
  const trail: string[] = [];
  for (let id = target; id !== parentId; id = v.children[id].parentId) {
    if (trail.includes(id) || !v.children[id]) return [];
    trail.unshift(id);
  }
  return trail;
}

export type NestedCounts = { input: number; failed: number; unread: number; working: number };

/**
 * The row that stands for hidden nested sessions, as in Claude's Code tab: "3 nested sessions" (or "2 more nested
 * sessions" when some still show), then each nonzero count in order (failed, unread, working), and the
 * button's label "Show 3 nested sessions, 1 failed, 1 working".
 */
export function nestedSummary(count: number, counts: NestedCounts, more: boolean) {
  const label = more
    ? pluralize(count, 'more nested session', 'more nested sessions')
    : pluralize(count, 'nested session', 'nested sessions');
  const parts = (
    [
      ['input', counts.input && pluralize(counts.input, 'needs input', 'need input')],
      ['failed', counts.failed && `${counts.failed} failed`],
      ['unread', counts.unread && `${counts.unread} unread`],
      ['working', counts.working && `${counts.working} working`],
    ] as const
  ).flatMap(([kind, text]) => (text ? [{ kind, text }] : []));
  return { label, parts, aria: [`Show ${label}`, ...parts.map((p) => p.text)].join(', ') };
}

/**
 * What a session made to wait for others shows instead of a state word: "Waits for api-schema, docs", or "Held:
 * api-schema failed" once one of them failed, was stopped, was lost or is gone. Null for a session that doesn't wait.
 */
export function waitingCaption(v: OrchestrationView, chatId: string): string | null {
  const w = v.waiting?.[chatId];
  if (!w) return null;
  const name = (id: string) => v.children[id]?.name ?? id;
  if (!w.held) return `Waits for ${w.after.map(name).join(', ')}`;
  const how = { failed: 'failed', stopped: 'was stopped', lost: 'was lost', gone: 'is gone', cycle: 'waits in a loop' }[w.held.how];
  return `Held: ${name(w.held.by)} ${how}`;
}

/** Tests: forget what was read. */
export function resetSideSessions() {
  started = false;
  view = EMPTY;
  listeners.clear();
}
