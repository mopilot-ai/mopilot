// Mount and unmount animations: keeping content (or a list's removed rows) mounted through its exit, and collapsing height.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Keep something mounted while it plays its exit animation. `mounted` says whether to render it and
 * `leaving` whether it is on its way out (add the `leaving` class so CSS can animate it).
 */
export function usePresence(show: boolean, ms = 150): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  useEffect(() => {
    if (show || !mounted) return;
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [show, mounted, ms]);
  return { mounted: show || mounted, leaving: !show };
}

/**
 * The longest height transition a Collapse plays (motion.css: tool rows 300ms, as the Codex app's disclosures;
 * sidebar lists 240ms), so closed content stays mounted until it has collapsed.
 */
export const COLLAPSE_MS = 300;

/** Height animation for content that opens and closes; closed content is unmounted once it has collapsed. */
export function Collapse({ open, className = '', children }: { open: boolean; className?: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (open) {
      setMounted(true);
      // paint the collapsed state once so the grid has something to transition from
      const f = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(f);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className={`collapse ${className} ${shown ? 'open' : ''}`}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/**
 * A list whose removed entries stay rendered for `ms` (as `leaving`) so they can play their exit, where they were.
 * Removals are found while rendering (not after it), so the removed entry's element is never unmounted and remounted
 * on its way out, which would skip its transition. Each removed entry has its own timer, so a second removal never cuts
 * the first one's exit short, and an entry that comes back is shown as itself at once. `ms` 0 (reduced motion) drops
 * removed entries straight away.
 */
export function usePresentList<T>(items: T[], keyOf: (item: T) => string, ms: number): { item: T; key: string; leaving: boolean }[] {
  // each leaving entry with the order the list was shown in when it left, to put it back where it was
  const [leaving, setLeaving] = useState<Map<string, { item: T; order: string[] }>>(() => new Map());
  const [previous, setPrevious] = useState(items);
  // the keys in the order they were last committed, leaving entries included
  const committed = useRef<string[]>(items.map(keyOf));
  if (previous !== items) {
    const now = new Set(items.map(keyOf));
    const next = new Map(leaving);
    // an entry that came back stops leaving
    for (const key of leaving.keys()) if (now.has(key)) next.delete(key);
    if (ms > 0)
      for (const item of previous) {
        const key = keyOf(item);
        if (!now.has(key) && !next.has(key)) next.set(key, { item, order: committed.current });
      }
    setPrevious(items);
    setLeaving(next);
  }
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const [key, t] of timers.current)
      if (!leaving.has(key)) {
        clearTimeout(t);
        timers.current.delete(key);
      }
    for (const key of leaving.keys()) {
      if (timers.current.has(key)) continue;
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setLeaving((m) => {
            const next = new Map(m);
            next.delete(key);
            return next;
          });
        }, ms),
      );
    }
  }, [leaving, ms]);
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => clearTimeout(t));
  }, []);
  // each leaving entry goes back before the entry that followed it when it left and is still there (or at the end),
  // earliest place first, so several leaving at once keep their order
  const out = items.map((item) => ({ item, key: keyOf(item), leaving: false }));
  const place = (key: string) => (leaving.get(key) as { order: string[] }).order.indexOf(key);
  for (const key of [...leaving.keys()].sort((x, y) => place(x) - place(y))) {
    if (out.some((o) => o.key === key)) continue;
    const { item, order } = leaving.get(key) as { item: T; order: string[] };
    const after = order.slice(order.indexOf(key) + 1).find((k) => out.some((o) => o.key === k && !o.leaving));
    const at = after === undefined ? out.length : out.findIndex((o) => o.key === after);
    out.splice(at, 0, { item, key, leaving: true });
  }
  const keys = out.map((o) => o.key).join('\0');
  useEffect(() => {
    committed.current = keys ? keys.split('\0') : [];
  }, [keys]);
  return out;
}
