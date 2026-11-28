// The session rail's section layout, as Claude Desktop's: which sections start open, which the user hid, and each chat's
// own folds. A fold by hand is this chat's and becomes how new chats start; Alt+click folds them all for the chat.
import { useMemo } from 'react';
import { setPrefs, useStore } from './core';
import type { AppState } from './state';

type Prefs = AppState['prefs'] | undefined;

const prefsNow = (): Prefs => useStore.getState().prefs;

/** The rail's sections in their order; Environment can't be hidden. */
export const RAIL_SECTIONS = [
  { id: 'environment', title: 'Environment', hideable: false },
  { id: 'goal', title: 'Goal', hideable: true },
  { id: 'context', title: 'Context', hideable: true },
  { id: 'connectors', title: 'Connectors', hideable: true },
  { id: 'outputs', title: 'Outputs', hideable: true },
  { id: 'changes', title: 'Changes', hideable: true },
  { id: 'servers', title: 'Servers', hideable: true },
  { id: 'backgroundTasks', title: 'Background tasks', hideable: true },
  { id: 'activity', title: 'Activity', hideable: true },
  { id: 'sources', title: 'Sources', hideable: true },
] as const;
export type RailSectionId = (typeof RAIL_SECTIONS)[number]['id'];

/** Sections that start collapsed until the user opens one by hand. */
const STARTS_CLOSED = new Set<RailSectionId>(['context', 'connectors']);
/** How many chats keep their own folds; older ones fall back to how new chats start. */
const FOLDS_KEPT = 100;

/** Whether the section is open in this chat: its own fold, else how chats start now, else the section's default. */
export function sectionOpen(prefs: Prefs, chatId: string, id: RailSectionId): boolean {
  const folds = prefs?.railFolds?.[chatId];
  if (folds?.expanded.includes(id)) return true;
  if (folds?.collapsed.includes(id)) return false;
  return prefs?.railSections?.startsOpen?.[id] ?? !STARTS_CLOSED.has(id);
}

export const sectionHidden = (prefs: Prefs, id: RailSectionId) =>
  RAIL_SECTIONS.some((s) => s.id === id && s.hideable) && (prefs?.railSections?.hidden ?? []).includes(id);

/** This chat's folds with `ids` set open or closed, the chat moved to the newest place and the oldest beyond the limit dropped. */
function withFolds(prefs: Prefs, chatId: string, ids: readonly RailSectionId[], open: boolean): NonNullable<Prefs>['railFolds'] {
  const { [chatId]: was, ...rest } = prefs?.railFolds ?? {};
  const drop = (list: string[] = []) => list.filter((id) => !ids.includes(id as RailSectionId));
  const folds = {
    expanded: open ? [...drop(was?.expanded), ...ids] : drop(was?.expanded),
    collapsed: open ? drop(was?.collapsed) : [...drop(was?.collapsed), ...ids],
  };
  const kept = Object.entries(rest).slice(-(FOLDS_KEPT - 1));
  return { ...Object.fromEntries(kept), [chatId]: folds };
}

/** A fold by hand: this chat's, and how the section starts in new chats. */
export function setSectionOpen(chatId: string, id: RailSectionId, open: boolean) {
  const prefs = prefsNow();
  setPrefs({
    railFolds: withFolds(prefs, chatId, [id], open),
    railSections: { ...prefs?.railSections, startsOpen: { ...prefs?.railSections?.startsOpen, [id]: open } },
  });
}

/** An open or close the app asks for (a form shown in the section, the element's own toggle): this chat's only. */
export function setSectionOpenFor(chatId: string, id: RailSectionId, open: boolean) {
  if (sectionOpen(prefsNow(), chatId, id) !== open) setPrefs({ railFolds: withFolds(prefsNow(), chatId, [id], open) });
}

/** Alt+click: every section of this chat open or closed; how new chats start is left alone. */
export function setAllSectionsOpen(chatId: string, open: boolean) {
  const prefs = prefsNow();
  setPrefs({
    railFolds: withFolds(
      prefs,
      chatId,
      RAIL_SECTIONS.map((s) => s.id),
      open,
    ),
  });
}

export function setSectionHidden(id: RailSectionId, hidden: boolean) {
  const prefs = prefsNow();
  const rest = (prefs?.railSections?.hidden ?? []).filter((h) => h !== id);
  setPrefs({ railSections: { ...prefs?.railSections, hidden: hidden ? [...rest, id] : rest } });
}

const DEFAULT_ORDER = RAIL_SECTIONS.map((s) => s.id);
const isSection = (id: string): id is RailSectionId => (DEFAULT_ORDER as string[]).includes(id);

/** The sections in the order the user left them; one the saved order doesn't know takes its default place after its predecessor. */
export function sectionOrder(saved: readonly string[] | undefined): RailSectionId[] {
  const order = (saved ?? []).filter(isSection).filter((id, i, all) => all.indexOf(id) === i);
  for (const [i, id] of DEFAULT_ORDER.entries()) {
    if (order.includes(id)) continue;
    const before = DEFAULT_ORDER.slice(0, i)
      .reverse()
      .find((p) => order.includes(p));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  }
  return order;
}

/** The rail's order, re-rendering when the user moves a section. */
export function useSectionOrder(): RailSectionId[] {
  const saved = useStore((s) => s.prefs?.railSections?.order);
  return useMemo(() => sectionOrder(saved), [saved]);
}

/** Move a section one place up (-1) or down (1) among all of them, as Claude Desktop's drag does; the order is the user's. */
export function moveSection(id: RailSectionId, by: -1 | 1) {
  const prefs = prefsNow();
  const order = sectionOrder(prefs?.railSections?.order);
  const at = order.indexOf(id);
  const to = at + by;
  if (to < 0 || to >= order.length) return;
  order.splice(at, 1);
  order.splice(to, 0, id);
  setPrefs({ railSections: { ...prefs?.railSections, order } });
}

/** A section dropped on another, as Claude Desktop's drag: it takes the place before (or after) the one it was dropped on. */
export function moveSectionTo(id: RailSectionId, target: RailSectionId, after: boolean) {
  if (id === target) return;
  const prefs = prefsNow();
  const order = sectionOrder(prefs?.railSections?.order).filter((s) => s !== id);
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
  setPrefs({ railSections: { ...prefs?.railSections, order } });
}

/** Whether anything differs from the defaults: something hidden or moved, a changed start, or this chat's own folds. */
export function sectionsChanged(prefs: Prefs, chatId: string): boolean {
  const folds = prefs?.railFolds?.[chatId];
  return (
    !!prefs?.railSections?.hidden?.length ||
    sectionOrder(prefs?.railSections?.order).some((id, i) => id !== DEFAULT_ORDER[i]) ||
    Object.entries(prefs?.railSections?.startsOpen ?? {}).some(([id, open]) => open === STARTS_CLOSED.has(id as RailSectionId)) ||
    !!(folds && (folds.expanded.length || folds.collapsed.length))
  );
}

/** Reset to defaults: nothing hidden or moved, every section starting as it does by default, and this chat's folds forgotten. */
export function resetSections(chatId: string) {
  const { [chatId]: _, ...rest } = prefsNow()?.railFolds ?? {};
  setPrefs({ railSections: {}, railFolds: rest });
}

/** The section's open and hidden state in this chat, re-rendering when either changes. */
export function useRailSection(chatId: string, id: RailSectionId) {
  const open = useStore((s) => sectionOpen(s.prefs, chatId, id));
  const hidden = useStore((s) => sectionHidden(s.prefs, id));
  return { open, hidden };
}
