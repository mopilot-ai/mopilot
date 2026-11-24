// Claude desktop's side-session links, merged into the sidebar's family view only: they nest rows, never grant authority.
import { useSyncExternalStore } from 'react';
import type { OrchestrationView, SideSessionChild } from '../../../../shared/orchestration';
import { native } from '../../../lib/native';
import { ignoring } from '../../../lib/ignored';
import { claudeThreadId } from '../../../harness/types';
import { orchestrationNow, subscribeOrchestration, useOrchestration } from '../../../lib/sideSessions';

/** Thread id → the thread id of the Claude desktop chat that started it. */
type Imported = Record<string, { parentId: string; createdAt: number }>;

const NONE: Imported = {};
let imported: Imported = NONE;
const listeners = new Set<() => void>();

const sameLinks = (a: Imported, b: Imported) => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => b[k] && b[k].parentId === a[k].parentId && b[k].createdAt === a[k].createdAt)
  );
};

/** Reads the links again (after each Claude session listing); unchanged links keep their identity, so nothing re-renders. */
export function loadDesktopLineage(): Promise<void> {
  // read inside the chain: a window whose bridge lacks it is noted below, not thrown into the listing
  return Promise.resolve()
    .then(() => native.claude.desktopLineage())
    .then((links) => {
      const next: Imported = {};
      for (const [child, l] of Object.entries(links))
        next[claudeThreadId(child)] = { parentId: claudeThreadId(l.parentId), createdAt: l.createdAt };
      if (sameLinks(imported, next)) return;
      imported = next;
      for (const fn of listeners) fn();
    })
    .catch(ignoring("read Claude desktop's side sessions"));
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const merged = new WeakMap<OrchestrationView, { from: Imported; view: OrchestrationView }>();

/**
 * `view` with Claude desktop's links added for chats MoPilot's own journal does not link: the journal decides every
 * chat it knows, including one the user detached here.
 */
export function withDesktopLineage(view: OrchestrationView, links: Imported): OrchestrationView {
  const hit = merged.get(view);
  if (hit && hit.from === links) return hit.view;
  const extra = Object.entries(links).filter(([id, l]) => !view.children[id] && l.parentId !== id);
  const next: OrchestrationView = extra.length
    ? { ...view, children: { ...view.children, ...Object.fromEntries(extra.map(([id, l]) => [id, desktopChild(l)])) } }
    : view;
  merged.set(view, { from: links, view: next });
  return next;
}

const desktopChild = (l: Imported[string]): SideSessionChild => ({
  parentId: l.parentId,
  name: '',
  title: '',
  harness: 'claude',
  useWorktree: false,
  createdAt: l.createdAt,
  lastReport: null,
});

/** The family view the sidebar nests by: MoPilot's linked sessions plus Claude desktop's. */
export function useSidebarLineage(): OrchestrationView {
  const links = useSyncExternalStore(
    subscribe,
    () => imported,
    () => imported,
  );
  return withDesktopLineage(useOrchestration(), links);
}

/** The family view now, for a reader outside React. */
export const sidebarLineageNow = () => withDesktopLineage(orchestrationNow(), imported);

const stamps = new WeakMap<OrchestrationView, string>();
/** Who started whom in a view, as text: all the sidebar's families read of it (lib/sidebarFamilies.ts), so it changes far less than the view. */
function stampOf(v: OrchestrationView): string {
  let stamp = stamps.get(v);
  if (stamp === undefined) {
    stamp = Object.entries(v.children)
      .map(([id, c]) => `${id}>${c.detached ? '!' : ''}${c.parentId}`)
      .join('\n');
    stamps.set(v, stamp);
  }
  return stamp;
}

/** Re-renders the component when the families change (who started whom), not for any other change of a linked session. */
export function useLineageStamp(): string {
  const read = () => stampOf(sidebarLineageNow());
  return useSyncExternalStore(subscribeLineage, read, read);
}

/** The family view last handed out, and the stamp it had: while the stamp holds, so does the view (below). */
let familyHeld: { stamp: string; view: OrchestrationView } | null = null;
export function familyLineageNow(): OrchestrationView {
  const view = sidebarLineageNow();
  const stamp = stampOf(view);
  if (familyHeld?.stamp !== stamp) familyHeld = { stamp, view };
  return familyHeld.view;
}

/**
 * The view for a reader that takes only who started whom from it (`familiesOf`: parent and detached, nothing else of a
 * linked session): the same object until the families change, so a running session's clock, a report or a title moving
 * (the view changes about every 20 s) neither re-renders the sidebar nor makes it rebuild every family (#5398). Do not read
 * a name, a time or a state from it: those are as old as the last change of the families.
 */
export function useFamilyLineage(): OrchestrationView {
  return useSyncExternalStore(subscribeLineage, familyLineageNow, familyLineageNow);
}

/** Calls `fn` when MoPilot's linked sessions or Claude desktop's links change; returns the unsubscribe. */
export function subscribeLineage(fn: () => void) {
  const stopOrchestration = subscribeOrchestration(fn);
  const stopLinks = subscribe(fn);
  return () => {
    stopOrchestration();
    stopLinks();
  };
}

/** Tests: forget what was read. */
export function resetDesktopLineage() {
  familyHeld = null;
  imported = NONE;
  listeners.clear();
}
