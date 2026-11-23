// The service tiers a Codex model reports (model/list `serviceTiers`): Fast is the "priority" one, but a
// model may list more (D-57). The picker and the + menu offer each as the app-server names it.
import type { ServiceTier } from '../../shared/model/harness';
export type { ServiceTier } from '../../shared/model/harness';

/** Every tier the model lists except "default" (that is Standard, always offered). */
export function codexTiers(m: { serviceTiers?: { id: string; name?: string; description?: string }[] } | null | undefined): ServiceTier[] {
  return (m?.serviceTiers ?? [])
    .filter((t) => t.id && t.id !== 'default')
    .map((t) => ({ id: t.id, name: t.name || t.id, description: t.description ?? '' }));
}

/** The tier in use: the stored one if the model offers it, else null (Standard). */
export const activeTier = (tiers: ServiceTier[], stored: string | null | undefined): string | null =>
  tiers.find((t) => t.id === stored)?.id ?? null;
