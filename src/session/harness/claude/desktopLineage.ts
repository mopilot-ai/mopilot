// Claude desktop's side-session links, merged into the sidebar's family view only: they nest rows, never grant authority.
import { useSyncExternalStore } from 'react';
import type { OrchestrationView, SideSessionChild } from '../../../../shared/orchestration';
import { native } from '../../../lib/native';
import { ignoring } from '../../../lib/ignored';
import { claudeThreadId } from '../../../harness/types';
import { useOrchestration } from '../../../lib/sideSessions';

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

/** Tests: forget what was read. */
export function resetDesktopLineage() {
  imported = NONE;
  listeners.clear();
}
