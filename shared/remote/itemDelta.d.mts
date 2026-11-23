// Types for shared/remote/itemDelta.mjs.
export const KNOWN_ITEMS: number;
export type DeltaItem = object;
export type ItemDelta<T extends DeltaItem = DeltaItem> = { order: (string | null)[]; changed: T[] };
export function itemTag(item: { id: string }): string;
export function knownOf(items: DeltaItem[], max?: number): [string, string][];
export function deltaOf<T extends DeltaItem>(items: T[], known: [string, string][]): ItemDelta<T>;
export function applyDelta<T extends DeltaItem>(cached: T[], delta: ItemDelta<T>): T[] | null;
