// Window-local tool arrangements: distinct tabs in resizable rows or columns, remembered per stable chat.
import { useSyncExternalStore } from 'react';

export type ToolAxis = 'columns' | 'rows';
export type ToolLayout = { ids: readonly string[]; active: string; axis: ToolAxis; weights: readonly number[] };
export const TOOL_PANES_MAX = 4;
const EMPTY: ToolLayout = { ids: [], active: '', axis: 'rows', weights: [] };
const layouts = new Map<string, ToolLayout>();
const listeners = new Set<() => void>();
export const toolLayoutScope = (chat: string | null) => JSON.stringify(chat === null ? ['home'] : ['chat', chat]);
const positive = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1);
const same = (a: ToolLayout, b: ToolLayout) =>
  a.axis === b.axis &&
  a.active === b.active &&
  JSON.stringify(a.ids) === JSON.stringify(b.ids) &&
  JSON.stringify(a.weights) === JSON.stringify(b.weights);

/** Remove unavailable tabs; selecting an unseen tab replaces only the previously focused slot. */
export function projectToolLayout(saved: ToolLayout, available: readonly string[], front: string): ToolLayout {
  const ids = saved.ids.filter((id, i) => available.includes(id) && saved.ids.indexOf(id) === i).slice(0, TOOL_PANES_MAX);
  const weights = ids.map((id) => positive(saved.weights[saved.ids.indexOf(id)]));
  if (front && available.includes(front) && !ids.includes(front)) {
    const retired = saved.ids.indexOf(saved.active);
    const at = Math.max(0, ids.indexOf(saved.active));
    if (retired >= 0 && !ids.includes(saved.active) && ids.length < TOOL_PANES_MAX) {
      ids.splice(Math.min(retired, ids.length), 0, front);
      weights.splice(Math.min(retired, weights.length), 0, positive(saved.weights[retired]));
    } else if (ids.length) ids[at] = front;
    else {
      ids.push(front);
      weights.push(1);
    }
  }
  const next: ToolLayout = { ids, weights, axis: saved.axis, active: ids.includes(front) ? front : (ids[0] ?? '') };
  return same(saved, next) ? saved : next;
}

/** Add after the focused tool with an average share, preserving the existing tools' relative sizes. */
export function splitToolLayout(layout: ToolLayout, target: string, axis: ToolAxis): ToolLayout {
  if (!target || !layout.ids.length || layout.ids.includes(target) || layout.ids.length >= TOOL_PANES_MAX) return layout;
  const at = Math.max(0, layout.ids.indexOf(layout.active));
  const ids = [...layout.ids];
  const previous = layout.ids.map((_, i) => positive(layout.weights[i]));
  const total = previous.reduce((sum, weight) => sum + weight, 0);
  const share = 1 / (ids.length + 1);
  const weights = previous.map((weight) => (weight / total) * (1 - share));
  ids.splice(at + 1, 0, target);
  weights.splice(at + 1, 0, share);
  return { ids, weights, active: target, axis };
}

/** Return to one visible tool without closing any tabs or their resource owners. */
export const singleToolLayout = (layout: ToolLayout): ToolLayout => ({
  ...layout,
  ids: layout.active ? [layout.active] : [],
  weights: layout.active ? [1] : [],
});

/** Remove a tile from the arrangement, retaining its tab for later selection. */
export function removeToolTile(layout: ToolLayout, id: string): ToolLayout {
  const at = layout.ids.indexOf(id);
  if (at < 0 || layout.ids.length < 2) return layout;
  const ids = layout.ids.filter((v) => v !== id);
  return {
    ...layout,
    ids,
    weights: layout.weights.filter((_, i) => i !== at),
    active: layout.active === id ? ids[Math.min(at, ids.length - 1)] : layout.active,
  };
}

/** Move an adjacent divider, preserving its pair's weight and every other tile's size. */
export function resizeToolPair(layout: ToolLayout, at: number, share: number): ToolLayout {
  if (at < 0 || at >= layout.ids.length - 1 || !Number.isFinite(share)) return layout;
  const fraction = Math.min(0.9, Math.max(0.1, share));
  const weights = [...layout.weights];
  const total = positive(weights[at]) + positive(weights[at + 1]);
  weights[at] = total * fraction;
  weights[at + 1] = total * (1 - fraction);
  return { ...layout, weights };
}

export const toolLayout = (scope: string): ToolLayout => layouts.get(scope) ?? EMPTY;
export function rememberToolLayout(scope: string, layout: ToolLayout) {
  if (same(toolLayout(scope), layout)) return;
  layouts.delete(scope);
  layouts.set(scope, layout);
  if (layouts.size > 100) layouts.delete(layouts.keys().next().value!);
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useToolLayout(scope: string) {
  return useSyncExternalStore(subscribe, () => toolLayout(scope));
}
/** Tests start from an empty window-local layout store. */
export function resetToolLayouts() {
  layouts.clear();
  for (const listener of [...listeners]) listener();
}
